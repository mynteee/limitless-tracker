import { entryTerms, matchesEntry, shard } from './search.js';

/* ── data sources ─────────────────────────────────────────────────────────── */

/** Card fronts. `_R_` is a constant in the path, not a rarity code, and the collector
 *  number is zero-padded to three digits. Verified against all 924 cards in the corpus. */
const CARD_CDN = 'https://limitlesstcg.nyc3.cdn.digitaloceanspaces.com/tpci';
/** 274x381, ~60 KB. Enough for a grid at 2x without pulling the 700 KB original. */
const CARD_SIZE = '_SM';

/**
 * Archetype sprites, all from Limitless.
 *
 * pokesprite used to serve the Gen 1-8 names, but it pads every sprite to a uniform
 * 68x56 canvas while Limitless crops tight at ~41x34 — so in the same box a pokesprite
 * Pokemon rendered visibly smaller than the one beside it. One source keeps them
 * consistent, and Limitless has all 160 icons in use.
 */
const LIMITLESS_CDN = 'https://r2.limitlesstcg.net/pokemon/gen9';
/** The "Other deck" placeholder is not a Pokemon and lives on Limitless' other host. */
const SUBSTITUTE_ICON = 'https://limitless3.nyc3.cdn.digitaloceanspaces.com/pokemon/substitute.png';
const FLAG_CDN = 'https://r2.limitlesstcg.net/flags';

const view = document.getElementById('view');
const input = document.getElementById('q');

let meta = null;

const cache = new Map();
async function getJson(path) {
    if (cache.has(path)) return cache.get(path);
    const promise = fetch(path)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null);
    cache.set(path, promise);
    return promise;
}

/* ── helpers ──────────────────────────────────────────────────────────────── */

const esc = (s) =>
    String(s ?? '').replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function ordinal(n) {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] ?? s[v] ?? s[0]);
}

function iconUrl(name) {
    if (name === 'substitute') return SUBSTITUTE_ICON;
    return `${LIMITLESS_CDN}/${encodeURIComponent(name)}.png`;
}

const pad3 = (n) => String(n).padStart(3, '0');
const cardImage = (set, number) =>
    `${CARD_CDN}/${set}/${set}_${pad3(number)}_R_EN${CARD_SIZE}.png`;
/** Limitless' own card page — the same destination its decklists link to. */
const cardPage = (set, number) => `https://limitlesstcg.com/cards/${set}/${number}`;

function deckIcons(deck, cls = '') {
    if (!deck?.icons?.length) return '';
    return deck.icons
        .map((n) => `<img class="icon small ${cls}" src="${esc(iconUrl(n))}" alt="" loading="lazy">`)
        .join('');
}

/* ── date ranges ──────────────────────────────────────────────────────────── */

/** Days covered by the time filters on first load. */
const DEFAULT_WINDOW = 90;

const dayMs = 86_400_000;
const isoDay = (d) => new Date(d).toISOString().slice(0, 10);

/**
 * A custom range chosen on a page: either the last N days, or explicit from/to dates.
 * Both resolve to an inclusive pair of YYYY-MM-DD strings, which is the granularity the
 * published day buckets hold.
 */
function resolveRange(custom) {
    if (!custom) return null;
    if (custom.kind === 'days') {
        const n = Math.max(1, Number(custom.days) || 1);
        return { from: isoDay(Date.now() - (n - 1) * dayMs), to: isoDay(Date.now()), label: `Last ${n} days` };
    }
    const from = custom.from || '0000-01-01';
    const to = custom.to || isoDay(Date.now());
    // Accept the ends either way round rather than silently returning nothing.
    const [a, b] = from <= to ? [from, to] : [to, from];
    return { from: a, to: b, label: `${a} to ${b}` };
}

/** The form behind the Custom chip. Shared by the archetype list and archetype pages. */
function customRangeForm(id, custom) {
    const c = custom ?? { kind: 'days', days: 14 };
    return `<form class="range-form" id="${id}">
        <label><input type="radio" name="${id}-kind" value="days"
          ${c.kind === 'days' ? 'checked' : ''}> Last
          <input type="number" name="days" min="1" max="3650" value="${c.kind === 'days' ? c.days : 14}"> days</label>
        <label><input type="radio" name="${id}-kind" value="range"
          ${c.kind === 'range' ? 'checked' : ''}> From
          <input type="date" name="from" value="${c.from ?? ''}"> to
          <input type="date" name="to" value="${c.to ?? ''}"></label>
        <button type="submit">Apply</button>
      </form>`;
}

/** Read a custom range back out of the form. */
function readRangeForm(form) {
    const data = new FormData(form);
    const kind = data.get(`${form.id}-kind`) ?? 'days';
    return kind === 'days'
        ? { kind: 'days', days: Number(data.get('days')) || 14 }
        : { kind: 'range', from: data.get('from') || '', to: data.get('to') || '' };
}

/* ── search ───────────────────────────────────────────────────────────────── */

/**
 * How well an index entry answers what was typed.
 *
 * The published buckets are sorted without knowing the search term, so ordering by
 * relevance has to happen here: an exact name beats a prefix, which beats matching a
 * word somewhere in the middle.
 */
function relevance(entry, term) {
    const names = entryTerms(entry);

    let score = 0;
    if (names.some((n) => n === term)) score += 100;
    else if (names.some((n) => n.startsWith(term))) score += 50;
    else if (names.some((n) => n.split(/[^a-z0-9]+/).includes(term))) score += 25;

    return score;
}

async function runSearch(term) {
    const t = term.trim().toLowerCase();
    if (t.length < 2) {
        view.innerHTML = `<p class="empty">Type at least two characters.</p>`;
        return;
    }
    // Players only. Decks and cards each have their own page and their own box: one
    // index still holds all three, but mixing 133 archetypes and 2,160 card names into
    // these results buries the person someone actually came to find.
    const bucket = await getJson(`data/search/${shard(t)}.json`);
    const hits = (bucket ?? [])
        .filter((e) => !e.type && matchesEntry(e, t))
        .sort((a, b) => relevance(b, t) - relevance(a, t) || b.events - a.events)
        .slice(0, 60);

    if (hits.length === 0) {
        view.innerHTML = `<p class="empty">No players matching “${esc(term)}”.</p>`;
        return;
    }

    view.innerHTML = `
      <div class="results">${hits
        .map((e) => {
            // Surface that a player has used other names, so a hit on an outdated one
            // does not look like the wrong person.
            const alias = e.names?.length > 1
                ? `<span class="alias">also ${esc(e.names.slice(1, 3).join(', '))}</span>`
                : '';
            return `<a class="result" href="#/p/${encodeURIComponent(e.handle)}">
                <span class="name">${esc(e.name)}</span>
                <span class="handle">@${esc(e.handle)}</span>
                ${alias}
                <span class="spacer"></span>
                <span class="count">${e.events} event${e.events === 1 ? '' : 's'} · last ${esc(e.last)}</span>
            </a>`;
        })
        .join('')}</div>`;
}

/* ── player page ──────────────────────────────────────────────────────────── */

async function renderPlayer(handle) {
    view.innerHTML = `<p class="empty">Loading…</p>`;
    const player = await getJson(`data/players/${shard(handle)}/${encodeURIComponent(handle)}.json`);
    if (!player) {
        view.innerHTML = `<p class="empty">No player <b>@${esc(handle)}</b> in this dataset.</p>`;
        return;
    }

    const games = player.record.wins + player.record.losses + player.record.ties;
    const winRate = games ? ((player.record.wins / games) * 100).toFixed(1) + '%' : '—';
    const flag = player.country
        ? `<img class="flag" src="${FLAG_CDN}/${esc(player.country)}.png" alt="${esc(player.country)}">`
        : '';
    const aka = player.names.length > 1
        ? `<p class="aka">also known as ${player.names.slice(1).map(esc).join(', ')}</p>`
        : '';

    view.innerHTML = `
      <div class="player-head">
        <h1>${esc(player.name)} ${flag}<span class="handle">@${esc(player.handle)}</span></h1>
        ${aka}
        <div class="stat-row">
          <span><b>${player.events}</b> events</span>
          <span><b>${player.record.wins}-${player.record.losses}-${player.record.ties}</b> record</span>
          <span><b>${winRate}</b> win rate</span>
          ${player.best ? `<span>best <b>${ordinal(player.best)}</b></span>` : ''}
          ${player.drops ? `<span><b>${player.drops}</b> drops</span>` : ''}
        </div>
      </div>
      <div class="history">${player.history.map(eventRow).join('')}</div>`;

    view.querySelectorAll('.event-row').forEach((btn) => {
        btn.addEventListener('click', () => toggleDecklist(btn, player.handle));
    });
}

