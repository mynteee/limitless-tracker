import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { indexKeys, shard } from './search.js';
import { groupArchetypes } from './archetypes.js';

/**
 * Publishing the card and archetype pages.
 *
 * Both are projections of the card index. Nothing here touches the network, and the
 * site answers every question from these files.
 */

/** Windows offered on an archetype page. 0 means all time. */
export const WINDOWS = [30, 90, 0];

/**
 * Results embedded directly in a card page, for the view it opens on.
 *
 * The complete history lives in packed sidecar pages instead — see HISTORY_PAGE_SIZE.
 * Only the newest event of these is shown initially, so this only has to be deep
 * enough to cover one event's worth of entrants.
 */
const CARD_RESULT_LIMIT = 150;

/**
 * Rows per page of a card's full history.
 *
 * Nothing is truncated any more, but a card can be extremely common - Boss's Orders
 * appears in 97,983 decklists - so the history is paged rather than shipped as one
 * file. Pages are packed against the shared tournament and deck dictionaries, which
 * takes a row from roughly 150 bytes of repeated event names down to about 30.
 */
const HISTORY_PAGE_SIZE = 2000;

/** Placements kept per archetype page. */
const ARCHETYPE_RESULT_LIMIT = 120;

/**
 * How far back custom date ranges reach.
 *
 * Custom ranges need day-level buckets, which grow with the archive rather than staying
 * fixed like the precomputed windows. Bounding them keeps the biggest archetype's file
 * a megabyte or so however deep the backfill goes, and any range older than this is
 * still covered by the all-time window.
 */
export const CUSTOM_RANGE_DAYS = 400;

/**
 * Every variant gets its own averages, however thin the sample. A five-deck variant
 * still describes those five decks accurately, and the page shows the count alongside
 * so a small sample is visible rather than silently swapped for the whole archetype.
 */
const VARIANT_AVERAGE_MIN = 1;

const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value));

function sinceFor(days) {
    return days === 0 ? null : new Date(Date.now() - days * 86_400_000).toISOString();
}

/**
 * @param {import('../db/queries.js').Store} store
 * @param {object} opts
 * @param {string} opts.dataDir
 * @param {Map<string, object[]>} opts.searchIndex shared with the player build
 * @param {(iconsJson: string|null) => string[]} opts.deckIcons parses and records icon sources
 */
