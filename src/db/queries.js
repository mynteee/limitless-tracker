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

            deleteStandings: db.prepare(`DELETE FROM standing WHERE tournament_id = ?`),

            insertStanding: db.prepare(`
                INSERT INTO standing (
                    tournament_id, player, name, country, placing,
                    wins, losses, ties, drop_round,
                    deck_id, deck_name, deck_icons, decklist
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
            this.stmt.deleteStandings.run(tournamentId);
            for (const r of rows) {
                this.stmt.insertStanding.run(
                    tournamentId, r.player, r.name, r.country, r.placing,
                    r.wins, r.losses, r.ties, r.dropRound,
                    r.deckId, r.deckName, r.deckIcons, r.decklist,
                );
            }
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