function eventRow(h) {
    // placing is null for players who went unplaced, usually after dropping. It is not
    // a zero and must not be rendered as one.
    const placing = h.placing === null
        ? `<span class="placing none">—</span>`
        : `<span class="placing${h.placing <= 8 ? ' top' : ''}">${ordinal(h.placing)}</span>`;
    const field = h.fieldSize ? `<span class="muted"> /${h.fieldSize}</span>` : '';
    const drop = h.dropRound !== null ? ` <span class="muted">drop r${h.dropRound}</span>` : '';

    return `<div class="event" data-tid="${esc(h.tournamentId)}" data-haslist="${h.hasList ? 1 : 0}">
      <button class="event-row" type="button" aria-expanded="false">
        <span class="date">${esc(h.date.slice(0, 10))}</span>
        <span>${placing}${field}</span>
        <span class="record">${h.wins ?? 0}-${h.losses ?? 0}-${h.ties ?? 0}${drop}</span>
        <span class="deck">${deckIcons(h.deck)}<span>${esc(h.deck?.name ?? '—')}</span></span>
        <span class="tname muted">${esc(h.tournament)}</span>
      </button>
    </div>`;
}

/* ── decklist ─────────────────────────────────────────────────────────────── */

const GROUPS = [['pokemon', 'Pokémon'], ['trainer', 'Trainer'], ['energy', 'Energy']];
const countOf = (cards) => cards.reduce((a, c) => a + c.count, 0);

async function toggleDecklist(btn, handle) {
    const event = btn.parentElement;
    const open = event.querySelector('.decklist');
    if (open) {
        open.remove();
        btn.setAttribute('aria-expanded', 'false');
        return;
    }
    btn.setAttribute('aria-expanded', 'true');

    if (event.dataset.haslist !== '1') {
        event.insertAdjacentHTML('beforeend',
            `<div class="decklist"><p class="muted">No decklist published for this event.</p></div>`);
        return;
    }

    event.insertAdjacentHTML('beforeend', `<div class="decklist"><p class="muted">Loading…</p></div>`);
    const decks = await getJson(`data/decks/${shard(handle)}/${encodeURIComponent(handle)}.json`);
    const list = decks?.lists?.[event.dataset.tid];
    const box = event.querySelector('.decklist');

    if (!list) {
        box.innerHTML = `<p class="muted">Decklist unavailable.</p>`;
        return;
    }

    showDecklist(box, list);
}

/** Draw a decklist with its List/Cards toggle. Shared by every page that shows one. */
function showDecklist(box, list) {
    const draw = (mode) => {
        box.innerHTML = `
          <div class="dl-tools">
            <button type="button" data-mode="list" aria-pressed="${mode === 'list'}">List</button>
            <button type="button" data-mode="cards" aria-pressed="${mode === 'cards'}">Cards</button>
            <span class="muted" style="font-size:.8rem">${countOf(
                GROUPS.flatMap(([k]) => list[k] ?? []),
            )} cards</span>
            <button type="button" class="dl-copy" title="Copy in the format Pokémon TCG Live imports">Copy for PTCGL</button>
          </div>
          ${mode === 'list' ? renderList(list) : renderCards(list)}`;
        box.querySelectorAll('.dl-tools [data-mode]').forEach((b) =>
            b.addEventListener('click', () => draw(b.dataset.mode)));
        box.querySelector('.dl-copy').addEventListener('click', (e) => copyDecklist(e.currentTarget, box, list));
    };
    draw('list');
}

/* ── PTCGL export ─────────────────────────────────────────────────────────── */

/**
 * Limitless and PTCGL share set codes with one exception in this corpus: Scarlet &
 * Violet promos are SVP on Limitless and PR-SV in the game. MEP, PK and every
 * expansion pass through unchanged, which is exactly what Limitless' own "Copy to
 * Clipboard" does.
 */
const PTCGL_SETS = { SVP: 'PR-SV' };

/** A decklist as the text PTCGL's import box takes, laid out like Limitless' own export. */
function ptcglText(list) {
    return GROUPS.map(([key, label]) => {
        const cards = list[key] ?? [];
        if (!cards.length) return '';
        return [
            `${label}: ${countOf(cards)}`,
            ...cards.map((c) => `${c.count} ${c.name} ${PTCGL_SETS[c.set] ?? c.set} ${c.number}`),
        ].join('\n');
    }).filter(Boolean).join('\n\n');
}

/**
 * Put the list on the clipboard. Where the async API is refused — an embedded frame, a
 * dismissed permission prompt — the older selection copy usually still works; where
 * even that fails, the text stays on screen selected, one Ctrl+C away rather than lost.
 */
async function copyDecklist(btn, box, list) {
    const text = ptcglText(list);
    box.querySelector('.dl-export')?.remove();

    let copied = await navigator.clipboard?.writeText(text).then(() => true, () => false);
    if (!copied) {
        box.querySelector('.dl-tools').insertAdjacentHTML('afterend',
            `<textarea class="dl-export" readonly rows="8" aria-label="Decklist for PTCGL">${esc(text)}</textarea>`);
        const area = box.querySelector('.dl-export');
        area.select();
        copied = document.execCommand('copy');
        if (!copied) {
            btn.textContent = 'Press Ctrl+C';
            return;
        }
        area.remove();
        btn.focus();
    }
    btn.textContent = 'Copied!';
    btn.classList.add('done');
    clearTimeout(btn.resetTimer);
    btn.resetTimer = setTimeout(() => {
        btn.textContent = 'Copy for PTCGL';
        btn.classList.remove('done');
    }, 1500);
}

/**
 * Expand the decklist behind a result row, in place.
 *
 * Rows on the card and archetype pages are about the deck that was played, so opening
 * one shows that list rather than navigating away to the player who brought it. The
 * player is still one click further in, from the row's own link.
 */
async function toggleRowDecklist(row) {
    const open = row.nextElementSibling;
    if (open?.classList.contains('row-decklist')) {
        open.remove();
        row.setAttribute('aria-expanded', 'false');
        return;
    }
    // Only one open at a time, or the table turns into a wall of lists.
    row.parentElement.querySelectorAll('.row-decklist').forEach((el) => el.remove());
    row.parentElement.querySelectorAll('.crow[aria-expanded="true"]')
        .forEach((el) => el.setAttribute('aria-expanded', 'false'));

    row.setAttribute('aria-expanded', 'true');
    row.insertAdjacentHTML('afterend',
        `<div class="row-decklist"><p class="muted">Loading…</p></div>`);
    const box = row.nextElementSibling;

    const { handle, tid } = row.dataset;
    const decks = await getJson(`data/decks/${shard(handle)}/${encodeURIComponent(handle)}.json`);
    const list = decks?.lists?.[tid];
    if (!list) {
        box.innerHTML = `<p class="muted">No decklist published for this entry.</p>`;
        return;
    }
    showDecklist(box, list);
}

/**
 * Wire every result row inside a container to expand its decklist.
 *
 * Only rows that name a decklist, and only once each. The card history grows a page at
 * a time and is re-wired after every one, so a row that already has its listener must
 * not collect a second: two listeners open the list and immediately close it again,
 * which reads as a dead row. Header rows carry no handle and are skipped.
 */
function wireRows(container) {
    container.querySelectorAll('.crow[data-handle]:not([data-wired])').forEach((row) => {
        row.dataset.wired = '1';
        row.addEventListener('click', (e) => {
            // The player link inside the row still navigates.
            if (e.target.closest('a')) return;
            toggleRowDecklist(row);
        });
    });
}

