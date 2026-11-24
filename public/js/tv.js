// The TV app.
//
// A remote is a keyboard with four directions and one button, and the screen
// is ten feet away. Three things follow from that: the focus has to be
// obvious, the direction pressed has to move the focus to the thing in that
// direction (not to the next thing in the markup), and nothing may happen
// until the middle button is pressed.
//
// The native shell hands every remote key to `window.__komaTv.key()`. This
// module decides what the key means: move the focus, open the thing that has
// it, go back, or drive the video. The same keys work from a keyboard when
// the site is opened with ?tv=1.

import { $, icon, card, syncListButton } from './ui.js';
import { inList, shelfOf, SHELVES } from './store.js';
import { applyShelfItem } from './library.js';
import { previewFocus, stopPreviews } from './preview.js';
import { api } from './api.js';

/* The television's focus targets. A card is pointed at through its artwork
   rather than through the title under it - from the sofa the poster is the
   thing you aim at. The little + that hangs off a poster is a mouse
   affordance; on a television the card's own menu carries that action. */
const TARGETS = [
  'a.poster',
  'a[href]:not(.card-title):not(.poster)',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  'label.settings-toggle',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Is this the television build? */
export function isTv() {
  // The URL asks for it outright. The television app opens the site with
  // ?tv=1, and it makes the television layout testable on a phone.
  if (new URLSearchParams(location.search).get('tv') === '1') return true;
  try { if (window.KomaAndroid?.isTv) return !!window.KomaAndroid.isTv(); } catch { /* no bridge */ }
  return matchMedia('(tv)').matches;
}

/** Is the native Android television shell driving this page? */
const nativeTvRemote = () => {
  try { return !!window.KomaAndroid?.isTv?.(); } catch { /* no bridge */ }
  return false;
};

/* ---------- the canvas ----------
   The television is drawn on a fixed canvas - 1920 pixels wide, 1080 lines
   high - and the whole drawing is scaled to the screen. That is what makes
   the television look the same on every set: a 1080p television, a 4K one
   and a small set all show the same picture, drawn at the size their own
   screen asks for.

   The canvas script in the head of the page sets the scale before the first
   paint; this is where it is kept in step when the screen changes. */

const viewW = () => document.documentElement.clientWidth;
const viewH = () => document.documentElement.clientHeight;

function fitCanvas() {
  window.__komaCanvas?.fit();
}

/* ---------- what is on screen ---------- */

const shown = el => {
  if (!el || el.hidden) return false;
  if (el.closest('[hidden]')) return false;
  // The page that is lifting away is not on the screen any more, and the
  // remote must not point at it.
  if (el.closest('.view-out')) return false;
  if (el.classList.contains('skip')) return false;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  const cs = getComputedStyle(el);
  return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
};

/* The player's own controls fade in, so their opacity cannot be the test:
   a button that is on the screen but still fading in is still the answer. */
const visible = el => {
  if (!el || el.hidden) return false;
  if (el.closest('[hidden]')) return false;
  if (el.closest('.view-out')) return false;
  if (el.classList.contains('skip')) return false;
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return false;
  const cs = getComputedStyle(el);
  // Opacity is deliberately ignored: the controls fade in and out. A control
  // hidden by the loading state, however, is not a remote target.
  return cs.visibility !== 'hidden' && cs.display !== 'none';
};

/* The watch page has a few thousand things to point at, and the list only
   changes when the page does - so it is kept until the page changes. */
let cached = null;
/* A television can deliver the tail of one centre press after the page has
   already changed: a native key event, a WebView click, or both. The shield
   consumes that tail so it cannot activate the new destination. */
let activationShieldUntil = 0;
const shieldActivations = (ms = 300) => {
  activationShieldUntil = performance.now() + ms;
};
/* A dialog on top of the page is a world of its own: the pad must not reach
   for the page behind it. */
const openDialog = () => [...document.querySelectorAll('dialog[open]')].pop() || null;
const targets = () => {
  if (cached) return cached;
  const dlg = openDialog();
  cached = [...document.querySelectorAll(TARGETS)]
    .filter(shown)
    .filter(el => !dlg || dlg.contains(el))
    // The breadcrumb is a pointer thing: a row of little arrows that only a
    // mouse has a use for. The rail down the side is where a television goes
    // back to, and the page it lands on opens on the show itself.
    .filter(el => !el.closest('.crumbs'));
  setTimeout(() => { cached = null; }, 5000);
  return cached;
};

const box = el => {
  const r = el.getBoundingClientRect();
  return {
    l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height,
    cx: r.left + r.width / 2, cy: r.top + r.height / 2,
  };
};

/**
 * Is a text field being typed into?
 *
 * Only the fields that take words: a checkbox or a radio button is not one,
 * and the pad must keep working there.
 */
const textEntry = () => {
  const a = document.activeElement;
  if (!a) return false;
  if (a.isContentEditable) return true;
  if (a.tagName === 'TEXTAREA') return true;
  if (a.tagName !== 'INPUT') return false;
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range', 'color', 'file', 'image'].includes((a.type || '').toLowerCase());
};

/* The page on screen. The old one stays in the app for a moment while it
   lifts away, so the last child is the one the viewer is looking at. */
const currentView = () => $('#app')?.lastElementChild || null;

/* ---------- the rows ---------- */

/**
 * The things on screen, grouped into rows.
 *
 * A row is a set of things that stand side by side: the header, the buttons
 * of the spotlight, a rail of cards, a line of the episode list. The rows are
 * found by looking at the layout, not at the markup - so a rail of cards is a
 * row whether it is a rail, a grid or a list, and the header is a row
 * whatever it is made of.
 *
 * Two things are in the same row when they stand side by side: their heights
 * overlap by more than half of the smaller one.
 */
function rows(list = targets()) {
  const out = [];
  for (const el of list) {
    const b = box(el);
    const row = out.find(r => {
      const over = Math.min(r.b, b.b) - Math.max(r.t, b.t);
      return over > Math.min(r.b - r.t, b.h) * 0.5;
    });
    if (row) {
      row.items.push(el);
      row.t = Math.min(row.t, b.t);
      row.b = Math.max(row.b, b.b);
    } else {
      out.push({ items: [el], t: b.t, b: b.b });
    }
  }
  out.sort((a, b) => a.t - b.t);
  // The head of a section - its title and the "View all" in the corner -
  // belongs to the row of cards under it. On a television the pad goes from
  // the spotlight straight to the shows, not to a link off in the corner.
  for (let i = out.length - 1; i >= 0; i--) {
    const r = out[i];
    if (!r.items.length || !r.items.every(el => el.closest('.row-head'))) continue;
    const next = out[i + 1];
    if (!next) continue;
    next.items.unshift(...r.items);
    next.t = Math.min(next.t, r.t);
    next.b = Math.max(next.b, r.b);
    out.splice(i, 1);
  }
  return out;
}

const rowOf = (el, list) => list.find(r => r.items.includes(el)) || null;

/* "View all" belongs to the head of a row, not to the line of anime under it.
   On a television it is reached by moving up from the anime; it must never
   slip into the sideways walk through the cards. */
const isRowLink = el => !!el?.matches?.('.row-head .link-btn');

/* The little arrows on the spotlight are controls for one picture, not a
   category of their own. "View all" must lead back to the show or row above,
   not to one of those arrows. */
const isHeroControl = el => !!el?.closest?.('.hero-ctrl');

/* A rail of shows is a lane of its own. Its cards can overlap the spotlight's
   controls on a television-sized canvas, so geometry alone must not pull a
   control from another part of the page into the sideways walk. */
const laneOf = el => el?.closest?.('.rail, .genre-grid') || null;

/* The "View all" belonging to the row the focus is in. */
const rowLinkFor = el => {
  const link = el?.closest?.('.row')?.querySelector('.row-head .link-btn');
  return link && shown(link) ? link : null;
};

/** How much two things stand side by side. */
const hOverlap = (a, b) => Math.max(0, Math.min(a.r, b.r) - Math.max(a.l, b.l));

/* The rail down the side is a column of its own, not a row of the page.
   It is always on the left and always the same width, so the pad walks it
   on its own and the page is reached by leaving it sideways. */
const inRail = el => !!el.closest?.('.tv-rail');

/* ---------- the focus mark ---------- */

/* The ring that says where the viewer is.
 *
 * A WebView does not always hold the window's focus, and a page that does
 * not hold the focus never matches :focus - so the ring cannot be left to
 * the pseudo-class alone. The page marks the element itself, and the mark
 * is what the stylesheet draws. */
let marked = null;
let markedCard = null;

function mark(el) {
  const next = el && el.nodeType === 1 ? el : null;
  if (marked && marked !== next) marked.classList.remove('tv-focus');
  if (markedCard && markedCard !== next) markedCard.classList.remove('tv-focus');
  marked = next;
  markedCard = next?.closest?.('.card') || null;
  if (marked) marked.classList.add('tv-focus');
  if (markedCard) markedCard.classList.add('tv-focus');
}

/* ---------- moving the focus ---------- */

/* The room a focused thing keeps under the top of the screen, and the room
   it keeps above the bottom. A card flush against the edge of the screen has
   half its mark cut off, and the page reads as if the row above had swallowed
   it. */
const TOP_GAP = 44;
const BOTTOM_GAP = 28;

/* The block a thing belongs to: the spotlight, a row of cards, the panel of
   the detail page. When the pad walks up, the block comes back into view
   whole - the viewer asked for the spotlight, not for the bottom of it. */
const SECTIONS = '.slide.on, .hero, .d-hero, .tabs, .panel, .row, .watch-grid, .watch, .ep-grid, .wo-list, .season-pills, .overview';
const sectionOf = el => el.closest(SECTIONS) || el.parentElement;

/**
 * Put the focus on an element and bring it into view.
 * The artwork is hidden from screen readers (the title under it carries the
 * name), but a focused element must not be hidden - so the name moves onto
 * the artwork when it takes the focus.
 *
 * `dir` is the way the viewer came. It matters for the scroll: a pad pressed
 * upwards means "take me back", and the page has to answer - the spotlight
 * comes back whole, not with its title still above the screen.
 */
function focusEl(el, dir = '') {
  if (!el) return;
  if (el.getAttribute('aria-hidden') === 'true') {
    el.removeAttribute('aria-hidden');
    if (!el.getAttribute('aria-label')) {
      const name = el.closest('.card')?.querySelector('.card-title')?.textContent?.trim();
      if (name) el.setAttribute('aria-label', name);
    }
  }
  el.focus({ preventScroll: true });
  // The mark is set here as well as on the focus event: a WebView that does
  // not hold the window's focus never fires one.
  mark(el);
  // A dialog is its own little page: the panel scrolls, the page behind it
  // stands still.
  const dlg = el.closest('dialog[open]');
  if (dlg) {
    scrollInBox(el, dlg);
    return;
  }
  // The rail is a fixed column of its own: walking it may scroll the rail
  // when it has grown too tall for the screen, and never the page it stands
  // in front of. The page-scroll below runs on every focus move, and from
  // the rail it dragged the middle of the screen up and down with each step.
  const railBox = inRail(el) ? el.closest('.tv-rail') : null;
  if (railBox) {
    const r = el.getBoundingClientRect();
    const rr = railBox.getBoundingClientRect();
    if (r.top < rr.top) railBox.scrollTop -= rr.top - r.top + 8;
    else if (r.bottom > rr.bottom) railBox.scrollTop += r.bottom - rr.bottom + 8;
    return;
  }
  // The rail a card sits in scrolls sideways, the page scrolls up and down:
  // scrollIntoView knows both, and the scroll margin keeps the header from
  // covering the thing that has the focus.
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  // The page is measured again on the next frame, because the rows below the
  // fold grow as their artwork arrives.
  const bring = () => {
    if (document.activeElement !== el) return;
    const r = el.getBoundingClientRect();
    const pad = parseFloat(getComputedStyle(document.documentElement).scrollPaddingTop) || 0;
    // A tab bar that sticks to the top of the window is already as high as
    // it can go; the room under the top edge is for the things that scroll.
    const stuck = getComputedStyle(el.closest('.tabs') || el).position === 'sticky';
    if (dir === 'up') {
      // The block the thing belongs to comes back whole. The viewer pressed
      // up because they wanted the spotlight, not the bottom of it.
      const sec = sectionOf(el);
      const sr = sec.getBoundingClientRect();
      if (sr.top < pad) {
        // The first block of the page is the spotlight: going back to it
        // means going back to the top of the page, and the page goes all the
        // way - "just about everything" is not back.
        const first = document.querySelector(SECTIONS);
        if (first && (sec === first || first.contains(sec))) {
          scrollTo(0, 0);
          return;
        }
        const y = Math.max(0, scrollY + (sr.top - pad));
        const moved = y - scrollY;
        // Only when the thing itself stays on the screen afterwards.
        if (r.top - moved > pad && r.bottom - moved <= viewH()) {
          scrollTo(0, y);
          return;
        }
      }
    }
    // The name of the show sits under the artwork: the whole name has to be
    // on the screen, not just the picture above it. A title cut off by the
    // bottom edge is a title nobody can read.
    const title = el.closest('.card')?.querySelector('.card-title');
    const tb = title ? title.getBoundingClientRect() : null;
    const bottom = tb && tb.height ? Math.max(r.bottom, tb.bottom) : r.bottom;
    if (!stuck && r.top < pad + TOP_GAP) {
      // Room under the top edge: a card flush against it has its mark cut
      // off, and the row above it looks as if it swallowed the card.
      scrollBy(0, r.top - (pad + TOP_GAP));
    } else if (bottom > viewH() - BOTTOM_GAP && r.height + pad + TOP_GAP < viewH()) {
      scrollBy(0, bottom - (viewH() - BOTTOM_GAP));
    }
  };
  requestAnimationFrame(bring);
  setTimeout(bring, 250);
}

/**
 * Move a thing into view inside its own box.
 *
 * A dialog is a little page of its own: the panel of the settings scrolls,
 * and the page behind it must not move when the focus walks up and down the
 * panel. scrollIntoView would scroll both - the page included - so the panel
 * is scrolled by hand and the page is left alone.
 */
function scrollInBox(el, box) {
  let sc = el.parentElement;
  while (sc && sc !== box) {
    const cs = getComputedStyle(sc);
    if (/(auto|scroll|overlay)/.test(cs.overflowY) && sc.scrollHeight > sc.clientHeight + 1) break;
    sc = sc.parentElement;
  }
  if (!sc || sc === box) return;
  const place = () => {
    const r = el.getBoundingClientRect();
    const sr = sc.getBoundingClientRect();
    // A head that sticks to the top of the panel covers what is under it, so
    // the thing that has the focus must not be behind it.
    const head = [...sc.children].find(c => getComputedStyle(c).position === 'sticky');
    const headH = head ? head.getBoundingClientRect().height : 0;
    const top = sr.top + headH;
    if (r.top < top) sc.scrollTop -= (top - r.top) + 8;
    else if (r.bottom > sr.bottom) sc.scrollTop += (r.bottom - sr.bottom) + 8;
  };
  place();
  // The browser brings the focused thing into view in its own time, and it
  // does not know about the head that sticks to the top of the panel. The
  // place is taken again after it, so the thing stays clear of the head.
  requestAnimationFrame(place);
  setTimeout(place, 120);
}

/**
 * Move the focus in a direction.
 *
 * Left and right walk along the row the focus is in - the header, a rail of
 * cards, a line of the episode list. Up and down change row: the row below
 * is the next rail, and the thing in it that stands in the same column is the
 * one the viewer meant.
 */
function move(dir) {
  const list = targets();
  if (!list.length) return false;
  const cur = list.includes(document.activeElement) ? document.activeElement : null;
  const railItems = list.filter(inRail);
  const pageItems = list.filter(el => !inRail(el));
  const all = rows(pageItems);

  /* The rail has its own walk. Up and down go through its items and the
     right button steps into the page; the left button, on the far left of
     the screen, goes nowhere. */
  if (cur && inRail(cur)) {
    if (dir === 'left') return false;
    if (dir === 'up' || dir === 'down') {
      const a = box(cur);
      const along = railItems.filter(el => el !== cur
        && (dir === 'down' ? box(el).t > a.t : box(el).b < a.b));
      if (!along.length) return false;
      const best = dir === 'down'
        ? along.reduce((x, y) => (box(y).t < box(x).t ? y : x))
        : along.reduce((x, y) => (box(y).b > box(x).b ? y : x));
      focusEl(best, dir);
      return true;
    }
    // Into the page: the thing nearest to the height of the item.
    const a = box(cur);
    const over = pageItems.filter(el => box(el).cx > a.cx);
    if (!over.length) return false;
    const best = over.reduce((x, y) => (Math.abs(box(y).cy - a.cy) < Math.abs(box(x).cy - a.cy) ? y : x));
    focusEl(best, dir);
    return true;
  }

  if (!cur) {
    // Nothing on the page has the focus. Take the first thing in the
    // direction that was pressed - not the first thing in the document,
    // which is the logo in the corner.
    const from = box(document.activeElement && document.activeElement !== document.body
      ? document.activeElement
      : { getBoundingClientRect: () => ({ left: 0, top: 0, right: viewW(), bottom: viewH(), width: viewW(), height: viewH() }) });
    const side = dir === 'right' ? el => box(el).cx > from.cx
      : dir === 'left' ? el => box(el).cx < from.cx
      : dir === 'down' ? el => box(el).cy > from.cy
      : el => box(el).cy < from.cy;
    // To the left, the rail is the only thing there is.
    const pool = dir === 'left' && railItems.length ? railItems : pageItems;
    const cands = pool.filter(side);
    if (!cands.length) return false;
    const best = cands.reduce((a, b) => (Math.abs(box(b).cx - from.cx) + Math.abs(box(b).cy - from.cy)
      < Math.abs(box(a).cx - from.cx) + Math.abs(box(a).cy - from.cy) ? b : a));
    focusEl(best, dir);
    return true;
  }

  const a = box(cur);

  if (dir === 'right' || dir === 'left') {
    const row = rowOf(cur, all);
    // "View all" is an action on the head of the row. Once it has the focus,
    // sideways does not put the viewer back into the cards: up and down are
    // the way in and out of it.
    if (isRowLink(cur)) return true;
    // A rail is a lane of its own. Controls from the spotlight can overlap a
    // card on a television-sized canvas, but they are not part of the shows.
    const lane = laneOf(cur);
    const pool = (row ? row.items : pageItems)
      .filter(el => !isRowLink(el))
      .filter(el => !lane || laneOf(el) === lane);
    const along = pool.filter(el => {
      if (el === cur) return false;
      const b = box(el);
      return dir === 'right' ? b.cx > a.cx : b.cx < a.cx;
    });
    if (along.length) {
      // The next thing along the row: the one whose middle is nearest.
      const best = along.reduce((x, y) => (Math.abs(box(y).cx - a.cx) < Math.abs(box(x).cx - a.cx) ? y : x));
      focusEl(best, dir);
      return true;
    }
    // The row ends.
    if (dir === 'left') {
      // The rail is always there on the left: the item nearest to the height
      // of the one the focus is leaving.
      if (!railItems.length) return false;
      const best = railItems.reduce((x, y) => (Math.abs(box(y).cy - a.cy) < Math.abs(box(x).cy - a.cy) ? y : x));
      focusEl(best, dir);
      return true;
    }
    // The end of a rail is still the rail. The next category is reached with
    // down, not by jumping out to a control on the far side of the screen.
    if (lane) return true;
    // To the right there is nothing on this row: take the next thing in that
    // direction anywhere on the page - the closest one vertically, so the
    // focus stays where the viewer is. "View all" never joins this walk.
    const any = pageItems.filter(el => {
      if (el === cur || isRowLink(el)) return false;
      return box(el).cx > a.cx;
    });
    if (!any.length) return false;
    const best = any.reduce((x, y) => (Math.abs(box(y).cy - a.cy) < Math.abs(box(x).cy - a.cy) ? y : x));
    focusEl(best, dir);
    return true;
  }

  // Up and down: the row above or below, and the thing in it that stands in
  // the same column.
  const down = dir === 'down';
  const row = rowOf(cur, all);

  // Up from an anime goes to the "View all" in that row's head. It is not
  // part of the sideways card walk, so it cannot interrupt it.
  if (!down && !isRowLink(cur)) {
    const link = rowLinkFor(cur) || row?.items.find(isRowLink);
    if (link) {
      focusEl(link, dir);
      return true;
    }
  }

  // Down from "View all" returns to the anime under it, rather than skipping
  // the whole row.
  if (down && isRowLink(cur)) {
    const section = cur.closest('.row');
    const cards = (row?.items || []).filter(el => el !== cur
      && !isRowLink(el)
      && !isHeroControl(el)
      && (!section || section.contains(el)));
    if (cards.length) {
      const same = cards.filter(el => hOverlap(a, box(el)) > 0);
      const best = same.length
        ? same.reduce((x, y) => (hOverlap(a, box(y)) > hOverlap(a, box(x)) ? y : x))
        : cards.reduce((x, y) => (Math.abs(box(y).cx - a.cx) < Math.abs(box(x).cx - a.cx) ? y : x));
      focusEl(best, dir);
      return true;
    }
  }

  // Down from the spotlight always enters the first rail of shows at its
  // beginning. The spotlight's arrows sit at the far right of the picture,
  // so a geometric nearest match would send the focus to the last anime in
  // the row instead of the first.
  if (down && cur.closest('.hero')) {
    const first = [...document.querySelectorAll('.rows .row a.poster')].find(shown);
    if (first) {
      focusEl(first, dir);
      return true;
    }
  }

  // Up from "View all" goes to the show or category above it. The spotlight's
  // little arrows are skipped: they control one picture and are not another
  // category in the walk.
  if (!down && isRowLink(cur)) {
    const above = all.filter(r => r !== row && r.b < a.t + 4
      && r.items.some(el => el !== cur && !isRowLink(el) && !isHeroControl(el)));
    if (above.length) {
      const near = above.slice().sort((x, y) => y.b - x.b);
      const target = near.find(r => r.items.some(el => el !== cur && !isRowLink(el) && !isHeroControl(el) && hOverlap(a, box(el)) > 0)) || near[0];
      const items = target.items.filter(el => el !== cur && !isRowLink(el) && !isHeroControl(el));
      if (items.length) {
        const same = items.filter(el => hOverlap(a, box(el)) > 0);
        const best = same.length
          ? same.reduce((x, y) => (hOverlap(a, box(y)) > hOverlap(a, box(x)) ? y : x))
          : items.reduce((x, y) => (Math.abs(box(y).cx - a.cx) < Math.abs(box(x).cx - a.cx) ? y : x));
        focusEl(best, dir);
        return true;
      }
    }
  }

  const others = all.filter(r => r !== row && (down ? r.t > a.b - 4 : r.b < a.t + 4));
  if (!others.length) return false;
  // The rows in that direction, nearest first.
  const near = down
    ? others.slice().sort((x, y) => x.t - y.t)
    : others.slice().sort((x, y) => y.b - x.b);
  // The row that has something in the column the focus is in. A row that has
  // nothing there - the arrows in the corner of the picture, say - is passed
  // over: the viewer pressing down wants the thing below, not the thing in
  // the far corner. "View all" is never chosen as a row's contents.
  const inColumn = near.find(r => r.items.some(el => el !== cur && !isRowLink(el) && !isHeroControl(el) && hOverlap(a, box(el)) > 0));
  const target = inColumn || near.find(r => r.items.some(el => el !== cur && !isRowLink(el) && !isHeroControl(el))) || near[0];
  const items = target.items.filter(el => el !== cur && !isRowLink(el) && !isHeroControl(el));
  if (!items.length) return false;
  // The thing in the same column first; if the row has nothing there, the
  // one nearest to it.
  const same = items.filter(el => hOverlap(a, box(el)) > 0);
  const best = same.length
    ? same.reduce((x, y) => (hOverlap(a, box(y)) > hOverlap(a, box(x)) ? y : x))
    : items.reduce((x, y) => (Math.abs(box(y).cx - a.cx) < Math.abs(box(x).cx - a.cx) ? y : x));
  focusEl(best, dir);
  return true;
}

/* ---------- the drop-downs ---------- */

/* The select widget is a button with a list under it. On a television the
   arrows must not open it - the middle button does that - and once it is
   open the arrows walk through the options. */
const openSelect = () => document.querySelector('.select.open');
const selectHasFocus = s => !!s?.contains(document.activeElement);

/* Where the pad last put the focus into a filter box. Asking the shell for
   the keyboard can shake the page's focus loose - the WebView hands it to
   the first thing it can focus, which is the skip link at the top of the
   body - and this is the memory the repair needs to put the focus back. */
let findEntry = null;      // { s, at, repaired }
let skipKeyboardUntil = 0; // the repair pass does not re-ask for the keyboard

function selectMove(dir) {
  const s = openSelect();
  if (!s) return false;
  // A menu left open after the focus has gone elsewhere must not swallow the
  // pad. It is closed and the page gets the press.
  if (!selectHasFocus(s)) {
    s._close?.(false);
    return false;
  }
  const find = s.querySelector('.select-find input');
  // The filter box at the top of the drop-down is a text field: while it has
  // the focus the arrows belong to it - down goes back to the list, and up
  // and the sideways keys do nothing. The box is the top of the drop-down,
  // and walking out of a menu the viewer is typing in helps no one.
  if (find && document.activeElement === find) {
    if (dir === 'down') s.querySelector('.select-btn')?.focus({ preventScroll: true });
    return true;
  }
  // Up from the first option reaches the filter box. This is the only way
  // into it with a remote, and the system keyboard follows the focus there.
  if (find && dir === 'up') {
    const first = [...s.querySelectorAll('.opt:not([hidden])')][0];
    if (first && first.classList.contains('active')) {
      find.focus({ preventScroll: true });
      return true;
    }
  }
  // The list is open: it has the focus, so the page must not move under it.
  if (dir === 'left' || dir === 'right') return true;
  if (s._move) return s._move(dir === 'down' ? 1 : -1);
  const key = dir === 'down' ? 'ArrowDown' : dir === 'up' ? 'ArrowUp' : null;
  if (!key) return false;
  s.querySelector('.select-menu')?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  return true;
}

function selectPick() {
  const s = openSelect();
  if (!s) return false;
  if (!selectHasFocus(s)) {
    s._close?.(false);
    return false;
  }
  if (s._pick) return s._pick();
  const opt = s.querySelector('.opt.active') || s.querySelector('.opt[aria-selected="true"]');
  if (!opt) return false;
  opt.click();
  return true;
}

function selectClose() {
  const s = openSelect();
  if (!s) return false;
  s._close?.(true);
  return true;
}

/* ---------- the route memory ---------- */

/* What the focus was on, in enough detail to find it again on the page the
   viewer comes back to. */
const describe = el => ({
  id: el.id || '',
  href: el.getAttribute?.('href') || '',
  cls: typeof el.className === 'string' ? el.className : '',
  text: (el.textContent || '').trim().slice(0, 60),
});

/* The element is looked for in the page that is on the screen and nowhere
   else: the page being left is still in the document for a moment while it
   lifts away, and a focus put on a button of that page is a focus on
   nothing once it goes. */
const find = d => {
  if (!d) return null;
  const root = currentView() || document;
  const q = sel => { try { return root.querySelector(sel); } catch { /* odd selector */ return null; } };
  if (d.id) { const el = q(`#${CSS.escape(d.id)}`); if (el) return el; }
  if (d.href) { const el = q(`a[href="${CSS.escape(d.href)}"]`); if (el) return el; }
  if (d.cls) {
    const sel = '.' + d.cls.split(/\s+/).filter(Boolean).join('.');
    const el = q(sel);
    if (el) return el;
  }
  return null;
};

/* ---------- the card menu ---------- */

/* The + that hangs off a poster is a mouse affordance. On a television the
   menu key (or a held-down centre button) opens the same actions on the card
   that has the focus. */
let menuEl = null;
let menuFocusFrame = 0;

/* A remote can deliver the tail of the press that closed a menu after the
   dialog is already gone. A native long-press timer may then send `hold`, and
   a trailing hold would open the very popup the viewer just dismissed. The
   dismissal owns the next matching hold/release pair; a later, deliberate
   long press still opens the menu normally. */
const MENU_DISMISS_GUARD_MS = 900;
let menuDismissedUntil = 0;
const menuWasDismissed = () => performance.now() < menuDismissedUntil;

function markMenuDismissed() {
  menuDismissedUntil = performance.now() + MENU_DISMISS_GUARD_MS;
  if (menuFocusFrame) {
    cancelAnimationFrame(menuFocusFrame);
    menuFocusFrame = 0;
  }
}

function closeMenu(dlg) {
  if (!dlg?.open) return;
  markMenuDismissed();
  dlg.close();
}

function cardOf(el) {
  const card = el?.closest?.('.card');
  if (!card) return null;
  const link = card.querySelector('a[href]');
  const id = Number((link?.getAttribute('href') || '').split('/').filter(Boolean).pop());
  if (!id) return null;
  const shelf = card.querySelector('[data-shelf-open]');
  const remove = card.querySelector('[data-continue-remove]');
  return {
    id,
    href: link.getAttribute('href'),
    name: card.querySelector('.card-title')?.textContent?.trim() || 'This show',
    shelf: shelf ? Number(shelf.dataset.shelfOpen) : 0,
    dismiss: remove ? Number(remove.dataset.continueRemove) : 0,
  };
}

function buildMenu() {
  if (menuEl) return menuEl;
  menuEl = document.createElement('dialog');
  menuEl.className = 'modal tv-menu';
  menuEl.innerHTML = `
    <div class="modal-body tv-menu-body">
      <header class="settings-head"><h3 id="tv-menu-title">Options</h3>
        <button class="icon-btn" type="button" data-tv-menu-close aria-label="Close">${'&times;'}</button>
      </header>
      <div class="tv-menu-list" role="menu"></div>
    </div>`;
  document.body.appendChild(menuEl);
  menuEl.addEventListener('click', e => {
    if (e.target === menuEl || e.target.closest('[data-tv-menu-close]')) {
      e.preventDefault();
      e.stopPropagation();
      closeMenu(menuEl);
      return;
    }
    const item = e.target.closest('[data-tv-act]');
    if (!item) return;
    const act = item.dataset.tvAct;
    closeMenu(menuEl);
    if (act === 'open') {
      // A result chosen in the search screen leaves that screen as well. If
      // it stays open underneath, the route changes but the viewer still
      // sees the search and thinks nothing happened.
      closeSearch();
      goToPage(item.dataset.href);
    } else if (act === 'library') openLibrary(Number(item.dataset.id));
    else if (act === 'hide') {
      const b = document.querySelector(`[data-continue-remove="${item.dataset.id}"]`);
      b?.click();
    }
  });
  menuEl.addEventListener('close', () => {
    markMenuDismissed();
    shieldActivations();
  });
  return menuEl;
}

function openMenu() {
  if (menuEl?.open) return true;
  if (menuWasDismissed()) return false;
  const card = cardOf(document.activeElement);
  if (!card) return false;
  const dlg = buildMenu();
  const list = dlg.querySelector('.tv-menu-list');
  dlg.querySelector('#tv-menu-title').textContent = card.name;
  const items = [];
  items.push(`<button class="tv-menu-item" type="button" role="menuitem" data-tv-act="open" data-href="${card.href}">Open</button>`);
  if (card.shelf) items.push(`<button class="tv-menu-item" type="button" role="menuitem" data-tv-act="library" data-id="${card.shelf}">Add to your library</button>`);
  if (card.dismiss) items.push(`<button class="tv-menu-item" type="button" role="menuitem" data-tv-act="hide" data-id="${card.dismiss}">Take out of Continue watching</button>`);
  list.innerHTML = items.join('');
  if (!dlg.open) dlg.showModal();
  // The first item takes the focus, so the pad has something to work with.
  menuFocusFrame = requestAnimationFrame(() => {
    menuFocusFrame = 0;
    if (dlg.open) focusEl(list.querySelector('.tv-menu-item'));
  });
  return true;
}

/* ---------- the library menu ---------- */

/* The little + on a poster is a mouse thing, and the list button used to be
   a plain toggle. On a television both open the same menu: My list, or one of
   the shelves - plan to watch, continue watching, watched, on hold, dropped.
   The middle button picks the shelf the pad is on. */
let libraryEl = null;

function buildLibrary() {
  if (libraryEl) return libraryEl;
  libraryEl = document.createElement('dialog');
  libraryEl.className = 'modal tv-menu tv-library';
  libraryEl.innerHTML = `
    <div class="modal-body tv-menu-body">
      <header class="settings-head"><h3 id="tv-lib-title">Add to your library</h3>
        <button class="icon-btn" type="button" data-tv-menu-close aria-label="Close">${'&times;'}</button>
      </header>
      <div class="tv-menu-list" role="menu"></div>
    </div>`;
  document.body.appendChild(libraryEl);
  libraryEl.addEventListener('click', e => {
    if (e.target === libraryEl || e.target.closest('[data-tv-menu-close]')) {
      e.preventDefault();
      e.stopPropagation();
      closeMenu(libraryEl);
      return;
    }
    const item = e.target.closest('[data-tv-lib]');
    if (!item) return;
    closeMenu(libraryEl);
    applyShelfItem(item.dataset.tvLib, Number(libraryEl.dataset.id));
    syncLibraryButtons();
  });
  libraryEl.addEventListener('close', () => {
    markMenuDismissed();
    shieldActivations();
  });
  return libraryEl;
}

/** Open the library menu for a show. */
function openLibrary(id, name = '') {
  if (!id) return false;
  const dlg = buildLibrary();
  const list = dlg.querySelector('.tv-menu-list');
  dlg.dataset.id = String(id);
  dlg.querySelector('#tv-lib-title').textContent = name ? `Add ${name} to your library` : 'Add to your library';
  const shelf = shelfOf(id);
  const items = [
    { id: 'list', label: 'My list', on: inList(id) },
    ...SHELVES.map(s => ({ id: s.id, label: s.label, on: shelf === s.id })),
  ];
  list.innerHTML = items.map(it => `<button class="tv-menu-item" type="button" role="menuitem${it.id === 'list' ? 'checkbox' : 'radio'}" aria-checked="${it.on}" data-tv-lib="${it.id}">
    <span class="lbl">${it.label}</span><span class="tick">${it.on ? icon('check') : ''}</span></button>`).join('');
  dlg.showModal();
  requestAnimationFrame(() => focusEl(list.querySelector('.tv-menu-item')));
  return true;
}

/** The list buttons say where the show sits: on a shelf, or on My list. */
function syncLibraryButtons() {
  for (const b of document.querySelectorAll('[data-list]')) syncListButton(b);
}
addEventListener('koma:store', syncLibraryButtons);
addEventListener('koma:shelf', syncLibraryButtons);

/* ---------- the television's own navigation ---------- */

/* A television has no top bar and no bottom tab bar. It has a rail down the
   left side, the way a set-top box does: big icons with their names under
   them, always on the screen, so the remote always knows where it is. The
   items are the page's own places to go, so there is one list and not two. */
const RAIL_ITEMS = [
  { href: '/', icon: 'home', label: 'Home' },
  { href: '/browse', icon: 'grid', label: 'Browse' },
  { href: '/schedule', icon: 'calendar', label: 'Schedule' },
  { href: '/browse?sort=TRENDING_DESC', icon: 'fire', label: 'Trending' },
  { href: '/list', icon: 'bookmark', label: 'Library' },
  { href: '/stats', icon: 'chart', label: 'Stats' },
];

let rail = null;

function buildRail() {
  rail = document.createElement('nav');
  rail.className = 'tv-rail';
  rail.setAttribute('aria-label', 'Main');
  rail.innerHTML = `
    <div class="tv-rail-logo" aria-hidden="true">
      <span class="tv-rail-mark">${icon('play')}</span>
      <span class="tv-rail-word">koma</span>
    </div>
    <button class="tv-rail-item" type="button" data-tv-search>${icon('search')}<span>Search</span></button>
    ${RAIL_ITEMS.map(r => `<a class="tv-rail-item" href="${r.href}" data-tv-href="${r.href}">${icon(r.icon)}<span>${r.label}</span></a>`).join('')}
    <span class="tv-rail-gap"></span>
    <button class="tv-rail-item" type="button" data-tv-surprise>${icon('dice')}<span>Surprise</span></button>
    <button class="tv-rail-item" type="button" data-tv-settings>${icon('gear')}<span>Settings</span></button>`;
  document.body.appendChild(rail);

  rail.addEventListener('click', e => {
    // The rail owns its routes. Letting the page's generic link handler deal
    // with them meant a click could be claimed twice; on a television that
    // left one category on Browse while another was on screen.
    const link = e.target.closest('a[data-tv-href]');
    if (link) {
      e.preventDefault();
      e.stopPropagation();
      goToPage(link.getAttribute('href'));
      return;
    }
    const b = e.target.closest('[data-tv-search],[data-tv-surprise],[data-tv-settings]');
    if (!b) return;
    e.preventDefault();
    if (b.hasAttribute('data-tv-search')) { openSearch(); return; }
    if (b.hasAttribute('data-tv-surprise')) { document.querySelector('#surprise')?.click(); return; }
    document.querySelector('#settings-btn')?.click();
  });
  syncRail();
}

/** Which rail item is the page the viewer is on. */
function syncRail() {
  if (!rail) return;
  const here = location.pathname + location.search;
  // A link with a query (Trending) wins over the plain page link (Browse).
  const queryHit = RAIL_ITEMS.some(r => r.href.includes('?') && here.startsWith(r.href));
  for (const a of rail.querySelectorAll('[data-tv-href]')) {
    const href = a.dataset.tvHref;
    const on = href === '/' ? location.pathname === '/'
      : href.includes('?') ? here.startsWith(href)
      : location.pathname.startsWith(href) && !queryHit;
    on ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current');
  }
}

/* ---------- search ---------- */

/* A television cannot type: the search is a screen of its own, with the
   results under the field and the pad walking them. The system's own keyboard
   comes up when the field takes the focus, so a viewer with a keyboard can
   type into it. */
let searchDlg = null;

/* Leave the current screen without reloading the whole television app. The
   route is rendered by the app shell, and the television flag stays in the
   address so a refresh cannot quietly turn the remote navigation off. */
function goToPage(href) {
  if (!href) return;
  const url = new URL(href, location.href);
  if (new URLSearchParams(location.search).get('tv') === '1' && !url.searchParams.has('tv')) {
    url.searchParams.set('tv', '1');
  }
  closeSearch();
  history.pushState({ y: 0 }, '', url.pathname + url.search + url.hash);
  dispatchEvent(new PopStateEvent('popstate', { state: { y: 0 } }));
}

function buildSearch() {
  const dlg = document.createElement('dialog');
  dlg.className = 'tv-search';
  dlg.innerHTML = `
    <form class="tv-search-head" role="search">
      <label class="tv-search-field">
        ${icon('search')}
        <span class="sr">Search anime</span>
        <input type="search" placeholder="Search anime" autocomplete="off" enterkeyhint="search" spellcheck="false">
      </label>
      <button class="tv-search-close icon-btn" type="button" aria-label="Close search">${icon('x')}</button>
    </form>
    <div class="tv-search-body"></div>`;
  document.body.appendChild(dlg);

  const input = $('input', dlg);
  const body = $('.tv-search-body', dlg);
  let timer;

  const showKeyboard = () => {
    try { window.KomaAndroid?.setTextEntry?.(true); } catch { /* no shell */ }
  };
  // Opening Search, returning to the field with the remote, and clicking it
  // after dismissing the keyboard are all explicit text-entry requests.
  input.addEventListener('focus', showKeyboard);
  input.addEventListener('click', showKeyboard);

  const paint = (list, q) => {
    const grid = list.length
      ? `<div class="tv-search-grid">${list.map(card).join('')}</div>`
      : `<p class="tv-search-empty">${icon('search')}Nothing matches that yet.</p>`;
    body.innerHTML = grid
      + `<a class="tv-search-all btn btn-primary" href="/browse?search=${encodeURIComponent(q)}">See every result${icon('right')}</a>`;
  };

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { body.innerHTML = ''; return; }
    timer = setTimeout(async () => {
      try {
        const { media } = await api('/suggest?q=' + encodeURIComponent(q));
        if (q !== input.value.trim()) return;
        paint(media.slice(0, 18), q);
      } catch { body.innerHTML = ''; }
    }, 220);
  });

  dlg.addEventListener('submit', e => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    goToPage('/browse?search=' + encodeURIComponent(q));
  });

  dlg.addEventListener('click', e => {
    if (e.target.closest('.tv-search-close')) {
      e.preventDefault();
      e.stopPropagation();
      closeSearch(true);
      return;
    }
    // "See every result" and a result card both leave the search screen. The
    // screen must be closed before the route changes: a modal dialog left
    // open over the new page looks exactly like the button did nothing.
    // The event stops here as well, so the page cannot claim the same click
    // and start a second route behind the first one.
    const all = e.target.closest('.tv-search-all');
    if (all) {
      e.preventDefault();
      e.stopPropagation();
      const href = all.getAttribute('href');
      goToPage(href);
      return;
    }
    const link = e.target.closest('.card a[href]');
    if (link) {
      e.preventDefault();
      e.stopPropagation();
      const href = link.getAttribute('href');
      goToPage(href);
      return;
    }
    // Clicking the backdrop (the dialog itself) closes it too.
    if (e.target === dlg) {
      e.preventDefault();
      e.stopPropagation();
      closeSearch(true);
    }
  });

  dlg.addEventListener('close', () => {
    try { window.KomaAndroid?.setTextEntry?.(false); } catch { /* no shell */ }
    cached = null;
    shieldActivations();
  });

  return dlg;
}

