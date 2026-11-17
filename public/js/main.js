// App shell: client-side routing, header state, search suggestions, My list syncing.
import { api } from './api.js';
import { libraryIds, toggleList, watchedIds, hideFromContinue } from './store.js';
import { openShelfMenu } from './library.js';
import { $, $$, esc, errorBox, icon, meta, name, pretty, score, small, syncListButton, toast } from './ui.js';
import { home } from './views/home.js';
import { anime } from './views/anime.js';
import { watch } from './views/watch.js';
import { browse } from './views/browse.js';
import { schedule } from './views/schedule.js';
import { list } from './views/list.js';
import { stats } from './views/stats.js';
import { notFound } from './views/notfound.js';
import { initAudioBadges } from './streaming.js';
import { abandon, arrive, initMotion, swapView } from './motion.js';
import { initSettings } from './settings.js';
import { initDialogs } from './dialog.js';
import { initNotifications } from './notify.js';
import { initPresence, presenceForRoute, setActivity } from './presence.js';
import { initVersion } from './version.js';
import { initWindow } from './window.js';
import { initTv, isTv } from './tv.js';

/* The Android shell injects `KomaAndroid`. With it the page is the app: the
   footer reports the app's own version ("Up to date") instead of presenting
   Koma as a web page, and the fine print says where the data really lives. */
if (window.KomaAndroid) {
  // The page is the app, not a web page: the stylesheet drops the site's own
  // furniture on `html.android` (the footer, and the player's volume slider,
  // which the device's own volume control replaces).
  document.documentElement.classList.add('android');
  const shell = window.KomaAndroid;
  const v = String(shell.version() || 'dev');
  const status = () => {
    try {
      const raw = shell.updateStatus?.();
      const info = raw ? JSON.parse(raw) : null;
      if (info?.current) return info;
    } catch (e) { /* fall back to the installed version */ }
    return { current: v, latest: v, outdated: false, state: 'idle', checking: false };
  };
  window.koma = {
    version: () => Promise.resolve(status()),
    update: {
      check: () => {
        shell.updateCheck?.();
        shell.updateShow?.();
        return Promise.resolve(true);
      },
      apply: () => { shell.updateShow?.(); return Promise.resolve(true); },
      cancel: () => { shell.updateCancel?.(); return Promise.resolve(true); },
    },
  };
  const fine = document.querySelector('.fine');
  if (fine) fine.textContent = fine.textContent.replace('in this browser', 'on this device');
}

/* The television build. The class goes on before anything is drawn, so the
   first page is already laid out for the sofa and the remote. */
const tv = isTv();
if (tv) initTv();
import { initScrollbar } from './scrollbar.js';
import { initPreviews, previewsOn } from './preview.js';
import { account, clientId, finishLogin, initAutoSync, loginUrl, REDIRECT, setClientId, signOut, syncNow, syncPending } from './anilist.js';
import { initRoomUI, joinSession, room, roomUrl, waitForState } from './room.js';
import { initLinks } from './links.js';

// The links out to Discord and GitHub live in one file; the markup only names
// them, so the addresses are set here.
initLinks();

/* ---------- Koma stays in Koma ----------
 * Middle-click here is autoscroll, not "open in browser", and nothing drags out —
 * cover thumbnails dragged onto a browser tab would open the app's URL there, which
 * isn't what Koma is for. Dropping things onto the window doesn't navigate either. */
addEventListener('auxclick', e => { if (e.button === 1) e.preventDefault(); });
addEventListener('dragstart', e => e.preventDefault());
addEventListener('dragover', e => e.preventDefault());
addEventListener('drop', e => e.preventDefault());

const routes = [
  [/^\/$/, home],
  [/^\/anime\/(\d+)\/?$/, anime],
  [/^\/watch\/(\d+)\/?$/, watch],
  [/^\/browse\/?$/, browse],
  [/^\/schedule\/?$/, schedule],
  [/^\/list\/?$/, list],
  [/^\/stats\/?$/, stats],
  [/^\/auth\/anilist\/?$/, authAniList],
  [/^\/join\/?$/, joinView],
];

