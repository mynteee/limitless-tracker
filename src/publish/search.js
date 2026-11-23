/**
 * Canonical search rules, shared by the build and the site.
 *
 * Plain ESM with no Node imports, so the browser can import this file directly and the
 * published site never re-derives (and subtly breaks) the matching rule.
 *
 * The published index is bucketed by a two-character key. A player is indexed under the
 * key of every two-character run of their handle and of every display name they have
 * used, so the bucket for what someone types is the only file the site needs to fetch.
 *
 * Everything on both sides goes through `normalize` first, so what a name is punctuated
 * or accented like stops mattering: "lillies" finds "Lillie's Determination", "ho oh"
 * and "hooh" both find "Ho-Oh ex", "jose" finds "José", "meg114" finds "MEG-114".
 */

/**
 * Fold text to the form everything here compares on: lower case ASCII letters and
 * digits, nothing else.
 *
 * Accents are split off their letters and dropped rather than deleted with the letter,
 * so "José" becomes "jose" and stays findable. Punctuation and spacing go entirely
 * rather than becoming separators, because that is what lets a query ignore them:
 * "Lillie's" and "lillies" both land on "lillies", and a name's own spacing can no
 * longer put it out of reach of someone who typed it without.
 *
 * Text in a script this cannot represent folds away to nothing. Such a name was never
 * reachable through this index — `indexKeys` has always split on the same ASCII rule —
 * and bucket keys are file names, so widening it here would put non-ASCII paths into
 * the published site.
 */
export function normalize(text) {
    return String(text)
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '');
}

/** The same folding, but per word, for the ranking tier that cares about word edges. */
export function normalizeWords(text) {
    return String(text).split(/\s+/).map(normalize).filter(Boolean);
}

/**
 * Bucket key for a raw term. Padded so single-character input still resolves.
 *
 * Takes text that is already folded. Search goes through `bucketFor`; this is also what
 * shards published files by handle and card id, which is why it does not fold on its
 * own — those paths are built from ids that are already safe, and must not move.
 */
export function shard(term) {
    return `${String(term).toLowerCase()}__`.slice(0, 2);
}

/** The bucket a typed query resolves to. */
export function bucketFor(term) {
    return shard(normalize(term));
}

/**
 * Every bucket key an entry should be indexed under.
 *
 * Indexes every two-character substring, not just the leading pair, so a query can
 * match from the middle of a word: "essica" resolves to bucket "es" and finds
 * "Jessica". Indexing only prefixes would put that player in "je" alone, and the
 * bucket for what was typed would not contain them.
 *
 * Pairs run across what used to be a space, because `normalize` has already closed it
 * up and the query is folded the same way — "liesdet" has to resolve to a bucket that
 * "Lillie's Determination" is in.
 */
export function indexKeys(handle, names = []) {
    const keys = new Set();

    const addGrams = (text) => {
        const word = normalize(text);
        if (!word) return;
        // A one-character word has no pair; index it under its padded shard so it is
        // still reachable, matching how `bucketFor` resolves a one-character query.
        if (word.length < 2) {
            keys.add(shard(word));
            return;
        }
        for (let i = 0; i <= word.length - 2; i++) keys.add(word.slice(i, i + 2));
    };

    addGrams(handle);
    for (const name of names) addGrams(name);
    return keys;
}

/**
 * Everything an index entry can be matched on, folded.
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
    ].filter(Boolean).map(normalize).filter(Boolean);
}

/** The same strings, kept as separate words, for ranking a whole-word hit. */
export function entryWords(entry) {
    return [
        entry.handle,
        ...(entry.names ?? [entry.name]),
        ...(entry.prints ?? []),
    ].filter(Boolean).flatMap(normalizeWords);
}

/** Does an index entry contain what was typed? */
export function matchesEntry(entry, term) {
    const t = normalize(term);
    if (!t) return false;
    return entryTerms(entry).some((n) => n.includes(t));
}

/**
 * How far off a query of this length may be and still count as a near miss.
 *
 * Nothing under four characters is corrected at all: at three characters almost every
 * name is one edit from almost every other, so the results would be noise rather than a
 * correction. The allowance grows with the query, because a longer one gives more
 * evidence that an edit is a slip and not a different word.
 */
export function fuzzyTolerance(term) {
    const n = normalize(term).length;
    if (n < 4) return 0;
    return n < 8 ? 1 : 2;
}

