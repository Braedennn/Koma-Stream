import { mediaByIds } from '../api.js';
import { inList, listIds, readJournal, readProgress, watchedMap, watchedSet } from '../store.js';
import { continueWatching, watchedShows } from '../continuing.js';
import { $, airedCount, card, icon, setTitle, skCards } from '../ui.js';

const FILTERS = [['all', 'All'], ['watching', 'Continue watching'], ['new', 'Not started'], ['done', 'Completed']];

const EMPTY = {
  watching: ['play', 'Nothing to continue', 'Start an episode and the show lands here — watchlist entries don’t.'],
  new: ['list', 'Nothing here yet', 'These are the shows on your list that you haven’t started in Koma.'],
  done: ['check', 'Nothing completed', 'Shows you’ve watched all the way through will show up here.'],
};

/** Where a show sits: caught up, actually being watched here, or only on the list. */
function stage(a, local) {
  const out = airedCount(a);
  const seen = watchedSet(a.id).size;
  if (a.status === 'FINISHED' && out && seen >= out) return 'done'; // every aired episode is behind you
  // Watching means local evidence: episodes you finished here, or one in progress.
  // A show that is only on the list — an AniList watchlist entry especially — is not it.
  return local.has(a.id) ? 'watching' : 'new';
}

/** The card for a show you are watching: where you stopped, and how much is behind you. */
function watchCard(a, entry) {
  if (!entry) return card(a);
  const note = entry.kind === 'mid'
    ? `Episode ${entry.ep}${entry.left ? ` · ${entry.left} min left` : ''}`
    : `Episode ${entry.ep} next`;
  return card(a, { progress: true, note, seen: entry.watched });
}

export async function list(root, { alive }) {
  setTitle('My list');
  const ids = listIds();
  if (!ids.length) {
    root.innerHTML = `<div class="page"><div class="empty-state" style="padding-top:110px">
      <div class="bubble">${icon('bookmark')}</div><h2>Your list is empty</h2>
      <p>Tap the + on any poster or “My list” on a title to save it here. Koma also remembers which episodes you’ve watched.</p>
      <a class="btn btn-primary" href="/browse">${icon('search')}Find something to watch</a></div></div>`;
    return;
  }
  root.innerHTML = `<div class="page"><div class="page-head"><div><h1>My list</h1><p>&nbsp;</p></div></div><div class="grid">${skCards(Math.min(ids.length, 12))}</div></div>`;
  const media = await mediaByIds(ids);
  if (!alive()) return;

  let filter = 'all';
  root.innerHTML = `<div class="page">
    <div class="page-head"><div><h1>My list</h1><p>Continue watching is what you actually watch here — AniList watchlist entries sit under Not started.</p></div></div>
    <div class="filter-tabs" role="tablist" aria-label="Filter"></div>
    <div class="grid" id="grid"></div>
  </div>`;

  const paint = () => {
    const mineNow = media.filter(a => inList(a.id));
    if (!mineNow.length) { off(); return list(root, { alive }); }
    const journal = readJournal();
    const progress = readProgress();
    const local = new Set(watchedShows({ journal, progress }));
    const entries = continueWatching({ journal, progress, watched: watchedMap() });
    const byEntry = new Map(entries.map(e => [e.id, e]));
    const counts = Object.fromEntries(FILTERS.map(([k]) => [k, k === 'all' ? mineNow.length : mineNow.filter(a => stage(a, local) === k).length]));
    $('.filter-tabs', root).innerHTML = FILTERS.map(([k, label]) =>
      `<button type="button" role="tab" data-f="${k}" aria-selected="${filter === k}">${label}<small>${counts[k]}</small></button>`).join('');
    const shown = mineNow.filter(a => filter === 'all' || stage(a, local) === filter);
    if (!shown.length) {
      const [bubble, title, text] = EMPTY[filter] || ['list', 'Nothing here', 'No shows on your list match this filter yet.'];
      $('#grid', root).innerHTML = `<div class="empty-state"><div class="bubble">${icon(bubble)}</div><h2>${title}</h2><p>${text}</p></div>`;
      return;
    }
    $('#grid', root).innerHTML = shown.map(a => watchCard(a, filter === 'watching' ? byEntry.get(a.id) : null)).join('');
  };

  $('.filter-tabs', root).addEventListener('click', e => {
    const b = e.target.closest('[data-f]');
    if (b) { filter = b.dataset.f; paint(); }
  });
  // Re-draw when a show is added or removed, and when an episode you finished changes
  // what you are watching (the journal is what says you watched it).
  const off = () => { removeEventListener('koma:store', onStore); removeEventListener('koma:journal', onStore); };
  const onStore = () => (alive() ? paint() : off());
  addEventListener('koma:store', onStore);
  addEventListener('koma:journal', onStore);
  paint();
}