/**
 * Text view, laid out the way Limitless does it: one column per group, each line
 * "<count> <name>", with the set and number shown for Pokémon only, and every card
 * linking to its page on limitlesstcg.com.
 */
function renderList(list) {
    return `<div class="dl-columns">${GROUPS.map(([key, label]) => {
        const cards = list[key] ?? [];
        if (!cards.length) return '';
        return `<div class="dl-group">
          <h3>${label} (${countOf(cards)})</h3>
          ${cards.map((c) => `<p>
            <span class="n">${c.count}</span>
            <a href="${esc(cardPage(c.set, c.number))}" target="_blank" rel="noopener">${esc(c.name)}</a>
            ${key === 'pokemon' ? `<span class="set">(${esc(c.set)}-${esc(c.number)})</span>` : ''}
          </p>`).join('')}
        </div>`;
    }).join('')}</div>`;
}

/** Card view: the actual card fronts, with the count as a badge. */
function renderCards(list) {
    return GROUPS.map(([key, label]) => {
        const cards = list[key] ?? [];
        if (!cards.length) return '';
        return `<div class="dl-grid-group">
          <h3>${label} (${countOf(cards)})</h3>
          <div class="dl-grid">${cards.map((c) => `
            <a class="dl-card" href="${esc(cardPage(c.set, c.number))}" target="_blank" rel="noopener"
               title="${esc(c.count)}× ${esc(c.name)} (${esc(c.set)}-${esc(c.number)})">
              <img src="${esc(cardImage(c.set, c.number))}" alt="${esc(c.name)}" loading="lazy">
              <span class="qty">${c.count}</span>
            </a>`).join('')}</div>
        </div>`;
    }).join('');
}

/* ── card page ────────────────────────────────────────────────────────────── */

/** Rows for one tournament, laid out like Limitless' "Decklists that include this card". */
function cardResultRows(rows) {
    return rows.map((r) => `<div class="crow" role="button" tabindex="0" aria-expanded="false"
        data-handle="${esc(r.handle)}" data-tid="${esc(r.tournamentId)}">
        <span class="place">${r.placing === null ? '—' : ordinal(r.placing)}${
            r.fieldSize ? `<span class="of">/${r.fieldSize}</span>` : ''}</span>
        <span class="deck">${deckIcons(r.deck)}<span>${esc(r.deck?.name ?? 'Other')}</span></span>
        <a class="who" href="#/p/${encodeURIComponent(r.handle)}">${esc(r.name)}</a>
        <span class="qty-inline">${r.count}&times;</span>
      </div>`).join('');
}

/**
 * A card page, following the reprint stub to whichever printing holds the data.
 *
 * Reprints share one page and every other printing is published as a stub pointing at
 * it, so an old link or a typed set code still lands on the card rather than a 404.
 * Returns the id the data actually lives under, which is not always the one asked for.
 */
async function loadCardPage(id) {
    const load = (cid) =>
        getJson(`data/cards/${shard(cid.toLowerCase())}/${encodeURIComponent(cid)}.json`);

    const first = await load(id);
    if (!first?.alias) return { card: first, id };
    return { card: await load(first.alias), id: first.alias };
}

async function renderCard(id) {
    view.innerHTML = `<p class="empty">Loading…</p>`;
    const { card, id: shownAs } = await loadCardPage(id);
    if (shownAs !== id) {
        window.history.replaceState(null, '', `#/c/${encodeURIComponent(shownAs)}`);
    }
    if (!card) {
        view.innerHTML = `<p class="empty">No card <b>${esc(id)}</b> in this dataset.</p>`;
        return;
    }

    // The default view is the newest event on its own, which is how Limitless shows it.
    // The build embeds exactly those rows; everything the page does not already show
    // comes from the packed history pages, loaded on demand.
    const latest = card.results;

    view.innerHTML = `
      <div class="card-head">
        <a class="card-art" href="${esc(cardPage(card.setCode, card.number))}" target="_blank" rel="noopener">
          <img src="${esc(cardImage(card.setCode, card.number))}" alt="${esc(card.name)}" loading="lazy">
        </a>
        <div>
          <h1>${esc(card.name)}</h1>
          <p class="muted">${esc(card.setCode)}-${esc(card.number)} · ${esc(card.kind)}</p>
          <div class="stat-row"><span><b>${card.decks.toLocaleString()}</b> decklists</span></div>
          ${card.prints?.length > 1 ? `<p class="prints">Also printed as
            ${card.prints.slice(1).map((p) => `<a href="${esc(cardPage(p.setCode, p.number))}"
              target="_blank" rel="noopener">${esc(p.id)}</a>`).join(', ')}
            <span class="muted">— counted together here</span></p>` : ''}
        </div>
      </div>

      <h2>Decklists that include this card</h2>
      <p class="muted">${esc(latest[0]?.tournament ?? '')} · ${esc(latest[0]?.date ?? '')}</p>
      <div class="ctable">
        <div class="crow head"><span>Place</span><span>Deck</span><span>Player</span><span>Copies</span></div>
        ${cardResultRows(latest)}
      </div>

      ${card.latestTotal > latest.length
        ? `<p class="muted note">The top ${latest.length.toLocaleString()} of
           ${card.latestTotal.toLocaleString()} at this event. The rest of it opens with
           the history below.</p>` : ''}

      ${card.historyRows > 0 ? `
        <button class="more" id="card-more">Show full history (${card.historyRows.toLocaleString()} more)</button>
        <div id="card-history" hidden>
          <div class="ctable" id="card-history-rows"></div>
          <p class="muted note" id="card-history-status" hidden></p>
          <button class="more" id="card-more-pages" hidden></button>
        </div>` : ''}
    `;

    wireRows(view);
    wireCardHistory(card);
}

/**
 * Full history, loaded from the packed sidecar pages.
 *
 * The card page itself only carries its newest event; everything else is fetched on
 * demand, a page at a time. A staple appears in tens of thousands of decklists, so
 * shipping that inline would make every card page enormous for a view most visitors
 * never open.
 */
async function wireCardHistory(card) {
    const btn = document.getElementById('card-more');
    if (!btn) return;

    const box = document.getElementById('card-history');
    const rowsBox = document.getElementById('card-history-rows');
    const status = document.getElementById('card-history-status');
    const moreBtn = document.getElementById('card-more-pages');

    let loaded = 0;
    let shown = 0;
    // A staple's first page is a real fetch, and the toggle stays clickable during it.
    // Without this a fast second open starts the same page over and appends it twice.
    let loading = false;
    /** An event is labelled once, where it starts. One can straddle a page boundary, so
     *  which event the list is in has to carry across fetches; starting from nothing
     *  means the history always names the event it opens on, including the newest one
     *  where the page's own table stopped part-way through it. */
    let labelled = null;

    const loadPage = async () => {
        if (loading) return;
        loading = true;
        moreBtn.disabled = true;
        status.hidden = false;
        status.textContent = 'Loading…';

        const [dicts, page] = await Promise.all([
            historyDicts(),
            getJson(`data/cards/${shard(card.id.toLowerCase())}/${encodeURIComponent(card.id)}.h${loaded}.json`),
        ]);
        // Say so rather than quietly stopping short of a history billed as complete.
        if (!page) {
            status.textContent = 'Could not load the rest of this history.';
            moreBtn.disabled = false;
            loading = false;
            return;
        }

        const html = page.map((packed) => {
            const r = unpackRow(packed, dicts);
            // Label each event once, as the list walks back through them.
            const header = r.tournamentId === labelled ? '' :
                `<div class="crow sub"><span></span><span class="ev">${esc(r.tournament)}</span>
                 <span class="muted">${esc(r.date)}</span><span></span></div>`;
            labelled = r.tournamentId;
            return header + cardResultRows([r]);
        }).join('');

        rowsBox.insertAdjacentHTML('beforeend', html);
        wireRows(rowsBox);
        loaded++;
        shown += page.length;

        status.hidden = true;
        moreBtn.hidden = loaded >= card.historyPages;
        moreBtn.disabled = false;
        moreBtn.textContent = `Load ${Math.max(0, card.historyRows - shown).toLocaleString()} more`;
        loading = false;
    };

    btn.addEventListener('click', async () => {
        box.hidden = !box.hidden;
        btn.textContent = box.hidden
            ? `Show full history (${card.historyRows.toLocaleString()} more)`
            : 'Hide history';
        if (!box.hidden && loaded === 0) await loadPage();
    });
    moreBtn.addEventListener('click', loadPage);
}

