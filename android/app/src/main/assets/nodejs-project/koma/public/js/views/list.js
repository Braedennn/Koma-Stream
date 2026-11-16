import { mediaByIds } from '../api.js';
import { inList, libraryIds, readJournal, readProgress, shelfMap, shelvedOut, watchedMap, watchedSet, continueHidden } from '../store.js';
import { continueWatching, watchedShows } from '../continuing.js';
import { $, airedCount, card, icon, setTitle, skCards } from '../ui.js';

const FILTERS = [
  ['all', 'All'],
  ['planned', 'Plan to watch'],
  ['watching', 'Continue watching'],
  ['new', 'Not started'],
  ['done', 'Watched'],
  ['hold', 'On hold'],
  ['dropped', 'Dropped'],
];

const EMPTY = {
  planned: ['calendar', 'Nothing planned', 'Shows you mean to watch later — put them on the Plan to watch shelf and they wait here.'],
  watching: ['play', 'Nothing to continue', 'Start an episode and the show lands here — or put it on this shelf yourself.'],
  new: ['list', 'Nothing here yet', 'These are the shows in your library that you haven’t started in Koma.'],
  done: ['check', 'Nothing finished yet', 'Shows you’ve watched all the way through — or put on the Watched shelf — show up here.'],
  hold: ['clock', 'Nothing on hold', 'A show you’re pausing for later can wait here.'],
  dropped: ['x', 'Nothing dropped', 'A show you gave up on can sit here, out of the way.'],
};

const SHELF_NOTE = { planned: 'Plan to watch', watching: 'Continue watching', watched: 'Watched', hold: 'On hold', dropped: 'Dropped' };

/** Where a show sits: the shelf it was put on, or what your own watching says. */
function stage(a, local, shelf) {
  if (shelf === 'dropped') return 'dropped';
  if (shelf === 'hold') return 'hold';
  if (shelf === 'watched') return 'done';
  if (shelf === 'watching') return 'watching';
  if (shelf === 'planned') return 'planned';
  const out = airedCount(a);
  const seen = watchedSet(a.id).size;
  if (a.status === 'FINISHED' && out && seen >= out) return 'done'; // every aired episode is behind you
  // Watching means local evidence: episodes you finished here, or one in progress.
  // A show that is only on the list — an AniList watchlist entry especially — is not it.
  return local.has(a.id) ? 'watching' : 'new';
}

/** The card for a show you are watching: where you stopped, and how much is behind you. */
function watchCard(a, entry, shelf) {
  if (entry) {
    const note = entry.kind === 'mid'
      ? `Episode ${entry.ep}${entry.left ? ` · ${entry.left} min left` : ''}`
      : `Episode ${entry.ep} next`;
    return card(a, { progress: true, note, seen: entry.watched, dismiss: true });
  }
  if (shelf) return card(a, { note: SHELF_NOTE[shelf] || '' });
  return card(a);
}

export async function list(root, { alive }) {
  setTitle('Library');
  const ids = libraryIds();
  if (!ids.length) {
    root.innerHTML = `<div class="page"><div class="empty-state" style="padding-top:110px">
      <div class="bubble">${icon('bookmark')}</div><h2>Your library is empty</h2>
      <p>Tap the + on any poster to put a show here — on your list, or on a shelf: planned, watching, watched, on hold, dropped. Koma also remembers which episodes you’ve watched.</p>
      <a class="btn btn-primary" href="/browse">${icon('search')}Find something to watch</a></div></div>`;
    return;
  }
  root.innerHTML = `<div class="page"><div class="page-head"><div><h1>Library</h1><p>&nbsp;</p></div></div><div class="grid">${skCards(Math.min(ids.length, 12))}</div></div>`;
  const media = await mediaByIds(ids);
  if (!alive()) return;

  let filter = 'all';
  root.innerHTML = `<div class="page">
    <div class="page-head"><div><h1>Library</h1><p>Everything you saved, and where it sits: planned, watching, finished, on hold, dropped.</p></div></div>
    <div class="filter-tabs" role="tablist" aria-label="Filter"></div>
    <div class="grid" id="grid"></div>
  </div>`;

  const paint = () => {
    const shelves = shelfMap();
    const mineNow = media.filter(a => inList(a.id) || shelves[a.id]);
    if (!mineNow.length) { off(); return list(root, { alive }); }
    const journal = readJournal();
    const progress = readProgress();
    const local = new Set(watchedShows({ journal, progress }));
    const hidden = continueHidden();
    const entries = continueWatching({ journal, progress, watched: watchedMap(), skip: [...shelvedOut(), ...hidden] });
    const byEntry = new Map(entries.map(e => [e.id, e]));
    // A show taken out of Continue watching is not in that filter any more.
    const inFilter = (a, k) => stage(a, local, shelves[a.id]) === k && !(k === 'watching' && hidden.has(a.id));
    const counts = Object.fromEntries(FILTERS.map(([k]) => [k, k === 'all' ? mineNow.length : mineNow.filter(a => inFilter(a, k)).length]));
    $('.filter-tabs', root).innerHTML = FILTERS.map(([k, label]) =>
      `<button type="button" role="tab" data-f="${k}" aria-selected="${filter === k}">${label}<small>${counts[k]}</small></button>`).join('');
    const shown = mineNow.filter(a => filter === 'all' || inFilter(a, filter));
    if (!shown.length) {
      const [bubble, title, text] = EMPTY[filter] || ['list', 'Nothing here', 'No shows in your library match this filter yet.'];
      $('#grid', root).innerHTML = `<div class="empty-state"><div class="bubble">${icon(bubble)}</div><h2>${title}</h2><p>${text}</p></div>`;
      return;
    }
    $('#grid', root).innerHTML = shown.map(a => watchCard(a, filter === 'watching' ? byEntry.get(a.id) : null, shelves[a.id])).join('');
  };

  $('.filter-tabs', root).addEventListener('click', e => {
    const b = e.target.closest('[data-f]');
    if (b) { filter = b.dataset.f; paint(); }
  });
  // Re-draw when a show is added or removed, and when an episode you finished changes
  // what you are watching (the journal is what says you watched it).
  const off = () => { removeEventListener('koma:store', onStore); removeEventListener('koma:journal', onStore); removeEventListener('koma:shelf', onShelf); removeEventListener('koma:continue', onStore); };
  const onStore = () => (alive() ? paint() : off());
  // A shelf can bring in a show that was never on the list, so the page is drawn again.
  const onShelf = () => { if (!alive()) return off(); off(); list(root, { alive }); };
  addEventListener('koma:store', onStore);
  addEventListener('koma:journal', onStore);
  addEventListener('koma:shelf', onShelf);
  addEventListener('koma:continue', onStore);
  paint();
}
