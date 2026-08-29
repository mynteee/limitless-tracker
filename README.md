# limitless-tracker

Look up any Pokémon TCG player's tournament history from
[Limitless](https://play.limitlesstcg.com) — every event they entered, how they placed,
and the exact deck they brought.

Search a name or handle, and you get their full record, best finishes, archetypes over
time, and each decklist rendered the way Limitless renders it.

---

## Using the site

The published site is static and answers everything from pre-built data, so it stays fast
no matter how many people use it. Search by:

- **handle** — `awsomeguy1975`
- **display name** — `Mark Miller`
- **an old display name** — players rename themselves often, and searching a name someone
  used months ago still finds them under their current one

Click any event to expand the decklist. **List** shows it in Limitless' own format;
**Cards** shows the actual card images.

---

## Running it locally

### Requirements

**Node 22.5 or newer. That is the entire dependency list** — there is no `npm install`
step and nothing to compile. `fetch` and `node:sqlite` are both built into Node.

```bash
node --version
```

### Getting the data

**A fresh clone contains no tournament data.** The database and the built site are both
gitignored, because a year of decklists runs to several hundred megabytes. You build your
own copy — which is also how you get results newer than whatever was last published.

```bash
node src/cli.js crawl --limit 200
```

That fetches the 200 most recent tournaments — roughly **20 minutes** — which is plenty
for a working site. Then build it and open it:

```bash
node src/cli.js build
node src/cli.js serve
```

Then go to <http://localhost:8080>.

### Getting results that have not been published yet

If the deployed site is behind, or you want events from the last few days that nobody has
committed, run the crawler again. **It only fetches what it does not already have**, so a
catch-up run is short — usually a couple of minutes for a day or two of events:

```bash
node src/cli.js crawl     # pull anything new since last time
node src/cli.js build     # regenerate the site from your database
node src/cli.js serve
```

Nothing is ever downloaded twice. You can stop a crawl at any point with Ctrl-C and re-run
it later; it resumes exactly where it left off, so there is no penalty for interrupting.

Check what you currently hold at any time:

```bash
node src/cli.js stats
```

### Going further back

**Just run `crawl` again.** Once the newest events are already stored, a run does not
stop with nothing to do — it carries on into older pages and extends your history
backwards, remembering how deep it got so the next run resumes from there. Running it
repeatedly is therefore a backfill, with no special flag:

```bash
node src/cli.js crawl
```

The output labels which part of the archive each page came from:

```
  page 1 (recent): 0 new (0 total)
  page 47 (older): 19 new (19 total)
  page 48 (older): 50 new (69 total)
```

`recent` is catching up the front, `older` is extending history. Catching up the front
always happens, even mid-backfill, so today's events never wait behind a long backfill.

Useful limits:

| Flag | Effect |
|---|---|
| `--since 2026-01-01` | only events on or after this date |
| `--until 2026-06-30` | only events on or before this date |
| `--limit 500` | stop after 500 tournaments this run |
| `--max-minutes 60` | stop cleanly after an hour, resume later |
| `--no-deepen` | only catch up the newest events, never extend backwards |
| `--full` | re-walk the whole archive from the front, ignoring the cursor |

A full year takes roughly **3 hours** of crawling, and is safe to do in chunks across
several sessions. The archive itself goes back to August 2021 — about 251 listing pages,
or 12,600 tournaments — and once a crawl reaches the end it records that and stops
extending, since nothing is ever added to the old end.

---

## Why crawling takes a while

Limitless allows **50 requests every 5 minutes** — one every six seconds — and offers no
endpoint to search for a player. The only way to know someone's history is to read every
tournament's standings and index them locally. That is why this tool keeps a database
rather than querying live, and why the first run is not instant.

The crawler paces itself against that limit automatically and will not get you rate
limited.

---

## Commands

```bash
node src/cli.js <command>
```

| Command | What it does |
|---|---|
| `crawl` | Fetch new tournaments. Resumable and rate-limited. |
| `lookup <player>` | A player's full history in the terminal. |
| `search <term>` | Find a player by handle or any display name. |
| `card <name\|SET-NUM>` | Which decklists ran a card, newest event first. `--all` for earlier events. |
| `reindex` | Rebuild the card index from stored decklists. |
| `build` | Generate the static site into `dist/`. Needs no network. |
| `serve` | Preview the built site on <http://localhost:8080>. |
| `stats` | What your database holds, and how much is left to crawl. |
| `prune` | Remove stored events that no longer match your filters. |

`npm run crawl`, `npm run build`, `npm run serve` and so on are shortcuts for the same
thing. If you pass flags through npm you need an extra `--`, otherwise npm swallows them
and the crawl runs unbounded:

```bash
npm run crawl -- --limit 200     # correct
npm run crawl --limit 200        # WRONG: npm eats the flag
```

Calling `node src/cli.js` directly avoids the issue entirely. Run
`node src/cli.js --help` for every flag.

### Looking a player up without the site

```bash
node src/cli.js lookup awsomeguy1975
```

```
AwsomeGuy1975  (@awsomeguy1975)
also: Mark Miller
31 events · 33-62-0 · 34.7% win rate · best finish: 20th

Date        Placing    Record  Drop  Deck            Tournament
──────────  ─────────  ──────  ────  ──────────────  ─────────────────────────────
2026-08-19  171st/213  0-1-0   r1    Mega Excadrill  Amyverse PTCG Live Weekly #9
2026-08-16  20th/197   5-3-0         Alakazam Dud…   Monster Collectibles After H…
```

Add `--deck <tournamentId>` to print a full decklist, or `--json` for raw output.

---

## What gets collected

By default the crawler keeps **events with 50 or more players that used decklists**, and
skips the rest. A small event with no lists submitted is only a ranking, which is not what
this tool is for.

To change that:

```bash
node src/cli.js crawl --min-players 0 --all-events   # keep everything
node src/cli.js crawl --min-players 100              # only large events
```

If you tighten the filters later, `prune` clears out anything already stored that no
longer qualifies. It reports what it would remove and changes nothing unless you pass
`--apply`.

---

## Finding players who changed their name

Display names on Limitless are not stable — roughly **8% of players** have used more than
one, and they are often unrelated to each other or to the account. One player in the
current data has appeared as "Victor von Bak", "Jessica Bak" and "Jack Bak".

The account handle is the real identity, so search matches **the handle and every name a
player has ever used**. Searching an outdated name returns their complete history under
their current name, and both the site and `lookup` list the older names so you can confirm
you have the right person.

Handles never change, so if you know one it is always the reliable way in — `#/p/<handle>`
on the site, or `lookup <handle>` in the terminal.

---

## Publishing your own copy

The site is static, so it can be hosted anywhere. For GitHub Pages:

1. Enable **Settings → Pages → Source: GitHub Actions** on your fork.
2. The included workflow ([`.github/workflows/crawl.yml`](.github/workflows/crawl.yml))
   runs daily — it crawls new tournaments, rebuilds the site, and deploys it. The database
   is carried between runs in the Actions cache, so the data never enters git history.

You can also run it by hand from the Actions tab, with inputs for how long to run, minimum
event size, and how far back to go.

GitHub Pages caps a site at 1 GB. A year of full decklists lands around 640 MB, so if you
crawl several years pass `--decklist-months 12` when building, to publish lists only from
the last year. Placement history for everyone is always included and costs very little.

---

## Where the data comes from

- Tournament results: the [Limitless API](https://docs.limitlesstcg.com/developer.html).
  No API key required.
- Card images and card pages: Limitless' own CDN.
- Archetype sprites: [pokesprite](https://github.com/msikma/pokesprite), falling back to
  Limitless' sprites for Pokémon it does not cover.

This project is not affiliated with Limitless. Please be considerate of their API — the
crawler is deliberately rate-limited, and you should not remove those limits.

---

<details>
<summary><b>Implementation notes</b> — API behaviour and design decisions worth reading before changing anything</summary>

### Layout

```
src/
├── api/      errors.js · client.js (rate limiting) · limitless.js (endpoints)
├── db/       schema.sql · open.js · queries.js
├── ingest/   crawl.js  (discover + fetch, both resumable)
├── publish/  build.js (SQLite → static JSON) · search.js (shared rules) · serve.js
└── cli.js
site/                          the front end, copied verbatim into dist/
scripts/refresh-pokesprite.mjs
archive/tracker.js             the original prototype
data/limitless.db              gitignored
dist/                          gitignored
```

### API behaviour, verified against the live API rather than the docs

- **No player-search endpoint exists.** Player lookup is an indexing problem, which is why
  there is a database at all. The line that makes it work is
  `CREATE INDEX idx_standing_player ON standing(player)`.
- **`player` vs `name`.** `player` is the stable lowercase handle and the only safe
  identity key; `name` is the display name *at that event*.
- **`placing` can be `null`** for players who dropped, and those rows are *not* sorted to
  the bottom — a dropped player can sit at array index 0 while placing 1 sits at index 1.
  Array position carries no meaning and is deliberately not stored.
- **`drop` and `placing` are independent.** A player can drop and still be placed.
- **A missing tournament returns `400`, not `404`**, with the body
  `"Tournament not found."` The crawler therefore treats any non-retryable error as a
  permanent per-tournament failure instead of matching on status codes.
- **No server-side date filtering.** `before`, `after`, `from`, `to`, `startDate`,
  `endDate` and `date` are all silently ignored. `--since`/`--until` are applied
  client-side, which still pays off because the listing is newest-first, so discovery can
  stop paging early.
- **The listing carries no decklist flag**, so whether an event used decklists is only
  knowable after fetching its standings. Those events are recorded and never re-fetched.
- Only `/games/{id}/decks` needs an API key, and this project does not use it. If you have
  one, set `LIMITLESS_API_KEY` and it is sent automatically.

### Rate limiting

Every request goes through one choke point (`src/api/client.js`). It paces locally with a
token bucket *and* resyncs from the server's `RateLimit` headers after each call, taking
whichever view is stricter, so it adapts automatically if Limitless changes the quota.
Errors are typed and carry a `retryable` flag, so a network failure can never be mistaken
for "player not found".

### Published data layout

```
data/meta.json                     build info and coverage
data/icons.json                    which CDN each archetype sprite comes from
data/search/<pp>.json              n-gram index over handles and display names
data/players/<pp>/<handle>.json    placements and archetypes
data/decks/<pp>/<handle>.json      full decklists, fetched on demand
```

Placements and decklists are split because decklists are **93%** of a player's payload —
336 bytes of history versus 4.8 KB with lists attached. One file per player, sharded by
the first two characters of the handle, so a lookup is a single small request.

The site imports `search.js`, the same module the index was built with, so the client and
the data cannot drift apart.

The index is keyed on **every two-character substring** of the handle and of each word of
each name, not just the leading pair, so the site matches substrings anywhere the CLI does
— `essica` finds "Jessica", `alderon` finds `@josecalderon77`. Indexing only prefixes put
those players in a bucket the query never looked in. N-grams are split per word so they
never straddle a space; a multi-word query still resolves, because the bucket comes from
the first two characters typed.

This costs about 7.6x the index size (3.4 MB against 449 KB at the current corpus). The
distribution is very skewed but the shape is fine: the median bucket is 0.7 KB and the
hottest — `an` — is 56 KB, and a bucket is fetched once and then cached. Queries shorter
than two characters are rejected outright, since they cannot address a bucket.

### Card images

```
https://limitlesstcg.nyc3.cdn.digitaloceanspaces.com/tpci/{SET}/{SET}_{NNN}_R_EN{SIZE}.png
```

Two easily-missed details: the collector number is **zero-padded to three digits**
(`PBL-46` → `PBL_046`), and **`_R_` is a constant, not a rarity code**. With both applied
the pattern resolves for all 924 distinct cards in the corpus, so no rarity lookup is
needed. Sizes: `_XS` 136×189 · `_SM` 274×381 · `_MD` · `_LG` 460×640 · no suffix 736×1024.

### Archetype sprites

pokesprite covers Generations 1–8 only. Every Gen 9 Pokémon and all the current Megas are
absent — 33 of the 109 icons in use — and fall back to `r2.limitlesstcg.net`. Which source
to use is resolved at build time into `data/icons.json`, from a checked-in list of
pokesprite's contents, so the site never requests a sprite it knows will 404. Refresh that
list with `npm run refresh-sprites`.

</details>