/** Tournament and deck dictionaries, fetched once and reused by every card page. */
let dictsPromise;
function historyDicts() {
    dictsPromise ??= Promise.all([getJson('data/tournaments.json'), getJson('data/decks.json')])
        .then(([tournaments, decks]) => ({ tournaments: tournaments ?? [], decks: decks ?? [] }));
    return dictsPromise;
}

/** [tournamentIndex, placing, handle, deckIndex, copies] back into a result row. */
function unpackRow([ti, placing, handle, di, count], { tournaments, decks }) {
    const t = tournaments[ti] ?? [];
    const d = di >= 0 ? decks[di] : null;
    return {
        tournamentId: t[0] ?? '',
        tournament: t[1] ?? '—',
        date: t[2] ?? '',
        fieldSize: t[3] ?? null,
        placing,
        handle,
        name: handle,
        deck: d ? { id: d[0], name: d[1], icons: d[2] } : null,
        count,
    };
}

/* ── archetype pages ──────────────────────────────────────────────────────── */

/** Shared card dictionary, fetched once: averages reference cards by id alone. */
let cardDict = null;
const WINDOW_LABEL = { 30: 'Last 30 days', 90: 'Last 90 days', 0: 'All time' };

/**
 * Below this many average copies a card is fringe tech, not part of the deck.
 *
 * Pooling an archetype's variants turns up every card any of them has ever run: 252
 * for Dragapult, 153 of which average less than 0.005 and would render as a card
 * image badged "0.00". Cutting at 0.05 leaves 47, which is about the length of a real
 * list. The rest stay one click away rather than being dropped.
 */
const MIN_AVERAGE = 0.05;

/** The average decklist as card art, with the mean copies as the badge. */
function renderAverage(cards, showAll = false) {
    const byKind = { pokemon: [], trainer: [], energy: [] };
    for (const [id, avg, incl] of cards) {
        const d = cardDict?.[id];
        if (!d) continue;
        (byKind[d[1]] ??= []).push({ id, avg, incl, name: d[0], set: d[2], number: d[3] });
    }

    let hidden = 0;
    const html = GROUPS.map(([key, label]) => {
        const list = byKind[key] ?? [];
        if (!list.length) return '';
        // The group total counts every card, including the ones not drawn, so the
        // three headings still add up to a 60 card deck.
        const sum = list.reduce((a, c) => a + c.avg, 0);
        const shown = showAll ? list : list.filter((c) => c.avg >= MIN_AVERAGE);
        hidden += list.length - shown.length;

        return `<div class="dl-grid-group">
          <h3>${label} (${sum.toFixed(1)})</h3>
          <div class="dl-grid">${shown.map((c) => `
            <a class="dl-card" href="#/c/${encodeURIComponent(c.id)}"
               title="${c.avg.toFixed(2)} average copies · in ${(c.incl * 100).toFixed(0)}% of lists — ${esc(c.name)}">
              <img src="${esc(cardImage(c.set, c.number))}" alt="${esc(c.name)}" loading="lazy">
              <span class="qty avg">${c.avg.toFixed(2)}</span>
            </a>`).join('')}</div>
        </div>`;
    }).join('');

    const toggle = hidden > 0
        ? `<button class="more" id="fringe">Show ${hidden} fringe card${hidden === 1 ? '' : 's'}</button>`
        : (showAll ? `<button class="more" id="fringe">Hide fringe cards</button>` : '');

    return html + toggle;
}

function archetypeResultRows(rows) {
    return rows.map((r) => `<div class="crow" role="button" tabindex="0" aria-expanded="false"
        data-handle="${esc(r.handle)}" data-tid="${esc(r.tournamentId)}">
        <span class="place">${r.placing === null ? '—' : ordinal(r.placing) + '<span class="of">/' + (r.fieldSize ?? '?') + '</span>'}</span>
        <span class="deck">${deckIcons({ icons: r.icons })}<span>${esc(r.variantName ?? '')}</span></span>
        <a class="who" href="#/p/${encodeURIComponent(r.handle)}">${esc(r.name)}</a>
        <span class="ev">${esc(r.tournament)}</span>
      </div>`).join('');
}

async function renderArchetype(id, preselectVariant = null) {
    view.innerHTML = `<p class="empty">Loading…</p>`;
    const [arch] = await Promise.all([
        getJson(`data/archetypes/${encodeURIComponent(id)}.json`),
        cardDict ? Promise.resolve() : getJson('data/cards.json').then((d) => { cardDict = d ?? {}; }),
    ]);
    if (!arch) {
        view.innerHTML = `<p class="empty">No archetype <b>${esc(id)}</b> in this dataset.</p>`;
        return;
    }

    // Both selectors only filter data already fetched, so switching is instant.
    // 90 days is the default: long enough to be a real sample, recent enough to
    // describe the current meta. An archetype with nothing that recent falls back to
    // whatever window it does have rather than opening on an empty page.
    let win = (String(DEFAULT_WINDOW) in arch.averages ? DEFAULT_WINDOW : null)
        ?? arch.windows.find((w) => String(w) in arch.averages)
        ?? 0;
    let variant = arch.variants.some((v) => v.id === preselectVariant) ? preselectVariant : 'all';
    let showFringe = false;
    let custom = null;   // set while a custom range is active
    let daily = null;    // <archetype>.days.json, fetched on first custom use

    /** Aggregate the day buckets into the same shape a precomputed window has. */
    const customAverage = () => {
        if (!daily) return null;
        const { from, to } = resolveRange(custom);
        const ids = variant === 'all' ? arch.variants.map((v) => v.id) : [variant];

        let total = 0;
        const merged = new Map();
        for (const id of ids) {
            for (const [day, [decks, flat]] of Object.entries(daily.variants[id] ?? {})) {
                if (day < from || day > to) continue;
                total += decks;
                for (let i = 0; i < flat.length; i += 3) {
                    const cardId = daily.cards[flat[i]];
                    const cur = merged.get(cardId);
                    if (cur) { cur.copies += flat[i + 1]; cur.decksWith += flat[i + 2]; }
                    else merged.set(cardId, { copies: flat[i + 1], decksWith: flat[i + 2] });
                }
            }
        }
        if (total === 0) return { total: 0, cards: [] };
        return {
            total,
            cards: [...merged.entries()]
                .map(([cardId, v]) => [cardId, v.copies / total, v.decksWith / total])
                .sort((a, b) => b[1] - a[1]),
        };
    };

    const draw = () => {
        // Every variant is published with its own average, however small the sample,
        // so this only falls back when the variant genuinely played nothing in the
        // window — never because the sample was judged too thin.
        const forVariant = custom ? customAverage() : arch.averages[win]?.[variant];
        const avg = custom
            ? (forVariant?.total ? forVariant : null)
            : (forVariant ?? (variant === 'all' ? arch.averages[win]?.all ?? null : null));
        const emptyVariant = variant !== 'all' && !avg;
        const results = variant === 'all'
            ? arch.results
            : arch.results.filter((r) => r.variant === variant);

        const body = document.getElementById('arch-body');
        body.innerHTML = `
          <div class="controls">
            <div class="chips" id="win-chips">
              ${arch.windows.filter((w) => String(w) in arch.averages).map((w) => `
                <button class="chip ${!custom && w === win ? 'on' : ''}" data-win="${w}">${WINDOW_LABEL[w] ?? w + 'd'}</button>`).join('')}
              <button class="chip ${custom ? 'on' : ''}" data-win="custom">Custom…</button>
            </div>
            ${custom ? customRangeForm('arch-range', custom) : ''}
            ${arch.variants.length > 1 ? `<div class="chips" id="var-chips">
              <button class="chip ${variant === 'all' ? 'on' : ''}" data-var="all">All variants</button>
              ${arch.variants.map((v) => `
                <button class="chip ${variant === v.id ? 'on' : ''}" data-var="${esc(v.id)}">
                  ${deckIcons(v)}<span>${esc(v.name)}</span> <span class="n">${v.decks.toLocaleString()}</span>
                </button>`).join('')}
            </div>` : ''}
          </div>

          <h2>Average decklist</h2>
          ${avg
            ? `<p class="muted">${avg.total.toLocaleString()} decklist${avg.total === 1 ? '' : 's'}
               · ${esc(custom ? resolveRange(custom).label : WINDOW_LABEL[win] ?? win + ' days')}${
                 avg.total < 20 ? ' · small sample' : ''}</p>
               ${renderAverage(avg.cards, showFringe)}`
            : `<p class="empty">${emptyVariant
                ? 'That variant was not played in this window.'
                : 'No decklists in this window.'}</p>`}

          <h2>Latest results</h2>
          ${results.length
            ? `<div class="ctable">
                 <div class="crow head"><span>Place</span><span>Variant</span><span>Player</span><span>Tournament</span></div>
                 ${archetypeResultRows(results)}
               </div>`
            : '<p class="empty">No placements for this selection.</p>'}`;
        wireRows(body);

        document.querySelectorAll('#win-chips .chip').forEach((b) =>
            b.addEventListener('click', async () => {
                if (b.dataset.win === 'custom') {
                    custom = custom ?? { kind: 'days', days: 14 };
                    // Day buckets ship as a sidecar covering the recent window only, and
                    // are fetched lazily so the page load never pays for them.
                    daily ??= await getJson(`data/archetypes/${encodeURIComponent(arch.id)}.days.json`);
                } else {
                    custom = null;
                    win = Number(b.dataset.win);
                }
                draw();
            }));
        document.getElementById('arch-range')?.addEventListener('submit', (e) => {
            e.preventDefault();
            custom = readRangeForm(e.target);
            draw();
        });
        document.querySelectorAll('#var-chips .chip').forEach((b) =>
            b.addEventListener('click', () => { variant = b.dataset.var; draw(); }));
        document.getElementById('fringe')?.addEventListener('click', () => {
            showFringe = !showFringe;
            draw();
        });
    };

    view.innerHTML = `
      <div class="player-head">
        <h1>${deckIcons(arch, 'big')}${esc(arch.name)}</h1>
        <p class="muted">${arch.decks.toLocaleString()} decklists ·
          ${arch.variants.length} variant${arch.variants.length === 1 ? '' : 's'}</p>
      </div>
      <div id="arch-body"></div>`;
    draw();
}

