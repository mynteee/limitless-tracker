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
    -- Denormalised from tournament, for the same reason card_play carries it: every
    -- archetype view is scoped to a date window, and without it SQLite finds all
    -- 20,000+ standings for an archetype and only then checks each one's date.
    date          TEXT,
    PRIMARY KEY (tournament_id, player)
) WITHOUT ROWID;

-- The index the API refuses to give us. Turns a multi-hour scan of every tournament
-- into a sub-millisecond lookup, and is the whole reason this project has a database.
CREATE INDEX IF NOT EXISTS idx_standing_player ON standing(player);

-- One row per distinct deck id, so archetype listings never have to read the standing
-- table. `standing` is WITHOUT ROWID and carries the decklist blob inline, so grouping
-- it by deck_id while also selecting the deck name drags ~180MB through the B-tree and
-- takes 8 seconds. Aggregating deck_id and date alone stays inside the covering index,
-- and the names come from here.
CREATE TABLE IF NOT EXISTS deck (
    id    TEXT PRIMARY KEY,
    name  TEXT,
    icons TEXT   -- JSON array
);

-- One row per distinct card ever played. Names are held here rather than repeated
-- across millions of play rows.
CREATE TABLE IF NOT EXISTS card (
    id     TEXT PRIMARY KEY,   -- "MEG-114"
    set_   TEXT NOT NULL,
    number TEXT NOT NULL,
    name   TEXT NOT NULL,
    kind   TEXT NOT NULL       -- pokemon | trainer | energy
);

CREATE INDEX IF NOT EXISTS idx_card_name ON card(name);

-- Which prints are the same card.
--
-- Sharing a name is NOT enough: Charcadet appears ten times in this corpus as ten
-- genuinely different cards, while Mystery Garden MEG-122 and ASC-194 are one card
-- printed twice. The only reliable answer is the card's own text, which the tournament
-- API never returns - so this is scraped from the "Prints" table Limitless publishes on
-- each card page, which is their authoritative grouping.
--
-- `group_id` is shared by every print of one card. `fetched_at` NULL means the card has
-- not been looked up yet, so `prints` only fetches what it is missing.
CREATE TABLE IF NOT EXISTS card_print (
    card_id    TEXT PRIMARY KEY,
    group_id   TEXT NOT NULL,
    fetched_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_card_print_group ON card_print(group_id);

-- Which decklists play which card. Decklists are stored as opaque JSON on `standing`,
-- which is right for reading one player's list back, but useless for the reverse
-- question - "which decks ran this card?" - because no index can reach inside a blob.
-- This is that reverse index, derived from the same JSON and rebuilt by `reindex`.
CREATE TABLE IF NOT EXISTS card_play (
    card_id       TEXT NOT NULL,
    tournament_id TEXT NOT NULL,
    player        TEXT NOT NULL,
    count         INTEGER NOT NULL,
    -- Denormalised from tournament. Card pages are ordered by event date, and a
    -- staple matches ~98,000 rows: without the date here every one of them has to be
    -- joined and sorted before LIMIT can apply, which measured at 5.9s per card and
    -- would put the site build into the hours.
    date          TEXT NOT NULL,
    PRIMARY KEY (card_id, tournament_id, player)
) WITHOUT ROWID;

-- Serves "most recent results for this card" straight from the index.
CREATE INDEX IF NOT EXISTS idx_card_play_recent ON card_play(card_id, date DESC);

-- Reaching the standing (and so the placing and deck) from a card.
CREATE INDEX IF NOT EXISTS idx_card_play_standing ON card_play(tournament_id, player);

-- Archetype views are always "this deck, in this window", so both columns are needed
-- for the window to narrow the scan rather than filter after it.
CREATE INDEX IF NOT EXISTS idx_standing_deck ON standing(deck_id, date DESC) WHERE deck_id IS NOT NULL;

-- Display-name search. Players are found by handle or by any display name they have
-- ever used, so this is indexed separately from the handle.
CREATE INDEX IF NOT EXISTS idx_standing_name ON standing(name) WHERE name IS NOT NULL;
