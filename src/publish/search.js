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

/** Every bucket key a player should be indexed under. */
export function indexKeys(handle, names = []) {
    const keys = new Set([shard(handle)]);
    for (const name of names) {
        if (!name) continue;
        for (const word of String(name).toLowerCase().split(/[^a-z0-9]+/)) {
            if (word) keys.add(shard(word));
        }
    }
    return keys;
}

/**
 * Does an index entry match what was typed?
 *
 * Matches the handle and every name the player has used — not just the current one.
 * A player who has changed display name is still found by an old one, which is the
 * whole point of keying identity on the handle.
 */
export function matchesEntry(entry, term) {
    const t = String(term).toLowerCase().trim();
    if (!t) return false;
    if (entry.handle.includes(t)) return true;
    // `names` is present only for players who have used more than one; `name` always is.
    const names = entry.names ?? [entry.name];
    return names.some((n) => String(n).toLowerCase().includes(t));
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