/* ---------- watch together ---------- */
// An invite lands here: /join?code=…&host=…&port=… on the viewer's own Koma.
// We join the session and hand the screen to the host's episode.
async function joinView(root, { query, alive }) {
  const code = (query.get('code') || '').trim().toUpperCase();
  if (!code) {
    root.innerHTML = '<div class="lost"><h1>No session code</h1><p>Open Koma and choose Watch together → Join a session.</p></div>';
    return;
  }
  root.innerHTML = `<div class="lost"><h1>Joining the session…</h1><p>Code ${esc(code)}</p></div>`;
  try {
    await joinSession({ code, host: query.get('host') || '', port: Number(query.get('port')) || 4000 });
  } catch (err) {
    root.innerHTML = `<div class="lost"><h1>Couldn’t join the session</h1><p>${esc(err.message)}</p></div>`;
    return;
  }
  if (!alive()) return;
  // The room may not have said where the host is yet: wait a moment for it.
  const s = await waitForState(5000);
  if (!alive()) return;
  if (location.pathname !== '/join') return; // the room already moved us there
  if (s?.animeId) { go(roomUrl(s)); return; }
  toast('Joined the session — waiting for the host');
  go('/');
}
// The host moved to another episode: a viewer follows.
addEventListener('koma:room-goto', e => {
  const url = e.detail;
  if (!url) return;
  if (url.split('?')[0] === location.pathname) return; // already where the host is
  go(url);
});

/* ---------- AniList account ---------- */
// AniList sends you back to /auth/anilist#access_token=…; finish the sign-in, then show My list.
async function authAniList(root) {
  root.innerHTML = '<div class="lost"><h1>Signing you in…</h1><p>Getting your AniList list.</p></div>';
  const hash = location.hash;
  history.replaceState(null, '', '/auth/anilist'); // don't leave the token in the address bar
  const user = await finishLogin(hash);
  toast(`Signed in as ${user.name} · your AniList list is synced`);
  go('/list', { replace: true });
}

function startLogin() {
  if (clientId()) { location.href = loginUrl(); return; }
  const dlg = $('#al-setup');
  $('#al-redirect').textContent = REDIRECT;
  $('#al-err').hidden = true;
  dlg.showModal();
}
$('[data-copy-redirect]').addEventListener('click', () => navigator.clipboard?.writeText(REDIRECT).then(() => toast('Redirect URL copied')));
$('#al-setup').addEventListener('close', () => {
  const dlg = $('#al-setup');
  if (dlg.returnValue !== 'ok') return;
  const id = $('#al-client').value.trim();
  if (!/^\d+$/.test(id)) { $('#al-err').textContent = 'The Client ID is the number AniList shows for your client.'; $('#al-err').hidden = false; dlg.showModal(); return; }
  setClientId(id);
  location.href = loginUrl();
});

function paintAccount() {
  const user = account();
  const box = $('#acct');
  box.innerHTML = user
    ? `<button class="acct-btn" type="button" aria-haspopup="menu" aria-expanded="false" title="${esc(user.name)}">
        ${user.avatar ? `<img src="${esc(user.avatar)}" alt="">` : `<span>${esc(user.name[0] || '?')}</span>`}</button>
       <div class="acct-menu" role="menu" hidden>
         <p>Signed in to AniList as<b>${esc(user.name)}</b></p>
         <p class="sync-pending" hidden></p>
         <button type="button" role="menuitem" data-acct="sync">${icon('reload')}Sync now</button>
         <a role="menuitem" href="https://anilist.co/user/${encodeURIComponent(user.name)}/animelist" target="_blank" rel="noopener">${icon('external')}My AniList</a>
         <button type="button" role="menuitem" data-acct="out">${icon('x')}Sign out</button>
       </div>`
    : `<button class="btn btn-ghost btn-sm acct-in" type="button" data-acct="in">Sign in with AniList</button>`;
}
$('#acct').addEventListener('click', async e => {
  const btn = e.target.closest('.acct-btn');
  const menu = $('.acct-menu');
  if (btn) { menu.hidden = !menu.hidden; btn.setAttribute('aria-expanded', !menu.hidden); return; }
  const act = e.target.closest('[data-acct]')?.dataset.acct;
  if (menu) menu.hidden = true;
  if (act === 'in') startLogin();
  else if (act === 'out') { signOut(); toast('Signed out of AniList. Your list stays in Koma.'); }
  else if (act === 'sync') {
    toast('Syncing with AniList…');
    syncNow().then(() => toast('Synced with AniList')).catch(err => toast(err.message));
  }
  if (act && $('.acct-btn')) paintSyncLine(); // the pending count may be stale from the last paint
});
document.addEventListener('click', e => { if (!e.target.closest('#acct')) { const m = $('.acct-menu'); if (m) m.hidden = true; } });
addEventListener('koma:account', paintAccount);
addEventListener('koma:sync-error', e => toast(`AniList: ${e.detail}`));
function paintSyncLine() {
  const el = $('#acct .sync-pending');
  if (!el) return;
  const n = syncPending();
  el.hidden = !n;
  if (n) el.textContent = n === 1 ? '1 change waiting to sync…' : `${n} changes waiting to sync…`;
}
addEventListener('koma:sync', paintSyncLine);
paintAccount();
paintSyncLine();
syncNow().catch(err => toast(`AniList: ${err.message}`)); // pull your list every launch
initAutoSync(); // mid-session pulls + pending-push flushes
const html = document.documentElement;
const header = $('#top');

