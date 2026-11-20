/* Koma TV — a study in a television interface.
   A screen is a place, not a list: every destination is a page, the remote
   walks one thing at a time, and every title leads to its own screen with a
   player at the bottom of it. */

import { TvPlayer, progressFor } from './player.js';

const bridge = window.komaTv;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const state = {
  page: 'home',
  stack: [],
  base: null,
  live: false,
  candidates: [],
  config: {},
  spotlight: null,
  shelves: [],
  genres: [],
  browse: { genre: '', page: 1, items: [], busy: false },
  schedule: { day: 0, items: [], busy: false },
  search: { text: '', items: [], busy: false, timer: null },
  watchItem: null,
  season: 1,
  audioType: 'sub',
  playerItem: null,
  playerEpisode: 1,
  playerStream: null,
  focus: { row: -1, col: -1 },
  artLayer: 'a',
};

/* ---------- the little helpers ---------- */

const titleOf = item => item?.title?.english || item?.title?.romaji || item?.title?.native || 'Untitled';
const scoreOf = item => (item.averageScore ? (item.averageScore / 10).toFixed(1) : null);
const artOf = item => item?.bannerImage || item?.coverImage?.extraLarge || item?.coverImage?.large || '';

const plain = text => String(text || '')
  .replace(/<br\s*\/?>/gi, ' ').replace(/<\/?[a-z][^>]*>/gi, '')
  .replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>').replace(/"/g, '"').replace(/&#039;/g, '’').replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ').trim();

const dateLabel = item => {
  const date = item.startDate;
  const when = date?.year ? new Date(Date.UTC(date.year, (date.month || 1) - 1, date.day || 1))
    : item.seasonYear ? new Date(Date.UTC(item.seasonYear, 6, 1)) : null;
  return when ? when.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : '';
};

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.hidden = false;
  requestAnimationFrame(() => toast.classList.add('on'));
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.classList.remove('on'); toast.hidden = true; }, 2600);
}

/* The study keeps its own list. A file:// page may have no storage, so an
   absence is not an error: the list simply lives for this run. */
const store = {
  get() { try { return JSON.parse(localStorage.getItem('koma.tv.list') || '[]'); } catch { return []; } },
  set(list) { try { localStorage.setItem('koma.tv.list', JSON.stringify(list)); } catch { /* no storage */ } },
  has(id) { return this.get().some(item => item.id === id); },
  toggle(item) {
    const list = this.get();
    const at = list.findIndex(entry => entry.id === item.id);
    if (at >= 0) list.splice(at, 1);
    else list.unshift({ id: item.id, title: item.title, coverImage: item.coverImage, format: item.format, episodes: item.episodes, averageScore: item.averageScore, genres: item.genres });
    this.set(list);
    return at < 0;
  },
};

/* ---------- data ---------- */

function fromHome(home) {
  const shelves = [
    { name: 'Trending now', note: 'What everyone is watching', items: home.trending || [] },
    { name: 'Airing this season', note: 'New episodes every week', items: home.airing || [] },
    { name: 'Top 10', note: 'Ranked by score', items: home.top || [], kind: 'ranked' },
    { name: 'Coming soon', note: 'Next season', items: home.upcoming || [] },
  ].filter(shelf => shelf.items.length);
  return { spotlight: home.trending?.[0] || home.top?.[0] || null, shelves };
}

function fromSnapshot(snapshot) {
  return {
    spotlight: snapshot.spotlight,
    shelves: snapshot.rows.map(row => ({ name: row.name, note: row.numbered ? 'Ranked by score' : '', items: row.items, kind: row.numbered ? 'ranked' : undefined })),
  };
}

async function pickBase() {
  for (const base of state.candidates) {
    const answer = await bridge.fetchHome(base);
    if (answer.ok) return base;
  }
  return null;
}

async function adoptHome(base) {
  state.base = base;
  state.live = !!base;
  const answer = base ? await bridge.fetchHome(base) : { ok: false };
  if (answer.ok) {
    const data = fromHome(answer.data);
    state.spotlight = data.spotlight;
    state.shelves = data.shelves;
  } else if (state.config.snapshot) {
    const data = fromSnapshot(state.config.snapshot);
    state.spotlight = data.spotlight;
    state.shelves = data.shelves;
  } else {
    state.spotlight = null;
    state.shelves = [];
  }
  paintStatus();
}

/* ---------- boot ---------- */

async function boot() {
  startClock();
  try { state.config = await bridge.config(); } catch { state.config = {}; }
  state.candidates = (state.config.candidates || []).filter(Boolean);
  // Everything on the rail that leads somewhere: the mark, the four sections
  // and the gear. The status dot is a settings shortcut of its own.
  $$('[data-nav]').forEach(button => button.addEventListener('click', () => go(button.dataset.nav)));
  $('#status').addEventListener('click', () => go('settings'));
  await adoptHome(await pickBase());
  if (state.live) {
    const answer = await bridge.fetchGenres(state.base);
    if (answer.ok) state.genres = answer.data.genres || [];
  }
  go('home', { push: false });
  document.addEventListener('keydown', event => onKey(event));
}

function paintStatus() {
  const status = $('#status');
  status.classList.toggle('is-off', !state.live);
  status.title = state.live ? `Live data from ${state.base}` : 'No Koma server: the study is showing its snapshot';
}

/* ---------- the router ---------- */

const PAGES = {
  home: renderHome,
  browse: renderBrowse,
  tv: renderTv,
  library: renderLibrary,
  search: renderSearch,
  settings: renderSettings,
  watch: renderWatch,
  player: renderPlayerPage,
};

