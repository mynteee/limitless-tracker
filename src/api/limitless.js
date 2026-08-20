import { ApiClient } from './client.js';
import { MalformedResponseError } from './errors.js';

/**
 * Typed wrappers over the Limitless endpoints, plus normalisation from the wire
 * shape into the shape the database stores.
 *
 * Base: https://play.limitlesstcg.com/api — no auth required for anything used here.
 */
export class LimitlessApi {
    constructor(client = new ApiClient()) {
        this.client = client;
    }

    get stats() {
        return this.client.stats;
    }

    /**
     * GET /tournaments
     * @param {{game?: string, format?: string, organizerId?: number, limit?: number, page?: number}} opts
     * @returns {Promise<Array<{id,game,format,name,date,players,organizerId}>>}
     */
    async listTournaments({ game, format, organizerId, limit = 50, page } = {}) {
        const body = await this.client.get('/tournaments', { game, format, organizerId, limit, page });
        if (!Array.isArray(body)) {
            throw new MalformedResponseError('/tournaments', `expected an array, got ${typeof body}`);
        }
        return body.map(normalizeTournament);
    }

    /**
     * GET /tournaments/{id}/standings — one request per tournament, ever.
     * @returns {Promise<Array<ReturnType<typeof normalizeStanding>>>}
     */
    async getStandings(tournamentId) {
        const path = `/tournaments/${encodeURIComponent(tournamentId)}/standings`;
        const body = await this.client.get(path);
        if (!Array.isArray(body)) {
            throw new MalformedResponseError(path, `expected an array, got ${typeof body}`);
        }
        return body.map((row, i) => normalizeStanding(row, path, i));
    }

    /** GET /tournaments/{id}/details */
    getDetails(tournamentId) {
        return this.client.get(`/tournaments/${encodeURIComponent(tournamentId)}/details`);
    }

    /** GET /tournaments/{id}/pairings */
    getPairings(tournamentId) {
        return this.client.get(`/tournaments/${encodeURIComponent(tournamentId)}/pairings`);
    }

    /** GET /games — id, name, formats{}, platforms{}, metagame */
    getGames() {
        return this.client.get('/games');
    }
}

function normalizeTournament(raw) {
    return {
        id: raw.id,
        game: raw.game,
        format: raw.format ?? null,
        name: raw.name ?? '',
        date: raw.date,
        players: Number.isFinite(raw.players) ? raw.players : null,
        // Present in live responses but absent from the published docs.
        organizerId: Number.isFinite(raw.organizerId) ? raw.organizerId : null,
    };
}

/**
 * Flatten one standing into a database row.
 *
 * Two details the prototype got wrong, both verified against live data:
 *
 *  - `player` is the stable lowercase handle and is the identity key. `name` is the
 *    display name *at this event* and changes over time (handle `flewis` displays as
 *    "Filip K"). Matching on either one conflates two different things.
 *  - `placing` is null for players who dropped, and such rows are not sorted to the
 *    bottom — a dropped player can sit at array index 0 while placing 1 sits at index 1.
 *    Array position carries no meaning and is deliberately not stored.
 */
export function normalizeStanding(raw, path = '<standings>', index = -1) {
    if (!raw || typeof raw.player !== 'string' || raw.player === '') {
        throw new MalformedResponseError(path, `row ${index} has no player handle`);
    }
    const record = raw.record ?? {};
    return {
        player: raw.player.toLowerCase(),
        name: raw.name ?? null,
        country: raw.country ?? null,
        placing: Number.isFinite(raw.placing) ? raw.placing : null,
        wins: Number.isFinite(record.wins) ? record.wins : null,
        losses: Number.isFinite(record.losses) ? record.losses : null,
        ties: Number.isFinite(record.ties) ? record.ties : null,
        dropRound: Number.isFinite(raw.drop) ? raw.drop : null,
        deckId: raw.deck?.id ?? null,
        deckName: raw.deck?.name ?? null,
        deckIcons: raw.deck?.icons ? JSON.stringify(raw.deck.icons) : null,
        // ~88.5% of the payload. Stored verbatim as JSON: dedup across players measured
        // at only 2.8%, so content-addressing it would not pay for the complexity.
        decklist: raw.decklist ? JSON.stringify(raw.decklist) : null,
    };
}