function openSearch() {
  const dlg = searchDlg || (searchDlg = buildSearch());
  if (!dlg.open) dlg.showModal();
  const input = $('input', dlg);
  input.value = '';
  $('.tv-search-body', dlg).innerHTML = '';
  cached = null;
  requestAnimationFrame(() => {
    // The field's focus handler asks the native shell for the TV keyboard.
    input.focus({ preventScroll: true });
  });
}

function closeSearch(focusPage = false) {
  const dlg = searchDlg;
  if (!dlg?.open) return;
  try { window.KomaAndroid?.setTextEntry?.(false); } catch { /* no shell */ }
  $('input', dlg)?.blur();
  cached = null;
  dlg.close();
  if (!focusPage) return;
  // Closing the search must not leave the Search button under the focus: the
  // next centre-button press would open the very screen the viewer just
  // closed. The first show on the page is a safe place to continue.
  requestAnimationFrame(() => {
    const target = currentView()?.querySelector('a.poster, .card-title');
    if (target && shown(target)) focusEl(target);
  });
}

/* ---------- the keys ---------- */

/**
 * Point at the player: the answer to "continue or start again" if there is
 * one on the screen, the play button otherwise.
 */
function focusPlayer() {
  const p = window.komaPlayer;
  if (!p) return false;
  // An open episode drawer owns the remote. The player can become ready
  // after the drawer opens, and its late focus event must not pull the focus
  // back to the picture underneath.
  if (p.el?.drawer && !p.el.drawer.hidden) {
    // Once the viewer has moved inside the drawer, a late player event must
    // not put the focus back on the current episode. The drawer owns the
    // remote until it closes.
    if (p.el.drawer.contains(document.activeElement)) return true;
    const episodes = playerDrawerEpisodes();
    const current = episodes.find(b => b.classList.contains('on')) || episodes[0] || null;
    const target = current || playerDrawerClose();
    if (target) { focusEl(target); return true; }
    return false;
  }
  const go = p.el?.resumeGo;
  if (go && visible(go)) { focusEl(go); return true; }
  const play = p.el?.bigPlay;
  if (play && visible(play)) { focusEl(play); return true; }
  return false;
}

