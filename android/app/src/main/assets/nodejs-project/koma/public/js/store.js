// My list and watch progress, kept in this browser's localStorage.
const KEY = 'koma.v1';
const blank = () => ({ list: [], watched: {} });

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    return s && Array.isArray(s.list) ? { list: s.list.filter(Number.isInteger), watched: s.watched || {} } : blank();
  } catch {
    return blank();
  }
}
let state = load();

// `id` = the show that changed (AniList sync pushes just that one); `remote` = the change came from AniList.
function save(id = null, remote = false) {
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch { /* private mode or full: keep in memory */ }
  dispatchEvent(new CustomEvent('koma:store', { detail: { id, remote } }));
}
addEventListener('storage', e => {
  if (e.key === KEY) { state = load(); dispatchEvent(new CustomEvent('koma:store')); }
});

export const inList = id => state.list.includes(id);
export const listIds = () => [...state.list];
export const watchedSet = id => new Set(state.watched[id] || []);

/* ---------- library shelves ----------
 * Where a show sits in your library: planning to watch it, watching it,
 * finished it, holding it, or dropped it. One shelf per show, and it is kept
 * apart from My list (the AniList watchlist) and from the watch state, so
 * dropping a show never throws away what you watched. Its own key again, so
 * nothing else can shift its shape. */
export const SHELVES = [
  { id: 'planned', label: 'Plan to watch', icon: 'calendar' },
  { id: 'watching', label: 'Continue watching', icon: 'play' },
  { id: 'watched', label: 'Watched', icon: 'check' },
  { id: 'hold', label: 'On hold', icon: 'clock' },
  { id: 'dropped', label: 'Dropped', icon: 'x' },
];
const SKEY = 'koma.shelf.v1';

function loadShelves() {
  try {
    const s = JSON.parse(localStorage.getItem(SKEY));
    return s && typeof s === 'object' && !Array.isArray(s)
      ? Object.fromEntries(Object.entries(s).filter(([k, v]) => Number.isInteger(Number(k)) && SHELVES.some(x => x.id === v)))
      : {};
  } catch {
    return {};
  }
}
let shelves = loadShelves();
function saveShelves(id = null) {
  try { localStorage.setItem(SKEY, JSON.stringify(shelves)); } catch { /* private mode or full: keep in memory */ }
  dispatchEvent(new CustomEvent('koma:shelf', { detail: { id } }));
}
addEventListener('storage', e => {
  if (e.key === SKEY) { shelves = loadShelves(); dispatchEvent(new CustomEvent('koma:shelf')); }
});

/** The shelf a show sits on — '' when it sits on none. */
export const shelfOf = id => shelves[id] || '';
/** Every show's shelf, as { id: shelf }. A copy — callers never touch the store. */
export const shelfMap = () => ({ ...shelves });
/** Put a show on a shelf, or take it off every shelf when the name is empty. */
export function setShelf(id, name) {
  const clean = SHELVES.some(s => s.id === name) ? name : '';
  if (clean) shelves[id] = clean; else delete shelves[id];
  saveShelves(id);
  return clean;
}
/** Everything in your library: My list, plus whatever shelf a show sits on. */
export function libraryIds() {
  return [...new Set([...state.list, ...Object.keys(shelves).map(Number)])];
}
/** Is this show in your library at all — on the list, or on a shelf? */
export const inLibrary = id => inList(id) || Boolean(shelves[id]);
/** Shows that are finished, dropped or planned: nothing to pick up right now. */
export const shelvedOut = () => new Set(Object.entries(shelves).filter(([, v]) => v === 'planned' || v === 'watched' || v === 'dropped').map(([k]) => Number(k)));
/** Every show's watched episodes, as { id: [eps] }. A copy — callers never touch the store. */
export const watchedMap = () => Object.fromEntries(Object.entries(state.watched).map(([id, eps]) => [id, [...eps]]));

/* ---------- resume points ---------- *
 * One entry per show you are in the middle of: which episode, how far in, and when.
 * The watch page writes it while the video plays; Home and My list read it to know
 * what you can pick up right now. Separate key again, so it never shifts the shape
 * of the list/progress data. */
const PKEY = 'koma.progress';

export const readProgress = () => { try { return JSON.parse(localStorage.getItem(PKEY) || '{}'); } catch { return {}; } };
export const writeProgress = (id, slot) => {
  const all = readProgress();
  if (slot) all[id] = slot; else delete all[id];
  try { localStorage.setItem(PKEY, JSON.stringify(all)); } catch { /* full */ }
};

/* ---------- out of Continue watching ---------- *
 * A show you took out of Continue watching: it is not offered again until you
 * open it again. Nothing else about it changes — the resume point, the journal,
 * the stats and the list all stay as they are. Separate key, so it never shifts
 * the shape of the rest. */