/**
 * Smallest number of edits between `needle` and any substring of `text`.
 *
 * The ordinary edit-distance table with a free start and a free end, so a query is
 * measured against the best-matching run inside a name rather than the whole of it:
 * "lilie" is one edit from part of "lilliesdetermination", not fifteen.
 *
 * Gives up as soon as every alignment still in play is worse than `max`. The row
 * minimum never falls as the table is filled, so that answer cannot come back.
 */
function nearestSubstring(needle, text, max) {
    if (!needle) return 0;
    if (needle.length - text.length > max) return max + 1;

    // Row zero is all zeros: a match may start anywhere in `text` for free.
    let prev = new Array(text.length + 1).fill(0);
    let cur = new Array(text.length + 1);

    for (let i = 1; i <= needle.length; i++) {
        cur[0] = i;
        let best = i;
        const c = needle.charCodeAt(i - 1);
        for (let j = 1; j <= text.length; j++) {
            const sub = prev[j - 1] + (c === text.charCodeAt(j - 1) ? 0 : 1);
            const del = prev[j] + 1;
            const ins = cur[j - 1] + 1;
            const v = sub < del ? (sub < ins ? sub : ins) : (del < ins ? del : ins);
            cur[j] = v;
            if (v < best) best = v;
        }
        if (best > max) return max + 1;
        const swap = prev; prev = cur; cur = swap;
    }

    let out = prev[0];
    for (let j = 1; j <= text.length; j++) if (prev[j] < out) out = prev[j];
    return out;
}

/**
 * How many edits separate the query from this entry, or null if it is further off than
 * a typo can explain.
 */
export function nearMiss(entry, term) {
    const t = normalize(term);
    const max = fuzzyTolerance(t);
    if (!t || max === 0) return null;

    let best = max + 1;
    for (const n of entryTerms(entry)) {
        const d = nearestSubstring(t, n, max);
        if (d < best) best = d;
        if (best === 0) break;
    }
    return best <= max ? best : null;
}

/**
 * Other buckets worth opening when the obvious one answered nothing.
 *
 * A bucket is addressed by the first two characters typed, so a slip in either of them
 * asks a bucket the entry was never put in and no amount of forgiving comparison in
 * that bucket can help. The index keys an entry under every pair in it, so the pairs
 * further along the query address it too — "xillies" still shares "il" with
 * "Lillie's Determination". Only worth the extra fetches once the first bucket has
 * already come back empty.
 */
export function probeBuckets(term, limit = 3) {
    const t = normalize(term);
    const keys = new Set();
    for (let i = 1; i + 2 <= t.length && keys.size < limit; i++) keys.add(t.slice(i, i + 2));
    keys.delete(bucketFor(t));
    return [...keys];
}

/**
 * Search the published index.
 *
 * Exact first, and only widened to near misses once that has come back with nothing —
 * which is the point at which a typo is the likeliest explanation for an empty list.
 *
 * @param {(key: string) => Promise<Array|null>} fetchBucket loads data/search/<key>.json,
 *   resolving to null when the bucket does not exist
 * @param {string} term
 * @param {(entry: object) => boolean} [keep] which kinds of entry this search wants
 * @returns {Promise<{hits: object[], corrected: boolean}>}
 */
export async function searchIndex(fetchBucket, term, keep = () => true) {
    const t = normalize(term);
    if (t.length < 2) return { hits: [], corrected: false };

    const pool = new Map();
    const take = async (key) => {
        for (const entry of (await fetchBucket(key)) ?? []) {
            if (keep(entry)) pool.set(`${entry.type ?? ''}\u0000${entry.handle}`, entry);
        }
    };

    await take(bucketFor(t));
    const exact = [...pool.values()].filter((e) => matchesEntry(e, t));
    if (exact.length) return { hits: exact, corrected: false };

    // In parallel: three round trips in series is a visible pause on a slow connection,
    // and these are only ever opened when there is nothing to show yet anyway.
    await Promise.all(probeBuckets(t).map(take));
    const near = [...pool.values()]
        .map((entry) => ({ entry, distance: nearMiss(entry, t) }))
        .filter((r) => r.distance !== null)
        .sort((a, b) => a.distance - b.distance)
        .map((r) => r.entry);
    return { hits: near, corrected: near.length > 0 };
}
