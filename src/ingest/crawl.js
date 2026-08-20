import { ApiError } from '../api/errors.js';

/**
 * Ingest, in two resumable phases sharing one rate limiter.
 *
 * The prototype fetched standings inline while searching for a player, twice per
 * tournament, and re-fetched the same endpoint again to read the row back — three
 * requests where one suffices. Here a tournament is fetched exactly once, ever, and
 * the result is durable. Lookups then never touch the network at all.
 */

const PAGE_SIZE = 50; // the documented default and maximum for /tournaments

/**
 * Phase 1 — discover which tournaments exist and record them as pending.
 * Cheap: one request per 50 tournaments.
 *
 * @param {import('../api/limitless.js').LimitlessApi} api
 * @param {import('../db/queries.js').Store} store
 */
export async function discover(api, store, {
    game = 'PTCG',
    format,
    maxPages = Infinity,
    /** Incremental mode: stop as soon as a whole page contains nothing new. */
    stopWhenKnown = true,
    /**
     * Inclusive ISO date bounds. The API ignores every date parameter we probed
     * (before/after/from/to/startDate/endDate/date), so this is filtered client-side.
     * It still pays: discovery costs one request per 50 tournaments while standings
     * cost one request each, so bounding the queue here saves the expensive half.
     */
    since = null,
    until = null,
    /**
     * Stop once this many tournaments are queued and waiting to be fetched.
     *
     * Without this, a first run against an empty database pages through the entire
     * archive before fetching a single standing — `stopWhenKnown` cannot fire when
     * every page is new, and the ingest cap does not apply to this phase. Discovery is
     * cheap but not free, and there is no point queueing 4,000 events to fetch 200.
     */
    pendingTarget = Infinity,
    /** Must match the ingest filter, or the queue depth is counted against the wrong set. */
    minPlayers = null,
    /**
     * When the newest pages hold nothing new, carry on into older ones rather than
     * stopping with nothing done. This is what turns repeated runs into a backfill.
     */
    deepen = true,
    deadline = Infinity,
    maxRequests = Infinity,
    onProgress = () => {},
    signal,
} = {}) {
    let discovered = 0;
    let pages = 0;

    // Cursors are per game+format: how deep discovery has walked, and whether the far
    // end of the archive has been reached.
    const scope = `${game}:${format ?? 'ALL'}`;
    const CURSOR = `discoveryPage:${scope}`;
    const COMPLETE = `archiveComplete:${scope}`;

    const outOfBudget = () =>
        Boolean(signal?.aborted) || Date.now() >= deadline || api.stats.requests >= maxRequests;
    const targetMet = () =>
        Number.isFinite(pendingTarget) && store.countPending(minPlayers) >= pendingTarget;

    /**
     * Walk consecutive listing pages from `from`, recording what falls in range.
     * @returns {Promise<{lastFetched: number, hitEnd: boolean}>}
     */
    async function walk(from, { untilKnown, respectTarget, phase }) {
        let lastFetched = from - 1;
        let hitEnd = false;

        for (let page = from; ; page++) {
            if (pages >= maxPages || outOfBudget()) break;
            if (respectTarget && targetMet()) break;

            const list = await api.listTournaments({ game, format, limit: PAGE_SIZE, page });
            pages++;
            lastFetched = page;
            if (list.length === 0) { hitEnd = true; break; }

            const inRange = list.filter(
                (t) => (!since || t.date >= since) && (!until || t.date <= until),
            );

            let fresh = 0;
            for (const t of inRange) {
                if (!store.upsertTournament(t)) fresh++;
            }
            discovered += fresh;
            onProgress({
                page, pageSize: list.length, inRange: inRange.length, fresh, discovered, phase,
            });

            // The listing is ordered newest-first, so once an entire page falls below
            // the lower bound, everything beyond it is older still.
            if (since && list[list.length - 1].date < since) break;

            // Nothing new on a page means we have caught up with what we already hold —
            // but only conclude that from a page that actually had rows in range, or an
            // `until` bound would stop discovery before it reached the range at all.
            if (untilKnown && fresh === 0 && inRange.length > 0) break;
            if (list.length < PAGE_SIZE) { hitEnd = true; break; }
        }

        return { lastFetched, hitEnd };
    }

    // Phase A — the newest pages, picking up whatever appeared since the last run.
    //
    // This deliberately ignores the queue target: catching up the front costs a page or
    // two and is what keeps the site current, so it has to happen even mid-backfill
    // with thousands already queued. The exception is an initial fill, where there is
    // no front to catch up and the nothing-new stop can never fire, leaving the target
    // as the only thing bounding the walk.
    const initialFill = store.countTournaments(game, format ?? null) === 0;
    const recent = await walk(1, {
        untilKnown: stopWhenKnown,
        respectTarget: initialFill,
        phase: stopWhenKnown ? 'recent' : 'full',
    });

    // Phase B — carry on into older pages.
    //
    // Phase A stops as soon as a page holds nothing new, which on a back-to-back run is
    // page 1, leaving the run with nothing to do at all. Extending backwards instead
    // means every run makes progress: once the front is current the remaining budget
    // goes into filling in history, and the backfill completes over successive runs
    // without anyone having to ask for it.
    //
    // Resuming from a remembered page number is safe because drift only goes one way.
    // Tournaments are added at the *front*, which pushes older ones to HIGHER page
    // numbers, so re-reading page N returns content newer than or equal to what it held
    // last time — overlap, never a gap. One page of margin absorbs the rare reverse
    // drift from a deleted tournament.
    let deepFrom = null;
    let deepTo = null;

    if (deepen && stopWhenKnown && store.getState(COMPLETE) !== '1'
        && !targetMet() && !outOfBudget()) {
        const saved = Number(store.getState(CURSOR) ?? 0);
        deepFrom = Math.max(1, Math.max(saved, recent.lastFetched) - 1);

        const older = await walk(deepFrom, {
            untilKnown: false,
            respectTarget: true,
            phase: 'older',
        });

        if (older.lastFetched >= deepFrom) {
            deepTo = older.lastFetched;
            store.setState(CURSOR, deepTo);
            // Nothing is ever added to the old end, so reaching it once is permanent.
            if (older.hitEnd) store.setState(COMPLETE, '1');
        }
    }

    return {
        discovered,
        pages,
        recentPages: Math.max(0, recent.lastFetched),
        deepFrom,
        deepTo,
        archiveComplete: store.getState(COMPLETE) === '1',
    };
}