/* ---------- the player's own controls ---------- */

/* The picture is a world of its own: the time line on top and the row of
   buttons under it. When the picture has the screen, the pad belongs to
   these and to nothing else - the page is not on the screen. */

const playerButtons = () => {
  const p = window.komaPlayer;
  const row = p?.el?.bottom?.querySelector('.kp-row');
  if (!row) return [];
  // A button that is switched off cannot take the focus - the previous
  // episode of the first episode, for one - so the walk steps over it.
  return [...row.querySelectorAll('button')].filter(b => visible(b) && !b.disabled);
};

/* The player's own menu - the gear. It is a column of rows, and while it is
   open the pad belongs to it and to nothing else. */
const playerMenuItems = () => {
  const m = window.komaPlayer?.el?.menu;
  if (!m || m.hidden) return [];
  return [...m.querySelectorAll('button, input[type="checkbox"]')].filter(visible);
};

const inPlayer = el => !!el?.closest?.('.kplayer');

/**
 * The controls in the middle of the picture.
 *
 * The question of the resume point, the play button under it, the retry of a
 * stream that would not play: they are drawn on the picture, so the pad
 * walks them the way it walks the picture - sideways between the two
 * answers, and down to the controls at the bottom of the picture.
 */
const playerOverlay = () => {
  const p = window.komaPlayer;
  if (!p) return [];
  return [
    p.el?.resumeGo,
    p.el?.resumeStart,
    p.el?.bigPlay,
    p.el?.error?.querySelector('[data-retry]'),
    p.el?.skip,
    p.el?.next?.querySelector('.kp-next-go'),
    p.el?.next?.querySelector('.kp-next-cancel'),
  ].filter(b => b && visible(b));
};

