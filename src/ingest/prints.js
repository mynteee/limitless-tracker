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
 * a new reprint appears, and only cards never looked up are fetched. That is also what
 * keeps reprints current — a new printing turns up in a decklist as a card id never
 * seen before, gets looked up, and its page names every older print, joining them all.
 */

const CARD_SITE = 'https://limitlesstcg.com/cards';

/** Deliberately gentle. Nothing here is urgent and the results are cached forever. */
const DEFAULT_DELAY_MS = 350;

/**
 * Failures in a row before giving up on the run. One bad page is a bad page; this many
 * means the site is down or refusing us, and carrying on would only hammer it.
 */
const MAX_CONSECUTIVE_FAILURES = 5;

/**
 * Pull the print list out of a card page.
 *
 * The prints table links every printing as /cards/SET/NUMBER, so collecting those hrefs
 * is enough — no HTML parser needed, and it degrades to "just this card" rather than
 * throwing if the markup changes.
 *
 * Only the international half of the table is read: the Japanese prints that follow it
 * live under /cards/jp/ and are not cards an English decklist can contain. Collector
 * "numbers" are not always numeric — older basic energy is printed as BRS G, SSH G — so
 * letters are accepted too, or every one of those would split off onto its own page.
 *
 * @returns {string[]} card ids in SET-NUMBER form, always including the card itself
 */
export function parsePrints(html, selfId) {
    const start = html.indexOf('card-prints-versions');
    let table = html;
    if (start !== -1) {
        const end = html.indexOf('JP. Prints', start);
        table = html.slice(start, end === -1 ? html.indexOf('</table>', start) : end);
    }

    const ids = new Set([selfId]);
    for (const m of table.matchAll(/href="\/cards\/([A-Za-z0-9]+)\/([A-Za-z0-9]+)"/g)) {
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
    let streak = 0;

    for (const card of pending) {
        if (signal?.aborted || Date.now() >= deadline) break;
        // Settled already by an earlier page in this run naming it as one of its prints.
        if (store.printGroupOf(card.id) !== null) continue;

        const url = `${CARD_SITE}/${card.setCode}/${card.number}`;
        let prints = null;
        try {
            const res = await fetch(url, {
                headers: { 'User-Agent': 'limitless-tracker/0.1' },
            });
            // Limitless has no page for this card, and never will: it is its own group.
            if (res.status === 404) prints = [card.id];
            else if (!res.ok) throw new Error(`HTTP ${res.status}`);
            else prints = parsePrints(await res.text(), card.id);
            streak = 0;
        } catch {
            // Anything else may be temporary, so it is left unrecorded and the next run
            // asks again. Caching it as its own group would split the card's page from
            // its other printings for good.
            failed++;
            streak++;
        }

        if (prints) {
            store.savePrintGroup(card.id, prints);
            done++;
        }
        onProgress({ done, failed, total: pending.length, card: card.id, prints: prints?.length ?? 0 });
        if (streak >= MAX_CONSECUTIVE_FAILURES) break;

        await sleep(delayMs);
    }

    return { done, failed, total: pending.length, gaveUp: streak >= MAX_CONSECUTIVE_FAILURES };
}