/**
 * Cards matching a typed term, best match first.
 *
 * Reads the same published buckets as the player search, filtered to cards, so nothing
 * extra is published for it. Shared with the slot pickers on the find page, which need
 * the identical resolution — a typed name or set code to the page that holds the data.
 */
async function searchCards(term, limit) {
    const t = String(term).trim().toLowerCase();
    if (t.length < 2) return [];
    const bucket = await getJson(`data/search/${shard(t)}.json`);
    return (bucket ?? [])
        .filter((e) => e.type === 'card' && matchesEntry(e, t))
        .sort((a, b) => relevance(b, t) - relevance(a, t) || b.events - a.events)
        .slice(0, limit);
}

/**
 * Card search, on its own page with its own box.
 */
async function renderCardSearch(initial = '') {
    view.innerHTML = `
      <h1 class="page-title">Cards</h1>
      <p class="muted">Search any card to see the decklists that ran it, or
        <a href="#/find">find decks by several cards at once →</a></p>
      <form id="card-form" class="inline-search" role="search">
        <input id="cq" type="search" placeholder="Card name or set code, e.g. MEG-114…"
               aria-label="Search cards" spellcheck="false" value="${esc(initial)}">
      </form>
      <div id="card-results"></div>`;

    const box = document.getElementById('card-results');
    const cq = document.getElementById('cq');

    const run = async (term) => {
        const t = term.trim().toLowerCase();
        if (t.length < 2) {
            box.innerHTML = `<p class="empty">Type at least two characters.</p>`;
            return;
        }
        const hits = await searchCards(t, 80);

        box.innerHTML = hits.length === 0
            ? `<p class="empty">No cards matching “${esc(term)}”.</p>`
            : `<div class="results">${hits.map((e) => `
                <a class="result" href="#/c/${encodeURIComponent(e.handle)}">
                  <img class="mini-card" src="${esc(cardImage(...e.handle.split('-')))}" alt="" loading="lazy">
                  <span class="name">${esc(e.name)}</span>
                  <span class="handle">${esc(e.handle)}</span>
                  <span class="spacer"></span>
                  <span class="count">${e.events.toLocaleString()} decklists</span>
                </a>`).join('')}</div>`;
    };

    document.getElementById('card-form').addEventListener('submit', (e) => e.preventDefault());
    let t;
    cq.addEventListener('input', () => {
        clearTimeout(t);
        t = setTimeout(() => run(cq.value), 120);
    });
    if (initial) run(initial); else cq.focus();
}

async function renderArchetypeList() {
    view.innerHTML = `<p class="empty">Loading…</p>`;
    const list = await getJson('data/archetypes.json');
    if (!list) { view.innerHTML = `<p class="empty">No archetype data.</p>`; return; }

    // Every control filters data already fetched — one small file holds the whole list
    // with its variants and per-window counts, so switching is instant.
    let win = DEFAULT_WINDOW;
    let split = false;
    let custom = null;       // set while the Custom window is active
    let dailyCounts = null;  // archetypes-days.json, fetched on first custom use

    view.innerHTML = `
      <h1 class="page-title">Archetypes</h1>
      <div class="controls">
        <div class="chips" id="adeck-win"></div>
        <div class="chips"><button class="chip" id="adeck-split">Split variants</button></div>
      </div>
      <div id="adeck-range"></div>
      <form id="deck-form" class="inline-search" role="search">
        <input id="dq" type="search" placeholder="Filter archetypes…"
               aria-label="Filter archetypes" spellcheck="false">
      </form>
      <p class="muted" id="adeck-count"></p>
      <div id="deck-results"></div>`;

    const box = document.getElementById('deck-results');
    const dq = document.getElementById('dq');
    const winBox = document.getElementById('adeck-win');
    const splitBtn = document.getElementById('adeck-split');

    const range = () => resolveRange(custom);

    /** Decklists for an entry, either from a precomputed window or a custom range. */
    const countIn = (entry) => {
        if (!custom) return entry.windows?.[win] ?? (win === 0 ? entry.decks : 0);
        if (!dailyCounts) return 0;
        const { from, to } = range();
        const ids = entry.variants?.length ? entry.variants.map((v) => v.id) : [entry.id];
        let n = 0;
        for (const id of ids) {
            for (const [day, c] of Object.entries(dailyCounts.decks[id] ?? {})) {
                if (day >= from && day <= to) n += c;
            }
        }
        return n;
    };

    const row = (e, href, sub) => `
      <a class="result" href="#/d/${href}">
        <span class="ico">${deckIcons(e)}</span>
        <span class="name${sub ? ' sub' : ''}">${esc(e.name)}</span>
        ${!sub && e.variants.length > 1 ? `<span class="alias">${e.variants.length} variants</span>` : ''}
        <span class="spacer"></span>
        <span class="count">${countIn(e).toLocaleString()} decks${
          e.lastSeen ? ` · last ${esc(e.lastSeen)}` : ''}</span>
      </a>`;

    const draw = () => {
        winBox.innerHTML = [[0, 'All time'], [90, 'Last 90 days'], [30, 'Last 30 days']]
            .map(([w, label]) => `<button class="chip ${!custom && w === win ? 'on' : ''}" data-win="${w}">${label}</button>`)
            .join('') + `<button class="chip ${custom ? 'on' : ''}" data-win="custom">Custom…</button>`;
        splitBtn.classList.toggle('on', split);
        document.getElementById('adeck-range').innerHTML =
            custom ? customRangeForm('adeck-form', custom) : '';

        const t = dq.value.trim().toLowerCase();
        const matches = (e) => !t || e.id.includes(t) || e.name.toLowerCase().includes(t);

        let rows;
        let shown;
        if (split) {
            // Flattened to one row per variant, ranked across archetypes rather than
            // nested, so the window ordering still means something.
            const flat = list.flatMap((a) => a.variants
                .filter((v) => matches(a) || matches(v))
                .map((v) => ({ ...v, parent: a })));
            const live = flat.filter((v) => countIn(v) > 0).sort((a, b) => countIn(b) - countIn(a));
            shown = live.length;
            rows = live.map((v) => row(
                { ...v, variants: [] },
                // Pages are keyed by base archetype, so a variant links to its parent
                // with itself preselected rather than to an id that has no page. Each
                // segment is encoded on its own — encoding the pair would escape the
                // separator to %2F and the route could never split it apart again.
                `${encodeURIComponent(v.parent.id)}/${encodeURIComponent(v.id)}`,
                true,
            )).join('');
        } else {
            const live = list.filter((a) => matches(a) && countIn(a) > 0)
                .sort((a, b) => countIn(b) - countIn(a));
            shown = live.length;
            rows = live.map((a) => row(a, encodeURIComponent(a.id), false)).join('');
        }

        document.getElementById('adeck-count').textContent =
            `${shown} ${split ? 'variants' : 'archetypes'}` +
            (custom ? ` · ${range().label}` : win ? ` played in the last ${win} days` : ' all time');
        box.innerHTML = shown === 0
            ? `<p class="empty">Nothing matching that.</p>`
            : `<div class="results">${rows}</div>`;
    };

    document.getElementById('deck-form').addEventListener('submit', (e) => e.preventDefault());
    dq.addEventListener('input', draw);
    winBox.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-win]');
        if (!b) return;
        if (b.dataset.win === 'custom') {
            custom = custom ?? { kind: 'days', days: 14 };
            // Day buckets only ship for the recent window, so this is fetched lazily
            // and only by people who actually use a custom range.
            dailyCounts ??= await getJson('data/archetypes-days.json');
        } else {
            custom = null;
            win = Number(b.dataset.win);
        }
        draw();
    });

    document.getElementById('adeck-range').addEventListener('submit', (e) => {
        e.preventDefault();
        custom = readRangeForm(e.target);
        draw();
    });
    splitBtn.addEventListener('click', () => { split = !split; draw(); });

    draw();
    dq.focus();
}