/**
 * Phase 2 — fetch standings for everything still pending.
 *
 * Each tournament is committed in its own transaction, so interrupting this at any
 * point is safe and the next run resumes from the same place.
 *
 * @param {import('../api/limitless.js').LimitlessApi} api
 * @param {import('../db/queries.js').Store} store
 */
export async function fetchPending(api, store, {
    /** Cap on tournaments processed this run. Infinity = drain the queue. */
    limit = Infinity,
    /** Skip small events. Applied from the listing, so it costs no extra requests. */
    minPlayers = null,
    /**
     * Discard events that ran without any decklists. Such an event yields only a
     * ranking, which is not what this project is for. Whether a tournament has lists
     * is not knowable in advance — the listing carries no flag and /details would cost
     * the very request we would be trying to save — so the request is spent either
     * way and this saves storage and query noise rather than budget.
     */
    requireDecklists = true,
    batchSize = 100,
    /** Circuit breaker: stop if this many tournaments fail back-to-back. */
    maxConsecutiveFailures = 25,
    /**
     * Wall-clock stop, as an epoch-ms timestamp. Unattended runs need this: GitHub
     * Actions hard-kills a job at 6 hours, and a kill mid-request wastes budget.
     * Stopping cleanly under our own control leaves the queue tidy for the next run.
     */
    deadline = Infinity,
    /** Stop after this many total requests on the shared client. */
    maxRequests = Infinity,
    onProgress = () => {},
    signal,
} = {}) {
    const total = Math.min(limit, store.countPending(minPlayers));
    let done = 0;
    let failed = 0;
    let standings = 0;
    let skippedNoDecklists = 0;
    let consecutiveFailures = 0;
    let stoppedBecause = 'complete';

    while (done + failed + skippedNoDecklists < total) {
        if (signal?.aborted) { stoppedBecause = 'interrupted'; break; }

        const batch = store.pending(
            Math.min(batchSize, total - done - failed - skippedNoDecklists), minPlayers,
        );
        if (batch.length === 0) break;

        for (const t of batch) {
            if (signal?.aborted) { stoppedBecause = 'interrupted'; break; }
            if (done + failed + skippedNoDecklists >= total) break;
            if (Date.now() >= deadline) { stoppedBecause = 'deadline'; break; }
            if (api.stats.requests >= maxRequests) { stoppedBecause = 'budget'; break; }

            try {
                const rows = await api.getStandings(t.id);
                const withLists = rows.reduce((n, r) => n + (r.decklist ? 1 : 0), 0);

                if (requireDecklists && withLists === 0) {
                    store.markNoDecklists(t.id);
                    skippedNoDecklists++;
                } else {
                    store.saveStandings(t.id, rows, withLists > 0);
                    standings += rows.length;
                    done++;
                }
                consecutiveFailures = 0;
            } catch (err) {
                // Key off `retryable`, not the error class. A tournament that is gone
                // does NOT come back as 404 — the live API answers 400 with the body
                // "Tournament not found." Matching on the class alone would abort the
                // whole run on a single dead event, and re-abort on every restart.
                if (err instanceof ApiError && !err.retryable) {
                    store.markError(t.id, err.message);
                    failed++;
                    consecutiveFailures++;
                    // A handful of dead tournaments is normal; a long unbroken run of
                    // them means the API shape changed and we should stop rather than
                    // mark the entire remaining corpus as failed.
                    if (consecutiveFailures >= maxConsecutiveFailures) {
                        throw new Error(
                            `Aborting: ${consecutiveFailures} consecutive tournaments failed. ` +
                            `Last error: ${err.message}`,
                            { cause: err },
                        );
                    }
                } else {
                    // Retries are already exhausted inside the client. Abort the run
                    // rather than burning the remaining budget; state is durable, so
                    // simply re-running picks up here.
                    throw err;
                }
            }

            onProgress({
                done, failed, total, standings, skippedNoDecklists,
                tournament: t,
                remaining: total - done - failed - skippedNoDecklists,
            });
        }

        // A stop decided inside the batch loop has to leave the outer loop too,
        // otherwise the next iteration re-enters with the same condition and spins.
        if (stoppedBecause !== 'complete') break;
    }

    return { done, failed, standings, skippedNoDecklists, total, stoppedBecause };
}

/** Convenience wrapper: discover, then fetch. */
export async function crawl(api, store, options = {}) {
    const discovery = await discover(api, store, options);
    const ingest = await fetchPending(api, store, options);
    return { discovery, ingest };
}
