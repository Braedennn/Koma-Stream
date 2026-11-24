// AniList account data: the signed-in session and two-way list/progress sync.
// OAuth itself lives in account.js, so Koma's provider credentials never have
// to be entered by the person using the app.
import { api } from './api.js';
import { inList, listIds, mergeRemote, watchedSet } from './store.js';

const KEY = 'koma.anilist';
const QKEY = 'koma.sync.queue';
const ACTIVE_KEY = 'koma.account.provider';
const GQL = 'https://graphql.anilist.co';

let acct = load(); // { token, expires, user: { id, name, avatar } }
let active = false;
const remote = new Map(); // mediaId -> AniList entry { id, mediaId, status, progress, updatedAt }

function load() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } }
function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(acct)); } catch { /* private mode */ }
  dispatchEvent(new CustomEvent('koma:account'));
}

export const provider = 'anilist';
export const providerLabel = 'AniList';
export const account = () => (acct.token && acct.expires > Date.now() ? acct.user : null);
export const profileUrl = user => `https://anilist.co/user/${encodeURIComponent(user?.name || '')}/animelist`;

/** Only the selected provider synchronizes. The other session is kept for a later switch. */
export function setActive(value) {
  active = !!value;
}
const connected = () => active && !!account();

export function setSession({ accessToken, expiresIn = 365 * 86400 }) {
  acct.token = String(accessToken || '');
  acct.expires = Date.now() + Number(expiresIn || 0) * 1000;
  persist();
}

export async function loadUser() {
  const { Viewer } = await gql('query{Viewer{id name avatar{medium}}}');
  acct.user = { id: Viewer.id, name: Viewer.name, avatar: Viewer.avatar?.medium || '' };
  persist();
  return acct.user;
}

export function signOut() {
  delete acct.token; delete acct.expires; delete acct.user;
  active = false;
  remote.clear();
  persist();
}

