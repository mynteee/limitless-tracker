import { parseArgs } from 'node:util';
import { ApiClient } from './api/client.js';
import { LimitlessApi } from './api/limitless.js';
import { openDb, DEFAULT_DB_PATH } from './db/open.js';
import { Store } from './db/queries.js';
import { discover, fetchPending } from './ingest/crawl.js';
import { build } from './publish/build.js';
import { serve } from './publish/serve.js';

const USAGE = `
limitless-tracker

  crawl    Discover tournaments and ingest their standings (resumable, rate-limited)
    --game <ID>          default PTCG
    --format <ID>        default STANDARD
    --pages <N>          max listing pages to discover (50 tournaments each)
    --limit <N>          max tournaments to ingest this run
    --min-players <N>    skip events smaller than this (default 50, 0 disables)
    --since <date>       only tournaments on or after this date (YYYY-MM-DD)
    --until <date>       only tournaments on or before this date
    --all-events         keep events that ran without decklists (off by default)
    --full               discover the whole corpus, not just what is new
    --no-deepen          only catch up the newest pages; do not extend history
    --max-minutes <N>    stop cleanly after N minutes (for CI job caps)
    --max-requests <N>   stop cleanly after N API requests

  prune    Delete already-ingested events that no longer match the crawl policy
    --min-players <N>, --all-events, --apply (dry run without it)

  build    Generate the static site data into dist/ (no network)
    --out <dir>              output directory, default dist
    --decklist-months <N>    only publish decklists newer than N months

  serve    Preview the built site locally
    --out <dir>              directory to serve, default dist
    --port <N>               default 8080

  lookup <player>        A player's placement and deck history
    --deck <tournamentId>  print the full decklist from that event
    --json

  search <term>          Find players by handle or display name
  stats                  What the local database currently holds

  Global: --db <path>    default ${DEFAULT_DB_PATH}
`;

const args = parseArgs({
    allowPositionals: true,
    strict: false,
    options: {
        game: { type: 'string' },
        format: { type: 'string' },
        pages: { type: 'string' },
        limit: { type: 'string' },
        'min-players': { type: 'string' },
        'max-minutes': { type: 'string' },
        'max-requests': { type: 'string' },
        'no-deepen': { type: 'boolean' },
        'all-events': { type: 'boolean' },
        since: { type: 'string' },
        until: { type: 'string' },
        apply: { type: 'boolean' },
        out: { type: 'string' },
        'decklist-months': { type: 'string' },
        port: { type: 'string' },
        full: { type: 'boolean' },
        deck: { type: 'string' },
        json: { type: 'boolean' },
        db: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
    },
});

const [command, ...rest] = args.positionals;
const opts = args.values;

if (!command || opts.help) {
    console.log(USAGE);
    // Asking for help succeeded; being given no command at all did not.
    process.exit(opts.help ? 0 : 1);
}

const num = (v, fallback) => (v === undefined ? fallback : Number(v));

/**
 * How far ahead a plain `crawl` may discover when nothing bounds the run. Enough to
 * keep a session busy without paging the entire archive before fetching anything.
 */
const DEFAULT_DISCOVERY_TARGET = 500;

const db = openDb(opts.db);
const store = new Store(db);

try {
    switch (command) {
        case 'crawl':   await cmdCrawl(); break;
        case 'prune':   cmdPrune(); break;
        case 'build':   cmdBuild(); break;
        case 'serve':   cmdServe(); break;
        case 'lookup':  cmdLookup(rest.join(' ')); break;
        case 'search':  cmdSearch(rest.join(' ')); break;
        case 'stats':   cmdStats(); break;
        default:
            console.error(`Unknown command: ${command}`);
            console.log(USAGE);
            process.exitCode = 1;
    }
} finally {
    db.close();
}

// ── commands ───────────────────────────────────────────────────────────────────

