import { parseArgs } from 'node:util';
import { ApiClient } from './api/client.js';
import { LimitlessApi } from './api/limitless.js';
import { openDb, DEFAULT_DB_PATH } from './db/open.js';
import { Store } from './db/queries.js';
import { discover, fetchPending } from './ingest/crawl.js';
import { fetchPrintGroups } from './ingest/prints.js';
import { build } from './publish/build.js';
import { serve } from './publish/serve.js';
import { groupArchetypes } from './publish/archetypes.js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const USAGE = `
limitless-tracker

  crawl    Discover tournaments and ingest their standings (resumable, rate-limited)
    --game <ID>          default PTCG
    --format <ID>        default STANDARD
    --pages <N>          max listing pages to discover (50 tournaments each)
    --limit <N>          max tournaments to ingest this run
    --min-players <N>    skip events smaller than this (default 16, 0 disables)
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

  card <name|SET-NUM>    Which decklists ran a card, newest event first
    --all                  every result, not just the most recent event
    --limit <N>            rows to show (default 25)

  decks                  List every archetype, most played first
    --variants             break each archetype out into its variants

  deck <archetype>       Average decklist and recent placements
    --days <N>             only decks from the last N days (default 30)
    --variant <deck_id>    restrict to one variant
    --results              show placements instead of the average list
    --limit <N>

  prints                 Work out which card printings are the same card
    --limit <N>            look up at most N cards this run
    --max-minutes <N>

  reindex                Rebuild the card index from stored decklists

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
        all: { type: 'boolean' },
        variants: { type: 'boolean' },
        variant: { type: 'string' },
        days: { type: 'string' },
        results: { type: 'boolean' },
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
        case 'card':    cmdCard(rest.join(' ')); break;
        case 'decks':   cmdDecks(); break;
        case 'deck':    cmdDeck(rest.join(' ')); break;
        case 'prints':  await cmdPrints(); break;
        case 'reindex': cmdReindex(); break;
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
/**
 * Minimum event size to keep. Must stay in step with the crawl workflow's default,
 * or a local run and CI build different corpora from the same repo — and `prune`,
 * which reads this same value, would then offer to delete everything CI collected
 * between the two thresholds.
 */
function policyMinPlayers() {
    if (opts['min-players'] === undefined) return 16;
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
            else if (p.type === 'repair') process.stdout.write(`  indexing missing cards: ${p.done}/${p.total}   `);
            else if (p.type === 'repaired') console.log(`  card index repaired: ${p.tournaments} tournaments were missing   `);
            else if (p.type === 'window') console.log(`  averaged ${p.decks} decks over the ${p.days || 'all-time'} window`);
            else console.log(`  ${p.written}/${p.total} ${p.type}`);
        },
    });

    console.log();
    console.log(`${r.players} players, ${r.cards} cards, ${r.archetypes} archetypes, `
        + `${r.listsWritten} decklists, ${r.searchBuckets} search buckets`);
    console.log(`  players/     ${mb(r.bytes.players)}`);
    console.log(`  decks/       ${mb(r.bytes.decks)}`);
    console.log(`  cards/       ${mb(r.bytes.cards)}`);
    console.log(`  archetypes/  ${mb(r.bytes.archetypes)}`);
    console.log(`  search/      ${mb(r.bytes.search)}`);
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

/** Deck ids grouped into base archetypes, with the hand-maintained corrections applied. */
function archetypes() {
    const here = dirname(fileURLToPath(import.meta.url));
    const overrides = JSON.parse(
        readFileSync(join(here, 'publish', 'data', 'archetype-overrides.json'), 'utf8'),
    );
    return groupArchetypes(store.allDecks(), overrides);
}