/* ---------- the navigation drawer ----------
   The bottom bar is gone: the header carries the navigation now. When the
   header has no room for the links - a narrow window - the menu button opens
   them in a drawer instead. */
const menuBtn = $('#menu-btn');
const menuDlg = $('#menu');

function closeMenu() {
  if (menuDlg?.open) menuDlg.close();
}
if (menuBtn && menuDlg) {
  menuBtn.addEventListener('click', () => {
    if (menuDlg.open) { closeMenu(); return; }
    menuDlg.showModal();
    menuBtn.setAttribute('aria-expanded', 'true');
  });
  menuDlg.addEventListener('close', () => menuBtn.setAttribute('aria-expanded', 'false'));
  // The backdrop closes it, and so does a link: the router takes the link
  // from there.
  menuDlg.addEventListener('click', e => {
    if (e.target === menuDlg || e.target.closest('a[href]')) closeMenu();
  });
}

/* The shell asks before it leaves the page: whatever is open takes the back
   button first - the drawer, a panel, a question. */
window.__komaBack = () => {
  // The television has one back path for every panel, including the open
  // drop-downs and the history behind the page.
  if (tv && window.__komaTv?.back?.()) return true;
  if (menuDlg?.open) { closeMenu(); return true; }
  const open = [...document.querySelectorAll('dialog[open]')].pop();
  if (open) { open.close('cancel'); return true; }
  const select = document.querySelector('.select.open');
  if (select) { select._close?.(true); return true; }
  return false;
};

/* ---------- light / dark ---------- */
// The theme is set on <html> before the first paint (see index.html); this only
// keeps the browser's chrome colour in step. The switch itself lives in the
// settings panel.
function applyTheme(dark) {
  html.dataset.theme = dark ? 'dark' : 'light';
  try { localStorage.setItem('koma.theme', dark ? 'dark' : 'light'); } catch { /* private mode */ }
  $('meta[name="theme-color"]')?.setAttribute('content', dark ? '#000000' : '#FFFFFF');
}
applyTheme(html.dataset.theme === 'dark');

// The settings panel edits the same preferences the player uses. Changing the
// language here tells any open watch page to follow.
initSettings({
  onTheme: theme => applyTheme(theme !== 'light'),
  onAudio: () => dispatchEvent(new CustomEvent('koma:audio')),
});

// A dialog is its own little page: the page behind it stands still while it
// is open.
initDialogs();

/* ---------- routing ---------- */
history.scrollRestoration = 'manual';
let current = 0;

export function go(url, { replace = false } = {}) {
  history.replaceState({ ...history.state, y: scrollY }, '');
  history[replace ? 'replaceState' : 'pushState']({ y: 0 }, '', url);
  render({ focus: true });
}

