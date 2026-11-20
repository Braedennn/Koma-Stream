// MyAnimeList account data: the signed-in session and two-way anime-list
// synchronization. OAuth is handled by account.js; this module only talks to
// the list API and maps MAL entries to the AniList ids Koma uses internally.
import { api as komaApi } from './api.js';
import { inList, listIds, mergeRemote, watchedSet } from './store.js';

const KEY = 'koma.myanimelist';
const QKEY = 'koma.sync.queue.myanimelist';
const ACTIVE_KEY = 'koma.account.provider';
const API = 'https://api.myanimelist.net/v2';

let acct = load();
let active = false;
const remote = new Map(); // AniList mediaId -> { id: MAL id, mediaId, status, progress }

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
}
function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(acct)); } catch { /* private mode */ }
  dispatchEvent(new CustomEvent('koma:account'));
}

export const provider = 'myanimelist';
export const providerLabel = 'MyAnimeList';
export const account = () => (acct.token && acct.user ? acct.user : null);
export const profileUrl = user => `https://myanimelist.net/profile/${encodeURIComponent(user?.name || '')}`;

/** Only the selected provider synchronizes. The other session is kept for a later switch. */
export function setActive(value) {
  active = !!value;
}
const connected = () => active && !!account();

export function setSession({ accessToken, refreshToken = '', expiresIn = 3600 }) {
  acct.token = String(accessToken || '');
  acct.refreshToken = String(refreshToken || '');
  acct.expires = Date.now() + Number(expiresIn || 0) * 1000;
  persist();
}

export async function loadUser() {
  const data = await malRequest('/users/@me?fields=id,name,picture');
  acct.user = { id: data.id, name: data.name, avatar: data.picture || '' };
  persist();
  return acct.user;
}

export function signOut() {
  delete acct.token;
  delete acct.refreshToken;
  delete acct.expires;
  delete acct.user;
  active = false;
  remote.clear();
  persist();
}

let refreshing = null;
async function refreshAccessToken() {
  if (refreshing) return refreshing;
  if (!acct.refreshToken) throw Object.assign(new Error('Your MyAnimeList sign-in expired. Sign in again.'), { status: 401 });
  refreshing = (async () => {
    const response = await fetch('/api/auth/myanimelist/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ refreshToken: acct.refreshToken }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      signOut();
      throw Object.assign(new Error(data.error || 'Your MyAnimeList sign-in expired. Sign in again.'), { status: 401 });
    }
    setSession(data);
    return data.accessToken;
  })();
  try { return await refreshing; }
  finally { refreshing = null; }
}

async function malRequest(path, options = {}, retry = true) {
  const headers = new Headers(options.headers || {});
  headers.set('Accept', 'application/json');
  if (acct.token) headers.set('Authorization', `Bearer ${acct.token}`);
  if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/x-www-form-urlencoded');
  let response;
  try {
    response = await fetch(API + path, { ...options, headers, signal: AbortSignal.timeout(20000) });
  } catch (error) {
    throw Object.assign(new Error(`Couldn't reach MyAnimeList (${error.cause?.code || error.name}).`), { status: 503 });
  }
  if (response.status === 401 && retry && acct.refreshToken) {
    await refreshAccessToken();
    return malRequest(path, options, false);
  }
  if (response.status === 404 && options.accept404) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    if (response.status === 401) signOut();
    throw Object.assign(
      new Error(data.message || `MyAnimeList answered with status ${response.status}.`),
      { status: response.status, retryAfter: Number(response.headers.get('retry-after')) || 0 },
    );
  }
  return data;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const maxWatched = id => {
  const seen = watchedSet(id);
  return seen.size ? Math.max(...seen) : 0;
};

const STATUS = {
  watching: 'CURRENT',
  completed: 'COMPLETED',
  on_hold: 'PAUSED',
  plan_to_watch: 'PLANNING',
  dropped: 'DROPPED',
};
const MAL_STATUS = Object.fromEntries(Object.entries(STATUS).map(([mal, al]) => [al, mal]));

async function pullList() {
  const entries = [];
  for (let offset = 0; offset < 10000; offset += 1000) {
    const page = await malRequest(`/users/@me/animelist?fields=list_status&limit=1000&offset=${offset}`);
    const items = Array.isArray(page?.data) ? page.data : [];
    entries.push(...items);
    if (items.length < 1000) break;
  }

  const malIds = [...new Set(entries.map(item => Number(item?.node?.id)).filter(Number.isInteger))];
  const mapped = [];
  for (let i = 0; i < malIds.length; i += 500) {
    const chunk = malIds.slice(i, i + 500);
    const data = await komaApi(`/media/mal?ids=${chunk.join(',')}`);
    mapped.push(...(data.media || []));
  }
  const byMal = new Map(mapped.map(media => [Number(media.idMal), Number(media.id)]));

  remote.clear();
  const local = [];
  for (const item of entries) {
    const malId = Number(item?.node?.id);
    const mediaId = byMal.get(malId);
    if (!mediaId) continue;
    const listStatus = item?.list_status || {};
    const status = STATUS[listStatus.status] || 'PLANNING';
    const progress = Number(listStatus.num_watched_episodes) || 0;
    const entry = { id: malId, mediaId, status, progress };
    remote.set(mediaId, entry);
    if (status !== 'DROPPED') local.push(entry);
  }
  mergeRemote(local);
}

