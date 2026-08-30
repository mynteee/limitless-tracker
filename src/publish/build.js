import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { indexKeys, shard } from './search.js';
import { buildCards, buildArchetypes } from './build-decks.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Project the SQLite store into static JSON for GitHub Pages.
 *
 * The published site makes zero API calls: a visitor's request must never reach
 * Limitless, because the 50-requests-per-5-minutes budget is shared across everyone.
 * So every question the site can answer is precomputed here.
 *
 * Layout:
 *   data/meta.json                     build info and coverage
 *   data/search/<pp>.json              prefix index over handles and display names
 *   data/players/<pp>/<handle>.json    placements and archetypes  (~336 B typical)
 *   data/decks/<pp>/<handle>.json      full decklists, loaded on demand
 *
 * Placements and decklists are split because decklists are 93% of a player's payload.
 * A player page therefore loads in a fraction of a kilobyte, and the lists are fetched
 * only if the visitor actually opens one.
 */

/** Handles observed are strictly [0-9_a-z]. Anything else would be unsafe as a path. */
const SAFE_HANDLE = /^[a-z0-9_-]+$/;

/** The hand-maintained archetype corrections, if present. */
function archetypeOverrides() {
    try {
        return JSON.parse(readFileSync(join(here, "data", "archetype-overrides.json"), 'utf8'));
    } catch {
        return {};
    }
}

function writeJson(path, value) {
    writeFileSync(path, JSON.stringify(value));
}

/** Parse a deck's icon list. Every sprite comes from Limitless, so there is nothing
 *  to record about where each one lives. */
function deckIcons(raw) {
    const icons = JSON.parse(raw ?? 'null');
    return Array.isArray(icons) ? icons : null;
}

/**
 * Put a page at the site root.
 *
 * If a `site/` directory exists it is copied verbatim — that is where the real UI will
 * live. Otherwise this writes a placeholder that reads meta.json, which is enough to
 * confirm a deploy actually served the data. Phase 4 replaces it.
 */
function writeSiteShell(outDir, meta) {
    if (existsSync('site')) {
        cpSync('site', outDir, { recursive: true });
        // The site imports the same matching rules the index was built with, rather
        // than reimplementing them and drifting out of sync.
        cpSync(join(here, 'search.js'), join(outDir, 'search.js'));
        return;
    }
    if (existsSync(join(outDir, 'index.html'))) return;

    // No template literals inside: this string is itself a template literal.
    const html = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>limitless tracker</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.5 system-ui, sans-serif; max-width: 42rem; margin: 4rem auto; padding: 0 1.5rem; }
  h1 { font-size: 1.4rem; margin-bottom: .25rem; }
  dl { display: grid; grid-template-columns: auto 1fr; gap: .35rem 1.5rem; }
  dt { opacity: .65; }
  dd { margin: 0; font-variant-numeric: tabular-nums; }
  .note { opacity: .6; font-size: .875rem; margin-top: 2.5rem; }
  code { background: color-mix(in srgb, currentColor 12%, transparent); padding: .1em .35em; border-radius: 3px; }