const CKEY = 'koma.continue.v1';

function loadHidden() {
  try {
    const h = JSON.parse(localStorage.getItem(CKEY));
    return h && typeof h === 'object' && !Array.isArray(h)
      ? Object.fromEntries(Object.entries(h).filter(([k, v]) => Number.isInteger(Number(k)) && Number.isFinite(Number(v))))
      : {};
  } catch {
    return {};
  }
}
let hidden = loadHidden();
function saveHidden(id = null) {
  try { localStorage.setItem(CKEY, JSON.stringify(hidden)); } catch { /* full */ }
  dispatchEvent(new CustomEvent('koma:continue', { detail: { id } }));
}
addEventListener('storage', e => {
  if (e.key === CKEY) { hidden = loadHidden(); dispatchEvent(new CustomEvent('koma:continue')); }
});

/** The shows taken out of Continue watching. */
export const continueHidden = () => new Set(Object.keys(hidden).map(Number));
/** Take a show out of Continue watching. Nothing else about it changes. */
export function hideFromContinue(id) {
  if (hidden[id]) return;
  hidden[id] = Date.now();
  saveHidden(id);
}
/** Put it back — opening the show again is a decision to watch it. */
export function showInContinue(id) {
  if (!hidden[id]) return;
  delete hidden[id];
  saveHidden(id);
}

/* ---------- account-driven Continue watching ----------
 * Only Watching/CURRENT and Rewatching/REPEATING live here. This is deliberately
 * separate from the manual shelves and from My list: a full account pull replaces
 * this map, but never removes list entries, watched episodes or shelf choices. */
const RKEY = 'koma.continue.remote.v1';
const REMOTE_STATUSES = new Set(['CURRENT', 'REPEATING']);

function loadRemoteContinue() {
  try {
    const saved = JSON.parse(localStorage.getItem(RKEY));
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
    return Object.fromEntries(Object.entries(saved).flatMap(([id, entry]) => {
      const mediaId = Number(id);
      if (!Number.isInteger(mediaId) || mediaId <= 0 || !REMOTE_STATUSES.has(entry?.status)) return [];
      const rawProgress = Number(entry.progress);
      const rawAt = Number(entry.at);
      const progress = Number.isFinite(rawProgress) ? Math.max(0, Math.floor(rawProgress)) : 0;
      const at = Number.isFinite(rawAt) ? Math.max(0, rawAt) : 0;
      return [[mediaId, { status: entry.status, progress, at }]];
    }));
  } catch {
    return {};
  }
}
let remoteContinue = loadRemoteContinue();