function go(page, options = {}) {
  if (!PAGES[page]) return;
  if (options.push !== false && state.page && state.page !== page) state.stack.push(state.page);
  state.page = page;
  state.focus = { row: -1, col: -1 };
  $$('.nav-item').forEach(button => button.classList.toggle('is-on', button.dataset.nav === page));
  const body = PAGES[page]();
  if (!body) return;
  body.classList.add('page');
  const stage = $('#stage');
  stage.replaceChildren();
  stage.scrollTop = 0;
  stage.append(body);
  if (page === 'search') $('input', stage)?.focus();
  else focusFirst();
  paintFooter();
}

function back() {
  const previous = state.stack.pop();
  if (previous) go(previous, { push: false });
  else if (state.page !== 'home') go('home', { push: false });
  else bridge.window('fullscreen');
}

function paintFooter() {
  $('#foot-note').textContent = state.page === 'home' && !state.live
    ? 'Koma is not running, so this study is showing its own snapshot — Settings says where to find it.'
    : '';
}

/* ---------- the pages ---------- */

function renderHome() {
  const page = document.createElement('div');
  const hero = document.createElement('section');
  hero.className = 'hero';
  if (state.spotlight) {
    const title = document.createElement('h1');
    title.className = 'hero-title';
    title.textContent = titleOf(state.spotlight);
    hero.append(title);
    const meta = document.createElement('div');
    meta.className = 'hero-meta';
    const bits = [dateLabel(state.spotlight), state.spotlight.format?.replace('_', ' ').toLowerCase(), state.spotlight.duration ? `${state.spotlight.duration}m` : ''].filter(Boolean);
    bits.forEach((bit, index) => {
      if (index) meta.append(sep());
      const part = document.createElement('b');
      part.textContent = bit;
      meta.append(part);
    });
    const genres = (state.spotlight.genres || []).slice(0, 3).join(' / ');
    if (genres) meta.append(chip(genres));
    const score = scoreOf(state.spotlight);
    if (score) meta.append(chip(`${score} / 10`, 'score'));
    hero.append(meta);
    const note = document.createElement('p');
    note.className = 'hero-note';
    note.textContent = plain(state.spotlight.description) || 'No description yet.';
    hero.append(note);
    const actions = document.createElement('div');
    actions.className = 'hero-actions';
    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'btn btn-solid';
    play.innerHTML = '<svg viewBox="0 0 24 24" class="i"><path d="M8 5.5v13l11-6.5-11-6.5Z"/></svg>Play';
    play.addEventListener('click', () => showToast('Playback is not part of this study: it is here for the picture.'));
    const details = document.createElement('button');
    details.type = 'button';
    details.className = 'btn btn-quiet';
    details.textContent = 'Details';
    details.addEventListener('click', () => goWatch(state.spotlight));
    actions.append(play, details);
    hero.append(actions);
  } else {
    hero.append(emptyBlock('No catalog on this screen', 'Koma’s server is not running and this study has no snapshot. Start Koma, or open Settings.'));
  }
  page.append(hero);

  const shelves = document.createElement('div');
  shelves.className = 'shelves';
  state.shelves.forEach((shelf, shelfIndex) => {
    const section = document.createElement('section');
    section.className = 'shelf';
    const head = document.createElement('div');
    head.className = 'shelf-head';
    const heading = document.createElement('h2');
    heading.textContent = shelf.name;
    head.append(heading);
    if (shelf.note) head.append(par(shelf.note));
    section.append(head);
    const track = document.createElement('div');
    track.className = 'shelf-track';
    const leading = shelfIndex === 0 && !shelf.kind;
    shelf.items.forEach((item, index) => {
      const card = cardElement(item, shelf.kind, index, { airing: shelfIndex === 1, spot: leading && index === 0 });
      track.append(card);
      if (leading && index === 0) {
        // The card says the name; the caption beside it says what the show is.
        const cap = document.createElement('div');
        cap.className = 'cap';
        cap.append(title3(`${scoreOf(item) ? `${scoreOf(item)} / 10 · ` : ''}${(item.genres || []).slice(0, 3).join(' · ')}`));
        cap.append(par(plain(item.description) || ''));
        track.append(cap);
      }
    });
    section.append(track);
    shelves.append(section);
  });
  page.append(shelves);
  enrichSpotlight();
  return page;
}

function renderBrowse() {
  const page = document.createElement('div');
  const head = document.createElement('header');
  head.className = 'page-head';
  head.append(title1('Browse'), par('The catalog, by genre'));
  page.append(head);

  const strip = document.createElement('div');
  strip.className = 'strip';
  strip.append(pill('All', !state.browse.genre, () => setGenre('')));
  state.genres.slice(0, 14).forEach(genre => strip.append(pill(genre, state.browse.genre === genre, () => setGenre(genre))));
  page.append(strip);

  const grid = document.createElement('div');
  grid.className = 'grid';
  grid.id = 'browse-grid';
  if (state.browse.items.length) state.browse.items.forEach(item => grid.append(cardElement(item)));
  else grid.append(emptyBlock('Nothing loaded yet', state.live
    ? 'Pick a genre, or press down at the bottom of this page for more.'
    : 'Browse needs Koma running — this study only carries its home snapshot.'));
  page.append(grid);
  return page;
}

