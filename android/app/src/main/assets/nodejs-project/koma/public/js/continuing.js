// "Continue watching": the shows you can pick up right now.
//
// What counts as watching is LOCAL evidence only — episodes you finished here (the
// journal) and episodes you are in the middle of (the resume point). A show that is
// merely on your list is not something you are watching, and that matters most for
// entries that arrive from an AniList watchlist: they come in with a list entry and
// a progress count, and nothing else. Those never land here.
//
// Pure module: no DOM, no network. The views feed it the journal, the resume points
// and whatever they know about how much of each show has aired.

/** The shows with any local watch evidence, as ids. */
export function watchedShows({ journal = [], progress = {} } = {}) {
  const ids = new Set();
  // A journal entry only counts when it names an episode — that is the watch evidence.
  for (const e of journal) if (Number.isInteger(e?.id) && Number.isInteger(e.ep)) ids.add(e.id);
  for (const id of Object.keys(progress || {})) {
    const n = Number(id);
    if (Number.isInteger(n)) ids.add(n);
  }
  return [...ids];
}

/** How many episodes of a show are marked watched, from the merged watch state. */
const watchedCount = (watched, id) => new Set(watched?.[id] || []).size;

/** The next episode worth watching: the first one nobody has ticked off. */
function nextEpisode(union, aired, mine) {
  if (aired > 0) {
    for (let n = 1; n <= aired; n++) if (!union.has(n)) return n;
    return aired + 1;
  }
  return Math.max(0, ...mine) + 1;
}

/**
 * The shows worth continuing, most recent activity first.
 *
 * `journal`   [{ id, ep, at }] — episodes finished here.
 * `progress`  { id: { ep, t, dur, at } } — the episode you are in the middle of.
 * `watched`   { id: [eps] } — every episode marked watched, wherever that came from.
 * `aired`     { id: number } — how many episodes have aired, when that is known.
 * `skip`      [id] — shows that are planned, finished, dropped or taken out by
 *                       hand: nothing to continue.
 *
 * Each entry says why it is here: `kind: 'mid'` (you are in the episode) or
 * `kind: 'next'` (you finished some and the next one is waiting).
 */
export function continueWatching({ journal = [], progress = {}, watched = {}, aired = {}, skip = [] } = {}, { limit = 18 } = {}) {
  const mine = new Map();   // id -> Set of episodes finished here
  const last = new Map();   // id -> when you last touched it
  for (const e of journal) {
    if (!Number.isInteger(e?.id) || !Number.isInteger(e.ep)) continue;
    if (!mine.has(e.id)) mine.set(e.id, new Set());
    mine.get(e.id).add(e.ep);
    last.set(e.id, Math.max(last.get(e.id) || 0, Number(e.at) || 0));
  }

  const out = new Set(skip.map(Number));
  const rows = [];
  for (const id of watchedShows({ journal, progress })) {
    if (out.has(id)) continue;   // planned, finished or dropped — there is nothing to pick up
    const slot = progress?.[id];
    const mid = slot && Number.isInteger(Number(slot.ep)) ? Number(slot.ep) : 0;
    const here = mine.get(id) || new Set();
    const union = new Set(watched?.[id] || []);
    const airedEp = Number(aired?.[id]) || 0;
    const caughtUp = airedEp > 0 && watchedCount(watched, id) >= airedEp;
    if (!mid && caughtUp) continue;   // you finished everything that aired — nothing to continue

    // The episode you are in the middle of counts as reached, even though it is not done.
    const reached = new Set(here);
    if (mid && !reached.has(mid)) reached.add(mid);

    const t = Number(slot?.t) || 0;
    const dur = Number(slot?.dur) || 0;
    const left = mid && Number.isFinite(dur) && dur > t ? Math.max(1, Math.round((dur - t) / 60)) : 0;

    rows.push({
      id,
      kind: mid ? 'mid' : 'next',
      ep: mid || nextEpisode(union, airedEp, here),
      left,
      watched: reached.size,
      at: Math.max(last.get(id) || 0, Number(slot?.at) || 0),
    });
  }

  rows.sort((a, b) => b.at - a.at || b.watched - a.watched || a.id - b.id);
  return rows.slice(0, limit);
}