async function render({ y = 0, focus = false } = {}) {
  const { pathname } = location;
  let view = notFound;
  let params = [];
  for (const [re, fn] of routes) {
    const m = pathname.match(re);
    if (m) { view = fn; params = m.slice(1); break; }
  }
  dispatchEvent(new Event('koma:route')); // lets the outgoing page clean up (the player, mainly)
  const app = $('#app');
  const root = document.createElement('div');
  html.classList.remove('has-hero');
  closeSuggest();
  markNav(pathname);
  scrollTo(0, 0);
  if (focus) app.focus({ preventScroll: true });

  const id = ++current;
  const ctx = { params, query: new URLSearchParams(location.search), alive: () => id === current && root.isConnected };
  // The page you're on is the default presence; the watch and anime pages
  // replace it with something more specific once they know their details.
  setActivity(presenceForRoute(pathname));

  // hand the screen over: the new page goes in at once, the old one lifts away
  swapView(app, root);

  try { await view(root, ctx); }
  catch (err) {
    if (ctx.alive()) { html.classList.remove('has-hero'); errorBox(root, err, () => render()); }
  }
  if (!ctx.alive()) { abandon(root); return; }
  arrive(root);
  initAudioBadges(root);
  initNotifications(); // desktop air toasts — no-op in a normal browser
  solidHeader();
  if (y && ctx.alive()) requestAnimationFrame(() => scrollTo(0, y));
  // The television restores its focus here: the new page is in, so the place
  // the viewer left can be found again.
  dispatchEvent(new Event('koma:rendered'));
}

export function markNav(path = location.pathname) {
  const here = path + location.search;
  const links = $$('.nav a, .menu-nav a');
  // A link with a query (Trending) wins over the plain page link (Browse) when it matches.
  const queryHit = links.some(a => a.getAttribute('href').includes('?') && here.startsWith(a.getAttribute('href')));
  for (const a of links) {
    const href = a.getAttribute('href');
    const on = href === '/' ? path === '/' : href.includes('?') ? here.startsWith(href) : path.startsWith(href) && !queryHit;
    on ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current');
  }
}

addEventListener('popstate', e => render({ y: e.state?.y || 0 }));
addEventListener('koma:url', () => markNav());

document.addEventListener('click', e => {
  const a = e.target.closest('a[href]');
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || a.target || a.hasAttribute('download')) return;
  const url = new URL(a.href, location.href);
  if (url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.preventDefault();
  if (url.pathname === location.pathname && url.search === location.search && url.hash) {
    document.getElementById(decodeURIComponent(url.hash.slice(1)))?.scrollIntoView({ behavior: 'smooth' });
    return;
  }
  go(url.pathname + url.search + url.hash);
});

/* ---------- header: transparent over hero images, solid once you scroll ---------- */
function solidHeader() {
  header.classList.toggle('solid', scrollY > 30 || !html.classList.contains('has-hero'));
}
addEventListener('scroll', solidHeader, { passive: true });

/* ---------- images fade in once loaded ---------- */
const loaded = e => { if (e.target.classList?.contains('fade')) e.target.classList.add('loaded'); };
document.addEventListener('load', loaded, true);
document.addEventListener('error', loaded, true);

/* ---------- My list buttons anywhere on the page ---------- */
document.addEventListener('click', e => {
  const b = e.target.closest('[data-list]');
  if (!b) return;
  e.preventDefault();
  // The + on a poster opens the library menu instead of toggling the list.
  if (b.hasAttribute('data-shelf-open')) { openShelfMenu(b, Number(b.dataset.shelfOpen)); return; }
  toast(toggleList(Number(b.dataset.list)) ? 'Added to My list' : 'Removed from My list');
});

/* ---------- taking a show out of Continue watching ---------- */
document.addEventListener('click', e => {
  const b = e.target.closest('[data-continue-remove]');
  if (!b) return;
  e.preventDefault();
  e.stopPropagation();
  // The button can also sit in the preview strip, outside the card.
  const card = b.closest('.card')
    || $(`.card [data-continue-remove="${b.dataset.continueRemove}"]`)?.closest('.card');
  const track = card?.closest('.track');   // before the card leaves the page
  hideFromContinue(Number(b.dataset.continueRemove));
  card?.remove();
  // A rail with nothing left in it goes away with its last card.
  if (track && !track.querySelector('.card')) track.closest('section.row')?.remove();
  toast('Taken out of Continue watching');
});
function syncList() {
  const n = libraryIds().length;
  for (const c of $$('[data-count]')) { c.textContent = n; c.hidden = !n; }
  $$('[data-list]').forEach(syncListButton);
}
addEventListener('koma:store', syncList);
addEventListener('koma:shelf', syncList);
syncList();

/* ---------- header search with suggestions ---------- */
const form = $('.search');
const input = $('#q');
const box = $('#suggest');
let items = [];
let active = -1;
let timer;

