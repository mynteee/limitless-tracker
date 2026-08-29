/** The three decklist sections the API returns. */
export const CARD_KINDS = ['pokemon', 'trainer', 'energy'];

/**
 * Prepared statements over the local store.
 *
 * Everything the crawler and the CLI need lives here, so SQL never leaks into the
 * ingest or presentation layers.
 */
export class Store {
    constructor(db) {
        this.db = db;

        this.stmt = {
            upsertTournament: db.prepare(`
                INSERT INTO tournament (id, game, format, name, date, players, organizer_id)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                    game = excluded.game,
                    format = excluded.format,
                    name = excluded.name,
                    date = excluded.date,
                    players = excluded.players,
                    organizer_id = excluded.organizer_id
            `),

            tournamentExists: db.prepare(`SELECT 1 FROM tournament WHERE id = ?`),

            getState: db.prepare(`SELECT value FROM crawl_state WHERE key = ?`),
            setState: db.prepare(`
                INSERT INTO crawl_state (key, value) VALUES (?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value
            `),

            // Newest first: a partial crawl should cover recent events, which are what
            // players look for. Backed by idx_tournament_pending.
            pending: db.prepare(`
                SELECT id, name, date, players
                FROM tournament
                WHERE standings_fetched_at IS NULL AND fetch_error IS NULL
                  AND (? IS NULL OR players >= ?)
                ORDER BY date DESC
                LIMIT ?
            `),

            countPending: db.prepare(`
                SELECT COUNT(*) AS n FROM tournament
                WHERE standings_fetched_at IS NULL AND fetch_error IS NULL
                  AND (? IS NULL OR players >= ?)
            `),

            countTournaments: db.prepare(`
                SELECT COUNT(*) AS n FROM tournament
                WHERE (? IS NULL OR game = ?) AND (? IS NULL OR format = ?)
            `),

            deleteStandings: db.prepare(`DELETE FROM standing WHERE tournament_id = ?`),

            deleteCardPlays: db.prepare(`DELETE FROM card_play WHERE tournament_id = ?`),

            // ?1 = tournament id, or NULL for the whole corpus.
            indexDecks: db.prepare(`
                INSERT INTO deck (id, name, icons)
                SELECT DISTINCT s.deck_id, s.deck_name, s.deck_icons
                FROM standing s
                WHERE s.deck_id IS NOT NULL AND (?1 IS NULL OR s.tournament_id = ?1)
                ON CONFLICT(id) DO UPDATE SET name = excluded.name, icons = excluded.icons
            `),

            // Derive the card tables straight from the decklist JSON. The same two
            // statements serve both the per-tournament path during a crawl and the
            // bulk rebuild, so the two can never drift: pass a tournament id to scope
            // it, or NULL to do the whole corpus.
            // ?1 = kind (pokemon|trainer|energy), ?2 = tournament id or NULL for all.
            indexCards: db.prepare(`
                INSERT INTO card (id, set_, number, name, kind)
                SELECT DISTINCT
                    json_extract(c.value, '$.set') || '-' || json_extract(c.value, '$.number'),
                    json_extract(c.value, '$.set'),
                    json_extract(c.value, '$.number'),
                    json_extract(c.value, '$.name'),
                    ?1
                FROM standing s, json_each(s.decklist, '$.' || ?1) c
                WHERE s.decklist IS NOT NULL AND (?2 IS NULL OR s.tournament_id = ?2)
                ON CONFLICT(id) DO NOTHING
            `),

            indexCardPlays: db.prepare(`
                INSERT INTO card_play (card_id, tournament_id, player, count, date)
                SELECT json_extract(c.value, '$.set') || '-' || json_extract(c.value, '$.number'),
                       s.tournament_id,
                       s.player,
                       -- A list can split one card across entries; sum rather than
                       -- letting the second row collide with the first.
                       SUM(json_extract(c.value, '$.count')),
                       t.date
                FROM standing s
                JOIN tournament t ON t.id = s.tournament_id
                JOIN json_each(s.decklist, '$.' || ?1) c
                WHERE s.decklist IS NOT NULL AND (?2 IS NULL OR s.tournament_id = ?2)
                GROUP BY 1, 2, 3
                ON CONFLICT(card_id, tournament_id, player)
                    DO UPDATE SET count = excluded.count
            `),

            insertStanding: db.prepare(`
                INSERT INTO standing (
                    tournament_id, player, name, country, placing,
                    wins, losses, ties, drop_round,
                    deck_id, deck_name, deck_icons, decklist,
                    date
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    (SELECT date FROM tournament WHERE id = ?1))
            `),

            markFetched: db.prepare(`
                UPDATE tournament
                SET standings_fetched_at = ?, standings_count = ?, fetch_error = NULL,
                    has_decklists = ?
                WHERE id = ?
            `),

            markError: db.prepare(`UPDATE tournament SET fetch_error = ? WHERE id = ?`),

            playerHistory: db.prepare(`
                SELECT t.id AS tournamentId, t.name AS tournamentName, t.date, t.game, t.format,
                       t.players AS fieldSize,
                       s.name AS displayName, s.country, s.placing,
                       s.wins, s.losses, s.ties, s.drop_round AS dropRound,
                       s.deck_id AS deckId, s.deck_name AS deckName, s.deck_icons AS deckIcons
                FROM standing s
                JOIN tournament t ON t.id = s.tournament_id
                WHERE s.player = ?
                ORDER BY t.date DESC
            `),

            playerDecklist: db.prepare(`
                SELECT decklist FROM standing WHERE player = ? AND tournament_id = ?
            `),

            // Every distinct player, for the publish step to walk. Aggregates come from
            // the same pass so the builder does not need a second query per player.
            allPlayers: db.prepare(`
                SELECT s.player AS handle, COUNT(*) AS events, MAX(t.date) AS lastSeen
                FROM standing s
                JOIN tournament t ON t.id = s.tournament_id
                GROUP BY s.player
                ORDER BY s.player
            `),

            // Full history including decklists. Used only by the publish step; the CLI
            // lookup deliberately avoids pulling decklist blobs it will not print.
            playerHistoryFull: db.prepare(`
                SELECT t.id AS tournamentId, t.name AS tournamentName, t.date,
                       t.game, t.format, t.players AS fieldSize,
                       s.name AS displayName, s.country, s.placing,
                       s.wins, s.losses, s.ties, s.drop_round AS dropRound,
                       s.deck_id AS deckId, s.deck_name AS deckName, s.deck_icons AS deckIcons,
                       s.decklist
                FROM standing s
                JOIN tournament t ON t.id = s.tournament_id
                WHERE s.player = ?
                ORDER BY t.date DESC
            `),

            /** Every deck id the corpus has seen, for grouping into base archetypes. */
            allDecks: db.prepare(`
                SELECT d.id AS deckId, d.name AS deckName, d.icons,
                       agg.decks, agg.firstSeen, agg.lastSeen
                FROM (
                    -- Covered entirely by idx_standing_deck(deck_id, date).
                    SELECT deck_id, COUNT(*) AS decks,
                           MIN(date) AS firstSeen, MAX(date) AS lastSeen
                    FROM standing
                    WHERE deck_id IS NOT NULL
                    GROUP BY deck_id
                ) agg
                JOIN deck d ON d.id = agg.deck_id
                ORDER BY agg.decks DESC
            `),

            /**
             * How many decklists a set of deck ids accounts for in a date window.
             * The denominator of the average decklist, and it must count decks that
             * did NOT play a card too, or every average comes out too high.
             */
            archetypeDeckCount: db.prepare(`
                SELECT COUNT(*) AS n
                FROM standing s
                WHERE s.deck_id IN (SELECT value FROM json_each(?1))
                  AND s.decklist IS NOT NULL
                  AND (?2 IS NULL OR s.date >= ?2)
                  AND (?3 IS NULL OR s.date <= ?3)
            `),

            /**
             * The average decklist: mean copies of each card across every deck of the
             * archetype in the window, including the decks that ran none of it. That
             * is what produces the 4.00 / 2.02 / 0.02 figures Limitless shows.
             */
            archetypeAverage: db.prepare(`
                SELECT cp.card_id AS cardId, c.name, c.kind, c.set_ AS setCode, c.number,
                       SUM(cp.count) AS copies,
                       COUNT(*) AS decksWith
                FROM standing s
                JOIN card_play cp ON cp.tournament_id = s.tournament_id AND cp.player = s.player
                JOIN card c ON c.id = cp.card_id
                WHERE s.deck_id IN (SELECT value FROM json_each(?1))
                  AND (?2 IS NULL OR s.date >= ?2)
                  AND (?3 IS NULL OR s.date <= ?3)
                GROUP BY cp.card_id
                ORDER BY copies DESC
            `),

            /** Tournament placements for an archetype, newest and best first. */
            archetypeResults: db.prepare(`
                SELECT t.id AS tournamentId, t.name AS tournamentName, t.date,
                       t.players AS fieldSize,
                       s.player, s.name AS displayName, s.placing,
                       s.deck_id AS deckId, s.deck_name AS deckName, s.deck_icons AS deckIcons
                FROM standing s
                JOIN tournament t ON t.id = s.tournament_id
                WHERE s.deck_id IN (SELECT value FROM json_each(?1))
                  AND (?2 IS NULL OR s.date >= ?2)
                  AND (?3 IS NULL OR s.date <= ?3)
                ORDER BY s.date DESC, s.placing IS NULL, s.placing ASC
                LIMIT ?4 OFFSET ?5
            `),

            /**
             * Every deck id crossed with every card it plays, in one pass.
             *
             * The publish step needs an average decklist for 133 archetypes plus their
             * variants across several windows. Asking per archetype is 400+ queries and
             * minutes of work; this answers all of them at once, and the caller sums
             * variants into their base.
             */
            allDeckCardTotals: db.prepare(`
                SELECT s.deck_id AS deckId, cp.card_id AS cardId,
                       SUM(cp.count) AS copies, COUNT(*) AS decksWith
                FROM standing s
                JOIN card_play cp ON cp.tournament_id = s.tournament_id AND cp.player = s.player
                WHERE s.deck_id IS NOT NULL AND (?1 IS NULL OR s.date >= ?1)
                GROUP BY s.deck_id, cp.card_id
            `),

            /** Decklist counts per deck id in a window — the averaging denominator. */
            allDeckCounts: db.prepare(`
                SELECT deck_id AS deckId, COUNT(*) AS decks
                FROM standing
                WHERE deck_id IS NOT NULL AND decklist IS NOT NULL
                  AND (?1 IS NULL OR date >= ?1)
                GROUP BY deck_id
            `),

            /**
             * Per-deck, per-day card totals inside a recent window.
             *
             * The precomputed windows on an archetype page cannot answer an arbitrary
             * date range, and day granularity is the only thing that makes "last N days"
             * exact. It is bounded to a recent window on purpose: unbounded it grows with
             * the whole archive, and the biggest archetype's file would reach tens of
             * megabytes once the backfill runs to the 2020 floor.
             */
            deckCardDaily: db.prepare(`
                SELECT s.deck_id AS deckId, substr(s.date, 1, 10) AS day,
                       cp.card_id AS cardId,
                       SUM(cp.count) AS copies, COUNT(*) AS decksWith
                FROM standing s
                JOIN card_play cp ON cp.tournament_id = s.tournament_id AND cp.player = s.player
                WHERE s.deck_id IS NOT NULL AND s.date >= ?1
                GROUP BY 1, 2, 3
            `),

            /** Decklists per deck id per day — the denominator, and the list's counts. */
            deckCountsDaily: db.prepare(`
                SELECT deck_id AS deckId, substr(date, 1, 10) AS day, COUNT(*) AS decks
                FROM standing
                WHERE deck_id IS NOT NULL AND decklist IS NOT NULL AND date >= ?1
                GROUP BY 1, 2
            `),

            /** Every card, for the shared dictionary the archetype pages reference. */
            allCards: db.prepare(`
                SELECT c.id, c.name, c.set_ AS setCode, c.number, c.kind,
                       (SELECT COUNT(*) FROM card_play WHERE card_id = c.id) AS decks
                FROM card c
                ORDER BY c.id
            `),

            /**
             * Results for a whole print group.
             *
             * A decklist can run two printings of the same card - 2x Ultra Ball SVI-196
             * plus 2x MEG-131 is four Ultra Balls in one deck, not two decks of two. So
             * the counts are summed per (tournament, player) rather than the rows being
             * unioned, which would double-count both the copies and the deck.
             */
            groupResults: db.prepare(`
                SELECT t.id AS tournamentId, t.name AS tournamentName, g.date,
                       t.players AS fieldSize,
                       s.player, s.name AS displayName, s.placing,
                       s.deck_id AS deckId, s.deck_name AS deckName, s.deck_icons AS deckIcons,
                       g.count
                FROM (
                    SELECT tournament_id, player, SUM(count) AS count, MAX(date) AS date
                    FROM card_play
                    WHERE card_id IN (SELECT value FROM json_each(?1))
                    GROUP BY tournament_id, player
                    ORDER BY date DESC
                    LIMIT ?2
                ) g
                JOIN standing s ON s.tournament_id = g.tournament_id AND s.player = g.player
                JOIN tournament t ON t.id = g.tournament_id
                ORDER BY g.date DESC, s.placing IS NULL, s.placing ASC
            `),

            countGroupDecks: db.prepare(`
                SELECT COUNT(*) AS n FROM (
                    SELECT 1 FROM card_play
                    WHERE card_id IN (SELECT value FROM json_each(?1))
                    GROUP BY tournament_id, player
                )
            `),

            cardsWithoutPrints: db.prepare(`
                SELECT c.id, c.set_ AS setCode, c.number, c.name
                FROM card c
                LEFT JOIN card_print p ON p.card_id = c.id
                WHERE p.card_id IS NULL
                ORDER BY (SELECT COUNT(*) FROM card_play WHERE card_id = c.id) DESC
                LIMIT CASE WHEN ?1 < 0 THEN -1 ELSE ?1 END
            `),

            setPrintGroup: db.prepare(`
                INSERT INTO card_print (card_id, group_id, fetched_at)
                VALUES (?, ?, ?)
                ON CONFLICT(card_id) DO UPDATE SET
                    group_id = excluded.group_id, fetched_at = excluded.fetched_at
            `),

            printGroupOf: db.prepare(`SELECT group_id FROM card_print WHERE card_id = ?`),

            /** Every print of a card that this corpus actually has data for. */
            printsInGroup: db.prepare(`
                SELECT c.id, c.set_ AS setCode, c.number, c.name, c.kind,
                       (SELECT COUNT(*) FROM card_play WHERE card_id = c.id) AS decks
                FROM card_print p
                JOIN card c ON c.id = p.card_id
                WHERE p.group_id = ?
                ORDER BY decks DESC, c.id
            `),

            allPrintGroups: db.prepare(`
                SELECT p.group_id AS groupId, p.card_id AS cardId
                FROM card_print p JOIN card c ON c.id = p.card_id
            `),

            searchCards: db.prepare(`
                SELECT c.id, c.name, c.set_ AS setCode, c.number, c.kind,
                       COUNT(cp.card_id) AS decks
                FROM card c
                LEFT JOIN card_play cp ON cp.card_id = c.id
                WHERE lower(c.name) LIKE ?1 OR lower(c.id) LIKE ?1
                GROUP BY c.id
                ORDER BY decks DESC
                LIMIT ?2
            `),

            cardById: db.prepare(`
                SELECT c.id, c.name, c.set_ AS setCode, c.number, c.kind,
                       (SELECT COUNT(*) FROM card_play WHERE card_id = c.id) AS decks
                FROM card c WHERE c.id = ?
            `),

            /** The newest event this card appeared at. Served straight off the index. */
            cardLatestTournament: db.prepare(`
                SELECT tournament_id AS id FROM card_play
                WHERE card_id = ? ORDER BY date DESC LIMIT 1
            `),

            /**
             * Every decklist at one event that ran this card, best placing first.
             * Dropped players have a NULL placing and sort last rather than first.
             */
            cardResultsAtTournament: db.prepare(`
                SELECT t.id AS tournamentId, t.name AS tournamentName, t.date,
                       t.players AS fieldSize,
                       s.player, s.name AS displayName, s.placing,
                       s.deck_id AS deckId, s.deck_name AS deckName, s.deck_icons AS deckIcons,
                       cp.count
                FROM card_play cp
                JOIN standing s ON s.tournament_id = cp.tournament_id AND s.player = cp.player
                JOIN tournament t ON t.id = cp.tournament_id
                WHERE cp.card_id = ? AND cp.tournament_id = ?
                ORDER BY s.placing IS NULL, s.placing ASC
            `),

            /**
             * The most recent results across events.
             *
             * The window is taken in a subquery ordered by date alone, which the
             * (card_id, date) index serves directly and stops at LIMIT. Sorting on the
             * joined placing in the outer query instead would force every matching row
             * into a temp b-tree first — 98,000 of them for a staple, and six seconds.
             */
            cardResults: db.prepare(`
                SELECT t.id AS tournamentId, t.name AS tournamentName, cp.date,
                       t.players AS fieldSize,
                       s.player, s.name AS displayName, s.placing,
                       s.deck_id AS deckId, s.deck_name AS deckName, s.deck_icons AS deckIcons,
                       cp.count
                FROM (
                    SELECT tournament_id, player, count, date
                    FROM card_play
                    WHERE card_id = ?
                    ORDER BY date DESC
                    LIMIT ? OFFSET ?
                ) cp
                JOIN standing s ON s.tournament_id = cp.tournament_id AND s.player = cp.player
                JOIN tournament t ON t.id = cp.tournament_id
                ORDER BY cp.date DESC, s.placing IS NULL, s.placing ASC
            `),

            coverage: db.prepare(`
                SELECT MIN(t.date) AS from_, MAX(t.date) AS to_,
                       COUNT(DISTINCT t.game) AS games, COUNT(DISTINCT t.format) AS formats
                FROM tournament t
                WHERE t.id IN (SELECT DISTINCT tournament_id FROM standing)
            `),

            gamesFormats: db.prepare(`
                SELECT DISTINCT game, format FROM tournament
                WHERE id IN (SELECT DISTINCT tournament_id FROM standing)
            `),

            // Matches on the handle or on ANY display name the player has ever used,
            // then reports the most recent name via a window function.
            //
            // The match resolves to a set of handles in a subquery first, and the
            // window functions then run over *all* of those players' rows. Filtering
            // inline instead would compute the aggregates over only the matching rows:
            // searching an old name would report that player as having one event and
            // would echo the stale name back, which is exactly backwards — the point of
            // searching by an old name is to find the player's whole history.
            searchPlayers: db.prepare(`
                SELECT handle, name, altNames, events, firstSeen, lastSeen FROM (
                    SELECT s.player AS handle,
                           FIRST_VALUE(s.name) OVER (PARTITION BY s.player ORDER BY t.date DESC) AS name,
                           COUNT(*)            OVER (PARTITION BY s.player) AS events,
                           MIN(t.date)         OVER (PARTITION BY s.player) AS firstSeen,
                           MAX(t.date)         OVER (PARTITION BY s.player) AS lastSeen,
                           ROW_NUMBER()        OVER (PARTITION BY s.player ORDER BY t.date DESC) AS rn,
                           (SELECT COUNT(DISTINCT x.name) FROM standing x WHERE x.player = s.player)
                               AS altNames
                    FROM standing s
                    JOIN tournament t ON t.id = s.tournament_id
                    WHERE s.player IN (
                        SELECT player FROM standing
                        WHERE player LIKE ? OR lower(name) LIKE ?
                    )
                )
                WHERE rn = 1
                ORDER BY events DESC, lastSeen DESC
                LIMIT ?
            `),

            /** Every display name a handle has used, most recent first. */
            playerNames: db.prepare(`
                SELECT DISTINCT s.name
                FROM standing s
                JOIN tournament t ON t.id = s.tournament_id
                WHERE s.player = ? AND s.name IS NOT NULL
                ORDER BY t.date DESC
            `),

            // Marked fetched so it never re-enters the queue, but no rows are kept.
            markNoDecklists: db.prepare(`
                UPDATE tournament
                SET standings_fetched_at = ?, standings_count = 0, fetch_error = NULL,
                    has_decklists = 0
                WHERE id = ?
            `),

            prunable: db.prepare(`
                SELECT id, name, date, players, has_decklists
                FROM tournament
                WHERE standings_fetched_at IS NOT NULL
                  AND ((? IS NOT NULL AND players < ?) OR (? = 1 AND has_decklists = 0))
                ORDER BY date DESC
            `),

            stats: db.prepare(`
                SELECT
                    (SELECT COUNT(*) FROM tournament) AS tournaments,
                    (SELECT COUNT(*) FROM tournament WHERE standings_fetched_at IS NOT NULL) AS ingested,
                    (SELECT COUNT(*) FROM tournament WHERE fetch_error IS NOT NULL) AS failed,
                    (SELECT COUNT(*) FROM tournament WHERE has_decklists = 0) AS noDecklists,
                    (SELECT COUNT(DISTINCT tournament_id) FROM standing) AS eventsWithData,
                    (SELECT COUNT(*) FROM standing) AS standings,
                    (SELECT COUNT(DISTINCT player) FROM standing) AS players,
                    (SELECT COUNT(*) FROM standing WHERE decklist IS NOT NULL) AS decklists,
                    (SELECT MIN(date) FROM tournament WHERE standings_fetched_at IS NOT NULL) AS oldest,
                    (SELECT MAX(date) FROM tournament WHERE standings_fetched_at IS NOT NULL) AS newest
            `),
        };
    }

