// "Continue watching": the shows you can pick up right now.
//
// Local evidence comes from finished episodes (the journal) and resume points.
// The active account can also explicitly mark a show Watching/CURRENT or
// Rewatching/REPEATING. Other provider statuses and mere list membership stay out.
//
// Pure module: no DOM, no network. The views feed it the journal, resume points,
// sanitized account entries and whatever they know about how much has aired.

/** The shows with local watch evidence or an explicit account Watching/Rewatching status. */
export function watchedShows({ journal = [], progress = {}, remote = {} } = {}) {
  const ids = new Set();
  // A journal entry only counts when it names an episode — that is the watch evidence.
  for (const e of journal) if (Number.isInteger(e?.id) && Number.isInteger(e.ep)) ids.add(e.id);
  for (const id of Object.keys(progress || {})) {
    const n = Number(id);
    if (Number.isInteger(n)) ids.add(n);
  }
  for (const [id, entry] of Object.entries(remote || {})) {
    const n = Number(id);
    if (Number.isInteger(n) && (entry?.status === 'CURRENT' || entry?.status === 'REPEATING')) ids.add(n);
  }
  return [...ids];
}

/** The next episode worth watching: the first one nobody has ticked off. */
function nextEpisode(union, aired, mine, remoteProgress = 0) {
  if (aired > 0) {
    for (let n = 1; n <= aired; n++) if (!union.has(n)) return n;
    return aired + 1;
  }
  return Math.max(0, ...mine, remoteProgress) + 1;
}

/**
 * The shows worth continuing, most recent activity first.
 *
 * `journal`   [{ id, ep, at }] — episodes finished here.
 * `progress`  { id: { ep, t, dur, at } } — the episode you are in the middle of.
 * `watched`   { id: [eps] } — every episode marked watched, wherever that came from.
 * `remote`    { id: { status, progress, at } } — only account CURRENT/REPEATING entries.
 * `aired`     { id: number } — how many episodes have aired, when that is known.
 * `skip`      [id] — shows that are planned, finished, dropped or taken out by
 *                       hand: nothing to continue.
 *
 * Each entry says why it is here: `kind: 'mid'` (you are in the episode) or
 * `kind: 'next'` (you finished some and the next one is waiting).
 */
export function continueWatching({ journal = [], progress = {}, watched = {}, remote = {}, aired = {}, skip = [] } = {}, { limit = 18 } = {}) {
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
  for (const id of watchedShows({ journal, progress, remote })) {
    if (out.has(id)) continue;   // planned, finished or dropped — there is nothing to pick up
    const slot = progress?.[id];
    const mid = slot && Number.isInteger(Number(slot.ep)) ? Number(slot.ep) : 0;
    const here = mine.get(id) || new Set();
    const account = remote?.[id];
    const repeating = account?.status === 'REPEATING';
    const rawRemoteProgress = Number(account?.progress);
    const remoteProgress = account && Number.isFinite(rawRemoteProgress) ? Math.max(0, Math.floor(rawRemoteProgress)) : 0;
    const union = new Set(watched?.[id] || []);
    // mergeRemote normally supplies these already; keeping them here also makes a
    // remote-only caller independent of local journal, resume and watched state.
    if (account && !repeating) for (let ep = 1; ep <= remoteProgress; ep++) union.add(ep);
    const airedEp = Number(aired?.[id]) || 0;
    const caughtUp = airedEp > 0 && union.size >= airedEp;
    if (!mid && !repeating && caughtUp) continue; // a rewatch has its own position, even after a completed run

    // The episode you are in the middle of counts as reached, even though it is not done.
    const reached = new Set(here);
    if (mid && !reached.has(mid)) reached.add(mid);

    const t = Number(slot?.t) || 0;
    const dur = Number(slot?.dur) || 0;
    const left = mid && Number.isFinite(dur) && dur > t ? Math.max(1, Math.round((dur - t) / 60)) : 0;

    rows.push({
      id,
      kind: mid ? 'mid' : 'next',
      ep: mid || (repeating ? remoteProgress + 1 : nextEpisode(union, airedEp, here, remoteProgress)),
      left,
      watched: repeating ? remoteProgress : account ? Math.max(reached.size, remoteProgress) : reached.size,
      at: Math.max(last.get(id) || 0, Number(slot?.at) || 0, Number(account?.at) || 0),
    });
  }

  rows.sort((a, b) => b.at - a.at || b.watched - a.watched || a.id - b.id);
  return rows.slice(0, limit);
}