/* ── find decklists by card counts ────────────────────────────────────────── */

/**
 * Decklists that run a set of cards in given numbers.
 *
 * Nothing new is published for this. A card's page plus the packed history pages beside
 * it are already its complete posting list — every (event, player) that ran it, with
 * how many copies — which is exactly what "exactly 4 of this and at least 2 of that"
 * needs. There is no query engine behind a static site, so the conjunction runs here.
 *
 * All the cost is in which lists get fetched, and it swings by three orders of
 * magnitude: the median card has 22 results while a staple has ~98,000. A conjunction
 * can never be larger than its smallest term, so the slot with the fewest decklists
 * proposes the candidates and the rest only have to settle those — see `planFind`.
 */

/**
 * Comparisons a slot can make.
 *
 * `leads` marks the ones that can propose candidates. A deck running none of a card is
 * absent from its posting list altogether, so "at most n" and "exactly 0" are satisfied
 * by decks no list can name — they can only narrow candidates some other slot proposed.
 */
const FIND_OPS = {
    '=': { label: 'exactly', test: (copies, n) => copies === n, leads: (n) => n > 0 },
    '>=': { label: 'at least', test: (copies, n) => copies >= n, leads: (n) => n > 0 },
    '<=': { label: 'at most', test: (copies, n) => copies <= n, leads: () => false },
};

/** Short forms, so a query survives a round trip through the URL. */
const FIND_CODE = { '=': '=', '>=': '>', '<=': '<' };
const FIND_OP = { '=': '=', '>': '>=', '<': '<=' };

/**
 * What the two ways of settling a slot cost, measured on the published corpus: a packed
 * history row is about 30 bytes, and a player's decklist file averages 4.6 KB.
 */
const BYTES_PER_POSTING = 30;
const BYTES_PER_DECKLIST = 4_600;

/** Past this the page asks before spending someone's bandwidth on a query. */
const FIND_BUDGET = 8 * 1024 * 1024;

/**
 * Matches drawn before the rest go behind a button.
 *
 * A query loose enough to match tens of thousands of decklists still answers, but
 * putting them all in the document at once does not: 30,000 rows measured at 15s to
 * render and left every click three seconds behind. A selective query — which is what
 * this page is for — never reaches this.
 */
const FIND_FIRST_ROWS = 500;

/** A query that cannot be run as asked, with a message worth showing. */
class FindError extends Error {}

/** Identity of one decklist: the event it was played at and who brought it. */
const postingKey = (tournamentId, handle) => `${tournamentId}\u0000${handle}`;

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** Every printing that counts towards a slot, the way a card page counts reprints. */
const printIdCache = new WeakMap();
function printIdsOf(card) {
    let ids = printIdCache.get(card);
    if (!ids) {
        ids = new Set((card.prints ?? [{ id: card.id }]).map((p) => p.id.toUpperCase()));
        printIdCache.set(card, ids);
    }
    return ids;
}

/** Walk a card's packed history pages, newest first. */
async function eachHistoryPage(card, visit, report = () => {}) {
    if (!card.historyPages) return;
    const dicts = await historyDicts();
    for (let p = 0; p < card.historyPages; p++) {
        if (card.historyPages > 1) {
            report(`Loading ${card.name} — page ${p + 1} of ${card.historyPages}…`);
        }
        const page = await getJson(
            `data/cards/${shard(card.id.toLowerCase())}/${encodeURIComponent(card.id)}.h${p}.json`);
        if (!page) throw new FindError(`Could not load the full history of ${card.name}.`);
        visit(page, dicts);
    }
}

/**
 * How many copies each decklist ran, for a slot that only has to settle candidates.
 *
 * Reads the packed rows without unpacking them into result rows: a staple is ~98,000 of
 * them and nothing here needs the placing or the deck.
 */
async function cardCopies(card, report) {
    const copies = new Map();
    for (const r of card.results) copies.set(postingKey(r.tournamentId, r.handle), r.count);
    await eachHistoryPage(card, (page, dicts) => {
        for (const [ti, , handle, , count] of page) {
            copies.set(postingKey(dicts.tournaments[ti]?.[0] ?? '', handle), count);
        }
    }, report);
    return copies;
}

/** The same list as renderable rows. Only the slot proposing candidates needs these. */
async function cardRows(card, report) {
    const rows = card.results.map((r) => ({ ...r, key: postingKey(r.tournamentId, r.handle) }));
    await eachHistoryPage(card, (page, dicts) => {
        for (const packed of page) {
            const r = unpackRow(packed, dicts);
            rows.push({ ...r, key: postingKey(r.tournamentId, r.handle) });
        }
    }, report);
    return rows;
}

/** Copies of one slot's card in a stored decklist, summed across its printings. */
function copiesInList(list, printIds) {
    let total = 0;
    for (const [group] of GROUPS) {
        for (const c of list[group] ?? []) {
            if (printIds.has(`${c.set}-${c.number}`.toUpperCase())) total += c.count;
        }
    }
    return total;
}

/** Oldest day whose decklists are published, or null when all of them are. */
function decklistFloor() {
    const months = meta?.decklistWindowMonths;
    return months ? isoDay(Date.now() - months * 30 * dayMs) : null;
}

/**
 * Run several fetches at a time.
 *
 * Hundreds of requests in series is minutes of waiting; all at once is rude to the host
 * and no faster once the connection is saturated.
 */
async function fetchPool(keys, load, width = 8) {
    const out = new Map();
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(width, keys.length) }, async () => {
        while (next < keys.length) {
            const key = keys[next++];
            out.set(key, await load(key));
        }
    }));
    return out;
}

/**
 * Find every decklist satisfying all the slots, fetching as little as it can.
 *
 * @param {object[]} terms slots, each with its resolved card page attached
 * @param {(msg: string) => void} report progress, shown while the query runs
 * @param {(bytes: number) => Promise<boolean>} confirm asked before a costly query
 */