    /** @returns {boolean} true if this tournament was already known before the call. */
    upsertTournament(t) {
        const known = this.stmt.tournamentExists.get(t.id) !== undefined;
        this.stmt.upsertTournament.run(
            t.id, t.game, t.format, t.name, t.date, t.players, t.organizerId,
        );
        return known;
    }

    /**
     * Persist a tournament's standings and mark it done, atomically.
     *
     * All-or-nothing matters: a crash mid-write must not leave a tournament flagged
     * as ingested with only half its rows, because nothing would ever re-fetch it.
     */
    saveStandings(tournamentId, rows, hasDecklists = true) {
        this.db.exec('BEGIN');
        try {
            // Delete-then-insert so a re-crawl repairs a partial or stale ingest.
            this.stmt.deleteCardPlays.run(tournamentId);
            this.stmt.deleteStandings.run(tournamentId);
            for (const r of rows) {
                this.stmt.insertStanding.run(
                    tournamentId, r.player, r.name, r.country, r.placing,
                    r.wins, r.losses, r.ties, r.dropRound,
                    r.deckId, r.deckName, r.deckIcons, r.decklist,
                );
            }
            // Same transaction as the standings themselves, so the reverse index can
            // never be left describing decklists that were rolled back.
            this.indexCards(tournamentId);
            this.stmt.indexDecks.run(tournamentId);

            this.stmt.markFetched.run(
                new Date().toISOString(), rows.length, hasDecklists ? 1 : 0, tournamentId,
            );
            this.db.exec('COMMIT');
        } catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
        }
    }

    /**
     * Record that an event ran without decklists: marked fetched so it never re-enters
     * the queue, but none of its standings are stored. The request is already spent by
     * the time we can tell, so this saves storage and keeps queries clean, not budget.
     */
    markNoDecklists(tournamentId) {
        this.stmt.markNoDecklists.run(new Date().toISOString(), tournamentId);
    }

    /** Tournaments already ingested that no longer satisfy the current crawl policy. */
    prunable({ minPlayers = null, requireDecklists = false } = {}) {
        return this.stmt.prunable.all(minPlayers, minPlayers, requireDecklists ? 1 : 0);
    }

    /**
     * Drop the standings of events that no longer match policy, keeping the tournament
     * row as a tombstone.
     *
     * Deleting the row outright would be wrong: discovery would find the event again,
     * re-add it as pending, and spend a request re-fetching exactly what we just
     * decided we did not want. The tombstone is a few hundred bytes and the standings
     * were the bulk of the storage anyway.
     */
    prune(ids) {
        this.db.exec('BEGIN');
        try {
            const dropRows = this.db.prepare('DELETE FROM standing WHERE tournament_id = ?');
            const tombstone = this.db.prepare(`
                UPDATE tournament
                SET standings_count = 0,
                    standings_fetched_at = COALESCE(standings_fetched_at, ?)
                WHERE id = ?
            `);
            const now = new Date().toISOString();
            for (const id of ids) { dropRows.run(id); tombstone.run(now, id); }
            this.db.exec('COMMIT');
        } catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
        }
    }

    /** Record a permanent failure so the crawler stops retrying this tournament forever. */
    markError(tournamentId, message) {
        this.stmt.markError.run(String(message).slice(0, 500), tournamentId);
    }

    pending(limit, minPlayers = null) {
        return this.stmt.pending.all(minPlayers, minPlayers, limit);
    }

    countPending(minPlayers = null) {
        return this.stmt.countPending.get(minPlayers, minPlayers).n;
    }

    getPlayerHistory(handle) {
        return this.stmt.playerHistory.all(handle.toLowerCase());
    }

    getDecklist(handle, tournamentId) {
        const row = this.stmt.playerDecklist.get(handle.toLowerCase(), tournamentId);
        return row?.decklist ? JSON.parse(row.decklist) : null;
    }

    /**
     * Rebuild the card index from the decklists already stored.
     * @param {string|null} tournamentId scope to one tournament, or null for everything
     */
    indexCards(tournamentId = null) {
        for (const kind of CARD_KINDS) {
            this.stmt.indexCards.run(kind, tournamentId);
            this.stmt.indexCardPlays.run(kind, tournamentId);
        }
    }

    /**
     * Tournaments whose decklists are stored but absent from the card index.
     *
     * `saveStandings` indexes as it goes, so this is only ever non-empty for events
     * crawled before the card index existed — which is every event in a database that
     * predates it. Left unrepaired the index still answers, just from a fraction of the
     * corpus: averages come out near zero because the denominator counts every deck
     * while the numerator only sees the indexed ones.
     */
    unindexedTournaments() {
        return this.db.prepare(`
            SELECT t.id FROM tournament t
            -- Keyed off decklists actually stored, not the has_decklists flag. The flag
            -- can outlive its rows: 34 events here carry has_decklists = 1 with zero
            -- standings, and trusting it would hand them to the repair on every single
            -- build, which then finds nothing to index and leaves them "missing" forever.
            WHERE EXISTS (
                SELECT 1 FROM standing s
                WHERE s.tournament_id = t.id AND s.decklist IS NOT NULL
            )
            AND NOT EXISTS (SELECT 1 FROM card_play cp WHERE cp.tournament_id = t.id)
        `).all().map((r) => r.id);
    }

    /** Index only what is missing. Cheap when nothing is, unlike a full rebuild. */
    repairCardIndex(onProgress = () => {}) {
        const missing = this.unindexedTournaments();
        if (missing.length === 0) return 0;

        this.db.exec('BEGIN');
        try {
            let done = 0;
            for (const id of missing) {
                this.indexCards(id);
                this.stmt.indexDecks.run(id);
                if (++done % 100 === 0) onProgress({ done, total: missing.length });
            }
            this.db.exec('COMMIT');
        } catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
        }
        return missing.length;
    }

    /** Drop and rebuild the whole card index. Derived data — safe to redo at any time. */
    reindexCards() {
        this.db.exec('BEGIN');
        try {
            this.db.exec('DELETE FROM card_play');
            this.db.exec('DELETE FROM card');
            this.indexCards(null);
            this.stmt.indexDecks.run(null);
            this.db.exec('COMMIT');
        } catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
        }
    }

    /** Raw deck rows with icons parsed, ready for groupArchetypes(). */
    allDecks() {
        return this.stmt.allDecks.all().map((r) => ({
            ...r,
            icons: JSON.parse(r.icons ?? '[]'),
        }));
    }

    /**
     * Average copies of each card across an archetype's decklists.
     * @param {string[]} deckIds every variant to include
     * @param {{since?: string|null, until?: string|null}} [window]
     */
    archetypeAverageDecklist(deckIds, { since = null, until = null } = {}) {
        const ids = JSON.stringify(deckIds);
        const total = this.stmt.archetypeDeckCount.get(ids, since, until).n;
        if (total === 0) return { total: 0, cards: [] };

        const cards = this.stmt.archetypeAverage.all(ids, since, until).map((r) => ({
            cardId: r.cardId,
            name: r.name,
            kind: r.kind,
            setCode: r.setCode,
            number: r.number,
            // Averaged over every deck in the window, not just those running the card.
            average: r.copies / total,
            // How often it shows up at all, which distinguishes a 1-of everyone plays
            // from a 4-of only a few builds run.
            inclusion: r.decksWith / total,
            decksWith: r.decksWith,
        }));
        return { total, cards };
    }

    archetypeResults(deckIds, { since = null, until = null, limit = 50, offset = 0 } = {}) {
        return this.stmt.archetypeResults.all(JSON.stringify(deckIds), since, until, limit, offset);
    }

    allCards() {
        return this.stmt.allCards.all();
    }

    /**
     * Per-deck-id card totals and decklist counts for one window.
     * @param {string|null} since ISO date, or null for all time
     */
    deckCardTotals(since = null) {
        return {
            totals: this.stmt.allDeckCardTotals.all(since),
            counts: this.stmt.allDeckCounts.all(since),
        };
    }

    getGroupResults(cardIds, { limit = 150 } = {}) {
        return this.stmt.groupResults.all(JSON.stringify(cardIds), limit);
    }

    countGroupDecks(cardIds) {
        return this.stmt.countGroupDecks.get(JSON.stringify(cardIds)).n;
    }

    cardsWithoutPrints(limit = -1) {
        return this.stmt.cardsWithoutPrints.all(limit);
    }

    /**
     * Record that these printings are all one card.
     *
     * The group id is the alphabetically first print, including printings this corpus
     * has never seen — that keeps the id stable no matter which prints get played, and
     * every print of the card resolves to the same one.
     */
    savePrintGroup(cardId, prints) {
        const groupId = [...prints].sort()[0] ?? cardId;
        const now = new Date().toISOString();
        this.db.exec('BEGIN');
        try {
            // Every print named on the page joins the group, so looking up one print
            // settles all of them and the rest are never fetched.
            for (const id of new Set([...prints, cardId])) {
                this.stmt.setPrintGroup.run(id, groupId, id === cardId ? now : null);
            }
            this.db.exec('COMMIT');
        } catch (err) {
            this.db.exec('ROLLBACK');
            throw err;
        }
    }

    printGroupOf(cardId) {
        return this.stmt.printGroupOf.get(cardId)?.group_id ?? null;
    }

    printsInGroup(groupId) {
        return this.stmt.printsInGroup.all(groupId);
    }

    printStats() {
        return this.db.prepare(`
            SELECT (SELECT COUNT(*) FROM card) AS cards,
                   (SELECT COUNT(*) FROM card_print WHERE fetched_at IS NOT NULL) AS looked_up,
                   (SELECT COUNT(DISTINCT group_id) FROM card_print
                     WHERE card_id IN (SELECT id FROM card)) AS groups
        `).get();
    }

    /** @param {string} since ISO date */
    deckCardDaily(since) {
        return {
            totals: this.stmt.deckCardDaily.all(since),
            counts: this.stmt.deckCountsDaily.all(since),
        };
    }

    cardIndexStats() {
        return this.db.prepare(`
            SELECT (SELECT COUNT(*) FROM card) AS cards,
                   (SELECT COUNT(*) FROM card_play) AS plays
        `).get();
    }

    searchCards(term, limit = 25) {
        return this.stmt.searchCards.all(`%${term.toLowerCase()}%`, limit);
    }

    getCard(cardId) {
        return this.stmt.cardById.get(cardId.toUpperCase()) ?? null;
    }

    getCardResults(cardId, { limit = 50, offset = 0 } = {}) {
        return this.stmt.cardResults.all(cardId.toUpperCase(), limit, offset);
    }

    /**
     * Every deck at the card's most recent event, which is what a card page leads with.
     * Queried by tournament rather than taking a slice of the recent window, so a big
     * event is never truncated halfway through its standings.
     */
    getCardLatestEvent(cardId) {
        const id = cardId.toUpperCase();
        const latest = this.stmt.cardLatestTournament.get(id);
        if (!latest) return [];
        return this.stmt.cardResultsAtTournament.all(id, latest.id);
    }

    countTournaments(game = null, format = null) {
        return this.stmt.countTournaments.get(game, game, format, format).n;
    }

    /** @returns {string|null} */
    getState(key) {
        return this.stmt.getState.get(key)?.value ?? null;
    }

    setState(key, value) {
        this.stmt.setState.run(key, String(value));
    }

    allPlayers() {
        return this.stmt.allPlayers.all();
    }

    getPlayerHistoryFull(handle) {
        return this.stmt.playerHistoryFull.all(handle);
    }

    /** Every display name this handle has used, most recent first. */
    getPlayerNames(handle) {
        return this.stmt.playerNames.all(handle.toLowerCase()).map((r) => r.name);
    }

    coverage() {
        const c = this.stmt.coverage.get();
        return { from: c.from_, to: c.to_, gamesFormats: this.stmt.gamesFormats.all() };
    }

    searchPlayers(term, limit = 25) {
        const q = `%${term.toLowerCase()}%`;
        return this.stmt.searchPlayers.all(q, q, limit);
    }

    stats() {
        return this.stmt.stats.get();
    }
}