/* The episode list that comes out of the picture: a drawer on the right. */
const playerDrawerEpisodes = () => {
  const d = window.komaPlayer?.el?.drawer;
  if (!d || d.hidden) return [];
  return [...d.querySelectorAll('.kp-ep-item')]
    .filter(b => visible(b) && !b.disabled && !b.classList.contains('later'));
};

const playerDrawerClose = () => {
  const d = window.komaPlayer?.el?.drawer;
  if (!d || d.hidden) return null;
  return d.querySelector('.kp-x');
};

/**
 * Move the focus inside the player.
 *
 * The time line is where the focus lands: it is the one thing a viewer
 * reaches for while watching, and the left and right arrows seek with it.
 * Down from the time line is the row of buttons - play, the next episode,
 * the captions, the full screen - and up from there is the time line again.
 */
function playerMove(dir) {
  const p = window.komaPlayer;
  if (!p || openDialog()) return false;
  const scrub = p.el?.scrub;
  const a = document.activeElement;
  const inFull = !!p.isFullscreen;
  // In full screen the picture is the whole screen, so the pad belongs to the
  // player. On the page it belongs to the player only while the focus is
  // already in it.
  if (!inFull && !inPlayer(a)) return false;

  const rowBtns = playerButtons();
  const overlay = playerOverlay();
  const onScrub = a === scrub;
  // Only the buttons of the control row belong to the row. The question on
  // the screen - continue or start again - is in the middle of the picture,
  // and the pad walks it like anything else.
  const onRow = !!a?.closest?.('.kp-row') && rowBtns.includes(a);

  // The menu is open: it is a little page of its own, and the pad walks it.
  const menuItems = playerMenuItems();
  if (menuItems.length) {
    const i = menuItems.indexOf(a);
    if (dir === 'down' || dir === 'up') {
      const next = dir === 'down' ? menuItems[i + 1] : menuItems[i - 1];
      if (next) focusEl(next);
      return true;
    }
    return true;
  }

  // The episode drawer is open: a list of its own, and the pad walks it. The
  // viewer opened it to pick an episode, not to look at the picture behind it.
  // Up and down walk the episodes; up from the first one reaches the X in
  // the drawer head, and down from the X returns to the current episode.
  const drawer = p.el?.drawer;
  if (drawer && !drawer.hidden) {
    const episodes = playerDrawerEpisodes();
    const close = playerDrawerClose();
    const current = episodes.find(b => b.classList.contains('on')) || episodes[0] || null;
    const i = episodes.indexOf(a);

    // The drawer has just opened, or its list has been replaced while the
    // focus was in it: start at the episode being watched.
    if (i < 0 && a !== close) {
      focusEl(current || close);
      return true;
    }
    if (dir === 'up') {
      if (a === close) return true;
      if (i > 0) { focusEl(episodes[i - 1]); return true; }
      if (close) { focusEl(close); return true; }
      return true;
    }
    if (dir === 'down') {
      if (a === close) { focusEl(current); return true; }
      if (i >= 0 && i < episodes.length - 1) { focusEl(episodes[i + 1]); return true; }
      return true;
    }
    // The drawer is a world of its own: left and right do not wander back
    // into the picture behind it.
    return true;
  }

  if (onScrub) {
    if (dir === 'left') { p.seekTo(Math.max(0, p.video.currentTime - 10)); return true; }
    if (dir === 'right') { p.seekTo(p.video.currentTime + 10); return true; }
    if (dir === 'down') {
      if (rowBtns.length) focusEl(rowBtns[0]);
      return true;
    }
    // Skip and Up Next sit above the time line. Up reaches the visible action;
    // left/right then walk its buttons, and Down returns here.
    if (dir === 'up' && overlay.length) { focusEl(overlay[0]); return true; }
    // There is nothing above the time line. On the page the page's own walk
    // takes it from here.
    return inFull;
  }

  if (onRow) {
    const i = rowBtns.indexOf(a);
    if (dir === 'up') { if (scrub) focusEl(scrub); return true; }
    if (dir === 'left' || dir === 'right') {
      if (i < 0) return false;
      const next = dir === 'right' ? rowBtns[i + 1] : rowBtns[i - 1];
      if (next) focusEl(next);
      return true;
    }
    if (dir === 'down') {
      // Under the picture is the band of the watch page: that is the page's
      // own row, and the page's own walk takes it from here.
      return inFull;
    }
  }

  // The question in the middle of the picture - continue where they stopped,
  // or start again - the play button under it, the retry of a stream that
  // would not play. Down from them is the controls at the bottom of the
  // picture: they are the same picture, so the pad stays inside it.
  if (overlay.includes(a)) {
    const i = overlay.indexOf(a);
    if (dir === 'left' || dir === 'right') {
      const next = dir === 'right' ? overlay[i + 1] : overlay[i - 1];
      if (next) focusEl(next);
      return true;
    }
    if (dir === 'down') {
      if (scrub && visible(scrub)) { focusEl(scrub); return true; }
      if (rowBtns.length) { focusEl(rowBtns[0]); return true; }
      return true;
    }
    // There is nothing above the middle of the picture.
    return true;
  }

  // A transient action can disappear while it has the focus. Recover to a
  // visible control instead of leaving the remote pointing at nothing.
  if (inFull && a && inPlayer(a) && !visible(a)) {
    const target = scrub && visible(scrub) ? scrub : rowBtns[0];
    if (target) { focusEl(target); return true; }
  }

  // Full screen with the focus somewhere else in the picture: the time line
  // is the only place the pad goes.
  if (inFull) {
    if (dir === 'down' && scrub && visible(scrub)) { focusEl(scrub); return true; }
    if (dir === 'left') { p.seekTo(Math.max(0, p.video.currentTime - 10)); return true; }
    if (dir === 'right') { p.seekTo(p.video.currentTime + 10); return true; }
    return true;
  }
  return false;
}