function renderTv() {
  const page = document.createElement('div');
  const head = document.createElement('header');
  head.className = 'page-head';
  head.append(title1('Schedule'), par('What airs this week, in your timezone'));
  page.append(head);

  const days = document.createElement('div');
  days.className = 'days';
  const today = new Date();
  for (let offset = 0; offset < 7; offset++) {
    const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `day${offset === state.schedule.day ? ' is-on' : ''}`;
    button.append(bold(offset === 0 ? 'Today' : date.toLocaleDateString('en-GB', { weekday: 'short' })), span(String(date.getDate())));
    button.addEventListener('click', () => setDay(offset));
    days.append(button);
  }
  page.append(days);

  const list = document.createElement('div');
  list.className = 'list';
  if (!state.schedule.items.length) {
    list.append(emptyBlock('Nothing airs here', state.live
      ? 'No episode is scheduled for this day.'
      : 'The schedule needs Koma running — this study only carries its home snapshot.'));
  } else {
    for (const entry of state.schedule.items) {
      const media = entry.media;
      const time = new Date((entry.airingAt || 0) * 1000);
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'row-item';
      row.append(
        img(media ? (media.coverImage?.large || '') : ''),
        div([title3(titleOf(media)), par(`${media?.format?.replace('_', ' ') || 'TV'} · episode ${entry.episode}`)]),
        div([bold(`${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`), span(time.toLocaleDateString('en-GB', { weekday: 'short' }))], 'when'),
      );
      row.addEventListener('click', () => goWatch(media));
      list.append(row);
    }
  }
  page.append(list);
  return page;
}

function renderLibrary() {
  const page = document.createElement('div');
  const head = document.createElement('header');
  head.className = 'page-head';
  head.append(title1('Library'), par('What you saved, and what you are watching'));
  page.append(head);

  const shelves = document.createElement('div');
  shelves.className = 'shelves';
  const mine = document.createElement('section');
  mine.className = 'shelf';
  const mineHead = document.createElement('div');
  mineHead.className = 'shelf-head';
  mineHead.append(title2('My list'), par('Saved from any title'));
  mine.append(mineHead);
  const mineTrack = document.createElement('div');
  mineTrack.className = 'shelf-track';
  const list = store.get();
  if (list.length) list.forEach(item => mineTrack.append(cardElement(item)));
  else mineTrack.append(emptyBlock('Your list is empty', 'Open any title and choose “Add to my list” — it appears here, on this device.'));
  mine.append(mineTrack);
  shelves.append(mine);

  const resume = document.createElement('section');
  resume.className = 'shelf';
  const resumeHead = document.createElement('div');
  resumeHead.className = 'shelf-head';
  resumeHead.append(title2('Continue watching'));
  resume.append(resumeHead);
  const resumeBody = document.createElement('div');
  resumeBody.style.padding = '0 var(--gut)';
  resumeBody.append(emptyBlock('Nothing in progress', 'Koma keeps your progress on this device; this study has none of its own, so this shelf stays quiet until the real app is asked for it.'));
  resume.append(resumeBody);
  shelves.append(resume);
  page.append(shelves);
  return page;
}

function renderSearch() {
  const page = document.createElement('div');
  const find = document.createElement('div');
  find.className = 'find';
  const head = document.createElement('header');
  head.className = 'page-head';
  head.append(title1('Search'), par('The catalog, by name'));
  find.append(head);
  const field = document.createElement('div');
  field.className = 'find-head';
  field.append(svgIcon('search'), input());
  find.append(field);
  const note = document.createElement('p');
  note.className = 'find-note';
  note.id = 'find-note';
  note.textContent = state.live ? 'Searching the live catalog through Koma’s server.' : 'Search needs Koma running — this study only carries its home snapshot.';
  find.append(note);
  const grid = document.createElement('div');
  grid.className = 'grid';
  grid.id = 'search-grid';
  find.append(grid);
  page.append(find);
  const box = $('input', page);
  if (box) {
    box.focus();
    box.addEventListener('input', event => runSearch(event.target.value));
  }
  return page;
}

function renderSettings() {
  const page = document.createElement('div');
  const head = document.createElement('header');
  head.className = 'page-head';
  head.append(title1('Settings'), par('This study, and where it looks for Koma'));
  page.append(head);
  const list = document.createElement('div');
  list.className = 'sheet-page';
  const rows = [
    ['Data source', state.live ? `Live · ${state.base.replace('http://', '')}` : 'Snapshot · no server found', 'Enter looks at the next address', 'source'],
    ['Full screen', document.fullscreenElement ? 'On' : 'Off', 'F toggles it anywhere', 'fullscreen'],
    ['Reload the data', 'Fetches the home feed again', 'For when Koma has been restarted', 'reload'],
  ];
  for (const [label, value, hint, action] of rows) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'setting';
    row.append(div([title3(label), par(hint)]), div([span(value)], 'value'));
    row.addEventListener('click', () => settingAction(action));
    list.append(row);
  }
  const about = document.createElement('div');
  about.className = 'empty quiet';
  about.append(bold('An interface study, not the app'), par('It shares no code with the real Koma television app: it exists to be argued with. Artwork and metadata come from AniList, through Koma’s own server when it is running.'));
  list.append(about);
  page.append(list);
  return page;
}

async function settingAction(action) {
  if (action === 'source') {
    if (!state.candidates.length) { showToast('No server address configured — start Koma first.'); return; }
    const next = state.candidates[(state.candidates.indexOf(state.base) + 1) % state.candidates.length];
    showToast(`Looking for Koma at ${next}…`);
    await adoptHome(next === state.base ? next : next);
    go('settings', { push: false });
    return;
  }
  if (action === 'fullscreen') { bridge.window('fullscreen'); return; }
  if (action === 'reload') {
    showToast('Looking for Koma…');
    await adoptHome(await pickBase());
    go(state.page, { push: false });
    showToast(state.live ? `Koma answered on ${state.base.replace('http://', '')}` : 'Koma is not running — the snapshot is still here');
  }
}

/* ---------- the watch page ---------- */

/* Koma's own server resolves an episode and hands back a playlist its proxy
   serves: the study asks for the same thing the site asks for, so playback
   goes through the machine the viewer already trusts. */