export function buildCards(store, { dataDir, searchIndex, deckIcons, onProgress = () => {} }) {
    const cards = store.allCards();
    mkdirSync(join(dataDir, 'cards'), { recursive: true });

    // Dictionaries the packed history references by index. Written once and shared by
    // every card page, so an event name is stored once rather than on each of the tens
    // of thousands of rows that mention it.
    const tournaments = store.publishedTournaments();
    const tIndex = new Map(tournaments.map((t, i) => [t.id, i]));
    writeJson(
        join(dataDir, 'tournaments.json'),
        tournaments.map((t) => [t.id, t.name, t.date.slice(0, 10), t.players]),
    );

    const deckMeta = store.allDeckMeta();
    const dIndex = new Map(deckMeta.map((d, i) => [d.id, i]));
    writeJson(
        join(dataDir, 'decks.json'),
        deckMeta.map((d) => [d.id, d.name, deckIcons(d.icons)]),
    );

    // Shared dictionary, so archetype averages can reference a card by id instead of
    // repeating its name and set in every window of every archetype.
    writeJson(
        join(dataDir, 'cards.json'),
        Object.fromEntries(cards.map((c) => [c.id, [c.name, c.kind, c.setCode, c.number]])),
    );

    // One page per card, not per printing. Mystery Garden MEG-122 and ASC-194 are the
    // same card and share a page; the ten different Charcadets do not, because they are
    // ten different cards that merely share a name. `card_print` holds that distinction,
    // scraped from Limitless. A card never looked up falls back to being its own group,
    // so an incomplete scrape splits pages rather than merging the wrong ones.
    /** @type {Map<string, typeof cards>} */
    const groups = new Map();
    for (const card of cards) {
        if (card.decks === 0) continue;
        const groupId = store.printGroupOf(card.id) ?? card.id;
        if (!groups.has(groupId)) groups.set(groupId, []);
        groups.get(groupId).push(card);
    }

    const made = new Set();
    const dirFor = (id) => {
        const dir = join(dataDir, 'cards', shard(id.toLowerCase()));
        if (!made.has(dir)) { mkdirSync(dir, { recursive: true }); made.add(dir); }
        return dir;
    };

    let bytes = 0;
    let historyBytes = 0;
    let written = 0;
    let merged = 0;

    for (const prints of groups.values()) {
        // Most-played printing names the page: it is the one people recognise, and it
        // keeps the URL on the print that actually sees play.
        prints.sort((a, b) => b.decks - a.decks || a.id.localeCompare(b.id));
        const primary = prints[0];
        const ids = prints.map((c) => c.id);

        // -1 is SQLite's "no limit": the whole history, however long.
        const rows = store.getGroupResults(ids, { limit: -1 });
        if (rows.length === 0) continue;
        const decks = store.countGroupDecks(ids);
        const historyPages = Math.ceil(rows.length / HISTORY_PAGE_SIZE);

        const payload = {
            id: primary.id,
            name: primary.name,
            setCode: primary.setCode,
            number: primary.number,
            kind: primary.kind,
            decks,
            // Every printing on this page, so it can say where else the card appears.
            prints: prints.map((c) => ({
                id: c.id, setCode: c.setCode, number: c.number, decks: c.decks,
            })),
            // The site shows this event on its own first, then the rest on request.
            latestTournament: rows[0].tournamentId,
            // Complete, not truncated: how many pages of packed history sit beside this.
            historyPages,
            historyPageSize: HISTORY_PAGE_SIZE,
            results: rows.slice(0, CARD_RESULT_LIMIT).map((r) => ({
                tournamentId: r.tournamentId,
                tournament: r.tournamentName,
                date: r.date.slice(0, 10),
                fieldSize: r.fieldSize,
                placing: r.placing,
                handle: r.player,
                name: r.displayName ?? r.player,
                deck: r.deckId
                    ? { id: r.deckId, name: r.deckName, icons: deckIcons(r.deckIcons) }
                    : null,
                count: r.count,
            })),
        };

        const json = JSON.stringify(payload);
        writeFileSync(join(dirFor(primary.id), `${primary.id}.json`), json);
        bytes += json.length;
        written++;

        // Packed history pages: [tournamentIndex, placing, handle, deckIndex, copies].
        // A null placing means the player was unplaced, and stays null rather than
        // becoming a zero.
        for (let page = 0; page < historyPages; page++) {
            const slice = rows.slice(page * HISTORY_PAGE_SIZE, (page + 1) * HISTORY_PAGE_SIZE);
            const packed = slice.map((r) => [
                tIndex.get(r.tournamentId) ?? -1,
                r.placing,
                r.player,
                r.deckId !== null ? (dIndex.get(r.deckId) ?? -1) : -1,
                r.count,
            ]);
            const pageJson = JSON.stringify(packed);
            writeFileSync(join(dirFor(primary.id), `${primary.id}.h${page}.json`), pageJson);
            historyBytes += pageJson.length;
        }
        if (prints.length > 1) merged += prints.length - 1;

        // Other printings resolve to the page rather than 404ing, so a link to any
        // printing still works.
        for (const other of prints.slice(1)) {
            const stub = JSON.stringify({ alias: primary.id });
            writeFileSync(join(dirFor(other.id), `${other.id}.json`), stub);
            bytes += stub.length;
        }

        const entry = {
            handle: primary.id, name: primary.name, type: 'card',
            events: decks, last: rows[0].date.slice(0, 10),
        };
        if (prints.length > 1) entry.prints = prints.length;
        // Findable by name and by ANY of its printing codes, all pointing at one page.
        for (const key of indexKeys(primary.id.toLowerCase(), [primary.name, ...ids])) {
            if (!searchIndex.has(key)) searchIndex.set(key, []);
            searchIndex.get(key).push(entry);
        }

        if (written % 250 === 0) onProgress({ type: 'cards', written, total: groups.size });
    }

    return { cards: written, mergedPrints: merged, bytes: bytes + historyBytes, historyBytes };
}

