import { api } from '../api.js';
import { $, $$, card, errorBox, esc, icon, initSelect, pretty, selectHTML, setTitle, skCards } from '../ui.js';

const SEASONS = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];
const FORMATS = ['TV', 'TV_SHORT', 'MOVIE', 'SPECIAL', 'OVA', 'ONA', 'MUSIC'];
const STATUSES = ['RELEASING', 'FINISHED', 'NOT_YET_RELEASED', 'HIATUS', 'CANCELLED'];
const SORTS = [['POPULARITY_DESC', 'Most popular'], ['TRENDING_DESC', 'Trending'], ['SCORE_DESC', 'Highest rated'],
  ['START_DATE_DESC', 'Newest'], ['FAVOURITES_DESC', 'Most favourited'], ['TITLE_ROMAJI', 'Title A–Z']];
const LABELS = { genre: 'Genre', year: 'Year', season: 'Season', format: 'Format', status: 'Status', sort: 'Sort' };

const opts = list => list.map(v => [String(v), pretty(String(v))]);
const headingFor = f => (f.search ? `Results for “${f.search}”` : f.genre ? `${f.genre} anime`
  : f.season && f.year ? `${pretty(f.season)} ${f.year}` : f.sort === 'TRENDING_DESC' ? 'Trending' : f.sort === 'SCORE_DESC' ? 'Top rated' : 'Browse anime');

export async function browse(root, { query }) {
  const f = Object.fromEntries(['search', ...Object.keys(LABELS)].map(k => [k, query.get(k) || '']));
  const { genres } = await api('/genres').catch(() => ({ genres: f.genre ? [f.genre] : [] }));
  const thisYear = new Date().getFullYear();
  const years = Array.from({ length: thisYear + 2 - 1960 }, (_, i) => String(thisYear + 1 - i));

  setTitle(headingFor(f));
  root.innerHTML = `<div class="page">
    <div class="page-head"><div><h1>${esc(headingFor(f))}</h1><p>Filter by genre, season, format and more. Results load as you scroll.</p></div></div>
    <form class="filter-bar" role="search" aria-label="Filter anime">
      <label class="field">${icon('search')}<span class="sr">Title</span><input name="search" type="search" value="${esc(f.search)}" placeholder="Search titles" autocomplete="off"></label>
      ${selectHTML({ name: 'genre', label: 'Genre', value: f.genre, options: genres.map(g => [g, g]) })}
      ${selectHTML({ name: 'year', label: 'Year', value: f.year, options: years.map(y => [y, y]) })}
      ${selectHTML({ name: 'season', label: 'Season', value: f.season, options: opts(SEASONS) })}
      ${selectHTML({ name: 'format', label: 'Format', value: f.format, options: opts(FORMATS) })}
      ${selectHTML({ name: 'status', label: 'Status', value: f.status, options: opts(STATUSES) })}
      ${selectHTML({ name: 'sort', label: 'Sort', value: f.sort, options: SORTS, any: f.search ? 'Best match' : 'Most popular', align: 'right' })}
    </form>
    <div class="active-filters" aria-live="polite"></div>
    <div class="grid" id="grid"></div>
    <div class="sentinel"></div>
    <button class="btn btn-ghost more" type="button" hidden>Load more</button>
  </div>`;

  const form = $('.filter-bar', root);
  const input = $('input[name="search"]', form);
  const grid = $('#grid', root);
  const more = $('.more', root);
  const chips = $('.active-filters', root);
  const selects = $$('.select', form);
  let page = 1;
  let hasNext = false;
  let loading = false;
  let total = '';
  let req = 0;

  const state = () => {
    const s = { search: input.value.trim() };
    for (const el of selects) s[el.dataset.name] = el.dataset.value;
    return s;
  };
  const params = () => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(state())) if (v) p.set(k, v);
    return p;
  };
  const paintChips = () => {
    const s = state();
    const active = Object.keys(LABELS).filter(k => k !== 'sort' && s[k]);
    chips.innerHTML = `<span class="total">${total}</span>`
      + (s.search ? `<button class="chip-x" type="button" data-clear="search">“${esc(s.search)}”${icon('x')}</button>` : '')
      + active.map(k => `<button class="chip-x" type="button" data-clear="${k}">${esc($(`.select[data-name="${k}"] .val`, form).textContent)}${icon('x')}</button>`).join('')
      + (s.search || active.length ? '<button class="clear" type="button" data-clear="all">Clear all</button>' : '');
  };

  async function load(reset = false) {
    if (reset) { page = 1; grid.innerHTML = skCards(12); }
    loading = true;
    more.hidden = true;
    const id = ++req;
    const p = params();
    p.set('page', page);
    try {
      const d = await api('/browse?' + p);
      if (id !== req) return;
      if (page === 1) grid.innerHTML = '';
      grid.insertAdjacentHTML('beforeend', d.media.map(a => card(a)).join(''));
      if (page === 1 && !d.media.length) {
        grid.innerHTML = `<div class="empty-state"><div class="bubble">${icon('search')}</div><h2>No anime match</h2><p>Try removing a filter or searching a shorter title.</p></div>`;
      }
      total = d.pageInfo.total ? `${d.pageInfo.total.toLocaleString()} titles` : '';
      paintChips();
      hasNext = d.pageInfo.hasNextPage;
      more.hidden = !hasNext;
      page++;
    } catch (err) {
      if (id !== req) return;
      if (page === 1) errorBox(grid, err, () => load(true));
      else { more.hidden = false; more.textContent = 'Loading failed. Try again'; }
    } finally {
      if (id === req) loading = false;
    }
  }

  const apply = () => {
    const p = params();
    history.replaceState(history.state, '', '/browse' + (String(p) ? `?${p}` : ''));
    dispatchEvent(new Event('koma:url')); // e.g. sorting by Trending lights up the Trending tab
    const h = headingFor(state());
    $('h1', root).textContent = h;
    setTitle(h);
    load(true);
  };
  for (const el of selects) initSelect(el, apply);

  let typing;
  input.addEventListener('input', () => { clearTimeout(typing); typing = setTimeout(apply, 400); });
  form.addEventListener('submit', e => { e.preventDefault(); clearTimeout(typing); apply(); });
  chips.addEventListener('click', e => {
    const b = e.target.closest('[data-clear]');
    if (!b) return;
    const k = b.dataset.clear;
    if (k === 'search' || k === 'all') input.value = '';
    for (const el of selects) if (k === 'all' ? el.dataset.name !== 'sort' : el.dataset.name === k) el.setValue('');
    apply();
  });
  more.addEventListener('click', () => { more.textContent = 'Load more'; load(); });

  // Infinite scroll: fetch the next page as the end of the grid comes into view.
  const io = new IntersectionObserver(([entry]) => {
    if (!root.isConnected) return io.disconnect();
    if (entry.isIntersecting && hasNext && !loading) load();
  }, { rootMargin: '900px 0px' });
  io.observe($('.sentinel', root));

  paintChips();
  await load(true);
}