function activate() {
  const p = window.komaPlayer;
  const el = document.activeElement;
  if (p?.isFullscreen && !openDialog()) {
    // The focus is on one of the player's own controls: that is what the
    // middle button presses. The time line is a slider - the middle button
    // plays and pauses there, like everywhere else.
    if (el && el !== document.body && p.container.contains(el) && el.matches('button, [role="slider"], input[type="checkbox"]')) {
      if (el.matches('[role="slider"]')) { p.togglePlay(); return true; }
      el.click();
      return true;
    }
    p.togglePlay();
    return true;
  }
  // A drop-down that is open: the middle button picks the option.
  if (selectPick()) return true;
  // A settings switch: the centre button changes it. The row itself is the
  // television's target, because the real checkbox is only one pixel wide.
  if (el?.matches?.('label.settings-toggle')) {
    const input = el.querySelector('input[type="checkbox"]');
    if (input) { input.click(); return true; }
  }
  if (el?.matches?.('input[type="checkbox"]')) { el.click(); return true; }
  // Once the TV keyboard has been dismissed, Center on Search must reopen it
  // rather than submitting the old query. The keyboard's Search key submits.
  if (searchDlg?.open && el === searchDlg.querySelector('input')) {
    el.click();
    return true;
  }
  // Other text fields keep their ordinary form-submit behavior.
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
    if (el.form) { try { el.form.requestSubmit?.(); } catch { /* older browser */ } }
    return true;
  }
  // The list button opens the library menu: the show can go on My list, or on
  // one of the shelves. A toggle would leave the viewer guessing where it
  // ended up.
  const listBtn = el?.closest?.('[data-list]');
  if (listBtn) {
    const id = Number(listBtn.dataset.list);
    const name = listBtn.closest('.card')?.querySelector('.card-title')?.textContent?.trim()
      || listBtn.closest('.d-info, .now')?.querySelector('h1')?.textContent?.trim() || '';
    return openLibrary(id, name);
  }
  if (el && el !== document.body && el !== document.documentElement) { el.click(); return true; }
  const first = targets().find(t => currentView()?.contains(t)) || targets()[0];
  if (first) { focusEl(first); first.click(); }
  return true;
}