/**
 * @param {import('../db/queries.js').Store} store
 */
export function buildArchetypes(store, {
    dataDir, searchIndex, deckIcons, overrides = {}, onProgress = () => {},
}) {
    const archetypes = groupArchetypes(store.allDecks(), overrides);
    mkdirSync(join(dataDir, 'archetypes'), { recursive: true });

    // One database pass per window rather than one per archetype: variants are summed
    // into their base here instead.
    /** @type {Map<number, {byDeck: Map<string, Map<string, {copies, decksWith}>>, counts: Map<string, number>}>} */
    const windows = new Map();
    for (const days of WINDOWS) {
        const { totals, counts } = store.deckCardTotals(sinceFor(days));
        const byDeck = new Map();
        for (const row of totals) {
            let cards = byDeck.get(row.deckId);
            if (!cards) { cards = new Map(); byDeck.set(row.deckId, cards); }
            cards.set(row.cardId, { copies: row.copies, decksWith: row.decksWith });
        }
        windows.set(days, { byDeck, counts: new Map(counts.map((c) => [c.deckId, c.decks])) });
        onProgress({ type: 'window', days, decks: byDeck.size });
    }

    /** Sum a set of deck ids into one average decklist for a window. */
    function averageFor(deckIds, days) {
        const { byDeck, counts } = windows.get(days);
        const total = deckIds.reduce((a, id) => a + (counts.get(id) ?? 0), 0);
        if (total === 0) return null;

        /** @type {Map<string, {copies: number, decksWith: number}>} */
        const merged = new Map();
        for (const id of deckIds) {
            for (const [cardId, v] of byDeck.get(id) ?? []) {
                const cur = merged.get(cardId);
                if (cur) { cur.copies += v.copies; cur.decksWith += v.decksWith; }
                else merged.set(cardId, { copies: v.copies, decksWith: v.decksWith });
            }
        }

        const cards = [...merged.entries()]
            .map(([cardId, v]) => [
                cardId,
                // Averaged over every deck in the window, including those running none
                // of the card — that is what produces the 0.02 entries.
                Math.round((v.copies / total) * 100) / 100,
                Math.round((v.decksWith / total) * 100) / 100,
            ])
            .sort((a, b) => b[1] - a[1]);

        return { total, cards };
    }

    // Day buckets for custom ranges, published beside the pages and fetched only when
    // someone actually picks a custom range.
    const customSince = sinceFor(CUSTOM_RANGE_DAYS);
    const daily = store.deckCardDaily(customSince);
    /** deckId -> day -> Map(cardId -> {copies, decksWith}) */
    const dailyByDeck = new Map();
    for (const row of daily.totals) {
        let days = dailyByDeck.get(row.deckId);
        if (!days) { days = new Map(); dailyByDeck.set(row.deckId, days); }
        let cards = days.get(row.day);
        if (!cards) { cards = new Map(); days.set(row.day, cards); }
        cards.set(row.cardId, { copies: row.copies, decksWith: row.decksWith });
    }
    /** deckId -> day -> decklist count */
    const dailyCounts = new Map();
    for (const row of daily.counts) {
        let days = dailyCounts.get(row.deckId);
        if (!days) { days = new Map(); dailyCounts.set(row.deckId, days); }
        days.set(row.day, row.decks);
    }

    const list = [];
    let bytes = 0;
    let dailyBytes = 0;

    for (const arch of archetypes) {
        const variantIds = arch.variants.map((v) => v.deckId);
        const results = store.archetypeResults(variantIds, { limit: ARCHETYPE_RESULT_LIMIT });

        const averages = {};
        for (const days of WINDOWS) {
            const entry = {};
            const base = averageFor(variantIds, days);
            if (base) entry.all = base;

            // Per-variant averages power the variant filter without another fetch.
            for (const v of arch.variants) {
                if (arch.variants.length === 1) continue;
                const avg = averageFor([v.deckId], days);
                if (avg) entry[v.deckId] = avg;
            }
            if (Object.keys(entry).length) averages[days] = entry;
        }

        const payload = {
            id: arch.id,
            name: arch.name,
            icons: arch.icons,
            decks: arch.decks,
            variants: arch.variants.map((v) => ({
                id: v.deckId,
                name: v.deckName,
                icons: deckIcons(JSON.stringify(v.icons)),
                decks: v.decks,
                hasAverage: arch.variants.length > 1,
            })),
            windows: WINDOWS,
            averages,
            results: results.map((r) => ({
                tournamentId: r.tournamentId,
                tournament: r.tournamentName,
                date: r.date.slice(0, 10),
                fieldSize: r.fieldSize,
                placing: r.placing,
                handle: r.player,
                name: r.displayName ?? r.player,
                variant: r.deckId,
                variantName: r.deckName,
                icons: deckIcons(r.deckIcons),
            })),
        };

        const json = JSON.stringify(payload);
        writeFileSync(join(dataDir, 'archetypes', `${arch.id}.json`), json);
        bytes += json.length;

        // Sidecar of day buckets, keyed by variant then day. Card ids are indices into
        // a per-file dictionary, which is most of why this stays small.
        const dict = [];
        const idx = new Map();
        const indexOf = (cardId) => {
            let i = idx.get(cardId);
            if (i === undefined) { i = dict.length; idx.set(cardId, i); dict.push(cardId); }
            return i;
        };
        const perVariant = {};
        for (const v of arch.variants) {
            const days = dailyByDeck.get(v.deckId);
            if (!days) continue;
            const out = {};
            for (const [day, cards] of days) {
                const flat = [];
                for (const [cardId, t] of cards) flat.push(indexOf(cardId), t.copies, t.decksWith);
                out[day] = [dailyCounts.get(v.deckId)?.get(day) ?? 0, flat];
            }
            perVariant[v.deckId] = out;
        }
        if (Object.keys(perVariant).length) {
            const dailyJson = JSON.stringify({ cards: dict, days: CUSTOM_RANGE_DAYS, variants: perVariant });
            writeFileSync(join(dataDir, 'archetypes', `${arch.id}.days.json`), dailyJson);
            dailyBytes += dailyJson.length;
        }

        const lastSeen = arch.variants.reduce((m, v) => (v.lastSeen > m ? v.lastSeen : m), '');

        /** Decklists in each window, so the list can be scoped without another fetch. */
        const windowCounts = (deckIds) => Object.fromEntries(WINDOWS.map((days) => {
            const { counts } = windows.get(days);
            return [days, deckIds.reduce((a, id) => a + (counts.get(id) ?? 0), 0)];
        }));

        list.push({
            id: arch.id,
            name: arch.name,
            icons: arch.icons,
            decks: arch.decks,
            windows: windowCounts(variantIds),
            lastSeen: lastSeen.slice(0, 10),
            // Carried so the list can split into variants without fetching each page.
            variants: arch.variants.map((v) => ({
                id: v.deckId,
                name: v.deckName,
                icons: deckIcons(JSON.stringify(v.icons)),
                decks: v.decks,
                windows: windowCounts([v.deckId]),
                lastSeen: String(v.lastSeen ?? '').slice(0, 10),
            })),
        });

        const entry = {
            handle: arch.id, name: arch.name, type: 'deck',
            events: arch.decks, last: lastSeen.slice(0, 10),
        };
        const names = [arch.name, ...arch.variants.map((v) => v.deckName)].filter(Boolean);
        for (const key of indexKeys(arch.id, [...new Set(names)])) {
            if (!searchIndex.has(key)) searchIndex.set(key, []);
            searchIndex.get(key).push(entry);
        }
    }

    const listJson = JSON.stringify(list);
    writeFileSync(join(dataDir, 'archetypes.json'), listJson);

    // Daily decklist counts for the whole list, so its custom range needs one fetch
    // rather than one per archetype.
    const listDaily = {};
    for (const [deckId, days] of dailyCounts) listDaily[deckId] = Object.fromEntries(days);
    const listDailyJson = JSON.stringify({ days: CUSTOM_RANGE_DAYS, decks: listDaily });
    writeFileSync(join(dataDir, 'archetypes-days.json'), listDailyJson);

    return {
        archetypes: list.length,
        bytes: bytes + listJson.length + dailyBytes + listDailyJson.length,
        dailyBytes: dailyBytes + listDailyJson.length,
    };
}
