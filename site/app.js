import { matchesEntry, shard } from './search.js';

/* ── data sources ─────────────────────────────────────────────────────────── */

/** Card fronts. `_R_` is a constant in the path, not a rarity code, and the collector
 *  number is zero-padded to three digits. Verified against all 924 cards in the corpus. */
const CARD_CDN = 'https://limitlesstcg.nyc3.cdn.digitaloceanspaces.com/tpci';
/** 274x381, ~60 KB. Enough for a grid at 2x without pulling the 700 KB original. */
const CARD_SIZE = '_SM';

/** pokesprite covers Gen 1-8; `data/icons.json` says which names it actually has. */
const POKESPRITE_CDN = 'https://cdn.jsdelivr.net/gh/msikma/pokesprite@master/pokemon-gen8/regular';
/** Limitless' own sprites, used for Gen 9 and the current Megas that pokesprite lacks. */
const LIMITLESS_CDN = 'https://r2.limitlesstcg.net/pokemon/gen9';
const FLAG_CDN = 'https://r2.limitlesstcg.net/flags';

const view = document.getElementById('view');
const input = document.getElementById('q');

let icons = {};
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
    const base = icons[name] === 'ps' ? POKESPRITE_CDN : LIMITLESS_CDN;
    return `${base}/${encodeURIComponent(name)}.png`;
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

/* ── search ───────────────────────────────────────────────────────────────── */

async function runSearch(term) {
    const t = term.trim().toLowerCase();
    if (t.length < 2) {
        view.innerHTML = `<p class="empty">Type at least two characters.</p>`;
        return;
    }
    const bucket = await getJson(`data/search/${shard(t)}.json`);
    const hits = (bucket ?? []).filter((e) => matchesEntry(e, t)).slice(0, 60);

    if (hits.length === 0) {
        view.innerHTML = `<p class="empty">No players matching “${esc(term)}”.</p>`;
        return;
    }

    view.innerHTML = `<div class="results">${hits
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

    const draw = (mode) => {
        box.innerHTML = `
          <div class="dl-tools">
            <button type="button" data-mode="list" aria-pressed="${mode === 'list'}">List</button>
            <button type="button" data-mode="cards" aria-pressed="${mode === 'cards'}">Cards</button>
            <span class="muted" style="font-size:.8rem">${countOf(
                GROUPS.flatMap(([k]) => list[k] ?? []),
            )} cards</span>
          </div>
          ${mode === 'list' ? renderList(list) : renderCards(list)}`;
        box.querySelectorAll('.dl-tools button').forEach((b) =>
            b.addEventListener('click', () => draw(b.dataset.mode)));
    };
    draw('list');
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

/* ── routing ──────────────────────────────────────────────────────────────── */

function route() {
    const hash = location.hash.slice(1);
    const m = hash.match(/^\/p\/(.+)$/);
    if (m) {
        const handle = decodeURIComponent(m[1]);
        input.value = '';
        renderPlayer(handle);
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
      </div>` : ''}
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
    [meta, icons] = await Promise.all([getJson('data/meta.json'), getJson('data/icons.json')]);
    icons = icons ?? {};
    if (meta) {
        document.getElementById('meta-line').textContent =
            `${meta.counts.tournaments.toLocaleString()} tournaments · ` +
            `${meta.coverage.from.slice(0, 10)} to ${meta.coverage.to.slice(0, 10)}`;
    }
    route();
    if (!location.hash || location.hash === '#/') input.focus();
})();
