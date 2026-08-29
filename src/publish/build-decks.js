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

/** Results kept per card page. The default view shows only the newest event of these. */
const CARD_RESULT_LIMIT = 150;

/** Placements kept per archetype page. */
const ARCHETYPE_RESULT_LIMIT = 120;

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
    let written = 0;
    let merged = 0;

    for (const prints of groups.values()) {
        // Most-played printing names the page: it is the one people recognise, and it
        // keeps the URL on the print that actually sees play.
        prints.sort((a, b) => b.decks - a.decks || a.id.localeCompare(b.id));
        const primary = prints[0];
        const ids = prints.map((c) => c.id);

        const rows = store.getGroupResults(ids, { limit: CARD_RESULT_LIMIT });
        if (rows.length === 0) continue;
        const decks = store.countGroupDecks(ids);

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
            results: rows.map((r) => ({
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

    return { cards: written, mergedPrints: merged, bytes };
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

    const list = [];
    let bytes = 0;

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

    return { archetypes: list.length, bytes: bytes + listJson.length };
}