function remoteTimestamp(value) {
  if (typeof value === 'string' && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(n < 1e12 ? n * 1000 : n); // AniList sends seconds; an already-normalized value is milliseconds.
}

function reconcileRemoteContinue(entries) {
  const next = {};
  for (const entry of Array.isArray(entries) ? entries : []) {
    const mediaId = Number(entry?.mediaId);
    if (!Number.isInteger(mediaId) || mediaId <= 0 || !REMOTE_STATUSES.has(entry?.status)) continue;
    const progress = Number(entry.progress);
    next[mediaId] = {
      status: entry.status,
      progress: Number.isFinite(progress) ? Math.max(0, Math.floor(progress)) : 0,
      at: remoteTimestamp(entry.updatedAt),
    };
  }
  if (JSON.stringify(next) === JSON.stringify(remoteContinue)) return false;
  remoteContinue = next;
  try { localStorage.setItem(RKEY, JSON.stringify(remoteContinue)); } catch { /* private mode or full: keep in memory */ }
  dispatchEvent(new CustomEvent('koma:remote-continue'));
  return true;
}

/** A copy of the active account's Watching/Rewatching entries, keyed by AniList id. */
export const remoteContinueMap = () => Object.fromEntries(Object.entries(remoteContinue).map(([id, entry]) => [id, { ...entry }]));

addEventListener('storage', e => {
  if (e.key !== RKEY) return;
  remoteContinue = loadRemoteContinue();
  dispatchEvent(new CustomEvent('koma:remote-continue'));
});

export function toggleList(id) {
  state.list = inList(id) ? state.list.filter(x => x !== id) : [id, ...state.list];
  save(id);
  return inList(id);
}
export function addToList(id) {
  if (inList(id)) return false;
  state.list = [id, ...state.list];
  save(id);
  return true;
}
export function removeFromList(id) {
  state.list = state.list.filter(x => x !== id);
  save(id);
}
export function setWatched(id, ep, on) {
  const s = watchedSet(id);
  on ? s.add(ep) : s.delete(ep);
  if (s.size) state.watched[id] = [...s].sort((a, b) => a - b);
  else delete state.watched[id];
  save(id);
}

/** Merge a provider list in: entries join My list and episodes up to their progress count as watched.
 *  My list/watch state is never removed. The separate continuation map is instead reconciled from
 *  the complete pull, so a later Planning/Completed/Dropped status removes only its remote rail entry. */
export function mergeRemote(entries, completeEntries = entries) {
  let changed = false;
  for (const { mediaId, progress } of entries) {
    if (!inList(mediaId)) { state.list.push(mediaId); changed = true; }
    const seen = watchedSet(mediaId);
    for (let ep = 1; ep <= (progress || 0); ep++) if (!seen.has(ep)) { seen.add(ep); changed = true; }
    if (seen.size) state.watched[mediaId] = [...seen].sort((a, b) => a - b);
  }
  if (changed) save(null, true);
  reconcileRemoteContinue(completeEntries);
  return changed;
}

/* ---------- the watch journal ----------
 * One event per finished episode, purely local fruit: this is what the Stats page,
 * streaks and badges run on. Separate key, so list/progress data never shifts shape.
 * Rewatches are their own event — they happened. */
const JKEY = 'koma.journal.v1';
const JCAP = 2000;

function loadJournal() {
  try {
    const j = JSON.parse(localStorage.getItem(JKEY));
    return Array.isArray(j) ? j.filter(e => e && Number.isInteger(e.ep) && Number.isFinite(e.at)) : [];
  } catch { return []; }
}
let journal = loadJournal();
const saveJournal = () => { try { localStorage.setItem(JKEY, JSON.stringify(journal)); } catch { /* full: memory keeps newest */ } };

export function journalEpisode(id, ep, { dur = null, type = 'sub' } = {}) {
  journal.push({
    id,
    ep,
    at: Date.now(),
    dur: Number.isFinite(dur) && dur > 0 ? Math.round(dur) : null,
    type: type === 'dub' ? 'dub' : 'sub',
  });
  if (journal.length > JCAP) journal = journal.slice(journal.length - JCAP);
  saveJournal();
  dispatchEvent(new CustomEvent('koma:journal', { detail: { id, ep } }));
}

export const readJournal = () => journal.map(e => ({ ...e }));

/* ---------- personal takes ----------
 * Your own score, rewatch count, note and tags per show — a private layer on top of
 * watch state. Separate key again, so neither AniList sync nor the journal can shift
 * its shape, and an emptied take leaves no husk behind. */
const TKEY = 'koma.take.v1';

function loadTakes() {
  try {
    const t = JSON.parse(localStorage.getItem(TKEY));
    return t && typeof t === 'object' && !Array.isArray(t) ? t : {};
  } catch { return {}; }
}
let takes = loadTakes();
function saveTakes(id = null) {
  try { localStorage.setItem(TKEY, JSON.stringify(takes)); } catch { /* full: memory keeps newest */ }
  dispatchEvent(new CustomEvent('koma:take', { detail: { id } }));
}
addEventListener('storage', e => {
  if (e.key === TKEY) { takes = loadTakes(); dispatchEvent(new CustomEvent('koma:take')); }
});

const touched = t => ({ ...t, at: Date.now() });
const isEmpty = t => !t.score && !t.rewatch && !t.note && !(t.tags && t.tags.length);
const keep = (id, t) => { if (isEmpty(t)) delete takes[id]; else takes[id] = t; };

/** One show's take with defaults filled in, so readers never null-check. */
export const take = id => ({ score: 0, rewatch: 0, note: '', tags: [], at: 0, ...(takes[id] || {}) });
/** Deep-enough copy of everything — mutating a result never leaks into the store. */
export const takesById = () => Object.fromEntries(Object.entries(takes).map(([id, t]) => [id, { ...t, tags: [...(t.tags || [])] }]));
/** Everything you already have a relationship with: watched, listed, or took. This is
 *  what "unseen" means for recommendations — your own list is not a discovery. */
export function watchedIds() {
  const s = new Set(Object.keys(state.watched).map(Number));
  for (const id of state.list) s.add(id);
  for (const id of Object.keys(takes)) s.add(Number(id));
  return s;
}

export function setScore(id, score) {
  keep(id, touched({ ...take(id), score: Math.max(0, Math.min(10, Math.round(Number(score) || 0))) }));
  saveTakes(id);
}
export function addRewatch(id, by) {
  const base = take(id);
  const t = touched({ ...base, rewatch: Math.max(0, base.rewatch + (Number(by) < 0 ? -1 : 1)) });
  keep(id, t);
  saveTakes(id);
  return t.rewatch;
}
export function setNote(id, note) {
  keep(id, touched({ ...take(id), note: String(note || '').slice(0, 500) }));
  saveTakes(id);
}
export function setTags(id, tags) {
  keep(id, touched({ ...take(id), tags: (Array.isArray(tags) ? tags : []).filter(s => typeof s === 'string' && s.trim()).slice(0, 8) }));
  saveTakes(id);
}