async function resolveEpisode(anilistId, episode, type = 'sub') {
  const answer = await bridge.fetchWatch(state.base, { anilistId, ep: episode, type, source: 'anikoto' });
  if (!answer.ok) throw new Error(answer.error || 'The streaming server could not be reached.');
  const data = answer.data;
  if (data?.error) throw new Error(data.error);
  const relative = data.hlsProxyUrl || data.mp4ProxyUrl || null;
  if (!relative) throw new Error('The streaming server did not return a stream.');
  // Koma's proxy is where the episode comes from; this study's own site is
  // where the player asks for it, because a page may only play video from its
  // own origin.
  const koma = new URL(relative, state.base);
  const mine = location.origin;
  const via = target => `${mine}/media/stream?url=${encodeURIComponent(target.href)}&ref=${encodeURIComponent(koma.searchParams.get('ref') || '')}`;
  const url = data.playbackMode === 'hls' ? via(koma) : koma.href;
  const subtitles = (data.subtitles || []).map(track => ({
    label: track.lang || track.label || 'Subtitles',
    code: (track.lang || 'en').slice(0, 2).toLowerCase(),
    url: via(new URL(track.url, state.base)),
  }));
  return { url, mode: data.playbackMode === 'hls' ? 'hls' : 'file', subtitles, server: data.server, intro: data.intro, outro: data.outro };
}

/* The episode list. AniList names the episodes it knows about; anything it does
   not know is still an episode, so the count fills the rest. */
function episodesOf(item) {
  const count = item.episodes || item.nextAiringEpisode?.episode || 0;
  const named = (item.streamingEpisodes || []).map((entry, index) => ({
    number: index + 1,
    title: entry.title || '',
    thumbnail: entry.thumbnail || '',
    summary: '',
  }));
  const out = [];
  for (let number = 1; number <= Math.max(count, named.length); number++) {
    const found = named.find(entry => entry.number === number);
    out.push(found || { number, title: `Episode ${number}`, thumbnail: '', summary: '' });
  }
  return out;
}

function renderWatch() {
  const item = state.watchItem;
  const page = document.createElement('div');
  if (!item) {
    page.append(head('Nothing to watch', 'Open a title from any shelf.'));
    return page;
  }
  const episodes = episodesOf(item);
  const seasons = [];
  for (let season = 1; season <= Math.max(1, Math.ceil(episodes.length / 12)); season++) seasons.push(season);
  const season = Math.min(state.season, seasons.length);
  const list = episodes.filter(entry => Math.ceil(entry.number / 12) === season);
  const first = list[0]?.number || 1;
  const progress = episodes.map(entry => progressFor(`${item.id}:${entry.number}`)).find(Boolean);
  const resume = progressFor(`${item.id}:${first}`);

  page.className = 'watch';
  const art = document.createElement('div');
  art.className = 'watch-art';
  art.style.backgroundImage = `url("${artOf(item)}")`;
  page.append(art);

  const hero = document.createElement('section');
  hero.className = 'watch-hero';
  const title = document.createElement('h1');
  title.className = 'watch-title';
  title.textContent = titleOf(item);
  const native = document.createElement('p');
  native.className = 'watch-native';
  native.textContent = item.title?.native || '';
  hero.append(title, native);
  const meta = document.createElement('div');
  meta.className = 'hero-meta';
  const bits = [
    (item.genres || []).slice(0, 2).join(' / '),
    dateLabel(item),
    item.duration ? `${item.duration}m` : '',
    item.isAdult ? 'TV-MA' : (item.format === 'MOVIE' ? 'Film' : ''),
  ].filter(Boolean);
  bits.forEach((bit, index) => {
    if (index) meta.append(sep());
    meta.append(bold(bit));
  });
  const score = scoreOf(item);
  if (score) meta.append(chip(`${score} / 10`, 'score'));
  hero.append(meta);
  const note = document.createElement('p');
  note.className = 'hero-note';
  note.textContent = plain(item.description) || 'No description yet.';
  hero.append(note);
  const actions = document.createElement('div');
  actions.className = 'watch-actions';
  const start = document.createElement('button');
  start.type = 'button';
  start.className = 'btn btn-solid';
  start.innerHTML = '<svg viewBox="0 0 24 24" class="i"><path d="M8 5.5v13l11-6.5-11-6.5Z"/></svg>' +
    (resume && resume.at > 20 ? `Resume S${season} · E${first}` : 'Start');
  start.addEventListener('click', () => watch(item, first));
  actions.append(start);
  const iconRow = document.createElement('div');
  iconRow.className = 'icon-row';
  const mine = document.createElement('button');
  mine.type = 'button';
  mine.className = `icon-btn${store.has(item) ? ' is-on' : ''}`;
  mine.innerHTML = '<svg viewBox="0 0 24 24" class="i"><path d="M6.5 4h11a1 1 0 0 1 1 1v15l-6.5-3.6L5.5 20V5a1 1 0 0 1 1-1Z" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>';
  mine.title = store.has(item) ? 'In my list' : 'Add to my list';
  mine.addEventListener('click', () => {
    const added = store.toggle(item);
    mine.classList.toggle('is-on', added);
    mine.title = added ? 'In my list' : 'Add to my list';
    showToast(added ? 'Saved to my list' : 'Removed from my list');
    if (state.page === 'library') go('library', { push: false });
  });
  const share = document.createElement('button');
  share.type = 'button';
  share.className = 'icon-btn';
  share.innerHTML = '<svg viewBox="0 0 24 24" class="i"><path d="M12 15V5m0 0-3.5 3.5M12 5l3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><path d="M6 12.5H5a1 1 0 0 0-1 1V19a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5.5a1 1 0 0 0-1-1h-1" fill="none" stroke="currentColor" stroke-width="1.7"/></svg>';
  share.title = 'Share';
  share.addEventListener('click', () => showToast('Sharing is the real app’s job.'));
  iconRow.append(mine, share);
  actions.append(iconRow);
  hero.append(actions);
  page.append(hero);

  const strip = document.createElement('div');
  strip.className = 'days seasons';
  for (const season2 of seasons) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `day${season2 === season ? ' is-on' : ''}`;
    const watched = episodes.filter(entry => Math.ceil(entry.number / 12) === season2).some(entry => progressFor(`${item.id}:${entry.number}`));
    button.append(bold(`Season ${season2}`), watched ? tick() : span(''));
    button.addEventListener('click', () => { state.season = season2; go('watch', { push: false }); });
    strip.append(button);
  }
  page.append(strip);

  const list2 = document.createElement('div');
  list2.className = 'eps';
  for (const entry of list) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'ep';
    const progress2 = progressFor(`${item.id}:${entry.number}`);
    row.dataset.ep = String(entry.number);
    const thumb = document.createElement('div');
    thumb.className = 'ep-thumb';
    thumb.style.backgroundImage = `url("${entry.thumbnail || item.coverImage?.extraLarge || ''}")`;
    const badge = document.createElement('span');
    badge.className = 'ep-badge';
    badge.textContent = `S${season} • E${String(entry.number % 12 || 12).padStart(2, '0')}`;
    thumb.append(badge);
    if (progress2 && progress2.dur && progress2.at / progress2.dur > 0.02) {
      const bar = document.createElement('i');
      bar.className = 'ep-bar';
      bar.style.width = `${Math.min(100, progress2.at / progress2.dur * 100)}%`;
      thumb.append(bar);
    }
    if (progress2 && progress2.dur && progress2.at / progress2.dur > 0.9) thumb.append(tick());
    const body = document.createElement('div');
    body.className = 'ep-body';
    body.append(title3(entry.title || `Episode ${entry.number}`));
    body.append(par(entry.summary || (entry.number === first ? 'The one everyone starts with.' : `Episode ${entry.number} of ${titleOf(item)}.`)));
    row.append(thumb, body);
    row.addEventListener('click', () => watch(item, entry.number));
    list2.append(row);
  }
  page.append(list2);
  return page;
}

