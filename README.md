# limitless-tracker

Look up any Pokémon TCG player's tournament history from
[Limitless](https://play.limitlesstcg.com) — every event they entered, how they placed,
and the exact deck they brought.

Search a name or handle, and you get their full record, best finishes, archetypes over
time, and each decklist rendered the way Limitless renders it.

### **[→ mynteee.github.io/limitless-tracker](https://mynteee.github.io/limitless-tracker/)**

Already live, kept current by a daily crawl. **Nothing to install** — everything below is
only for running your own copy.

---

## Using the site

The published site is static and answers everything from pre-built data, so it stays fast
no matter how many people use it. Each kind of thing has its own box: the top bar searches
**players**, `#/decks` filters the archetype list, and `#/cards` searches cards. They are
kept apart so 133 archetypes and 2,160 card names cannot bury the person you came to find.

**Players** — search by handle (`awsomeguy1975`), display name (`Mark Miller`), or a name
someone used months ago; renames never hide a player. Click any event to expand the
decklist: **List** shows it in Limitless' own format, **Cards** shows the actual card art.

**Decks** — every archetype is at `#/decks`, with a filter box, a date window, and a
**Split variants** toggle that flattens the list to one row per variant ranked across all
archetypes. An archetype page shows the average decklist as card art badged with the mean
number of copies, plus its recent placements. Both scope to the last 30 days, 90 days or
all time, or a **Custom…** range given either as "last N days" or as explicit from/to
dates. Every variant has its own average however few decks it has, with the sample size
shown rather than being silently replaced.

**Cards** — search them at `#/cards`. A card page lists the decklists that ran it at its
newest event, sorted by placing, with the rest of its **complete** history behind a
toggle — every earlier event, labelled, and nothing truncated however common the card.
Clicking a row opens that decklist in place. Reprints share one page — see
[Reprints](#reprints).

---

## Running it locally

You do not need to. [The hosted site](https://mynteee.github.io/limitless-tracker/) is the
same build from the same data, and updates itself daily.

Run your own copy if you want results newer than the last daily build, a different crawl
policy (other games, formats or event sizes), or somewhere to develop against.

### Requirements

**Node 22.5 or newer. That is the entire dependency list** — there is no `npm install`
step and nothing to compile. `fetch` and `node:sqlite` are both built into Node.

```bash
node --version
```

### Getting the data

**A fresh clone contains no tournament data.** The database and the built site are both
gitignored, because a year of decklists runs to several hundred megabytes — which is why
[the hosted site](https://mynteee.github.io/limitless-tracker/) exists and why a local copy
starts empty.

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
several sessions.

**Nothing before 1 January 2020 is ever fetched.** Limitless keeps adding history at the
old end, so an unbounded backfill has no natural stopping point; the floor gives it one,
and a repeated `crawl` eventually finishes rather than running forever. A tighter
`--since` still applies on top of it. Once a crawl reaches the floor it records that and
stops extending, since nothing below it will ever appear.

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
| `decks` | List every archetype, most played first. `--variants` to break them out. |
| `deck <archetype>` | Average decklist, or `--results` for placements. `--days`, `--variant`. |
| `prints` | Work out which printings are the same card. Cached; run once. |
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

By default the crawler keeps **events with 16 or more players that used decklists**, and
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

## Reprints

The tournament API describes a decklist entry as `{count, set, number, name}` and nothing
more — no card text. A name alone cannot decide whether two printings are the same card:
this corpus holds **ten different Charcadet cards** that merely share a name, alongside
**Mystery Garden MEG-122 and ASC-194**, which are one card printed twice.

Limitless already answers this on each card page, so `prints` reads their grouping rather
than guessing:

```bash
node src/cli.js prints
```

It looks up only cards it has never seen, caches permanently, and is safe to interrupt.
Looking up one printing settles every other printing of that card at once. Card pages
then cover all printings together, counting a deck that runs two printings as one deck
with the copies summed, and any printing's URL resolves to the shared page.

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
- Archetype sprites: Limitless' own sprite set.

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

### Custom date ranges

Precomputed windows cannot answer an arbitrary range, so each archetype ships a sidecar
of **day buckets** — `archetypes/<id>.days.json`, plus `archetypes-days.json` for the
list — fetched only when someone actually picks a custom range. Day granularity is what
makes "last N days" exact.

They cover the most recent **400 days** on purpose. Unbounded they would grow with the
whole archive rather than staying fixed like the windows, and the largest archetype's
sidecar would reach tens of megabytes once the backfill runs to the 2020 floor. Bounded,
the worst case is 368 KB (Dragapult) and it stays there. Anything older is still covered
by the all-time window.

A custom range and its equivalent window agree to about 0.4% — windows cut at a timestamp,
custom ranges snap to whole days.

### Full card history

A card page embeds its newest event and nothing else. Everything the page does not already
show lives in packed sidecar pages (`cards/<pp>/<ID>.h<N>.json`), fetched a page at a time
when the history is opened, because a staple is in far more decklists than a page can
usefully hold — Boss's Orders appears in 97,983.

The two halves are cut at the same row. The page carries results `0..n`, the first sidecar
page starts at `n` — so the history repeats nothing already on screen and skips nothing
between them, and `results` plus every packed row is exactly the count in the headline.
`historyRows` says how many that is, which is what the toggle counts down.

Rows are packed against two shared dictionaries, `tournaments.json` and `decks.json`,
referencing them by index. That takes a row from roughly 150 bytes of repeated event names
down to about 30, which is what makes shipping all 2.9M of them practical. The
dictionaries are 75 KB and 12 KB, fetched once and reused by every card page.

The history labels each event where it starts, and an event can straddle a page boundary,
so the client carries the last one labelled across fetches rather than re-labelling from
the top of every page.

Only the largest events are bounded on the page itself, at 500 rows: a staple at a
4,000-player Internationals would otherwise put most of a megabyte in front of a visitor
before anything rendered. Past that the event simply continues into the history, and the
page says so. Most cards never page at all — the median card has 22 results — and a card
whose whole history is its newest event ships no sidecar pages.

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

All from `r2.limitlesstcg.net/pokemon/gen9`, which covers 159 of the 160 icons in use.
The odd one out is `substitute`, the "Other deck" placeholder, served from Limitless'
other host.

This used to prefer pokesprite for the Gen 1-8 names and fall back to Limitless for the
rest, but pokesprite pads every sprite to a uniform 68x56 canvas while Limitless crops
tight at ~41x34 — so in the same box a pokesprite Pokemon rendered visibly smaller than
the Limitless one beside it. One source is worth more than either sprite set's merits.


</details>
