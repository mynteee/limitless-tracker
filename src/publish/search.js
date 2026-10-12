/**
 * Canonical search rules, shared by the build and the site.
 *
 * Plain ESM with no Node imports, so the browser can import this file directly and the
 * published site never re-derives (and subtly breaks) the matching rule.
 *
 * The published index is bucketed by a two-character key. A player is indexed under the
 * key of their handle and of every word of every display name they have used, so the
 * bucket for what someone types is the only file the site needs to fetch.
 */

/** Bucket key for a term. Padded so single-character input still resolves. */
export function shard(term) {
    return `${String(term).toLowerCase()}__`.slice(0, 2);
}

/**
 * Every bucket key a player should be indexed under.
 *
 * Indexes every two-character substring, not just the leading pair, so a query can
 * match from the middle of a word: "essica" resolves to bucket "es" and finds
 * "Jessica". Indexing only prefixes would put that player in "je" alone, and the
 * bucket for what was typed would not contain them.
 *
 * Names are split into words first, so n-grams never straddle a space. A multi-word
 * query still works, because the bucket comes from the first two characters typed —
 * "von bak" looks in "vo", where the player is indexed via "von".
 */
export function indexKeys(handle, names = []) {
    const keys = new Set();

    const addGrams = (word) => {
        if (!word) return;
        // A one-character word has no bigram; index it under its padded shard so it is
        // still reachable, matching how `shard` resolves a one-character query.
        if (word.length < 2) {
            keys.add(shard(word));
            return;
        }
        for (let i = 0; i <= word.length - 2; i++) keys.add(word.slice(i, i + 2));
    };

    addGrams(String(handle).toLowerCase());
    for (const name of names) {
        if (!name) continue;
        for (const word of String(name).toLowerCase().split(/[^a-z0-9]+/)) addGrams(word);
    }
    return keys;
}

/**
 * Everything an index entry can be matched on, lowercased.
 *
 * This has to cover the same strings `indexKeys` was given, or an entry lands in the
 * bucket for what was typed and is then filtered straight back out of it. For a player
 * that is the handle and every display name they have used — a player who has changed
 * name is still found by an old one, which is the whole point of keying identity on the
 * handle. For a card it also covers the other printings, because one page answers for
 * all of them.
 */
export function entryTerms(entry) {
    return [
        entry.handle,
        // `names` is present only for players who have used more than one; `name` always is.
        ...(entry.names ?? [entry.name]),
        // Cards only: the printings that resolve to this same page.
        ...(entry.prints ?? []),
    ].filter(Boolean).map((n) => String(n).toLowerCase());
}

/**
 * Does an index entry match what was typed?
 *
 * Case-folded on both sides. A card id is published upper-case while a query is
 * lowered before it gets here, so comparing them raw silently matched nothing —
 * which took out every search by set code, the card box's own example included.
 */
export function matchesEntry(entry, term) {
    const t = String(term).toLowerCase().trim();
    if (!t) return false;
    return entryTerms(entry).some((n) => n.includes(t));
}

/**
 * Search the published index.
 *
 * @param {(path: string) => Promise<Array|null>} fetchBucket loads data/search/<key>.json,
 *   resolving to null when the bucket does not exist
 * @param {string} term
 */
export async function searchIndex(fetchBucket, term) {
    const t = String(term).toLowerCase().trim();
    if (!t) return [];
    const bucket = await fetchBucket(shard(t));
    if (!bucket) return [];
    return bucket.filter((entry) => matchesEntry(entry, t));
}