function tick() {
  const el = document.createElement('span');
  el.className = 'tick';
  el.innerHTML = '<svg viewBox="0 0 24 24" class="i"><path d="M5 12.5 10 17.5 19 7.5" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  return el;
}

/* Play it. The watch page hands over to the player, and the player hands back
   a page that knows which episode was last on the screen. */
async function watch(item, number) {
  if (!state.live) { showToast('Playback needs Koma’s servers running.'); return; }
  showToast(`Finding episode ${number}…`);
  let stream;
  try {
    stream = await resolveEpisode(item.id, number, state.audioType);
  } catch (error) {
    showToast(`${error.message}`);
    return;
  }
  state.playerItem = item;
  state.playerEpisode = number;
  state.playerStream = stream;
  go('player', { push: false });
}

function renderPlayerPage() {
  const item = state.playerItem;
  const number = state.playerEpisode;
  const stream = state.playerStream;
  const page = document.createElement('div');
  if (!item || !stream) {
    page.append(head('Nothing to play', 'Pick an episode on its title page.'));
    return page;
  }
  const saved = progressFor(`${item.id}:${number}`);
  page.className = 'page player-page';
  const mount = document.createElement('div');
  mount.id = 'player-mount';
  mount.style.height = '100%';
  page.append(mount);
  new TvPlayer(mount, {
    title: titleOf(item),
    subtitle: `Season ${Math.ceil(number / 12)} · Episode ${number}${state.audioType === 'dub' ? ' · dubbed' : ''}`,
    art: artOf(item),
    streams: [stream],
    subtitles: stream.subtitles,
    resumeAt: saved && saved.at > 20 && saved.at / saved.dur < 0.9 ? saved.at : 0,
    progressKey: `${item.id}:${number}`,
    onExit: () => go('watch', { push: false }),
    onNext: () => {
      const next = number + 1;
      if (next <= episodesOf(item).length) { watch(item, next); return; }
      go('watch', { push: false });
      showToast('That was the last episode.');
    },
  });
  return page;
}

/* ---------- data for the pages that need their own ---------- */

async function setGenre(genre) {
  state.browse.genre = genre;
  state.browse.page = 1;
  state.browse.items = [];
  if (!state.live) { go('browse', { push: false }); return; }
  state.browse.busy = true;
  const answer = await bridge.fetchBrowse(state.base, { genre, sort: 'POPULARITY_DESC', page: 1 });
  state.browse.busy = false;
  if (answer.ok) state.browse.items = answer.data.media || [];
  go('browse', { push: false });
  if (state.live) showToast(answer.ok ? `Browse · ${state.browse.items.length} titles` : `Koma said: ${answer.error}`);
}

async function moreBrowse() {
  if (!state.live || state.browse.busy) return;
  state.browse.busy = true;
  const next = state.browse.page + 1;
  const answer = await bridge.fetchBrowse(state.base, { genre: state.browse.genre, sort: 'POPULARITY_DESC', page: next });
  if (answer.ok && answer.data.media?.length) {
    state.browse.page = next;
    const grid = $('#browse-grid');
    const before = state.browse.items.length;
    state.browse.items.push(...answer.data.media);
    answer.data.media.forEach(item => grid.append(cardElement(item)));
    const rows = rowsOf([...grid.children]).length;
    focusRow(rows - 1, 0);
    showToast(`Browse · page ${next} · ${state.browse.items.length} titles`);
  } else showToast('That is the whole catalog.');
  state.browse.busy = false;
}

async function setDay(offset) {
  state.schedule.day = offset;
  state.schedule.items = [];
  if (!state.live) { go('tv', { push: false }); return; }
  state.schedule.busy = true;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() + offset);
  const from = Math.floor(start.getTime() / 1000);
  const answer = await bridge.fetchSchedule(state.base, from, from + 86400);
  state.schedule.busy = false;
  if (answer.ok) state.schedule.items = answer.data.schedules || [];
  go('tv', { push: false });
  showToast(answer.ok ? `${state.schedule.items.length} episodes air this day` : `Koma said: ${answer.error}`);
}