function back() {
  // The topmost thing on the screen gets the press first.
  const dlg = [...document.querySelectorAll('dialog[open]')].pop();
  if (dlg) {
    if (dlg === searchDlg) closeSearch(true);
    else dlg.close('cancel');
    return true;
  }
  if (selectClose()) return true;
  // A text field being typed into: the press puts the keyboard away and
  // gives the focus back to the page.
  if (textEntry()) {
    const a = document.activeElement;
    a?.blur?.();
    const top = [...document.querySelectorAll('.top a[href], .top button')].filter(shown);
    if (top.length) focusEl(top[top.length - 1]);
    return true;
  }
  const p = window.komaPlayer;
  if (p) {
    // Anything the player has laid over the picture takes the press first,
    // and only that: the settings, the episode drawer. Full screen is where
    // the television watches - Back never leaves it in place, it goes back to
    // the title's own page instead.
    if (p.el?.menu && !p.el.menu.hidden) { p.toggleMenu(false); return true; }
    if (p.el?.drawer && !p.el.drawer.hidden) { p.toggleDrawer(false); return true; }
    if (p.isFullscreen) {
      const title = document.querySelector('[data-title-link]')?.getAttribute('href');
      if (title) {
        const destination = new URL(title, location.href);
        if (isTv()) destination.searchParams.set('tv', '1');
        location.replace(destination.href);
        return true;
      }
    }
  }
  if (history.length > 1) { history.back(); return true; }
  // Nowhere to go back to: the app closes.
  try { window.KomaAndroid?.exit?.(); } catch { /* no shell */ }
  return true;
}

