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

/**
 * How well an index entry answers what was typed.
 *
 * The published buckets are sorted without knowing the search term, so ordering by
 * relevance has to happen here: an exact name beats a prefix, which beats matching a
 * word somewhere in the middle.
 */
function relevance(entry, term) {
    const names = [entry.handle, ...(entry.names ?? [entry.name])]
        .filter(Boolean)
        .map((n) => String(n).toLowerCase());

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
          </div>
          ${mode === 'list' ? renderList(list) : renderCards(list)}`;
        box.querySelectorAll('.dl-tools button').forEach((b) =>
            b.addEventListener('click', () => draw(b.dataset.mode)));
    };
    draw('list');
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

/** Wire every .crow inside a container to expand its decklist. */
function wireRows(container) {
    container.querySelectorAll('.crow').forEach((row) => {
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

async function renderCard(id) {
    view.innerHTML = `<p class="empty">Loading…</p>`;
    const load = (cid) =>
        getJson(`data/cards/${shard(cid.toLowerCase())}/${encodeURIComponent(cid)}.json`);

    let card = await load(id);
    // Reprints share one page. Any other printing is published as a stub pointing at it,
    // so an old link or a typed set code still lands on the card rather than a 404.
    if (card?.alias) {
        history.replaceState(null, '', `#/c/${encodeURIComponent(card.alias)}`);
        card = await load(card.alias);
    }
    if (!card) {
        view.innerHTML = `<p class="empty">No card <b>${esc(id)}</b> in this dataset.</p>`;
        return;
    }

    // The default view is the newest event on its own, which is how Limitless shows it.
    const latest = card.results.filter((r) => r.tournamentId === card.latestTournament);
    const rest = card.results.filter((r) => r.tournamentId !== card.latestTournament);

    const history = rest.map((r, i) => {
        // Label each event once as the list walks back through them.
        const header = i === 0 || r.tournamentId !== rest[i - 1].tournamentId
            ? `<div class="crow sub"><span></span><span class="ev">${esc(r.tournament)}</span>
               <span class="muted">${esc(r.date)}</span><span></span></div>`
            : '';
        return header + cardResultRows([r]);
    }).join('');

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

      ${rest.length ? `<button class="more" id="card-more">Show full history (${rest.length} more)</button>
      <div class="ctable" id="card-history" hidden>${history}</div>` : ''}

      ${card.decks > card.results.length
        ? `<p class="muted note">Showing the ${card.results.length} most recent of
           ${card.decks.toLocaleString()} decklists.</p>` : ''}
    `;

    wireRows(view);

    const btn = document.getElementById('card-more');
    if (btn) {
        btn.addEventListener('click', () => {
            const box = document.getElementById('card-history');
            box.hidden = !box.hidden;
            btn.textContent = box.hidden ? `Show full history (${rest.length} more)` : 'Hide history';
        });
    }
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
    let win = arch.windows.find((w) => String(w) in arch.averages) ?? 0;
    let variant = arch.variants.some((v) => v.id === preselectVariant) ? preselectVariant : 'all';
    let showFringe = false;

    const draw = () => {
        // Every variant is published with its own average, however small the sample,
        // so this only falls back when the variant genuinely played nothing in the
        // window — never because the sample was judged too thin.
        const forVariant = arch.averages[win]?.[variant];
        const avg = forVariant ?? (variant === 'all' ? arch.averages[win]?.all ?? null : null);
        const emptyVariant = variant !== 'all' && !forVariant;
        const results = variant === 'all'
            ? arch.results
            : arch.results.filter((r) => r.variant === variant);

        const body = document.getElementById('arch-body');
        body.innerHTML = `
          <div class="controls">
            <div class="chips" id="win-chips">
              ${arch.windows.filter((w) => String(w) in arch.averages).map((w) => `
                <button class="chip ${w === win ? 'on' : ''}" data-win="${w}">${WINDOW_LABEL[w] ?? w + 'd'}</button>`).join('')}
            </div>
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
               · ${esc(WINDOW_LABEL[win] ?? win + ' days')}${
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
            b.addEventListener('click', () => { win = Number(b.dataset.win); draw(); }));
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
 * Card search, on its own page with its own box.
 *
 * Reads the same published buckets as the main search, filtered to cards, so nothing
 * extra is published for it.
 */
async function renderCardSearch(initial = '') {
    view.innerHTML = `
      <h1 class="page-title">Cards</h1>
      <p class="muted">Search any card to see the decklists that ran it.</p>
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
        const bucket = await getJson(`data/search/${shard(t)}.json`);
        const hits = (bucket ?? [])
            .filter((e) => e.type === 'card' && matchesEntry(e, t))
            .sort((a, b) => relevance(b, t) - relevance(a, t) || b.events - a.events)
            .slice(0, 80);

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
    let win = 0;
    let split = false;

    view.innerHTML = `
      <h1 class="page-title">Archetypes</h1>
      <div class="controls">
        <div class="chips" id="adeck-win"></div>
        <div class="chips"><button class="chip" id="adeck-split">Split variants</button></div>
      </div>
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

    const countIn = (entry) => entry.windows?.[win] ?? (win === 0 ? entry.decks : 0);

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
            .map(([w, label]) => `<button class="chip ${w === win ? 'on' : ''}" data-win="${w}">${label}</button>`)
            .join('');
        splitBtn.classList.toggle('on', split);

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
            (win ? ` played in the last ${win} days` : ' all time');
        box.innerHTML = shown === 0
            ? `<p class="empty">Nothing matching that.</p>`
            : `<div class="results">${rows}</div>`;
    };

    document.getElementById('deck-form').addEventListener('submit', (e) => e.preventDefault());
    dq.addEventListener('input', draw);
    winBox.addEventListener('click', (e) => {
        const b = e.target.closest('[data-win]');
        if (!b) return;
        win = Number(b.dataset.win);
        draw();
    });
    splitBtn.addEventListener('click', () => { split = !split; draw(); });

    draw();
    dq.focus();
}

/* ── routing ──────────────────────────────────────────────────────────────── */

function route() {
    const hash = location.hash.slice(1);
    const player = hash.match(/^\/p\/(.+)$/);
    const card = hash.match(/^\/c\/(.+)$/);
    const deck = hash.match(/^\/d\/(.+)$/);
    const cardSearch = hash === '/cards';
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
        <a href="#/cards">Search cards →</a></p>
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