async function planFind(terms, report, confirm) {
    const leads = terms.filter((t) => FIND_OPS[t.op].leads(t.n));
    if (!leads.length) {
        throw new FindError('At least one card has to be one the deck must contain. '
            + '“At most” also matches decks that do not run the card at all, so on its own '
            + 'it has nothing to search.');
    }

    // Fewest decklists first. The answer can be no larger than this slot, and every
    // other one then only has to settle the candidates it proposes.
    const lead = leads.reduce((a, b) => (b.card.decks < a.card.decks ? b : a));
    const rest = terms.filter((t) => t !== lead);

    // Two ways to settle the rest, and the gap between them is what makes this
    // practical. Posting lists cost whatever their cards are played — a staple is
    // ~2.9 MB. Decklists cost whatever the candidates are, and one file answers every
    // remaining slot at once however many cards the query names.
    const listBytes = rest.reduce((a, t) => a + t.card.decks * BYTES_PER_POSTING, 0);
    const leadBytes = lead.card.decks * BYTES_PER_POSTING;
    // Only promise the cheaper route where it is certain to be available: with a
    // decklist window set it may turn out that the candidates fall outside it, and an
    // estimate that quietly assumed otherwise would be the one that spent the 2.9 MB.
    const worstCase = leadBytes + (decklistFloor()
        ? listBytes
        : Math.min(listBytes, lead.card.decks * BYTES_PER_DECKLIST));
    if (worstCase > FIND_BUDGET && !(await confirm(worstCase))) return null;

    report(`Loading ${lead.card.name}…`);
    const candidates = (await cardRows(lead.card, report))
        .filter((r) => FIND_OPS[lead.op].test(r.count, lead.n));
    if (!candidates.length) return { lead, matches: [], unverified: 0, via: 'lead' };
    // One slot is already its own answer: its posting list is the result.
    if (!rest.length) {
        return {
            lead,
            matches: candidates.map((r) => ({ ...r, counts: [r.count] })),
            unverified: 0,
            via: 'lead',
        };
    }

    // A decklist is published only if it falls inside the window the build was given,
    // so candidates older than that cannot be settled from one.
    const floor = decklistFloor();
    const players = [...new Set(candidates.map((r) => r.handle))];
    const deckBytes = players.length * BYTES_PER_DECKLIST;
    const viaDecklists = (!floor || candidates.every((r) => r.date >= floor))
        && deckBytes <= listBytes;

    const matches = [];
    let unverified = 0;

    if (viaDecklists) {
        report(`Checking ${players.length.toLocaleString()} decklists…`);
        const lists = await fetchPool(players, (handle) =>
            getJson(`data/decks/${shard(handle)}/${encodeURIComponent(handle)}.json`));

        for (const r of candidates) {
            const list = lists.get(r.handle)?.lists?.[r.tournamentId];
            // No published list means no way to settle the other slots, and a match
            // cannot be claimed on a guess.
            if (!list) { unverified++; continue; }
            const counts = terms.map((t) =>
                t === lead ? r.count : copiesInList(list, printIdsOf(t.card)));
            if (terms.every((t, i) => FIND_OPS[t.op].test(counts[i], t.n))) {
                matches.push({ ...r, counts });
            }
        }
    } else {
        const copiesFor = new Map();
        for (const t of rest) {
            report(`Loading ${t.card.name}…`);
            copiesFor.set(t, await cardCopies(t.card, report));
        }
        for (const r of candidates) {
            const counts = terms.map((t) =>
                t === lead ? r.count : (copiesFor.get(t).get(r.key) ?? 0));
            if (terms.every((t, i) => FIND_OPS[t.op].test(counts[i], t.n))) {
                matches.push({ ...r, counts });
            }
        }
    }

    return { lead, matches, unverified, via: viaDecklists ? 'decklists' : 'postings' };
}

/**
 * Matching decklists, grouped under the event they were played at.
 *
 * `labelled` carries the last event named, so drawing the remainder of a long result
 * picks up mid-event rather than repeating its header.
 */
function findResultRows(matches, labelled = null) {
    return matches.map((r) => {
        // Label each event once, as the list walks back through them.
        const header = r.tournamentId === labelled ? '' :
            `<div class="crow sub"><span></span><span class="ev">${esc(r.tournament)}</span>
             <span class="muted">${esc(r.date)}</span><span></span></div>`;
        labelled = r.tournamentId;
        return header + `<div class="crow" role="button" tabindex="0" aria-expanded="false"
            data-handle="${esc(r.handle)}" data-tid="${esc(r.tournamentId)}">
            <span class="place">${r.placing === null ? '—' : ordinal(r.placing)}${
                r.fieldSize ? `<span class="of">/${r.fieldSize}</span>` : ''}</span>
            <span class="deck">${deckIcons(r.deck)}<span>${esc(r.deck?.name ?? 'Other')}</span></span>
            <a class="who" href="#/p/${encodeURIComponent(r.handle)}">${esc(r.name)}</a>
            <span class="qty-inline">${r.counts.join(' · ')}</span>
          </div>`;
    }).join('');
}

/** A slot as it appears in the URL, e.g. `MEG-114=4`. */
const findToQuery = (slots) => slots
    .filter((s) => s.cardId)
    .map((s) => `${s.cardId}${FIND_CODE[s.op]}${s.n}`)
    .join(',');

function findFromQuery(q) {
    return String(q ?? '').split(',').map((part) => {
        const m = part.match(/^([A-Za-z0-9-]+?)([=><])(\d+)$/);
        if (!m) return null;
        return { cardId: m[1].toUpperCase(), name: m[1].toUpperCase(), op: FIND_OP[m[2]], n: Number(m[3]), q: '' };
    }).filter(Boolean);
}

const newFindSlot = () => ({ cardId: null, name: '', op: '=', n: 4, q: '' });