async function cmdCrawl() {
    const api = new LimitlessApi(new ApiClient());
    const game = opts.game ?? 'PTCG';
    const format = opts.format ?? 'STANDARD';
    const minPlayers = policyMinPlayers();
    const requireDecklists = !opts['all-events'];
    const since = isoBound(opts.since, false);
    const until = isoBound(opts.until, true);
    const maxRequests = num(opts['max-requests'], Infinity);
    const deadline = opts['max-minutes']
        ? Date.now() + Number(opts['max-minutes']) * 60_000
        : Infinity;

    // Discovery and ingest draw on one shared request budget. Left unbounded, a first
    // run against an empty database spends the whole budget queueing tournaments it
    // will never reach — 2,600 discovered, zero fetched, and a site deployed with no
    // data in it. So cap how far ahead discovery may run: there is no value in queueing
    // more work than this run could possibly fetch. `--full` opts out for backfills.
    const affordable = Math.min(
        maxRequests,
        // At the 50-per-5-minute limit a request costs 6 seconds.
        opts['max-minutes'] ? Math.ceil((Number(opts['max-minutes']) * 60_000) / 6_000) : Infinity,
        num(opts.limit, Infinity),
    );
    const pendingTarget = opts.full
        ? Infinity
        : (Number.isFinite(affordable) ? affordable : DEFAULT_DISCOVERY_TARGET);

    // Ctrl-C stops after the current tournament commits, rather than mid-write.
    const controller = new AbortController();
    process.on('SIGINT', () => {
        if (controller.signal.aborted) process.exit(130);
        console.log('\n\nStopping after the current tournament — progress is saved, re-run to resume.');
        controller.abort();
    });

    console.log(`Crawling ${game}/${format}  (limit: 50 requests / 5 min)`);
    console.log(`Policy: ${minPlayers === null ? 'all sizes' : `>= ${minPlayers} players`}`
        + `, ${requireDecklists ? 'decklist events only' : 'all events'}`
        + `${since ? `, from ${since.slice(0, 10)}` : ''}`
        + `${until ? `, to ${until.slice(0, 10)}` : ''}`);
    console.log();

    console.log('Discovering tournaments...');
    const d = await discover(api, store, {
        game,
        format,
        maxPages: num(opts.pages, Infinity),
        stopWhenKnown: !opts.full,
        since,
        until,
        pendingTarget,
        minPlayers,
        deepen: !opts['no-deepen'],
        deadline,
        maxRequests,
        signal: controller.signal,
        onProgress: ({ page, fresh, discovered, phase }) =>
            process.stdout.write(`  page ${page} (${phase}): ${fresh} new (${discovered} total)\n`),
    });
    console.log(`  ${d.discovered} new tournaments across ${d.pages} pages`);
    if (d.deepTo !== null) {
        console.log(`  extended history through listing page ${d.deepTo}`);
    }
    if (d.archiveComplete) {
        console.log('  the archive is fully discovered back to its oldest event');
    }
    console.log();

    const queued = store.countPending(minPlayers);
    if (queued === 0) {
        console.log('Nothing pending — everything discovered is already ingested.');
        return report(api);
    }

    const cap = num(opts.limit, Infinity);
    const planned = Math.min(cap, queued);
    console.log(`Ingesting standings for ${planned} of ${queued} pending tournaments`);
    console.log(`Estimated time: ${humanDuration(planned * 6000)} at the rate limit\n`);

    const started = Date.now();
    const result = await fetchPending(api, store, {
        limit: cap,
        minPlayers,
        requireDecklists,
        deadline,
        maxRequests,
        signal: controller.signal,
        onProgress: ({ done, failed, total, remaining, skippedNoDecklists, tournament }) => {
            const pct = ((total - remaining) / total * 100).toFixed(1);
            const eta = humanDuration(remaining * 6000);
            const line = `  [${pct.padStart(5)}%] ${done} kept, ${skippedNoDecklists} no-lists, ${failed} failed, ${remaining} left · ETA ${eta} · ${truncate(tournament.name, 34)}`;
            if (process.stdout.isTTY) process.stdout.write(`\r${line.padEnd(120)}`);
            else console.log(line);
        },
    });

    if (process.stdout.isTTY) process.stdout.write('\n');
    console.log(`\nIngested ${result.done} tournaments (${result.standings} standings) in ${humanDuration(Date.now() - started)}`);
    if (result.skippedNoDecklists) {
        console.log(`${result.skippedNoDecklists} events ran without decklists and were skipped (ranking only).`);
    }
    if (result.failed) console.log(`${result.failed} tournaments had no usable standings and were skipped permanently.`);

    const stillPending = store.countPending(minPlayers);
    if (result.stoppedBecause !== 'complete') {
        const why = {
            deadline: 'reached the --max-minutes limit',
            budget: 'reached the --max-requests limit',
            interrupted: 'was interrupted',
        }[result.stoppedBecause] ?? result.stoppedBecause;
        console.log(`\nStopped early: ${why}. ${stillPending} tournaments still pending — re-run to continue.`);
    } else if (stillPending > 0) {
        console.log(`\n${stillPending} tournaments still pending (${humanDuration(stillPending * 6000)} of crawling).`);
    }
    report(api);
}

