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
