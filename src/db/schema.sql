-- Limitless tracker local store.
--
-- This database is the source of truth and keeps everything at full fidelity, so a
-- tournament is never crawled twice. The public static site is a projection of it.

CREATE TABLE IF NOT EXISTS tournament (
    id                   TEXT PRIMARY KEY,
    game                 TEXT NOT NULL,
    format               TEXT,
    name                 TEXT NOT NULL,
    date                 TEXT NOT NULL,   -- ISO 8601, as returned by the API
    players              INTEGER,
    organizer_id         INTEGER,
    -- NULL means standings have not been ingested yet. This single column is the
    -- entire resume mechanism: kill the crawler anywhere and the next run continues
    -- exactly where it stopped, with no separate state file to get out of sync.
    standings_fetched_at TEXT,
    standings_count      INTEGER,
    -- Set when standings are permanently unavailable so we stop retrying forever.
    fetch_error          TEXT,
    -- 0 = ran without decklists. Such an event is only a ranking, which is not what
    -- this project is for, so its standings are marked fetched but never stored.
    -- 1 = at least one list present. NULL = not yet fetched.
    has_decklists        INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tournament_date ON tournament(date DESC);

-- Small key/value scratchpad for the crawler. Currently holds, per game+format, how
-- deep into the listing discovery has walked, so a run that finds nothing new at the
-- front can carry on extending history backwards instead of doing nothing.
CREATE TABLE IF NOT EXISTS crawl_state (
    key   TEXT PRIMARY KEY,
    value TEXT
);

-- Partial index: the crawler asks "what is left to do?" on every batch, and this
-- keeps that query proportional to the work remaining rather than the corpus size.
CREATE INDEX IF NOT EXISTS idx_tournament_pending
    ON tournament(date DESC)
    WHERE standings_fetched_at IS NULL AND fetch_error IS NULL;

CREATE TABLE IF NOT EXISTS standing (
    tournament_id TEXT NOT NULL REFERENCES tournament(id) ON DELETE CASCADE,
    -- Canonical lowercase handle. Stable across events; this is the identity key.
    player        TEXT NOT NULL,
    -- Display name as it appeared at THIS event. Mutable, and not an identity.
    name          TEXT,
    country       TEXT,
    -- NULL for players who dropped. Never assume this is dense or ordered.
    placing       INTEGER,
    wins          INTEGER,
    losses        INTEGER,
    ties          INTEGER,
    drop_round    INTEGER,
    deck_id       TEXT,
    deck_name     TEXT,
    deck_icons    TEXT,   -- JSON array
    decklist      TEXT,   -- JSON blob: { pokemon[], trainer[], energy[] }
    PRIMARY KEY (tournament_id, player)
) WITHOUT ROWID;

-- The index the API refuses to give us. Turns a multi-hour scan of every tournament
-- into a sub-millisecond lookup, and is the whole reason this project has a database.
CREATE INDEX IF NOT EXISTS idx_standing_player ON standing(player);

-- Supports archetype queries ("who played Dragapult Dusknoir?") in later phases.
CREATE INDEX IF NOT EXISTS idx_standing_deck ON standing(deck_id) WHERE deck_id IS NOT NULL;

-- Display-name search. Players are found by handle or by any display name they have
-- ever used, so this is indexed separately from the handle.
CREATE INDEX IF NOT EXISTS idx_standing_name ON standing(name) WHERE name IS NOT NULL;