</style>
<h1>limitless tracker</h1>
<p>Tournament data is published and queryable. The interface is not built yet.</p>
<dl id="meta"></dl>
<p class="note">Placeholder page. Data lives under <code>/data</code>.</p>
<script>
fetch('data/meta.json').then(function (r) { return r.json(); }).then(function (m) {
  var rows = [
    ['Tournaments', m.counts.tournaments.toLocaleString()],
    ['Players', m.counts.players.toLocaleString()],
    ['Standings', m.counts.standings.toLocaleString()],
    ['Decklists', m.counts.decklists.toLocaleString()],
    ['Coverage', m.coverage.from.slice(0, 10) + ' to ' + m.coverage.to.slice(0, 10)],
    ['Updated', new Date(m.generated).toLocaleString()]
  ];
  document.getElementById('meta').innerHTML = rows.map(function (r) {
    return '<dt>' + r[0] + '</dt><dd>' + r[1] + '</dd>';
  }).join('');
}).catch(function (e) {
  document.getElementById('meta').textContent = 'Could not load data/meta.json: ' + e.message;
});
</script>
`;
    writeFileSync(join(outDir, 'index.html'), html);
}

/**
 * @param {import('../db/queries.js').Store} store
 * @param {{outDir?: string, decklistMonths?: number|null, onProgress?: Function}} [opts]
 */
export function build(store, { outDir = 'dist', decklistMonths = null, onProgress = () => {} } = {}) {
    const dataDir = join(outDir, 'data');

    // Card pages and every archetype average are read out of the card index, so it has
    // to cover the whole corpus before anything is written. A partial index does not
    // fail loudly — it publishes averages computed from a fraction of the decks, which
    // look plausible but are wrong by whatever fraction is missing. Repairing here means
    // a database that predates the index (the scheduled crawl's, for one) fixes itself
    // on the next build rather than shipping bad numbers.
    const repaired = store.repairCardIndex((p) => onProgress({ type: 'repair', ...p }));
    if (repaired > 0) onProgress({ type: 'repaired', tournaments: repaired });

    // Wipe only the generated subtrees, so a pruned or renamed player cannot leave a
    // stale file behind that the site would still happily serve.
    for (const sub of ['players', 'decks', 'search', 'cards', 'archetypes']) {
        rmSync(join(dataDir, sub), { recursive: true, force: true });
    }
    mkdirSync(dataDir, { recursive: true });

    // Decklists older than this are omitted from the published output. The database
    // still has them — this only bounds what ships, for the 1 GB Pages site limit.
    const decklistCutoff = decklistMonths
        ? new Date(Date.now() - decklistMonths * 30 * 24 * 3600 * 1000).toISOString()
        : null;

    const players = store.allPlayers();
    /** @type {Map<string, Array<object>>} */
    const searchIndex = new Map();
    const madeDirs = new Set();

    let written = 0;
    let skipped = 0;
    let listsWritten = 0;
    let bytesPlayers = 0;
    let bytesDecks = 0;

    for (const { handle } of players) {
        if (!SAFE_HANDLE.test(handle)) {
            // Never turn an unexpected handle into a path. Skip loudly rather than
            // risk writing outside the output directory.
            skipped++;
            onProgress({ type: 'unsafe', handle });
            continue;
        }

        const rows = store.getPlayerHistoryFull(handle);
        if (rows.length === 0) continue;

        const pp = shard(handle);
        for (const sub of ['players', 'decks']) {
            const dir = join(dataDir, sub, pp);
            if (!madeDirs.has(dir)) { mkdirSync(dir, { recursive: true }); madeDirs.add(dir); }
        }

        const totals = rows.reduce(
            (a, r) => ({
                wins: a.wins + (r.wins ?? 0),
                losses: a.losses + (r.losses ?? 0),
                ties: a.ties + (r.ties ?? 0),
            }),
            { wins: 0, losses: 0, ties: 0 },
        );
        const placings = rows.filter((r) => r.placing !== null).map((r) => r.placing);

        const lists = {};
        const history = rows.map((r) => {
            // A decklist is published only if it exists and falls inside the window.
            const include = r.decklist && (!decklistCutoff || r.date >= decklistCutoff);
            if (include) lists[r.tournamentId] = JSON.parse(r.decklist);
            return {
                tournamentId: r.tournamentId,
                tournament: r.tournamentName,
                date: r.date,
                game: r.game,
                format: r.format,
                fieldSize: r.fieldSize,
                // Null placing means the player was unplaced, usually after dropping.
                // It is not a zero and must not be rendered as one.
                placing: r.placing,
                wins: r.wins,
                losses: r.losses,
                ties: r.ties,
                dropRound: r.dropRound,
                deck: r.deckId
                    ? { id: r.deckId, name: r.deckName, icons: deckIcons(r.deckIcons) }
                    : null,
                hasList: Boolean(include),
            };
        });

        // Names change between events; the most recent one is the display name, but all
        // of them stay searchable.
        const names = [...new Set(rows.map((r) => r.displayName).filter(Boolean))];

        const player = {
            handle,
            name: names[0] ?? handle,
            // Every name this handle has used, most recent first. The site shows the
            // older ones so a visitor who searched an outdated name can see they landed
            // on the right player.
            names,
            country: rows.find((r) => r.country)?.country ?? null,
            events: rows.length,
            record: totals,
            best: placings.length ? Math.min(...placings) : null,
            drops: rows.filter((r) => r.dropRound !== null).length,
            history,
        };

        const playerJson = JSON.stringify(player);
        writeFileSync(join(dataDir, 'players', pp, `${handle}.json`), playerJson);
        bytesPlayers += playerJson.length;

        const listCount = Object.keys(lists).length;
        if (listCount > 0) {
            const decksJson = JSON.stringify({ handle, lists });
            writeFileSync(join(dataDir, 'decks', pp, `${handle}.json`), decksJson);
            bytesDecks += decksJson.length;
            listsWritten += listCount;
        }

        const entry = {
            handle,
            name: player.name,
            events: rows.length,
            last: rows[0].date.slice(0, 10),
        };
        // The older names must travel with the entry, not just decide which buckets it
        // lands in. A client filtering on `name` alone would drop a player found via an
        // outdated name: the entry is in the right bucket, but nothing in it matches
        // what was typed. Only carried when there is more than one, so the index does
        // not pay for the ~92% of players who have never changed name.
        if (names.length > 1) entry.names = names;
        for (const key of indexKeys(handle, names)) {
            if (!searchIndex.has(key)) searchIndex.set(key, []);
            searchIndex.get(key).push(entry);
        }

        written++;
        if (written % 500 === 0) onProgress({ type: 'players', written, total: players.length });
    }

    // Both add their own entries to the shared search index, so this has to happen
    // before it is written out.
    const icons = (raw) => deckIcons(raw);
    const cardsBuilt = buildCards(store, { dataDir, searchIndex, deckIcons: icons, onProgress });
    const archesBuilt = buildArchetypes(store, {
        dataDir, searchIndex, deckIcons: icons, overrides: archetypeOverrides(), onProgress,
    });

    mkdirSync(join(dataDir, 'search'), { recursive: true });
    let bytesSearch = 0;
    for (const [key, entries] of searchIndex) {
        // Most-active first, so a truncated autocomplete list still shows the players
        // someone is most likely looking for.
        // Players first, then archetypes, then cards: a bare name is nearly always a
        // player, and a truncated list should not bury them under card matches.
        const rank = (e) => (e.type === 'card' ? 2 : e.type === 'deck' ? 1 : 0);
        entries.sort((a, b) =>
            rank(a) - rank(b) || b.events - a.events || a.handle.localeCompare(b.handle));
        const json = JSON.stringify(entries);
        writeFileSync(join(dataDir, 'search', `${key}.json`), json);
        bytesSearch += json.length;
    }


    const cov = store.coverage();
    const stats = store.stats();
    const meta = {
        generated: new Date().toISOString(),
        coverage: { from: cov.from, to: cov.to },
        gamesFormats: cov.gamesFormats,
        counts: {
            tournaments: stats.eventsWithData,
            players: written,
            standings: stats.standings,
            decklists: listsWritten,
            cards: cardsBuilt.cards,
            archetypes: archesBuilt.archetypes,
        },
        decklistWindowMonths: decklistMonths,
        shardPrefixLength: 2,
    };
    writeJson(join(dataDir, 'meta.json'), meta);
    writeSiteShell(outDir, meta);

    return {
        players: written,
        skipped,
        searchBuckets: searchIndex.size,
        listsWritten,
        cards: cardsBuilt.cards,
        archetypes: archesBuilt.archetypes,
        bytes: {
            players: bytesPlayers,
            decks: bytesDecks,
            search: bytesSearch,
            cards: cardsBuilt.bytes,
            archetypes: archesBuilt.bytes,
            total: bytesPlayers + bytesDecks + bytesSearch + cardsBuilt.bytes + archesBuilt.bytes,
        },
        meta,
    };
}