function report(api) {
    const { requests, retries, rateLimitHits } = api.stats;
    console.log(`Requests: ${requests} · retries: ${retries} · 429s: ${rateLimitHits}`);
    if (rateLimitHits > 0) {
        console.log('Hit the rate limit — the client backed off and recovered, but pacing may need review.');
    }
}

/**
 * Crawl policy default. A ranking with no decklists is not what this project is for,
 * and small events are mostly noise, so the default is deliberately selective.
 * `--min-players 0` turns the size filter off.
 */
function policyMinPlayers() {
    if (opts['min-players'] === undefined) return 50;
    const n = Number(opts['min-players']);
    return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Normalise a YYYY-MM-DD (or full ISO) bound to an ISO timestamp. ISO strings compare
 * correctly with `<` and `>`, which is what the discovery filter relies on.
 */
function isoBound(value, endOfDay) {
    if (!value) return null;
    const raw = String(value).trim();
    const iso = raw.includes('T')
        ? raw
        : `${raw}${endOfDay ? 'T23:59:59.999Z' : 'T00:00:00.000Z'}`;
    const parsed = new Date(iso);
    if (Number.isNaN(parsed.getTime())) {
        console.error(`Invalid date: ${value} (expected YYYY-MM-DD)`);
        process.exit(1);
    }
    return parsed.toISOString();
}

function cmdPrune() {
    const minPlayers = policyMinPlayers();
    const requireDecklists = !opts['all-events'];
    const rows = store.prunable({ minPlayers, requireDecklists });

    if (rows.length === 0) {
        console.log('Nothing to prune — every ingested event already matches the policy.');
        return;
    }

    const tooSmall = rows.filter((r) => minPlayers !== null && r.players < minPlayers).length;
    const noLists = rows.filter((r) => r.has_decklists === 0).length;

    console.log(`\n${rows.length} ingested events no longer match the policy ` +
        `(>= ${minPlayers ?? 0} players` +
        `${requireDecklists ? ', decklists required' : ''}):`);
    // An event can fail both tests at once, so these do not sum to the total.
    console.log(`  ${tooSmall} below the player threshold`);
    console.log(`  ${noLists} ran without decklists   (an event can be both)\n`);

    printTable(
        ['Date', 'Players', 'Lists', 'Tournament'],
        rows.slice(0, 12).map((r) => [
            r.date.slice(0, 10),
            String(r.players ?? '?'),
            r.has_decklists ? 'yes' : 'no',
            truncate(r.name, 48),
        ]),
    );
    if (rows.length > 12) console.log(`  ... and ${rows.length - 12} more`);

    if (!opts.apply) {
        console.log('\nDry run — nothing deleted. Re-run with --apply to remove their standings.');
        return;
    }

    store.prune(rows.map((r) => r.id));
    console.log(`\nRemoved standings for ${rows.length} events.`);
    console.log('Tournament rows are kept as tombstones so they are never re-fetched.');
}

function cmdBuild() {
    const outDir = opts.out ?? 'dist';
    const decklistMonths = opts['decklist-months'] ? Number(opts['decklist-months']) : null;

    console.log(`Building static data into ${outDir}/data`);
    if (decklistMonths) console.log(`Decklists limited to the last ${decklistMonths} months`);
    console.log();

    const started = Date.now();
    const r = build(store, {
        outDir,
        decklistMonths,
        onProgress: (p) => {
            if (p.type === 'unsafe') console.warn(`  skipped unsafe handle: ${JSON.stringify(p.handle)}`);
            else console.log(`  ${p.written}/${p.total} players`);
        },
    });

    console.log();
    console.log(`${r.players} player files, ${r.listsWritten} decklists, ${r.searchBuckets} search buckets`);
    console.log(`  players/  ${mb(r.bytes.players)}`);
    console.log(`  decks/    ${mb(r.bytes.decks)}`);
    console.log(`  search/   ${mb(r.bytes.search)}`);
    console.log(`  total     ${mb(r.bytes.total)}`);
    console.log();
    console.log(`Coverage ${r.meta.coverage.from?.slice(0, 10)} to ${r.meta.coverage.to?.slice(0, 10)}`
        + ` · built in ${humanDuration(Date.now() - started)}`);

    if (r.skipped) console.log(`${r.skipped} handles skipped as unsafe for a file path.`);

    // GitHub Pages refuses to publish a site larger than 1 GB.
    const pct = r.bytes.total / 1e9 * 100;
    if (pct > 60) {
        console.log();
        console.log(`Warning: ${pct.toFixed(0)}% of the 1 GB GitHub Pages limit. Consider --decklist-months.`);
    }
}


function cmdServe() {
    // serve() never touches the database, so the finally block closing it is harmless.
    // The listening socket is what keeps the process alive.
    serve({ dir: opts.out ?? 'dist', port: num(opts.port, 8080) });
}

function mb(bytes) {
    return bytes < 1e6 ? `${(bytes / 1e3).toFixed(0)} KB` : `${(bytes / 1e6).toFixed(1)} MB`;
}

function cmdLookup(handle) {
    if (!handle) return fail('Usage: lookup <player>');

    const history = store.getPlayerHistory(handle);
    if (history.length === 0) {
        console.log(`No results for "${handle}".`);
        console.log('Handles are the Limitless username, not the display name — try: search ' + handle);
        return;
    }

    if (opts.deck) {
        const list = store.getDecklist(handle, opts.deck);
        if (!list) return fail(`No decklist stored for ${handle} at tournament ${opts.deck}`);
        return printDecklist(list);
    }

    if (opts.json) {
        console.log(JSON.stringify(history, null, 2));
        return;
    }

    // Dropped players have placing === null; they still count as events played but
    // must not be treated as a placement of 0.
    const placed = history.filter((h) => h.placing !== null);
    const totals = history.reduce(
        (a, h) => ({ w: a.w + (h.wins ?? 0), l: a.l + (h.losses ?? 0), t: a.t + (h.ties ?? 0) }),
        { w: 0, l: 0, t: 0 },
    );
    const games = totals.w + totals.l + totals.t;
    const winRate = games ? ((totals.w / games) * 100).toFixed(1) + '%' : 'n/a';
    const best = placed.length ? Math.min(...placed.map((h) => h.placing)) : null;

    console.log(`\n${history[0].displayName ?? handle}  (@${handle.toLowerCase()})`);

    // Display names change between events; the handle does not. Listing the older ones
    // confirms this is the right player when someone arrived here via an old name.
    const allNames = store.getPlayerNames(handle);
    if (allNames.length > 1) {
        console.log(`also: ${allNames.slice(1).join(', ')}`);
    }
    console.log(`${history.length} events · ${totals.w}-${totals.l}-${totals.t} · ${winRate} win rate` +
        (best ? ` · best finish: ${ordinal(best)}` : ''));
    // `drop` and `placing` are independent in the API: a player can drop and still be
    // assigned a placing, or drop and be left unplaced. They get separate columns
    // rather than being collapsed into one, which would misreport both.
    const drops = history.filter((h) => h.dropRound !== null).length;
    console.log(`${drops} ${drops === 1 ? 'drop' : 'drops'}\n`);

    printTable(
        ['Date', 'Placing', 'Record', 'Drop', 'Deck', 'Tournament'],
        history.map((h) => [
            h.date.slice(0, 10),
            h.placing === null ? '—' : `${ordinal(h.placing)}/${h.fieldSize ?? '?'}`,
            `${h.wins ?? 0}-${h.losses ?? 0}-${h.ties ?? 0}`,
            h.dropRound === null ? '' : `r${h.dropRound}`,
            truncate(h.deckName ?? '—', 24),
            truncate(h.tournamentName, 44),
        ]),
    );

    console.log(`\nFull decklist:  lookup ${handle} --deck ${history[0].tournamentId}`);
}

function cmdSearch(term) {
    if (!term) return fail('Usage: search <term>');
    const rows = store.searchPlayers(term);
    if (rows.length === 0) return console.log(`No players matching "${term}".`);

    printTable(
        ['Handle', 'Display name', 'Events', 'First', 'Last'],
        rows.map((r) => [
            r.handle,
            // Flag players who have used other names, so a hit on an old one is
            // obviously the same person rather than looking like a mismatch.
            (r.name ?? '—') + (r.altNames > 1 ? ` (+${r.altNames - 1})` : ''),
            String(r.events),
            r.firstSeen.slice(0, 10),
            r.lastSeen.slice(0, 10),
        ]),
    );

    if (rows.some((r) => r.altNames > 1)) {
        console.log('\n(+N) = the player has used N other display names. The handle is the stable identity.');
    }
}

function cmdStats() {
    const s = store.stats();
    const minPlayers = policyMinPlayers();
    // Count pending under the crawl policy, since that is what will actually be fetched.
    const pending = store.countPending(minPlayers);
    console.log(`
Database   ${opts.db ?? DEFAULT_DB_PATH}
Policy     >= ${minPlayers ?? 0} players, decklist events only

Tournaments known      ${s.tournaments}
  with stored data     ${s.eventsWithData}
  fetched, not stored  ${s.ingested - s.eventsWithData}  (${s.noDecklists} ranking-only, rest below policy)
  pending (policy)     ${pending}
  permanently failed   ${s.failed}

Standings              ${s.standings}
  with decklists       ${s.decklists}
Distinct players       ${s.players}

Coverage               ${s.oldest ? `${s.oldest.slice(0, 10)} to ${s.newest.slice(0, 10)}` : 'nothing ingested yet'}
`);
    if (pending > 0) console.log(`${humanDuration(pending * 6000)} of crawling left to drain the queue.\n`);
}

// ── formatting ─────────────────────────────────────────────────────────────────

function printDecklist(list) {
    for (const group of ['pokemon', 'trainer', 'energy']) {
        const cards = list[group] ?? [];
        if (!cards.length) continue;
        const count = cards.reduce((a, c) => a + c.count, 0);
        console.log(`\n${group.toUpperCase()} (${count})`);
        for (const c of cards) {
            console.log(`  ${String(c.count).padStart(2)}  ${c.name.padEnd(32)} ${c.set} ${c.number}`);
        }
    }
    console.log();
}

function printTable(headers, rows) {
    const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
    const line = (cells) => cells.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
    console.log(line(headers));
    console.log(widths.map((w) => '─'.repeat(w)).join('  '));
    for (const r of rows) console.log(line(r));
}

function truncate(s, n) {
    s = s ?? '';
    return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}

function humanDuration(ms) {
    const sec = Math.round(ms / 1000);
    if (sec < 60) return `${sec}s`;
    const min = Math.round(sec / 60);
    if (min < 60) return `${min}m`;
    const hours = Math.floor(min / 60);
    return `${hours}h ${min % 60}m`;
}

function fail(msg) {
    console.error(msg);
    process.exitCode = 1;
}
