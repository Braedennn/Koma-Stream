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

/** Merge an AniList list in: every entry joins My list, and episodes up to its progress count as watched. Never removes anything. */
export function mergeRemote(entries) {
  let changed = false;
  for (const { mediaId, progress } of entries) {
    if (!inList(mediaId)) { state.list.push(mediaId); changed = true; }
    const seen = watchedSet(mediaId);
    for (let ep = 1; ep <= (progress || 0); ep++) if (!seen.has(ep)) { seen.add(ep); changed = true; }
    if (seen.size) state.watched[mediaId] = [...seen].sort((a, b) => a - b);
  }
  if (changed) save(null, true);
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
