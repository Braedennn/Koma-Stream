// AniList account: sign in (AniList's "implicit grant" OAuth), pull your AniList anime list into
// My list on every launch, and push My list / watched-episode changes back to AniList.
// The token lives only in this browser/app (localStorage) and talks to AniList directly.
import { api } from './api.js';
import { inList, listIds, mergeRemote, watchedSet } from './store.js';

const KEY = 'koma.anilist';
const GQL = 'https://graphql.anilist.co';
export const REDIRECT = `${location.origin}/auth/anilist`;

let acct = load(); // { clientId, token, expires, user: { id, name, avatar } }
const remote = new Map(); // mediaId -> AniList entry { id, mediaId, status, progress }

function load() { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; } }
function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(acct)); } catch { /* private mode */ }
  dispatchEvent(new CustomEvent('koma:account'));
}

export const account = () => (acct.token && acct.expires > Date.now() ? acct.user : null);
export const clientId = () => acct.clientId || '';
export function setClientId(id) { acct.clientId = String(id).trim(); persist(); }
export const loginUrl = () => `https://anilist.co/api/v2/oauth/authorize?client_id=${encodeURIComponent(clientId())}&response_type=token`;

export function signOut() {
  delete acct.token; delete acct.expires; delete acct.user;
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
  if (!r.ok || d.errors) throw new Error(d.errors?.[0]?.message || `AniList answered with status ${r.status}.`);
  return d.data;
}

/** The /auth/anilist page: AniList sends the token back in the URL fragment. */
export async function finishLogin(hash) {
  const p = new URLSearchParams(String(hash).replace(/^#/, ''));
  const token = p.get('access_token');
  if (!token) throw new Error(p.get('error_description') || 'AniList didn’t send a sign-in token back.');
  acct.token = token;
  acct.expires = Date.now() + (Number(p.get('expires_in')) || 365 * 86400) * 1000;
  const { Viewer } = await gql('query{Viewer{id name avatar{medium}}}');
  acct.user = { id: Viewer.id, name: Viewer.name, avatar: Viewer.avatar?.medium || '' };
  persist();
  await syncNow();
  return acct.user;
}

/** Pull AniList into My list, then push anything Koma has that AniList doesn't (or is further along on). */
let syncing = null;
export function syncNow() {
  if (!account()) return Promise.resolve(false);
  return (syncing ??= (async () => {
    try {
      const d = await gql(`query($u:Int){MediaListCollection(userId:$u,type:ANIME){lists{entries{id mediaId status progress}}}}`, { u: acct.user.id });
      remote.clear();
      for (const l of d.MediaListCollection?.lists || []) for (const e of l.entries) remote.set(e.mediaId, e);
      mergeRemote([...remote.values()].filter(e => e.status !== 'DROPPED'));
      for (const id of listIds()) {
        const r = remote.get(id);
        if (!r || maxWatched(id) > (r.progress || 0)) { await push(id); await sleep(700); } // AniList allows ~90 requests a minute
      }
      return true;
    } finally { syncing = null; }
  })());
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const maxWatched = id => { const s = watchedSet(id); return s.size ? Math.max(...s) : 0; };

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

// Every change to My list / watched episodes goes to AniList shortly after (bursts collapse into one save per show).
const timers = new Map();
addEventListener('koma:store', e => {
  const { id, remote: fromAniList } = e.detail || {};
  if (!id || fromAniList || !account()) return;
  clearTimeout(timers.get(id));
  timers.set(id, setTimeout(() => {
    timers.delete(id);
    push(id).catch(err => dispatchEvent(new CustomEvent('koma:sync-error', { detail: err.message })));
  }, 1500));
});
