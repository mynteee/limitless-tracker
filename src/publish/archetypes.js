/**
 * Grouping deck ids into base archetypes.
 *
 * Limitless publishes its own archetype/variant rules at /games/{id}/decks, but that
 * is the one endpoint requiring an API key, so the grouping is derived here instead.
 *
 * The API gives each deck an id ("dragapult-dusknoir"), a name, and an icon list
 * (["dragapult","dusknoir"]). The first icon is reliably the core of the deck, so it
 * makes a good base: dragapult-ex, -dusknoir, -blaziken and six others all collapse
 * under "dragapult", which is how Limitless presents them.
 *
 * The heuristic is not perfect — basic-box-m leads with an Ogerpon icon despite not
 * really being an Ogerpon deck — so `overrides` takes precedence and is where those
 * get corrected by hand.
 *
 * Plain ESM with no Node imports, so the site can import it directly.
 */

/** @typedef {{id: string, name: string, icons: string[]}} Deck */

/**
 * Base archetype id for a deck.
 * @param {string} deckId
 * @param {string[]} icons
 * @param {Record<string,string>} overrides deckId -> base id
 */
export function baseArchetype(deckId, icons = [], overrides = {}) {
    if (Object.hasOwn(overrides, deckId)) return overrides[deckId];
    return icons[0] ?? deckId;
}

/** Title-case a slug: "raging-bolt" -> "Raging Bolt". */
export function titleize(slug) {
    return String(slug)
        .split('-')
        .filter(Boolean)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
}

/**
 * Collapse deck rows into base archetypes.
 *
 * @param {Array<{deckId: string, deckName: string, icons: string[], decks: number}>} rows
 * @param {{decks?: Record<string,string>, names?: Record<string,string>}} [overrides]
 *   `decks` moves a deck id under a different base; `names` renames a base.
 * @returns {Array<{id, name, icons, decks, variants}>} sorted by popularity
 */
export function groupArchetypes(rows, overrides = {}) {
    const deckOverrides = overrides.decks ?? {};
    const nameOverrides = overrides.names ?? {};
    /** @type {Map<string, any>} */
    const bases = new Map();

    for (const row of rows) {
        const id = baseArchetype(row.deckId, row.icons, deckOverrides);
        let base = bases.get(id);
        if (!base) {
            base = { id, name: null, icons: [], decks: 0, variants: [] };
            bases.set(id, base);
        }
        base.decks += row.decks;
        base.variants.push(row);
    }

    for (const base of bases.values()) {
        base.variants.sort((a, b) => b.decks - a.decks);

        // The most generic member names the group: a deck carrying a single icon is
        // the archetype itself ("Dragapult") rather than one of its pairings.
        //
        // Where no such member exists the most played variant names it instead, which
        // beats titling the slug — the only deck leading with a Dipplin icon is
        // "Festival Lead", and calling that group "Dipplin" would name it after a card
        // nobody uses for it. The slug is the last resort.
        const generic = base.variants.find((v) => v.icons.length === 1);
        const fallback = base.variants[0];
        base.name = nameOverrides[base.id]
            ?? generic?.deckName
            ?? fallback?.deckName
            ?? titleize(base.id);
        base.icons = generic?.icons ?? fallback?.icons ?? [base.id];
    }

    return [...bases.values()].sort((a, b) => b.decks - a.decks);
}
