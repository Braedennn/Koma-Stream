// Motion. The reference design arrives slowly and softly: a long curve, a
// small lift, and a sequence rather than a single cut. This is where that
// lives — the blocks that rise into place as they reach the screen, and the
// quiet crossfade between one page and the next.

const reduced = matchMedia('(prefers-reduced-motion: reduce)');

/* The blocks that rise into place as they reach the screen. */
const REVEAL = '.row, .grid, .genre-grid, .take-grid, .badge-grid, .ep-grid, .week-grid';

let observer = null;

/* The page on screen, and the one lifting away over it. */
let live = null;
let overlay = null;

/** Reveal one block: it rises, and the cards inside it arrive in sequence. */
function reveal(el) {
  el.classList.add('in');
  const cards = el.querySelectorAll(':scope > .grid > .card, :scope > .track > .card, :scope > .card');
  cards.forEach((c, i) => {
    c.classList.add('reveal');
    c.style.setProperty('--rd', `${Math.min(i, 14) * 45}ms`);
    c.classList.add('in');
  });
}

/**
 * Watch the app for blocks that have just arrived, and let them rise when
 * they reach the screen. A block already on screen is revealed at once, so
 * nothing is ever left waiting for a scroll that will not come.
 */
export function initMotion(root) {
  if (reduced.matches || !('IntersectionObserver' in window)) return;

  observer = new IntersectionObserver((entries, obs) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      obs.unobserve(e.target);
      reveal(e.target);
    }
  }, { rootMargin: '0px 0px -4% 0px', threshold: .01 });

  const watch = el => {
    if (el.dataset.reveal) return;
    el.dataset.reveal = '1';
    el.classList.add('reveal');
    observer.observe(el);
  };

  const scan = node => {
    if (node.nodeType !== 1) return;
    if (node.matches(REVEAL)) watch(node);
    node.querySelectorAll(REVEAL).forEach(watch);
    // a card that turns up after its block was already revealed still gets its turn
    if (node.matches('.card') && !node.classList.contains('reveal') && node.closest('.reveal.in')) {
      node.classList.add('reveal', 'in');
      const sibs = [...(node.parentElement?.children || [])].filter(c => c.classList.contains('card'));
      node.style.setProperty('--rd', `${Math.min(sibs.indexOf(node), 14) * 45}ms`);
    }
  };

  new MutationObserver(muts => {
    for (const m of muts) for (const n of m.addedNodes) scan(n);
  }).observe(root, { childList: true, subtree: true });

  scan(root);

  // Safety net: a block the observer never reports (hidden, zero-height, or
  // caught mid-layout) must never be left invisible.
  setTimeout(() => {
    // The height of the page's own canvas, not of the window: on a television
    // the page is drawn on a fixed canvas and scaled to the set, so the
    // window's height is not the height of the screen.
    const h = document.documentElement.clientHeight;
    root.querySelectorAll('.reveal:not(.in)').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.top < h && r.bottom > 0) reveal(el);
    });
  }, 2500);
}

/**
 * Hand the screen from the view that is there now to the one that is coming.
 *
 * The new page goes in straight away, so its loading state is on screen and
 * the app never looks stuck on the page it came from. The old page stays
 * exactly where it is and lifts away over the new one — the page turns over
 * rather than cutting.
 *
 * Exactly one page is on screen at a time. A page that was still building
 * when the user moved on is removed along with it, so nothing can be left
 * stranded over the page the user is actually looking at.
 */
export function swapView(app, root) {
  // A page that is still lifting away is taken off now.
  if (overlay) { overlay.remove(); overlay = null; }

  const outgoing = live;
  live = root;

  if (!outgoing || outgoing === root || reduced.matches) {
    app.replaceChildren(root);
    root.classList.add('view-in');
    return;
  }

  // The new page sits exactly where the old one was, so nothing jumps.
  const h = outgoing.getBoundingClientRect().height;
  root.style.marginTop = `-${h}px`;
  app.replaceChildren(outgoing, root);
  root.classList.add('view-in');
  outgoing.classList.add('view-out');
  overlay = outgoing;

  setTimeout(() => {
    outgoing.remove();
    if (overlay === outgoing) overlay = null;
    root.style.marginTop = '';
  }, 260);
}

/** The new view is in place. */
export function arrive(root) {
  root.classList.add('view-in');
}

/** This view was superseded while it was still building — take it away. */
export function abandon(root) {
  root.remove();
}
