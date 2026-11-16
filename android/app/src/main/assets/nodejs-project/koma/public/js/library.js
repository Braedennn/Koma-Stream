// The "add to your library" menu on a poster.
//
// The + on a poster used to toggle My list and nothing else. Now it opens a
// short menu: the show can go on My list, or on one of the library shelves —
// plan to watch, continue watching, watched, on hold, dropped — and the library
// page reads the shelves back.
//
// The menu is a plain element in the body, placed against the button that
// opened it, because a poster card lives in a scrolling rail and a menu that
// scrolls with it is a menu that ends up off screen.
import { icon } from './icons.js';
import { inList, setShelf, shelfOf, toggleList, writeProgress, SHELVES } from './store.js';
import { toast } from './ui.js';

// My list, then every shelf — read from the store so the menu and the shelves
// can never drift apart.
const ITEMS = [
  { id: 'list', label: 'My list', icon: 'bookmark' },
  ...SHELVES.map(s => ({ id: s.id, label: s.label, icon: s.icon })),
];

const label = k => ITEMS.find(i => i.id === k)?.label || k;

let menu = null;
let anchorEl = null;

/** Close the menu, if one is open. */
export function closeShelfMenu() {
  menu?.remove();
  menu = null;
  if (anchorEl) {
    anchorEl.setAttribute('aria-expanded', 'false');
    anchorEl = null;
  }
  removeEventListener('click', onDoc, true);
  removeEventListener('keydown', onKey, true);
  removeEventListener('scroll', closeShelfMenu, true);
  removeEventListener('resize', closeShelfMenu, true);
}

function onDoc(e) {
  if (!menu) return;
  if (menu.contains(e.target)) return;
  if (anchorEl && (e.target === anchorEl || anchorEl.contains(e.target))) return; // the button itself re-opens it
  closeShelfMenu();
}

function onKey(e) {
  if (e.key !== 'Escape' || !menu) return;
  const a = anchorEl;
  closeShelfMenu();
  a?.focus();
}

/** Put the menu against the button: above it when there is room, below when not. */
function place(el, anchor) {
  const r = anchor.getBoundingClientRect();
  el.style.left = '0px';
  el.style.top = '0px';
  const m = el.getBoundingClientRect();
  const pad = 10;
  let left = r.right - m.width;
  left = Math.max(pad, Math.min(left, innerWidth - m.width - pad));
  let top = r.top - m.height - 8;
  if (top < pad) top = Math.min(r.bottom + 8, innerHeight - m.height - pad);
  el.style.left = `${Math.round(left)}px`;
  el.style.top = `${Math.round(top)}px`;
}

function build(id) {
  const el = document.createElement('div');
  el.className = 'shelf-menu';
  el.setAttribute('role', 'menu');
  el.setAttribute('aria-label', 'Add to your library');
  const shelf = shelfOf(id);
  el.innerHTML = `<p>Add to library</p>${ITEMS.map(it => {
    const on = it.id === 'list' ? inList(id) : it.id === shelf;
    const role = it.id === 'list' ? 'menuitemcheckbox' : 'menuitemradio';
    return `<button type="button" role="${role}" aria-checked="${on}" data-shelf-item="${it.id}">
      <span class="lead">${icon(it.icon)}</span><span class="lbl">${it.label}</span><span class="tick">${icon('check')}</span></button>`;
  }).join('')}`;
  return el;
}

/** Do what the menu said: put the show on a shelf, or take it off one. */
export function applyShelfItem(item, id) {
  if (item === 'list') {
    toast(toggleList(id) ? 'Added to My list' : 'Removed from My list');
    return;
  }
  const was = shelfOf(id);
  const now = setShelf(id, was === item ? '' : item);
  if (!now) { toast(`Removed from ${label(item)}`); return; }
  // Planned, finished or dropped: there is nothing left to pick up right now,
  // so the resume point goes.
  if (now === 'planned' || now === 'watched' || now === 'dropped') writeProgress(id, null);
  toast(`Added to ${label(now)}`);
}

/** Open the menu against a button. Clicking the same button again closes it. */
export function openShelfMenu(anchor, id) {
  const same = anchorEl === anchor;
  closeShelfMenu();
  if (same) return;
  anchorEl = anchor;
  anchor.setAttribute('aria-expanded', 'true');
  menu = build(id);
  document.body.appendChild(menu);
  place(menu, anchor);
  menu.addEventListener('click', e => {
    const b = e.target.closest('[data-shelf-item]');
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    applyShelfItem(b.dataset.shelfItem, id);
    closeShelfMenu();
  });
  addEventListener('click', onDoc, true);
  addEventListener('keydown', onKey, true);
  addEventListener('scroll', closeShelfMenu, true);
  addEventListener('resize', closeShelfMenu, true);
}