function runSearch(text) {
  clearTimeout(state.search.timer);
  if (!text.trim()) { state.search.items = []; paintSearch(); return; }
  if (!state.live) return;
  state.search.timer = setTimeout(async () => {
    state.search.busy = true;
    const answer = await bridge.fetchSearch(state.base, text);
    state.search.busy = false;
    state.search.text = text;
    state.search.items = answer.ok ? (answer.data.media || []) : [];
    paintSearch();
    $('#find-note').innerHTML = answer.ok ? `${state.search.items.length} matches` : `Koma said: <b>${answer.error}</b>`;
  }, 240);
}

function paintSearch() {
  const grid = $('#search-grid');
  if (!grid) return;
  grid.replaceChildren();
  state.search.items.forEach((item, index) => grid.append(cardElement(item, index < 5 ? undefined : undefined)));
  focusFirst();
}

/* The home feed is a card: it carries no air date, no runtime and no streaming
   site. The spotlight asks for the whole record, so the hero can say what a
   television says: when it is from, how long it runs, and where to watch. */
async function enrichSpotlight() {
  const item = state.spotlight;
  if (!item?.id || !state.live || state.page !== 'home') return;
  const answer = await bridge.fetchAnime(state.base, item.id);
  if (!answer.ok || state.spotlight !== item || state.page !== 'home') return;
  Object.assign(item, answer.data);
  const meta = $('.hero-meta');
  if (meta) {
    meta.replaceChildren();
    const bits = [dateLabel(item), item.format?.replace('_', ' ').toLowerCase(), item.duration ? `${item.duration}m` : ''].filter(Boolean);
    bits.forEach((bit, index) => {
      if (index) meta.append(sep());
      const part = document.createElement('b');
      part.textContent = bit;
      meta.append(part);
    });
    const genres = (item.genres || []).slice(0, 3).join(' / ');
    if (genres) meta.append(chip(genres));
    const studio = item.studios?.nodes?.[0]?.name;
    if (studio) meta.append(chip(studio));
    const score = scoreOf(item);
    if (score) meta.append(chip(`${score} / 10`, 'score'));
    const links = (item.externalLinks || []).filter(link => link?.site && (link.type ? link.type === 'STREAMING' : link.site !== 'Official Site'));
    for (const link of links.slice(0, 2)) meta.append(chip(link.site, 'site'));
    setBackdrop(artOf(item), item.coverImage?.color);
  }
}

/* ---------- the pieces of a page ---------- */

function cardElement(item, kind, index = 0, flags = {}) {
  const card = document.createElement('button');
  card.type = 'button';
  card.className = `card ${kind === 'ranked' ? 'card-portrait' : 'card-landscape'}${flags.spot ? ' card-spot' : ''}${flags.airing ? ' is-airing' : ''}`;
  if (item.id) card.dataset.id = String(item.id);
  card.style.setProperty('--tone', item.coverImage?.color || '#22262e');
  const art = document.createElement('img');
  art.loading = 'lazy';
  art.decoding = 'async';
  art.src = kind === 'ranked' ? (item.coverImage?.large || item.coverImage?.extraLarge || '') : artOf(item);
  art.alt = '';
  card.append(art);
  const scrim = document.createElement('div');
  scrim.className = 'card-scrim';
  card.append(scrim);
  if (kind === 'ranked') {
    const rank = document.createElement('span');
    rank.className = 'card-rank';
    rank.textContent = String(index + 1).padStart(2, '0');
    card.append(rank);
  }
  if (item.nextAiringEpisode?.episode && flags.airing) card.append(badge(`Ep ${item.nextAiringEpisode.episode}`));
  const body = document.createElement('div');
  body.className = 'card-body';
  body.append(title3(titleOf(item)));
  const line = document.createElement('p');
  line.textContent = [item.format?.replace('_', ' ').toLowerCase(), item.episodes ? `${item.episodes} eps` : ''].filter(Boolean).join(' · ');
  body.append(line);
  card.append(body);
  card.addEventListener('click', () => goWatch(item));
  card.addEventListener('mouseenter', () => setBackdrop(artOf(item), item.coverImage?.color));
  return card;
}

