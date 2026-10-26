import { mediaByIds } from '../api.js';
import { inList, listIds, watchedSet } from '../store.js';
import { $, airedCount, card, icon, setTitle, skCards } from '../ui.js';

const FILTERS = [['all', 'All'], ['watching', 'Watching'], ['new', 'Not started'], ['done', 'Completed']];

function stage(a) {
  const seen = watchedSet(a.id).size;
  if (!seen) return 'new';
  const out = airedCount(a);
  return a.status === 'FINISHED' && out && seen >= out ? 'done' : 'watching';
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
    <div class="page-head"><div><h1>My list</h1><p>Saved in this browser. Newest additions first.</p></div></div>
    <div class="filter-tabs" role="tablist" aria-label="Filter"></div>
    <div class="grid" id="grid"></div>
  </div>`;

  const paint = () => {
    const mineNow = media.filter(a => inList(a.id));
    if (!mineNow.length) { removeEventListener('koma:store', onStore); return list(root, { alive }); }
    const counts = Object.fromEntries(FILTERS.map(([k]) => [k, k === 'all' ? mineNow.length : mineNow.filter(a => stage(a) === k).length]));
    $('.filter-tabs', root).innerHTML = FILTERS.map(([k, label]) =>
      `<button type="button" role="tab" data-f="${k}" aria-selected="${k === filter}">${label}<small>${counts[k]}</small></button>`).join('');
    const shown = mineNow.filter(a => filter === 'all' || stage(a) === filter);
    $('#grid', root).innerHTML = shown.length ? shown.map(a => card(a, { progress: stage(a) === 'watching' })).join('')
      : `<div class="empty-state"><div class="bubble">${icon('list')}</div><h2>Nothing here</h2><p>No shows on your list match this filter yet.</p></div>`;
  };

  $('.filter-tabs', root).addEventListener('click', e => {
    const b = e.target.closest('[data-f]');
    if (b) { filter = b.dataset.f; paint(); }
  });
  // Re-draw when a show is added or removed (from a + button here, or another tab).
  const onStore = () => (alive() ? paint() : removeEventListener('koma:store', onStore));
  addEventListener('koma:store', onStore);
  paint();
}

