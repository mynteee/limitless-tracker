/**
 * Which printing the site shows for each card.
 *
 * `prints` groups reprints into one card, but a group still needs one face: the set
 * code, number and art that its page, the archetype averages and every decklist show.
 * That face is the print current tournaments list. Limitless writes each new decklist
 * with whichever print it currently treats as the card's standard one, and moves that
 * to a reprint some time after release — Energy Switch went from SVI-173 to MEG-115 —
 * so following the newest results keeps every card on the print players see today,
 * with nothing to maintain by hand when the next set comes out.
 *
 * "Newest set" is the obvious rule and the wrong one. Limitless has a page for a print
 * before any event lists it (Energy Switch PBL-107), and some reprints are never
 * adopted: a week of events in February listed Lillie's Determination as ASC-192, and
 * every event since has gone back to MEG-119.
 *
 * Only what is published changes. The database keeps every decklist exactly as it was
 * submitted, so this is recomputed from scratch on every build.
 */

/**
 * How much of a card's recent history decides its print. Long enough that one odd
 * event cannot flip it, short enough that a switch shows up within a couple of weeks.
 * Measured back from the card's own newest result, so a card that rotated out years
 * ago is judged on its last fortnight of play rather than on nothing.
 */
export const CURRENT_WINDOW_DAYS = 14;

/**
 * @param {import('../db/queries.js').Store} store
 * @returns {Map<string, {id: string, setCode: string, number: string, name: string}>}
 *   every card id to the print it is shown as, which for most cards is itself
 */
export function canonicalPrints(store, { windowDays = CURRENT_WINDOW_DAYS } = {}) {
    /** @type {Map<string, Array<{id, setCode, number, name}>>} */
    const groups = new Map();
    for (const { groupId, ...card } of store.cardGroups()) {
        if (!groups.has(groupId)) groups.set(groupId, []);
        groups.get(groupId).push(card);
    }

    const canon = new Map();
    for (const prints of groups.values()) {
        let pick = prints[0];
        if (prints.length > 1) {
            const usage = prints.map((card) => ({ card, last: store.lastPlayed(card.id) ?? '' }));
            const newest = usage.reduce((m, u) => (u.last > m ? u.last : m), '');
            const since = newest
                ? new Date(Date.parse(newest) - windowDays * 86_400_000).toISOString()
                : null;
            for (const u of usage) {
                u.recent = since && u.last >= since ? store.playsSince(u.card.id, since) : 0;
            }
            usage.sort((a, b) =>
                b.recent - a.recent || b.last.localeCompare(a.last) || a.card.id.localeCompare(b.card.id));
            pick = usage[0].card;
        }
        for (const card of prints) canon.set(card.id, pick);
    }
    return canon;
}

/**
 * A decklist with every card shown as its current print.
 *
 * Copies split across two printings collapse into one entry, where the first of them
 * appeared, so a list never shows the same card twice.
 *
 * @param {{pokemon?: object[], trainer?: object[], energy?: object[]}} list
 * @param {ReturnType<typeof canonicalPrints>} canon
 */
export function canonicalList(list, canon) {
    const out = {};
    for (const [section, entries] of Object.entries(list)) {
        if (!Array.isArray(entries)) { out[section] = entries; continue; }
        /** @type {Map<string, object>} */
        const merged = new Map();
        for (const entry of entries) {
            const id = `${entry.set}-${entry.number}`;
            const to = canon.get(id);
            const key = to?.id ?? id;
            const seen = merged.get(key);
            if (seen) seen.count += entry.count;
            else if (to) merged.set(key, { ...entry, set: to.setCode, number: to.number, name: to.name });
            else merged.set(key, { ...entry });
        }
        out[section] = [...merged.values()];
    }
    return out;
}