let syncing = null;
export function syncNow() {
  if (!connected()) return Promise.resolve(false);
  return (syncing ??= (async () => {
    try {
      await pullList();
      for (const id of listIds()) {
        const entry = remote.get(id);
        if (!entry || maxWatched(id) > (entry.progress || 0)) {
          await push(id).catch(error => {
            if (transient(error) && error.status !== 401) enqueue([id], rateAfter(error));
          });
          await sleep(400);
        }
      }
      return true;
    } finally { syncing = null; }
  })());
}

export function syncPull() {
  if (!connected()) return Promise.resolve(false);
  return (syncing ??= (async () => { try { await pullList(); return true; } finally { syncing = null; } })());
}

let outbox = (() => {
  try {
    const queue = JSON.parse(localStorage.getItem(QKEY));
    return Array.isArray(queue) ? queue.filter(Number.isInteger) : [];
  } catch { return []; }
})();
const persistBox = () => { try { localStorage.setItem(QKEY, JSON.stringify(outbox)); } catch { /* private mode */ } };
const announce = () => dispatchEvent(new CustomEvent('koma:sync', { detail: { pending: outbox.length } }));
export const syncPending = () => outbox.length;

const transient = error => !error?.status || error.status === 429 || error.status >= 500 || Boolean(error?.retryAfter);
const rateAfter = error => error?.retryAfter ? Math.max(10e3, error.retryAfter * 1000) : undefined;

function enqueue(ids, at) {
  let added = 0;
  for (const id of ids) if (!outbox.includes(id)) { outbox.push(id); added++; }
  if (!added) return false;
  persistBox();
  schedule(at);
  announce();
  return true;
}
function dequeue(id) {
  const at = outbox.indexOf(id);
  if (at < 0) return false;
  outbox.splice(at, 1);
  persistBox();
  announce();
  return true;
}

const BACKOFF = [5000, 15000, 30000, 60000, 120000, 300000];
let attempt = 0;
let pumpTimer = null;
let pumping = false;

function schedule(at) {
  clearTimeout(pumpTimer);
  if (!outbox.length) return;
  pumpTimer = setTimeout(() => { pumpTimer = null; pump(); }, at ?? BACKOFF[Math.min(attempt, BACKOFF.length - 1)]);
}

async function pump() {
  if (pumping || !outbox.length || !connected()) return;
  pumping = true;
  let calmed = null;
  try {
    let failed = 0;
    for (let i = 0; i < outbox.length;) {
      const id = outbox[i];
      try {
        await push(id);
        dequeue(id);
        attempt = 0;
      } catch (error) {
        if (error?.status === 401) { outbox.length = 0; persistBox(); announce(); return; }
        failed++;
        if (transient(error)) i++;
        else {
          dequeue(id);
          dispatchEvent(new CustomEvent('koma:sync-error', { detail: error.message }));
        }
        if (error?.retryAfter) { calmed = Math.max(10e3, error.retryAfter * 1000); break; }
      }
      if (i < outbox.length || !failed) await sleep(400);
    }
    if (failed) attempt++;
  } finally {
    pumping = false;
    if (outbox.length) schedule(calmed);
    else attempt = 0;
  }
}

async function push(id) {
  const known = remote.get(id);
  if (!inList(id)) {
    if (known) {
      await malRequest(`/anime/${known.id}/my_list_status`, { method: 'DELETE', accept404: true });
      remote.delete(id);
    }
    return;
  }

  let malId = known?.id;
  if (!malId) {
    const media = await komaApi(`/anime/${id}`).catch(() => null);
    malId = Number(media?.idMal) || 0;
  }
  if (!malId) {
    throw Object.assign(new Error('This title has no MyAnimeList entry, so it cannot be synced there.'), { status: 400 });
  }

  const progress = maxWatched(id);
  let status = progress ? 'watching' : 'plan_to_watch';
  if (progress) {
    const data = await komaApi(`/media?ids=${id}`).catch(() => null);
    const media = data?.media?.[0];
    if (media?.episodes && progress >= media.episodes && media.status === 'FINISHED') status = 'completed';
  }
  if (known && ['on_hold', 'completed'].includes(MAL_STATUS[known.status]) && status !== 'completed' && progress <= (known.progress || 0)) {
    status = MAL_STATUS[known.status];
  }
  if (known && known.status === STATUS[status] && (known.progress || 0) === progress) return;

  const body = new URLSearchParams({ status, num_watched_episodes: String(progress) });
  await malRequest(`/anime/${malId}/my_list_status`, { method: 'PUT', body });
  remote.set(id, { id: malId, mediaId: id, status: STATUS[status], progress });
}

const timers = new Map();
addEventListener('koma:store', event => {
  const { id, remote: fromProvider } = event.detail || {};
  if (!id || fromProvider || !connected()) return;
  clearTimeout(timers.get(id));
  timers.set(id, setTimeout(() => {
    timers.delete(id);
    push(id).then(() => dequeue(id)).catch(error => {
      if (!transient(error)) {
        dispatchEvent(new CustomEvent('koma:sync-error', { detail: error.message }));
        return;
      }
      if (enqueue([id], rateAfter(error))) {
        dispatchEvent(new CustomEvent('koma:sync-error', { detail: `${error.message}. It will be retried automatically.` }));
      }
    });
  }, 1500));
});

const PULL_EVERY = 10 * 60e3;
let lastPull = 0;
function pullIfDue() {
  if (!connected() || Date.now() - lastPull < PULL_EVERY) return;
  syncPull().then(ok => { if (ok) lastPull = Date.now(); }).catch(() => {});
}

export function initAutoSync() {
  lastPull = Date.now();
  addEventListener('online', () => schedule(5000));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { schedule(5000); pullIfDue(); } });
  setInterval(pullIfDue, PULL_EVERY);
  if (outbox.length) { announce(); schedule(3000); }
}
