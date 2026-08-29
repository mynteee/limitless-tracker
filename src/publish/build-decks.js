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
 * A variant gets its own averages only above this many decklists. Below it the sample
 * is too thin to mean much, and every extra variant multiplies the page by a window.
 */
const VARIANT_AVERAGE_MIN = 100;

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

    const made = new Set();
    let bytes = 0;
    let written = 0;

    for (const card of cards) {
        if (card.decks === 0) continue;

        const rows = store.getCardResults(card.id, { limit: CARD_RESULT_LIMIT });
        if (rows.length === 0) continue;

        const pp = shard(card.id.toLowerCase());
        const dir = join(dataDir, 'cards', pp);
        if (!made.has(dir)) { mkdirSync(dir, { recursive: true }); made.add(dir); }

        const payload = {
            id: card.id,
            name: card.name,
            setCode: card.setCode,
            number: card.number,
            kind: card.kind,
            decks: card.decks,
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
        writeFileSync(join(dir, `${card.id}.json`), json);
        bytes += json.length;
        written++;

        const entry = { handle: card.id, name: card.name, type: 'card', events: card.decks, last: rows[0].date.slice(0, 10) };
        // Findable by the card name and by its set-number id.
        for (const key of indexKeys(card.id.toLowerCase(), [card.name])) {
            if (!searchIndex.has(key)) searchIndex.set(key, []);
            searchIndex.get(key).push(entry);
        }

        if (written % 250 === 0) onProgress({ type: 'cards', written, total: cards.length });
    }

    return { cards: written, bytes };
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
                if (v.decks < VARIANT_AVERAGE_MIN || arch.variants.length === 1) continue;
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
                hasAverage: v.decks >= VARIANT_AVERAGE_MIN && arch.variants.length > 1,
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
        list.push({
            id: arch.id,
            name: arch.name,
            icons: arch.icons,
            decks: arch.decks,
            variants: arch.variants.length,
            lastSeen: lastSeen.slice(0, 10),
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