function media(k) {
  const p = window.komaPlayer;
  if (!p?.video) return false;
  const v = p.video;
  if (k === 'play') { if (v.paused) p.play(); return true; }
  if (k === 'pause') { if (!v.paused) v.pause(); return true; }
  p.togglePlay();
  return true;
}

/** The remote's keys, as the native shell names them. */
let held = false;   // the centre button was held down: the card's menu is open

export function tvKey(name) {
  const k = String(name || '').toLowerCase();
  // Any key wakes the player's controls: the remote is the pointer now, and
  // a control bar that only a mouse can bring back is no control bar at all.
  window.komaPlayer?.wake?.();
  if (k === 'up' || k === 'down' || k === 'left' || k === 'right') {
    // The pad always moves the focus - even from a text field. On a
    // television the words are typed with the on-screen keyboard, and a
    // viewer who cannot get out of the search box is a viewer who is stuck.
    // The player comes first: when the picture has the screen, it is the only
    // thing on it.
    if (playerMove(k)) return true;
    // A drop-down that is open: the arrows walk through its options.
    if (selectMove(k)) return true;
    return move(k);
  }
  if (k === 'center' || k === 'enter') {
    // A centre button held down opens the card's menu; letting go must not
    // then open the card as well. The native shell sends that release as a
    // centre event, and this is the one press it swallows.
    if (held) { held = false; return true; }
    // A pointer click may close the menu just before the native release of
    // the same press arrives. That release belongs to the dismissed menu.
    if (menuWasDismissed()) return true;
    return activate();
  }
  if (k === 'back') return back();
  if (k === 'hold') {
    // The tail of the press that dismissed a menu belongs to that press, not
    // to a new one. Swallow the hold and its matching release together.
    if (menuWasDismissed()) {
      held = true;
      return true;
    }
    // A search result is a choice, not a card with a menu behind it. A long
    // press there still opens the chosen show. The matching release is
    // swallowed so the show is not opened twice.
    if (searchDlg?.open) {
      held = true;
      activate();
      return true;
    }
    // The button was held down: the card's menu opens, and the release that
    // follows must not open the card as well.
    const opened = openMenu();
    if (opened) held = true;
    return opened;
  }
  if (k === 'menu') {
    if (menuWasDismissed()) return true;
    return openMenu();
  }
  if (k === 'play' || k === 'pause' || k === 'playpause') return media(k);
  if (k === 'next') { window.komaPlayer?.nextEpisode(); return true; }
  return false;
}

/* ---------- the setup ---------- */

/* The real checkbox in a settings switch is invisible. On a television the
   whole labelled row is the target instead, so the row can be pointed at and
   the centre button can change the switch without landing on a one-pixel
   input hidden behind the knob. */
function prepareSettingsToggles() {
  for (const row of document.querySelectorAll('label.settings-row')) {
    if (!row.querySelector('.switch input')) continue;
    row.classList.add('settings-toggle');
    row.tabIndex = 0;
  }
}