async function renderFind(initial = []) {
    const slots = initial.length ? initial : [newFindSlot(), newFindSlot()];
    let running = false;

    view.innerHTML = `
      <h1 class="page-title">Find decklists</h1>
      <p class="muted">Decklists that run a set of cards in the numbers you choose —
        “exactly 4 Lillie's Determination, exactly 1 Mist Energy, at least 2 Boss's Orders”.</p>
      <div class="slots" id="find-slots"></div>
      <div class="chips">
        <button class="chip" id="find-add">Add a card</button>
        <button class="chip on" id="find-run">Search</button>
      </div>
      <p class="muted note" id="find-status"></p>
      <div id="find-results"></div>`;

    const slotBox = document.getElementById('find-slots');
    const status = document.getElementById('find-status');
    const results = document.getElementById('find-results');
    const say = (msg) => { status.textContent = msg; };

    const drawSlots = () => {
        slotBox.innerHTML = slots.map((s, i) => `
          <div class="slot" data-i="${i}">
            <select class="slot-op" aria-label="How many copies">
              ${Object.entries(FIND_OPS).map(([op, o]) =>
                `<option value="${op}" ${s.op === op && !(s.op === '=' && s.n === 0) ? 'selected' : ''}>${o.label}</option>`).join('')}
              <option value="none" ${s.op === '=' && s.n === 0 ? 'selected' : ''}>none</option>
            </select>
            <input class="slot-n" type="number" min="0" max="60" value="${s.n}"
                   aria-label="Copies" ${s.op === '=' && s.n === 0 ? 'hidden' : ''}>
            <div class="slot-card">
              ${s.cardId
                ? `<div class="slot-pick">
                     <img class="mini-card" src="${esc(cardImage(...s.cardId.split('-')))}" alt="" loading="lazy">
                     <span class="nm">${esc(s.name)}</span>
                     <span class="muted">${esc(s.cardId)}</span>
                     <button class="slot-clear" type="button" aria-label="Change card">change</button>
                   </div>`
                : `<input class="slot-q" type="search" placeholder="Card name or set code…"
                          aria-label="Card" spellcheck="false" value="${esc(s.q)}">
                   <div class="slot-hits" hidden></div>`}
            </div>
            <button class="slot-del" type="button" ${slots.length === 1 ? 'disabled' : ''}>Remove</button>
          </div>`).join('');

        slotBox.querySelectorAll('.slot').forEach((el) => {
            const i = Number(el.dataset.i);
            const s = slots[i];

            el.querySelector('.slot-op').addEventListener('change', (e) => {
                if (e.target.value === 'none') { s.op = '='; s.n = 0; } else { s.op = e.target.value; if (s.n === 0) s.n = 4; }
                drawSlots();
            });
            el.querySelector('.slot-n')?.addEventListener('input', (e) => {
                s.n = Math.max(0, Math.min(60, Number(e.target.value) || 0));
            });
            el.querySelector('.slot-del').addEventListener('click', () => {
                slots.splice(i, 1);
                drawSlots();
            });
            el.querySelector('.slot-clear')?.addEventListener('click', () => {
                s.cardId = null; s.name = ''; s.q = '';
                drawSlots();
            });

            const q = el.querySelector('.slot-q');
            const hits = el.querySelector('.slot-hits');
            if (!q) return;

            let t;
            const show = async () => {
                s.q = q.value;
                const found = await searchCards(q.value, 8);
                if (!found.length) { hits.hidden = true; return; }
                hits.hidden = false;
                hits.innerHTML = found.map((e) => `
                  <button class="slot-hit" type="button" data-id="${esc(e.handle)}" data-name="${esc(e.name)}">
                    <img class="mini-card" src="${esc(cardImage(...e.handle.split('-')))}" alt="" loading="lazy">
                    <span class="nm">${esc(e.name)}</span>
                    <span class="muted">${esc(e.handle)}</span>
                    <span class="spacer"></span>
                    <span class="muted">${e.events.toLocaleString()}</span>
                  </button>`).join('');
                hits.querySelectorAll('.slot-hit').forEach((b) =>
                    b.addEventListener('click', () => {
                        s.cardId = b.dataset.id;
                        s.name = b.dataset.name;
                        drawSlots();
                    }));
            };
            q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(show, 120); });
            if (s.q) show();
        });
    };

    const run = async () => {
        if (running) return;
        const chosen = slots.filter((s) => s.cardId);
        if (!chosen.length) { say('Pick at least one card.'); return; }

        running = true;
        results.innerHTML = '';
        say('Resolving cards…');
        // Keeps the query in the URL, so a search can be linked and reloaded.
        window.history.replaceState(null, '', `#/find?s=${findToQuery(chosen)}`);

        try {
            const pages = await Promise.all(chosen.map((s) => loadCardPage(s.cardId)));
            const terms = chosen.map((s, i) => ({ ...s, card: pages[i].card }));
            const absent = terms.find((t) => !t.card);
            if (absent) throw new FindError(`No card ${absent.cardId} in this dataset.`);
            // A query arriving by URL knows only ids, so label the slots properly now.
            let renamed = false;
            terms.forEach((t) => {
                const slot = slots.find((s) => s.cardId === t.cardId);
                if (slot && slot.name !== t.card.name) { slot.name = t.card.name; renamed = true; }
                t.name = t.card.name;
            });
            if (renamed) drawSlots();

            const out = await planFind(terms, say, async (bytes) =>
                window.confirm(`Nothing in this query is rare, so settling it needs about `
                    + `${mb(bytes)} of card history. Search anyway?`));
            if (!out) { say('Search cancelled.'); return; }

            const { matches, unverified, via } = out;
            const legend = terms.map((t) => `${FIND_OPS[t.op].label} ${t.n} ${t.name}`).join(' · ');
            const SETTLED = { postings: 'from card history', decklists: 'from decklists' };
            say(`${matches.length.toLocaleString()} decklist${matches.length === 1 ? '' : 's'}`
                + ` — ${legend}`
                + (unverified ? ` · ${unverified.toLocaleString()} skipped, decklist not published` : '')
                + (SETTLED[via] ? ` · settled ${SETTLED[via]}` : ''));

            const first = matches.slice(0, FIND_FIRST_ROWS);
            results.innerHTML = matches.length === 0
                ? `<p class="empty">No decklist runs all of those together.</p>`
                : `<div class="ctable" id="find-rows">
                     <div class="crow head"><span>Place</span><span>Deck</span><span>Player</span>
                       <span>${terms.map((t) => esc(t.cardId)).join(' · ')}</span></div>
                     ${findResultRows(first)}
                   </div>
                   ${matches.length > first.length
                     ? `<button class="more" id="find-all">Show the other ${
                         (matches.length - first.length).toLocaleString()}</button>` : ''}`;
            wireRows(results);

            document.getElementById('find-all')?.addEventListener('click', (e) => {
                e.target.disabled = true;
                e.target.textContent = 'Drawing…';
                const box = document.getElementById('find-rows');
                box.insertAdjacentHTML('beforeend',
                    findResultRows(matches.slice(first.length), first.at(-1).tournamentId));
                wireRows(box);
                e.target.remove();
            });
        } catch (err) {
            if (!(err instanceof FindError)) throw err;
            say(err.message);
        } finally {
            running = false;
        }
    };

    drawSlots();
    document.getElementById('find-add').addEventListener('click', () => {
        slots.push(newFindSlot());
        drawSlots();
    });
    document.getElementById('find-run').addEventListener('click', run);
    if (initial.length) run();
}

/* ── routing ──────────────────────────────────────────────────────────────── */

function route() {
    const hash = location.hash.slice(1);
    const player = hash.match(/^\/p\/(.+)$/);
    const card = hash.match(/^\/c\/(.+)$/);
    const deck = hash.match(/^\/d\/(.+)$/);
    const cardSearch = hash === '/cards';
    const find = hash.match(/^\/find(?:\?s=(.*))?$/);
    if (player) {
        input.value = '';
        renderPlayer(decodeURIComponent(player[1]));
    } else if (card) {
        input.value = '';
        renderCard(decodeURIComponent(card[1]));
    } else if (deck) {
        input.value = '';
        // #/d/<archetype> or #/d/<archetype>/<variant>
        const [base, chosen] = deck[1].split('/').map(decodeURIComponent);
        renderArchetype(base, chosen ?? null);
    } else if (hash === '/decks') {
        input.value = '';
        renderArchetypeList();
    } else if (cardSearch) {
        input.value = '';
        renderCardSearch();
    } else if (find) {
        input.value = '';
        renderFind(findFromQuery(find[1] ? decodeURIComponent(find[1]) : ''));
    } else if (input.value.trim()) {
        runSearch(input.value);
    } else {
        renderHome();
    }
}

function renderHome() {
    const c = meta?.counts;
    view.innerHTML = `<div class="card">
      <p style="margin-top:0">Search any player to see every tournament they have entered,
      how they placed, and the decks they brought.</p>
      ${c ? `<div class="stat-row">
        <span><b>${c.players.toLocaleString()}</b> players</span>
        <span><b>${c.tournaments.toLocaleString()}</b> tournaments</span>
        <span><b>${c.decklists.toLocaleString()}</b> decklists</span>
        ${c.archetypes ? `<span><b>${c.archetypes.toLocaleString()}</b> archetypes</span>` : ''}
        ${c.cards ? `<span><b>${c.cards.toLocaleString()}</b> cards</span>` : ''}
      </div>` : ''}
      <p class="browse"><a href="#/decks">Browse all archetypes →</a>
        <a href="#/cards">Search cards →</a>
        <a href="#/find">Find decks by cards →</a></p>
    </div>`;
}

let timer;
input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
        const term = input.value.trim();
        if (location.hash && location.hash !== '#/') {
            // Typing from a player page returns to results without stacking history.
            history.replaceState(null, '', '#/');
        }
        term ? runSearch(term) : renderHome();
    }, 120);
});

document.getElementById('search-form').addEventListener('submit', (e) => e.preventDefault());
window.addEventListener('hashchange', route);

(async function start() {
    meta = await getJson('data/meta.json');
    if (meta) {
        document.getElementById('meta-line').textContent =
            `${meta.counts.tournaments.toLocaleString()} tournaments · ` +
            `${meta.coverage.from.slice(0, 10)} to ${meta.coverage.to.slice(0, 10)}`;
    }
    route();
    if (!location.hash || location.hash === '#/') input.focus();
})();