async function gql(query, variables = {}) {
  const r = await fetch(GQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${acct.token}` },
    body: JSON.stringify({ query, variables }),
  });
  const d = await r.json().catch(() => ({}));
  if (r.status === 401 || /invalid token|unauthorized/i.test(d.errors?.[0]?.message || '')) {
    signOut();
    throw Object.assign(new Error('Your AniList sign-in expired. Sign in again.'), { status: 401 });
  }
  if (!r.ok || d.errors) throw Object.assign(
    new Error(d.errors?.[0]?.message || `AniList answered with status ${r.status}.`),
    { status: r.status, retryAfter: Number(r.headers?.get?.('retry-after')) || 0 });
  return d.data;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const maxWatched = id => { const s = watchedSet(id); return s.size ? Math.max(...s) : 0; };
const LIST_QUERY = `query($u:Int){MediaListCollection(userId:$u,type:ANIME){lists{entries{id mediaId status progress updatedAt}}}}`;

async function pullList() {
  const d = await gql(LIST_QUERY, { u: acct.user.id });
  remote.clear();
  for (const l of d.MediaListCollection?.lists || []) for (const e of l.entries) remote.set(e.mediaId, e);
  const entries = [...remote.values()];
  mergeRemote(entries.filter(e => e.status !== 'DROPPED'), entries);
}

/** A full pass: pull the AniList list into Koma, then push what's ahead of AniList. */
let syncing = null;
export function syncNow() {
  if (!connected()) return Promise.resolve(false);
  return (syncing ??= (async () => {
    try {
      await pullList();
      for (const id of listIds()) {
        const r = remote.get(id);
        if (!r || maxWatched(id) > (r.progress || 0)) { // AniList allows ~90 requests a minute
          await push(id).catch(err => { if (transient(err) && err.status !== 401) enqueue([id], rateAfter(err)); });
          await sleep(700);
        }
      }
      return true;
    } finally { syncing = null; }
  })());
}

/** Reconcile from AniList alone (no pushing): what you did on anilist.co or on another device. */
export function syncPull() {
  if (!connected()) return Promise.resolve(false);
  return (syncing ??= (async () => { try { await pullList(); return true; } finally { syncing = null; } })());
}

/* ---------- the outbox: changes AniList hasn't accepted yet ---------- */
let outbox = (() => { try { const q = JSON.parse(localStorage.getItem(QKEY)); return Array.isArray(q) ? q.filter(Number.isInteger) : []; } catch { return []; } })();
const persistBox = () => { try { localStorage.setItem(QKEY, JSON.stringify(outbox)); } catch { /* private mode */ } };
const announce = () => dispatchEvent(new CustomEvent('koma:sync', { detail: { pending: outbox.length } }));
export const syncPending = () => outbox.length;

const transient = err => !err?.status || err.status === 429 || err.status >= 500 || Boolean(err?.retryAfter);
// status 0 means the request never left (offline). 401 is its own flow: the token is dead, signOut already ran.
const rateAfter = err => err?.retryAfter ? Math.max(10e3, err.retryAfter * 1000) : undefined;

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

/* Sending it all out: each pump tries every queued show once; a failure leaves it queued.
   Backoff per pump round, Retry-After respected where AniList sends one, and the whole queue
   survives reloads. */
const BACKOFF = [5000, 15000, 30000, 60000, 120000, 300000]; // then it stays at 5 minutes
let attempt = 0, pumpTimer = null, pumping = false;

function schedule(at) {
  clearTimeout(pumpTimer);
  if (!outbox.length) return;
  pumpTimer = setTimeout(() => { pumpTimer = null; pump(); }, at ?? BACKOFF[Math.min(attempt, BACKOFF.length - 1)]);
}

async function pump() {
  if (pumping || !outbox.length || !connected()) return;
  pumping = true;
  let calmed = null; // a Retry-After the next pump should honor
  try {
    let failed = 0;
    for (let i = 0; i < outbox.length;) {
      const id = outbox[i];
      try {
        await push(id);
        dequeue(id);
        attempt = 0;
      } catch (err) {
        if (err?.status === 401) { outbox.length = 0; persistBox(); announce(); return; } // the local changes wait for the next sign-in
        failed++;
        if (transient(err)) i++; // stays queued; still try the other shows so one bad one can't block the rest
        else { // AniList refused this one for good (bad request etc.) — keep it out, a later change retries it
          dequeue(id);
          dispatchEvent(new CustomEvent('koma:sync-error', { detail: err.message }));
        }
        if (err?.retryAfter) { calmed = Math.max(10e3, err.retryAfter * 1000); break; }
      }
      if (i < outbox.length || !failed) await sleep(700); // keep the ~90/minute budget
    }
    if (failed) attempt++;
  } finally {
    pumping = false;
    if (outbox.length) schedule(calmed);
    else attempt = 0;
  }
}

/** Make AniList match Koma for one show. */
async function push(id) {
  const r = remote.get(id);
  if (!inList(id)) { // removed from My list -> removed from your AniList list
    if (r) { await gql('mutation($id:Int){DeleteMediaListEntry(id:$id){deleted}}', { id: r.id }); remote.delete(id); }
    return;
  }
  const progress = maxWatched(id);
  let status = progress ? 'CURRENT' : 'PLANNING';
  if (progress) {
    const { media: [m] = [] } = await api(`/media?ids=${id}`).catch(() => ({}));
    if (m?.episodes && progress >= m.episodes && m.status === 'FINISHED') status = 'COMPLETED';
  }
  // Statuses you set on AniList yourself (paused, rewatching, completed) stay unless Koma has news.
  if (r && ['PAUSED', 'REPEATING', 'COMPLETED'].includes(r.status) && status !== 'COMPLETED' && progress <= (r.progress || 0)) status = r.status;
  if (r && r.status === status && (r.progress || 0) === progress) return;
  const { SaveMediaListEntry: e } = await gql(
    'mutation($m:Int,$s:MediaListStatus,$p:Int){SaveMediaListEntry(mediaId:$m,status:$s,progress:$p){id mediaId status progress}}',
    { m: id, s: status, p: progress },
  );
  remote.set(id, e);
}

// Every change to My list / watched episodes goes to AniList shortly after (bursts collapse into
// one save per show); a failure drops into the outbox, which retries on its own until it lands.
const timers = new Map();
addEventListener('koma:store', e => {
  const { id, remote: fromAniList } = e.detail || {};
  if (!id || fromAniList || !connected()) return;
  clearTimeout(timers.get(id));
  timers.set(id, setTimeout(() => {
    timers.delete(id);
    push(id).then(() => dequeue(id)).catch(err => {
      if (!transient(err)) { dispatchEvent(new CustomEvent('koma:sync-error', { detail: err.message })); return; }
      if (enqueue([id], rateAfter(err))) dispatchEvent(new CustomEvent('koma:sync-error', { detail: `${err.message}. It will be retried automatically.` }));
    });
  }, 1500));
});

/* ---------- keeping the session live: pull while Koma is open, flush the moment it matters ---------- */
const PULL_EVERY = 10 * 60000;
let lastPull = 0;

function pullIfDue() {
  if (!connected() || Date.now() - lastPull < PULL_EVERY) return;
  syncPull().then(s => { if (s) lastPull = Date.now(); }).catch(() => {});
}

/** Arm the auto-sync timers: a reconcile every 10 min while visible, and outbox flushes the second
 *  the network returns or the app comes back up. Safe to call once at launch, and while signed out. */
export function initAutoSync() {
  lastPull = Date.now();
  addEventListener('online', () => schedule(5000));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { schedule(5000); pullIfDue(); } });
  setInterval(pullIfDue, PULL_EVERY);
  if (outbox.length) { announce(); schedule(3000); }
}