export function initTv() {
  const html = document.documentElement;
  html.classList.add('tv');

  // The canvas is drawn at the size the screen asks for. The canvas script
  // in the head of the page set it before the first paint; this keeps it in
  // step if the screen changes.
  fitCanvas();
  addEventListener('resize', fitCanvas);

  // The television's own navigation and its own search screen.
  prepareSettingsToggles();
  // The filter box inside a drop-down is a text field on a television too:
  // the system keyboard comes up with the focus and goes away with it. A
  // television has no other way to type.
  const keyboard = on => { try { window.KomaAndroid?.setTextEntry?.(!!on); } catch { /* no shell */ } };
  document.addEventListener('focusin', e => {
    const input = e.target?.closest?.('.select.open .select-find input');
    if (!input) return;
    if (performance.now() < skipKeyboardUntil) return;  // the repair pass: not again
    const s = input.closest('.select');
    if (s) findEntry = { s, at: performance.now(), repaired: false };
    keyboard(true);
  }, true);
  // The keyboard can take the focus with it. Give the filter box a moment to
  // take it back before deciding that the viewer has really left the field.
  document.addEventListener('focusout', e => {
    if (!e.target?.closest?.('.select-find input')) return;
    setTimeout(() => {
      if (!document.activeElement?.closest?.('.select.open .select-find input')) keyboard(false);
    }, 250);
  }, true);
  // Asking the shell for the keyboard can make the WebView drop the page's
  // focus and give it back to the first thing it can find - the skip link at
  // the top of the body, which no one can see. The filter box takes the focus
  // back once; the shell is not asked a second time for the same entry,
  // because it is the ask that shakes the focus loose.
  document.addEventListener('focusin', e => {
    if (!e.target?.classList?.contains('skip')) return;
    const entry = findEntry;
    if (!entry || entry.repaired || performance.now() - entry.at > 2000) return;
    const s = entry.s;
    const input = s?.isConnected ? s.querySelector('.select-find input') : null;
    if (!input) return;
    entry.repaired = true;
    skipKeyboardUntil = performance.now() + 1200;
    if (!s.classList.contains('open')) s.querySelector('.select-btn')?.click();
    requestAnimationFrame(() => input.focus({ preventScroll: true }));
  }, true);
  buildRail();
  searchDlg = buildSearch();
  // The list buttons say where a show sits, from the first frame.
  syncLibraryButtons();

  // The same keys from a keyboard, for the site opened with ?tv=1.
  const KEYS = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    Enter: 'center', ' ': 'center', Escape: 'back', ContextMenu: 'menu',
  };
  addEventListener('keydown', e => {
    const name = KEYS[e.key];
    if (!name) return;
    // The native shell sends every remote key itself. Some television
    // remotes also reach the WebView as an Enter keydown: handling that a
    // second time would click the destination after the route has moved the
    // focus there. The browser's default Enter action is stopped as well.
    if (nativeTvRemote()) {
      e.preventDefault();
      return;
    }
    // A real keyboard types into a text field: its arrows move the caret.
    if (textEntry()) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // A held key repeats. The pad's walk wants that; every other key does
    // not - a held Enter would press the same thing again and again, and a
    // held Back would leave the page several pages deep.
    if (e.repeat && !['up', 'down', 'left', 'right'].includes(name)) return;
    e.preventDefault();
    tvKey(name);
  });
  addEventListener('keyup', e => {
    // Space activates a focused button on key-up, not key-down.
    if (nativeTvRemote() && (e.key === 'Enter' || e.key === ' ')) e.preventDefault();
  });
  // Some television remotes turn the release of the centre key into a
  // native WebView click. Once a route or a menu has closed, that click must
  // not fall through to the poster that has just received the focus.
  addEventListener('click', e => {
    // A route change or a closed menu gets a short shield. The release that
    // follows can arrive as a click on the poster that is now behind it; that
    // click belongs to the old press and must not navigate. The chosen menu
    // action is a button, not a poster, so it still gets through.
    if (performance.now() >= activationShieldUntil) return;
    if (e.target?.closest?.('.tv-menu')) return;
    if (!e.target?.closest?.('a[href], .poster, .card, [data-tv-href]')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);

  // Where the focus was on the page being left, so going back puts it where
  // the viewer left it.
  const memory = new Map();
  let route = location.pathname;
  addEventListener('koma:route', () => {
    shieldActivations();
    const a = document.activeElement;
    if (a && a !== document.body && a !== document.documentElement) memory.set(route, describe(a));
    route = location.pathname;
    syncRail();
  });
  addEventListener('koma:url', syncRail);
  addEventListener('koma:rendered', () => {
    cached = null;
    // The page on screen is the one being looked at: the page that is still
    // lifting away has the same buttons on it, and pointing at those would
    // leave the focus on nothing when it goes.
    const view = currentView();
    // Home keeps the focus on the fixed Home item in the rail. Pointing at
    // the first row instead scrolled the page down to the Trending poster
    // and left the centre-button release ready to open that show.
    if (route === '/') {
      const home = rail?.querySelector('a[data-tv-href="/"]');
      if (home) {
        home.focus({ preventScroll: true });
        mark(home);
        return;
      }
    }
    const el = find(memory.get(route));
    if (el && shown(el)) { focusEl(el); return; }
    // The watch page opens on the player: that is what the viewer came for.
    if (view?.querySelector('.player-shell')) {
      if (focusPlayer()) return;
      // The stream has not arrived yet. The player asks for the focus when
      // it is ready; if it never gets there, the retry button takes it.
      setTimeout(() => {
        if (!currentView()?.querySelector('.player-shell')) return;
        if (focusPlayer()) return;
        const again = document.querySelector('.kp-error [data-retry]');
        if (again && visible(again)) focusEl(again);
      }, 2500);
      return;
    }
    // The detail page opens on the show itself: the button that starts it.
    // Not on the breadcrumb - a television does not point at breadcrumbs,
    // and the middle button on one goes home.
    const watch = view?.querySelector('.d-actions .btn-primary');
    if (watch) { focusEl(watch); return; }
    const first = targets().find(t => view?.contains(t));
    if (first) { focusEl(first); return; }
    $('#app')?.focus({ preventScroll: true });
  });

  // The list of things to point at follows the page: the spotlight slides
  // change what is on the screen, so a class that changes can change the
  // list too.
  const watcher = new MutationObserver(() => { cached = null; });
  watcher.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class', 'style'] });

  // The player arrives after the page does - it is waiting for the stream to
  // resolve - and it is what the viewer came for, so it takes the focus.
  addEventListener('koma:player', e => {
    cached = null;
    const p = e.detail?.player;
    if (!p) return;
    // The television's own volume is the volume: the set's volume keys are
    // the remote's volume keys, and a muted video would silence them all.
    if (p.video) { p.video.muted = false; p.video.volume = 1; p.updateVolumeUI(); }
    // The picture starts on its own, and nothing moves the mouse on a
    // television: the controls are put away by the video itself, and any
    // key brings them back.
    const onPlay = () => {
      p.wake?.();
      // The episode drawer is open: its list keeps the focus even when the
      // stream starts underneath it.
      if (p.el?.drawer && !p.el.drawer.hidden) { focusPlayer(); return; }
      // The picture is playing now, so the pad belongs on the controls: the
      // play button is the one that is always there.
      const playBtn = p.el?.play;
      if (playBtn && visible(playBtn)) focusEl(playBtn);
    };
    p.video?.addEventListener('play', onPlay);
    if (p.video && !p.video.paused) onPlay();
    if (p.el?.drawer && !p.el.drawer.hidden) { focusPlayer(); return; }
    const play = p.el?.bigPlay;
    if (play && visible(play)) focusEl(play);
  });
  // A question on the screen takes the focus: continue where they stopped,
  // or start again. The same goes for the player itself: when it is ready,
  // the play button is what the remote should point at.
  document.addEventListener('koma:player-ask', () => { focusPlayer(); });
  document.addEventListener('koma:player-ready', () => { focusPlayer(); });
  // A stream that will not play: the message says so, and the button under
  // it is the only way out. The remote has to point at it.
  document.addEventListener('koma:player-error', () => {
    cached = null;
    const again = document.querySelector('.kp-error [data-retry]');
    if (again && visible(again)) focusEl(again);
  });

  // The picture took the screen: the pad belongs to the picture now, and the
  // time line is where it starts - it is the one thing a viewer reaches for
  // while watching. Down from there is the row of buttons.
  addEventListener('koma:fullscreen', e => {
    cached = null;
    const p = window.komaPlayer;
    if (!p) return;
    if (!e.detail?.on) return;
    p.wake?.();
    const scrub = p.el?.scrub;
    if (scrub && visible(scrub)) focusEl(scrub);
  });

  // The player's own menu opened: the pad walks it, so the focus goes in.
  // Closing it puts the focus back on the gear, rather than on the hidden
  // menu row the remote was on.
  addEventListener('koma:player-menu', e => {
    cached = null;
    const p = window.komaPlayer;
    if (!e.detail?.open) {
      requestAnimationFrame(() => {
        const settings = p?.el?.settings;
        if (settings && visible(settings)) focusEl(settings);
      });
      return;
    }
    requestAnimationFrame(() => {
      const items = playerMenuItems();
      if (items.length) focusEl(items[0]);
    });
  });

  // The episode drawer came out of the picture: the pad walks it, so the
  // focus goes in. When it closes, the focus goes back to the Episodes
  // button; leaving it on the hidden X makes the next remote press jump.
  addEventListener('koma:player-drawer', e => {
    cached = null;
    const p = window.komaPlayer;
    if (!e.detail?.open) {
      requestAnimationFrame(() => {
        const eps = p?.el?.eps;
        if (eps && visible(eps)) focusEl(eps);
      });
      return;
    }
    requestAnimationFrame(() => {
      const episodes = playerDrawerEpisodes();
      const current = episodes.find(b => b.classList.contains('on')) || episodes[0] || null;
      focusEl(current || playerDrawerClose());
    });
  });

  // A dialog is a little page of its own: the focus goes inside it, and the
  // page behind it stands still.
  let dialogWasOpen = false;
  addEventListener('koma:dialog', e => {
    cached = null;
    const dlg = e.detail?.dialog;
    const wasOpen = dialogWasOpen;
    dialogWasOpen = Boolean(dlg);
    if (!dlg) {
      // The last dialog on the screen has gone. The tail of the press that
      // dismissed it - the second centre code of a two-code remote, a hold
      // that fires after the panel is already gone, a native click on the
      // release - belongs to that press. Without this, the X that closes a
      // panel opens the very same panel again at once. The initial "nothing
      // is open" broadcast is not a dismissal and must not eat the first key.
      if (wasOpen) {
        markMenuDismissed();
        shieldActivations();
      }
      // The focus came back to the page: the mark goes with it, or the
      // viewer is left looking at a page with no focus on it.
      requestAnimationFrame(() => {
        const a = document.activeElement;
        mark(a && a !== document.body && a !== document.documentElement ? a : null);
      });
      return;
    }
    requestAnimationFrame(() => {
      // The panel has already put the focus where it wants it - the menu
      // that opened it knows better than this does. The browser, on the
      // other hand, leaves the focus on the panel itself.
      const a = document.activeElement;
      if (a && a !== dlg && dlg.contains(a) && a.matches(TARGETS)) return;
      const first = targets().find(t => dlg.contains(t));
      if (first) focusEl(first);
    });
    // The browser puts its own focus on the dialog when it opens, and it
    // does that in its own time. The first thing inside the panel is pointed
    // at once more after that, so the remote starts inside the panel.
    setTimeout(() => {
      const a = document.activeElement;
      if (a && a !== dlg && dlg.contains(a) && a.matches(TARGETS)) return;
      const first = targets().find(t => dlg.contains(t));
      if (first) focusEl(first);
    }, 140);
  });

  // The trailer of the card that has the focus - the television's answer to
  // the pointer resting on a card. It is off until the viewer asks for it.
  // The focus mark is kept here too: it follows every change of focus, the
  // ones the remote makes and the ones the page makes.
  addEventListener('focusin', e => {
    mark(e.target);
    const card = e.target.closest?.('[data-trailer],[data-ep-preview]');
    if (card) previewFocus(card);
    else stopPreviews();
  });
  addEventListener('focusout', e => { if (!e.relatedTarget) mark(null); });
  addEventListener('koma:previews', e => {
    if (e.detail?.on) {
      const card = document.activeElement?.closest?.('[data-trailer],[data-ep-preview]');
      if (card) previewFocus(card);
    } else stopPreviews();
  });

  // The native shell's way in.
  window.__komaTv = { key: tvKey, back, menu: openMenu };
}