function badge(text) { const el = document.createElement('span'); el.className = 'card-badge'; el.textContent = text; return el; }
function sep() { const el = document.createElement('span'); el.className = 'hero-sep'; el.textContent = '·'; return el; }
function chip(text, kind) {
  const el = document.createElement('span');
  el.className = `chip${kind ? ` ${kind}` : ''}`;
  if (kind === 'score') el.innerHTML = `<span class="dot"></span>${text}`;
  else el.textContent = text;
  return el;
}
function pill(text, on, action) {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = `pill${on ? ' is-on' : ''}`;
  el.textContent = text;
  el.addEventListener('click', action);
  return el;
}
function title1(text) { const el = document.createElement('h1'); el.textContent = text; return el; }
function title2(text) { const el = document.createElement('h2'); el.textContent = text; return el; }
function title3(text) { const el = document.createElement('h3'); el.textContent = text; return el; }
function par(text) { const el = document.createElement('p'); el.textContent = text; return el; }
function bold(text) { const el = document.createElement('b'); el.textContent = text; return el; }
function span(text) { const el = document.createElement('span'); el.textContent = text; return el; }
function div(children, className) { const el = document.createElement('div'); if (className) el.className = className; el.append(...children); return el; }
function img(src) { const el = document.createElement('img'); el.src = src; el.alt = ''; return el; }
function input() {
  const el = document.createElement('input');
  el.type = 'search';
  el.placeholder = 'Search anime';
  el.autocomplete = 'off';
  el.spellcheck = false;
  return el;
}
function svgIcon(name) {
  const paths = {
    search: '<circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="1.7"/><path d="M15.5 15.5 21 21" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  };
  const wrap = document.createElement('div');
  wrap.innerHTML = `<svg viewBox="0 0 24 24" class="i">${paths[name] || ''}</svg>`;
  return wrap.firstElementChild;
}
function emptyBlock(title, text) {
  const wrap = document.createElement('div');
  wrap.className = 'empty';
  wrap.append(bold(title), par(text));
  return wrap;
}

/* ---------- the artwork behind the focus ---------- */

let artToken = 0;

function setBackdrop(url, tone) {
  if (tone) document.body.style.setProperty('--tint', tone);
  if (!url) return;
  const token = ++artToken;
  const next = $(`.backdrop-art[data-art="${state.artLayer === 'a' ? 'b' : 'a'}"]`);
  const loader = new Image();
  loader.onload = () => {
    if (token !== artToken) return;
    next.style.backgroundImage = `url("${url}")`;
    state.artLayer = state.artLayer === 'a' ? 'b' : 'a';
    $$('.backdrop-art').forEach(layer => layer.dataset.show = layer === next ? '1' : '0');
  };
  loader.src = url;
}

/* A title opens its own screen: the record is fetched whole so the watch page
   can say how long an episode runs, name the episodes it knows, and offer the
   seasons. */
async function goWatch(item) {
  if (!item?.id) return;
  state.season = 1;
  if (item.streamingEpisodes || !state.live) { state.watchItem = item; go('watch', { push: true }); return; }
  showToast('Opening the title page…');
  const answer = await bridge.fetchAnime(state.base, item.id);
  if (!answer.ok) { state.watchItem = item; go('watch', { push: true }); return; }
  state.watchItem = Object.assign({}, item, answer.data);
  go('watch', { push: true });
}

/* ---------- the title sheet ---------- */

function openSheet(item) {
  if (!item) return;
  state.sheetItem = item;
  let sheet = $('#sheet');
  if (!sheet) {
    sheet = document.createElement('section');
    sheet.className = 'sheet';
    sheet.id = 'sheet';
    sheet.hidden = true;
    document.body.append(sheet);
  }
  sheet.hidden = false;
  sheet.replaceChildren();
  const panel = document.createElement('div');
  panel.className = 'sheet-panel';
  const art = document.createElement('div');
  art.className = 'sheet-art';
  art.style.backgroundImage = `url("${artOf(item)}")`;
  panel.append(art);
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'icon-btn sheet-close';
  close.innerHTML = '<svg viewBox="0 0 24 24" class="i"><path d="M7 7l10 10M17 7 7 17" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
  close.setAttribute('aria-label', 'Close');
  close.addEventListener('click', closeSheet);
  panel.append(close);
  const body = document.createElement('div');
  body.className = 'sheet-body';
  body.append(title3(titleOf(item)));
  const meta = document.createElement('div');
  meta.className = 'sheet-meta';
  meta.append(chip(dateLabel(item) || (item.seasonYear ? String(item.seasonYear) : '—'), 'flat'));
  if (item.format) meta.append(chip(item.format.replace('_', ' ').toLowerCase()));
  if (item.episodes) meta.append(chip(`${item.episodes} episodes`));
  if (item.studios?.nodes?.[0]) meta.append(chip(item.studios.nodes[0].name));
  const score = scoreOf(item);
  if (score) meta.append(chip(`${score} / 10`, 'score'));
  body.append(meta);
  body.append(par(plain(item.description) || 'No description yet.'));
  const actions = document.createElement('div');
  actions.className = 'sheet-actions';
  const play = document.createElement('button');
  play.type = 'button';
  play.className = 'btn btn-solid';
  play.innerHTML = '<svg viewBox="0 0 24 24" class="i"><path d="M8 5.5v13l11-6.5-11-6.5Z"/></svg>Play';
  play.addEventListener('click', () => showToast('Playback is not part of this study: it is here for the picture.'));
  const mine = document.createElement('button');
  mine.type = 'button';
  mine.className = `btn ${store.has(item) ? 'is-on' : 'btn-quiet'}`;
  mine.addEventListener('click', () => {
    const added = store.toggle(item);
    mine.className = `btn ${added ? 'is-on' : 'btn-quiet'}`;
    mine.textContent = added ? 'In my list' : 'Add to my list';
    showToast(added ? 'Saved to my list — the Library page shows it' : 'Removed from my list');
    if (state.page === 'library') go('library', { push: false });
  });
  mine.textContent = store.has(item) ? 'In my list' : 'Add to my list';
  actions.append(play, mine);
  body.append(actions);
  panel.append(body);
  sheet.append(panel);
  if (item.coverImage?.color) sheet.style.setProperty('--tint', item.coverImage.color);
  requestAnimationFrame(() => panel.classList.add('on'));
}

function closeSheet() {
  state.sheetItem = null;
  const sheet = $('#sheet');
  if (sheet) { sheet.hidden = true; sheet.replaceChildren(); }
}

/* ---------- the clock ---------- */

function startClock() {
  const paint = () => {
    const now = new Date();
    $('#clock').textContent = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  };
  paint();
  setInterval(paint, 20000);
}

/* ---------- the remote ---------- */

/* Everything the page can point at, grouped the way the page is laid out: a
   row of shelves, a grid, or one plain column. */
function pageRows() {
  const stage = $('#stage');
  const rows = [];
  const tracks = [...stage.querySelectorAll('.shelf-track')];
  if (tracks.length) rows.push(...tracks.map(track => [...track.querySelectorAll('.card')]));
  // A page of filters and a grid: the pills are the first row, the grid the rest.
  const strips = [...stage.querySelectorAll('.strip, .days')];
  if (strips.length) rows.unshift(...strips.map(strip => [...strip.querySelectorAll('button')]));
  const grid = $('#browse-grid, #search-grid');
  if (grid) {
    const cards = [...grid.querySelectorAll('.card')];
    if (cards.length) {
      const gridRows = rowsOf(cards);
      const trackRows = rows.slice();
      return { kind: 'grid', rows: [...trackRows, ...gridRows].filter(items => items.length) };
    }
  }
  const list = [...stage.querySelectorAll('.row-item, .setting')];
  if (list.length) return { kind: 'linear', rows: [list] };
  return { kind: rows.length ? 'rows' : 'none', rows: rows.filter(items => items.length) };
}

function rowsOf(items) {
  const rows = [];
  let top = null;
  for (const item of items) {
    const y = Math.round(item.getBoundingClientRect().top);
    if (top === null || Math.abs(y - top) > 8) { rows.push([item]); top = y; }
    else rows[rows.length - 1].push(item);
  }
  return rows;
}

function focusFirst() {
  const layout = pageRows();
  if (!layout.rows.length || !layout.rows[0].length) { focusRail(); return; }
  focusRow(0, 0);
}

function focusRow(row, col) {
  const layout = pageRows();
  const items = layout.rows[row];
  if (!items?.length) return;
  const index = Math.max(0, Math.min(col, items.length - 1));
  state.focus = { row, col: index };
  const item = items[index];
  $$('.card.is-on, .row-item.is-on').forEach(other => { if (other !== item) other.classList.remove('is-on'); });
  item.classList.add('is-on');
  item.focus({ preventScroll: true });
  item.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  if (item.dataset.id) {
    const found = findItem(Number(item.dataset.id));
    if (found) setBackdrop(artOf(found), found.coverImage?.color);
  }
}

function findItem(id) {
  const pools = [
    state.shelves.flatMap(shelf => shelf.items),
    state.browse.items,
    state.search.items,
    state.schedule.items.map(entry => entry.media),
    store.get(),
  ];
  for (const pool of pools) {
    const found = pool.find(item => item?.id === id);
    if (found) return found;
  }
  return null;
}

function move(dir) {
  if (state.focus.row < 0) return walkRail(dir);
  const layout = pageRows();
  if (layout.kind === 'none') { focusRail(); return; }
  const { row, col } = state.focus;
  if (layout.kind === 'linear') {
    const items = layout.rows[0];
    if (dir === 'down' || dir === 'right') { if (col < items.length - 1) focusRow(0, col + 1); }
    if (dir === 'up' || dir === 'left') { if (col > 0) focusRow(0, col - 1); else focusRail(); }
    return;
  }
  if (dir === 'left' || dir === 'right') {
    const delta = dir === 'right' ? 1 : -1;
    if (layout.rows[row][col + delta]) focusRow(row, col + delta);
    return;
  }
  if (dir === 'down') {
    if (row + 1 < layout.rows.length) focusRow(row + 1, col);
    else if (state.page === 'browse') moreBrowse();
    return;
  }
  if (dir === 'up') {
    if (row > 0) focusRow(row - 1, col);
    else focusRail();
  }
}

/* The rail is a row of its own: sideways walks it, down leaves it for the
   page, and up does nothing at all — there is nothing above the top. */
function railItems() {
  return [$('.who'), ...$$('.nav-item'), $('[data-nav="settings"]')].filter(Boolean);
}

function walkRail(dir) {
  if (dir === 'down') { focusFirst(); return; }
  if (dir === 'up') return;
  const items = railItems();
  const at = items.indexOf(document.activeElement);
  const next = at + (dir === 'right' ? 1 : -1);
  if (next >= 0 && next < items.length) items[next].focus();
}

function focusRail(item) {
  state.focus = { row: -1, col: -1 };
  $$('.card.is-on, .row-item.is-on').forEach(card => card.classList.remove('is-on'));
  (item || $$('.nav-item.is-on')[0] || railItems()[0])?.focus();
}

function onKey(event) {
  const key = event.key;
  if (key === 'Escape') {
    back();
    return;
  }
  if (event.target?.tagName === 'INPUT') return;
  switch (key) {
    case 'ArrowDown': case 's': move('down'); event.preventDefault(); break;
    case 'ArrowUp': case 'w': move('up'); event.preventDefault(); break;
    case 'ArrowRight': case 'd': move('right'); event.preventDefault(); break;
    case 'ArrowLeft': case 'a': move('left'); event.preventDefault(); break;
    case 'Enter': {
      const card = document.activeElement?.closest?.('.card');
      if (card?.dataset.id) {
        const found = findItem(Number(card.dataset.id));
        if (found) goWatch(found);
        event.preventDefault();
      }
      break;
    }
    case 'f': case 'F': bridge.window('fullscreen'); break;
    default: break;
  }
}

/* When the focus lands on a card the pad did not put there — a click, a tab —
   the page follows it, so the highlight never lags behind the artwork. */
document.addEventListener('focusin', event => {
  const card = event.target.closest?.('.card');
  if (!card || state.focus.row < 0) return;
  for (const [row, items] of pageRows().rows.entries()) {
    const col = items.indexOf(card);
    if (col >= 0) { state.focus = { row, col }; break; }
  }
});

boot().catch(error => {
  console.error('The study could not start:', error);
  const marker = document.createElement('div');
  marker.id = 'boot-error';
  marker.style.cssText = 'position:fixed;inset:auto 12px 12px 12px;z-index:99;padding:10px;border-radius:8px;background:#2a0d0d;color:#ffd7d7;font:12px monospace;white-space:pre-wrap';
  marker.textContent = String(error?.stack || error);
  document.body.append(marker);
});