function cmdDecks() {
    const list = archetypes();
    console.log(`
${list.length} archetypes across ${list.reduce((a, x) => a + x.decks, 0).toLocaleString()} decklists
`);

    if (opts.variants) {
        printTable(
            ['Archetype', 'Variant', 'Decks'],
            list.flatMap((a) => a.variants.map((v, i) => [
                i === 0 ? a.id : '',
                v.deckId + (v.deckId === a.id ? '' : ''),
                v.decks.toLocaleString(),
            ])),
        );
        return;
    }

    printTable(
        ['Archetype', 'Name', 'Decks', 'Variants', 'Last seen'],
        list.slice(0, num(opts.limit, 40)).map((a) => [
            a.id,
            truncate(a.name, 26),
            a.decks.toLocaleString(),
            String(a.variants.length),
            a.variants.reduce((m, v) => (v.lastSeen > m ? v.lastSeen : m), '').slice(0, 10),
        ]),
    );
    console.log(`
Detail: deck <archetype>`);
}

function cmdDeck(term) {
    if (!term) return fail('Usage: deck <archetype>');

    const list = archetypes();
    const key = term.toLowerCase();
    const arch = list.find((a) => a.id === key)
        ?? list.find((a) => a.name.toLowerCase() === key)
        ?? list.find((a) => a.id.includes(key) || a.name.toLowerCase().includes(key));
    if (!arch) return console.log(`No archetype matching "${term}". Try: decks`);

    const variant = opts.variant
        ? arch.variants.find((v) => v.deckId === opts.variant)
        : null;
    if (opts.variant && !variant) {
        return fail(`"${opts.variant}" is not a variant of ${arch.id}. Have: `
            + arch.variants.map((v) => v.deckId).join(', '));
    }

    const deckIds = variant ? [variant.deckId] : arch.variants.map((v) => v.deckId);
    const days = num(opts.days, 30);
    const since = new Date(Date.now() - days * 86_400_000).toISOString();

    console.log(`
${variant ? variant.deckName : arch.name}  (${variant ? variant.deckId : arch.id})`);
    if (!variant && arch.variants.length > 1) {
        console.log(`${arch.variants.length} variants: `
            + arch.variants.slice(0, 6).map((v) => `${v.deckId} (${v.decks})`).join(', ')
            + (arch.variants.length > 6 ? ', ...' : ''));
    }

    if (opts.results) {
        const rows = store.archetypeResults(deckIds, { since, limit: num(opts.limit, 25) });
        console.log(`
Placements, last ${days} days
`);
        if (rows.length === 0) return console.log('  none in this window');
        printTable(
            ['Place', 'Variant', 'Player', 'Tournament'],
            rows.map((r) => [
                r.placing === null ? 'drop' : ordinal(r.placing) + '/' + (r.fieldSize ?? '?'),
                truncate(r.deckName ?? '—', 20),
                truncate(r.displayName ?? r.player, 18),
                truncate(r.tournamentName, 34),
            ]),
        );
        return;
    }

    const { total, cards } = store.archetypeAverageDecklist(deckIds, { since });
    if (total === 0) return console.log(`
No decklists in the last ${days} days.`);

    console.log(`
Average decklist — ${total.toLocaleString()} decklists, last ${days} days
`);
    for (const kind of ['pokemon', 'trainer', 'energy']) {
        const group = cards.filter((c) => c.kind === kind);
        if (group.length === 0) continue;
        const totalAvg = group.reduce((a, c) => a + c.average, 0);
        console.log(`${kind.toUpperCase()} (${totalAvg.toFixed(1)})`);
        for (const c of group.slice(0, num(opts.limit, 20))) {
            console.log(`  ${c.average.toFixed(2).padStart(5)}  ${truncate(c.name, 30).padEnd(30)}`
                + ` ${(c.setCode + '-' + c.number).padEnd(9)} ${(c.inclusion * 100).toFixed(0)}% of lists`);
        }
        console.log();
    }
}

