import { setTimeout as sleep } from 'node:timers/promises';

/**
 * Work out which card printings are the same card.
 *
 * The tournament API gives a decklist entry as `{count, set, number, name}` and nothing
 * more — no rules text, no card identity. So a name is all we have to go on, and a name
 * is not enough: this corpus holds ten different Charcadet cards that merely share a
 * name, alongside Mystery Garden MEG-122 and ASC-194 which really are one card printed
 * twice. Deciding from the name alone would merge the first group and split the second.
 *
 * Limitless already answers this. Each card page carries a "Prints" table listing every
 * printing of that exact card, so this reads their grouping rather than guessing at it.
 *
 * Different host from the tournament API and not rate-limit documented, so this paces
 * itself conservatively and caches permanently: a card's print group only changes when
 * a new reprint appears, and only cards never looked up are fetched.
 */

const CARD_SITE = 'https://limitlesstcg.com/cards';

/** Deliberately gentle. Nothing here is urgent and the results are cached forever. */
const DEFAULT_DELAY_MS = 350;

/**
 * Pull the print list out of a card page.
 *
 * The prints table links every printing as /cards/SET/NUMBER, so collecting those hrefs
 * is enough — no HTML parser needed, and it degrades to "just this card" rather than
 * throwing if the markup changes.
 *
 * @returns {string[]} card ids in SET-NUMBER form, always including the card itself
 */
export function parsePrints(html, selfId) {
    const ids = new Set([selfId]);
    for (const m of html.matchAll(/href="\/cards\/([A-Za-z0-9]+)\/(\d+)"/g)) {
        ids.add(`${m[1]}-${m[2]}`);
    }
    return [...ids].sort();
}

/**
 * Fetch print groups for every card that has not been looked up yet.
 *
 * @param {import('../db/queries.js').Store} store
 */
export async function fetchPrintGroups(store, {
    delayMs = DEFAULT_DELAY_MS,
    limit = Infinity,
    deadline = Infinity,
    onProgress = () => {},
    signal,
} = {}) {
    const pending = store.cardsWithoutPrints(limit === Infinity ? -1 : limit);
    let done = 0;
    let failed = 0;

    for (const card of pending) {
        if (signal?.aborted || Date.now() >= deadline) break;

        const url = `${CARD_SITE}/${card.setCode}/${card.number}`;
        let prints;
        try {
            const res = await fetch(url, {
                headers: { 'User-Agent': 'limitless-tracker/0.1' },
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            prints = parsePrints(await res.text(), card.id);
        } catch {
            // A card page that cannot be read is recorded as its own group so the run
            // makes progress; re-running `prints --refresh` retries it.
            prints = [card.id];
            failed++;
        }

        store.savePrintGroup(card.id, prints);
        done++;
        onProgress({ done, failed, total: pending.length, card: card.id, prints: prints.length });

        await sleep(delayMs);
    }

    return { done, failed, total: pending.length };
}
