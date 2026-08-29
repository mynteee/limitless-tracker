import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

export const DEFAULT_DB_PATH = resolve(here, '..', '..', 'data', 'limitless.db');

/**
 * Open (creating if needed) the local store and apply the schema.
 *
 * Uses node:sqlite, which ships with Node 22.5+ — no npm dependency and no native
 * build step. It prints an ExperimentalWarning; the npm scripts pass
 * --disable-warning=ExperimentalWarning to keep crawl output readable.
 *
 * @param {string} [path]
 * @returns {DatabaseSync}
 */
export function openDb(path = DEFAULT_DB_PATH) {
    mkdirSync(dirname(path), { recursive: true });
    const db = new DatabaseSync(path);

    // WAL lets the site build read while a crawl is still writing.
    db.exec('PRAGMA journal_mode = WAL');
    // The crawler is restartable and every tournament is re-fetchable, so trading
    // durability-on-power-loss for write throughput is the right call here.
    db.exec('PRAGMA synchronous = NORMAL');
    db.exec('PRAGMA foreign_keys = ON');

    addMissingColumns(db);
    dropStaleDerived(db);
    db.exec(readFileSync(join(here, 'schema.sql'), 'utf8'));
    migrate(db);
    return db;
}

/**
 * Add columns to existing tables before the schema runs.
 *
 * CREATE TABLE IF NOT EXISTS leaves an existing table alone, so a column added later
 * never appears — and the schema then fails creating an index that references it.
 * Unlike the derived card tables these hold crawled data, so they are altered in
 * place and backfilled rather than dropped.
 */
function addMissingColumns(db) {
    const has = (table, column) =>
        db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);

    if (!db.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='standing'`).get()) {
        return;
    }
    if (!has('standing', 'date')) {
        db.exec('ALTER TABLE standing ADD COLUMN date TEXT');
        db.exec(`
            UPDATE standing
            SET date = (SELECT t.date FROM tournament t WHERE t.id = standing.tournament_id)
        `);
        // The old single-column index would otherwise shadow the new composite one.
        db.exec('DROP INDEX IF EXISTS idx_standing_deck');
    }
}

/**
 * Drop derived tables whose shape no longer matches the schema, before it is applied.
 *
 * CREATE TABLE IF NOT EXISTS will not alter a table that already exists, so a new
 * column on a derived table would leave the old shape in place and then fail on the
 * index that references the missing column. These tables hold nothing that cannot be
 * rebuilt from `standing` by `reindex`, so dropping is always safe — unlike the
 * crawled data, which is migrated in place.
 */
function dropStaleDerived(db) {
    const exists = db.prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'card_play'`,
    ).get();
    if (!exists) return;

    const columns = new Set(db.prepare(`PRAGMA table_info(card_play)`).all().map((c) => c.name));
    if (!columns.has('date')) {
        db.exec('DROP TABLE card_play');
        db.exec('DROP TABLE IF EXISTS card');
    }
}

/**
 * Additive migrations for databases created by an earlier version.
 *
 * schema.sql uses CREATE TABLE IF NOT EXISTS, so it will not alter a table that
 * already exists. Columns added after the first release have to be applied here.
 */
function migrate(db) {
    const columns = new Set(db.prepare(`PRAGMA table_info(tournament)`).all().map((c) => c.name));

    // 0 = the event ran without decklists, so it holds nothing but a ranking and its
    // standings are deliberately not stored. 1 = at least one list present.
    // NULL = ingested before this column existed, or not yet fetched.
    if (!columns.has('has_decklists')) {
        db.exec(`ALTER TABLE tournament ADD COLUMN has_decklists INTEGER`);
        // Backfill from what is already stored, so existing rows report accurately.
        db.exec(`
            UPDATE tournament SET has_decklists = (
                SELECT CASE WHEN COUNT(*) > 0 THEN 1 ELSE 0 END
                FROM standing s
                WHERE s.tournament_id = tournament.id AND s.decklist IS NOT NULL
            )
            WHERE standings_fetched_at IS NOT NULL
        `);
    }
}