async function cmdPrints() {
    const before = store.printStats();
    const todo = store.cardsWithoutPrints(-1).length;
    if (todo === 0) {
        console.log(`All ${before.cards.toLocaleString()} cards resolved into `
            + `${before.groups.toLocaleString()} distinct cards.`);
        return;
    }

    const deadline = opts['max-minutes']
        ? Date.now() + Number(opts['max-minutes']) * 60_000
        : Infinity;

    console.log(`Looking up print groups for ${todo.toLocaleString()} cards on limitlesstcg.com`);
    console.log('Cached permanently — only cards never looked up are fetched.\n');

    const controller = new AbortController();
    process.on('SIGINT', () => {
        console.log('\n\nStopping — progress is saved, re-run to continue.');
        controller.abort();
    });

    const r = await fetchPrintGroups(store, {
        limit: num(opts.limit, Infinity),
        deadline,
        signal: controller.signal,
        onProgress: ({ done, total, card, prints }) => {
            const line = `  [${String(done).padStart(5)}/${total}] ${card.padEnd(10)} ${prints} print${prints === 1 ? '' : 's'}`;
            if (process.stdout.isTTY) process.stdout.write(`\r${line.padEnd(70)}`);
            else console.log(line);
        },
    });
    if (process.stdout.isTTY) process.stdout.write('\n');

    const after = store.printStats();
    console.log(`\nLooked up ${r.done}${r.failed ? ` (${r.failed} unreadable)` : ''}.`);
    console.log(`${after.looked_up.toLocaleString()} of ${after.cards.toLocaleString()} `
        + `printings resolved, into ${after.groups.toLocaleString()} distinct cards.`);
    const left = store.cardsWithoutPrints(-1).length;
    if (left) console.log(`${left.toLocaleString()} still to look up — re-run to continue.`);
}

function cmdReindex() {
    const t = Date.now();
    process.stdout.write('Rebuilding the card index from stored decklists... ');
    store.reindexCards();
    const s = store.cardIndexStats();
    console.log(`done in ${humanDuration(Date.now() - t)}`);
    console.log(`${s.cards.toLocaleString()} distinct cards, ${s.plays.toLocaleString()} card-in-deck rows`);
}

function cmdCard(term) {
    if (!term) return fail('Usage: card <name or SET-NUM>');

    // Accept an exact id, otherwise search by name and take the most-played match.
    let card = /^[A-Za-z0-9]+-[A-Za-z0-9]+$/.test(term) ? store.getCard(term) : null;
    if (!card) {
        const hits = store.searchCards(term, 10);
        if (hits.length === 0) return console.log(`No card matching "${term}".`);
        if (hits.length > 1 && hits[0].name.toLowerCase() !== term.toLowerCase()) {
            console.log(`
Several cards match "${term}":
`);
            printTable(
                ['Card', 'Name', 'Kind', 'Decks'],
                hits.map((h) => [h.id, truncate(h.name, 34), h.kind, h.decks.toLocaleString()]),
            );
            console.log(`
Pick one: card ${hits[0].id}`);
            return;
        }
        card = hits[0];
    }

    const limit = num(opts.limit, 25);
    // Default view is the most recent event only, which is what the card page shows;
    // --all walks back through everything the index holds.
    const shown = opts.all
        ? store.getCardResults(card.id, { limit })
        : store.getCardLatestEvent(card.id);
    if (shown.length === 0) return console.log(`No decklists recorded for ${card.id}.`);

    console.log(`
${card.name}  (${card.setCode}-${card.number}, ${card.kind})`);
    console.log(`in ${card.decks.toLocaleString()} decklists`);
    console.log(opts.all
        ? `
Latest ${Math.min(shown.length, limit)} results`
        : `
Decklists that include this card — ${shown[0].tournamentName}`);
    console.log();

    printTable(
        ['Place', 'Deck', 'Player', 'Copies'].concat(opts.all ? ['Tournament'] : []),
        shown.slice(0, limit).map((r) => [
            r.placing === null ? 'drop' : ordinal(r.placing),
            truncate(r.deckName ?? '—', 22),
            truncate(r.displayName ?? r.player, 20),
            String(r.count),
        ].concat(opts.all ? [truncate(r.tournamentName, 34)] : [])),
    );

    if (!opts.all && card.decks > shown.length) {
        console.log(`
${(card.decks - shown.length).toLocaleString()} more across earlier events: card ${card.id} --all`);
    }
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
