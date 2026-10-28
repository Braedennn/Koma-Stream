// App shell: client-side routing, header state, search suggestions, My list syncing.
import { api } from './api.js';
import { listIds, toggleList } from './store.js';
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
import { initNotifications } from './notify.js';
import { initPresence, presenceForRoute, setActivity } from './presence.js';
import { account, clientId, finishLogin, initAutoSync, loginUrl, REDIRECT, setClientId, signOut, syncNow, syncPending } from './anilist.js';

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
];

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
  app.replaceChildren(root);
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
  try { await view(root, ctx); }
  catch (err) {
    if (ctx.alive()) { html.classList.remove('has-hero'); errorBox(root, err, () => render()); }
  }
  initAudioBadges(root);
  initNotifications(); // desktop air toasts — no-op in a normal browser
  solidHeader();
  if (y && ctx.alive()) requestAnimationFrame(() => scrollTo(0, y));
}

export function markNav(path = location.pathname) {
  const here = path + location.search;
  const links = $$('.nav a, .tabbar a');
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
  toast(toggleList(Number(b.dataset.list)) ? 'Added to My list' : 'Removed from My list');
});
function syncList() {
  const n = listIds().length;
  for (const c of $$('[data-count]')) { c.textContent = n; c.hidden = !n; }
  $$('[data-list]').forEach(syncListButton);
}
addEventListener('koma:store', syncList);
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

render();
initPresence().catch(() => {});