function closeSuggest() {
  box.hidden = true;
  input.setAttribute('aria-expanded', 'false');
  input.removeAttribute('aria-activedescendant');
  active = -1;
}
function highlight() {
  $$('[role="option"]', box).forEach((li, i) => li.setAttribute('aria-selected', i === active));
  active >= 0 ? input.setAttribute('aria-activedescendant', `sg-${active}`) : input.removeAttribute('aria-activedescendant');
}
function paint(q) {
  box.innerHTML = items.map((a, i) => `<li role="option" id="sg-${i}" aria-selected="false">
      <a href="/anime/${a.id}" tabindex="-1"><img src="${esc(small(a))}" alt="">
        <span><b>${esc(name(a))}</b><small>${esc(meta(pretty(a.format), a.seasonYear))}</small></span>
        ${score(a) ? `<span class="sc">${icon('star')}${score(a)}</span>` : '<span></span>'}</a></li>`).join('')
    + `<li role="option" class="all" id="sg-${items.length}" aria-selected="false"><a href="/browse?search=${encodeURIComponent(q)}" tabindex="-1">${items.length ? 'See all results' : 'No quick matches. Search everything'}${icon('right')}</a></li>`;
  box.hidden = false;
  input.setAttribute('aria-expanded', 'true');
  active = -1;
  highlight();
}
input.addEventListener('input', () => {
  clearTimeout(timer);
  const q = input.value.trim();
  if (q.length < 2) return closeSuggest();
  timer = setTimeout(async () => {
    try {
      const { media } = await api('/suggest?q=' + encodeURIComponent(q));
      if (q !== input.value.trim()) return;
      items = media;
      paint(q);
    } catch { closeSuggest(); }
  }, 200);
});
input.addEventListener('focus', () => { if (input.value.trim().length >= 2 && box.innerHTML) { box.hidden = false; input.setAttribute('aria-expanded', 'true'); } });
input.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeSuggest(); input.blur(); return; }
  if (box.hidden) return;
  const n = items.length + 1;
  if (e.key === 'ArrowDown') { active = (active + 1) % n; highlight(); e.preventDefault(); }
  else if (e.key === 'ArrowUp') { active = (active - 1 + n) % n; highlight(); e.preventDefault(); }
  else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); $$('a', box)[active].click(); input.blur(); }
});
document.addEventListener('click', e => { if (!form.contains(e.target)) closeSuggest(); });
form.addEventListener('submit', e => {
  e.preventDefault();
  const q = input.value.trim();
  closeSuggest();
  input.blur();
  go(q ? `/browse?search=${encodeURIComponent(q)}` : '/browse');
});
// Press "/" or Ctrl+K anywhere to jump to search.
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    if (e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
    e.preventDefault();
    input.focus();
    return;
  }
  if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.target.closest('input, textarea, select, [contenteditable="true"]')) return;
  e.preventDefault();
  input.focus();
});

/* ---------- Surprise me: one good roll you haven't seen ----------
 * Random page of the top-rated catalog, filtered down to what's actually rollable:
 * unseen, released, well-rated, no Hentai. Three pages deep, then it owns the miss. */
const surprise = $('#surprise');
let rolling = false;
surprise?.addEventListener('click', async () => {
  if (rolling) return;
  rolling = true;
  surprise.classList.add('spin');
  try {
    const mine = watchedIds();
    const rollable = a => a
      && a.status !== 'NOT_YET_RELEASED'
      && (a.averageScore || 0) >= 72
      && !(a.genres || []).includes('Hentai')
      && !mine.has(a.id);
    for (let attempt = 0; attempt < 3; attempt++) {
      const page = 1 + (Math.random() * 8 | 0); // top 8 score-sorted pages: good, never fame-only
      const { media } = await api(`/browse?sort=SCORE_DESC&page=${page}`);
      const good = media.filter(rollable);
      if (good.length) {
        const a = good[Math.random() * good.length | 0];
        toast(`🎲 Rolling: ${name(a)}`);
        go(`/anime/${a.id}`);
        return;
      }
    }
    toast('No lucky roll — try again');
  } catch (err) {
    toast(err.message || 'The roll failed — try again');
  } finally {
    surprise.classList.remove('spin');
    rolling = false;
  }
});

initMotion($('#app'));
render();
initRoomUI();
initPresence().catch(() => {});
initVersion();
initWindow();
initScrollbar();
// The previews need a pointer - or, on a television, the focus. They are off
// on a television until the viewer asks for them, and the card menu carries
// what the preview was for until then.
if (!tv || previewsOn()) initPreviews();
