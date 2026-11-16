// The scrollbar.
//
// The native one runs the full height of the window, which means it slides
// under the fixed header and the page looks like it is scrolling behind the
// bar. This draws its own instead: the rail starts under the header, and the
// thumb gets shorter the further down you go, so the bar reads as a quiet
// hint of where you are rather than a permanent strip down the edge.
//
// It is a scrollbar, not a picture of one: press the thumb and drag it, and
// the page follows. The rail itself stays click-through, so it never swallows
// a click meant for the page; the thumb carries a wider, invisible grip, and
// it only takes the pointer while the bar is showing.

const SHRINK = 0.45;   // how much of the thumb the scroll gives back
const MIN = 28;        // never smaller than this, or it stops being a thumb
const EDGE = 22;       // how near the edge the pointer has to come to show it

export function initScrollbar() {
  const doc = document.documentElement;
  const rail = document.createElement('div');
  rail.className = 'scroll-rail';
  rail.setAttribute('aria-hidden', 'true');
  const thumb = document.createElement('i');
  thumb.className = 'scroll-thumb';
  rail.appendChild(thumb);
  document.body.appendChild(rail);

  let idle = 0;
  let drag = null;   // { id, startY, startScroll, travel, max, h }

  const maxScroll = () => Math.max(0, doc.scrollHeight - innerHeight);

  const paint = () => {
    const max = maxScroll();
    if (max <= 2) { rail.classList.remove('on'); return; }
    rail.classList.add('on');
    if (drag) return;   // the thumb belongs to the pointer until the drag ends
    const p = Math.min(1, Math.max(0, scrollY / max));
    const railH = rail.clientHeight;
    const content = Math.min(1, innerHeight / Math.max(1, doc.scrollHeight));
    let h = railH * content * (1 - SHRINK * p);
    h = Math.max(MIN, Math.min(railH, h));
    thumb.style.height = `${h}px`;
    thumb.style.transform = `translateY(${p * (railH - h)}px)`;
  };

  const wake = () => {
    paint();
    clearTimeout(idle);
    idle = setTimeout(() => rail.classList.remove('on'), 1400);
  };

  /* ---------- dragging the thumb ---------- */
  thumb.addEventListener('pointerdown', e => {
    const max = maxScroll();
    if (max <= 2) return;
    const box = thumb.getBoundingClientRect();
    const railH = rail.clientHeight;
    // The thumb keeps its size for the length of the drag, so the pointer and
    // the thumb stay together: the page moves exactly as far as the thumb does.
    drag = {
      id: e.pointerId,
      startY: e.clientY,
      startScroll: scrollY,
      travel: Math.max(1, railH - box.height),
      max,
      h: box.height,
    };
    try { thumb.setPointerCapture(e.pointerId); } catch { /* the browser said no */ }
    rail.classList.add('dragging');
    document.body.classList.add('bar-dragging');
    e.preventDefault();
  });

  thumb.addEventListener('pointermove', e => {
    if (!drag || e.pointerId !== drag.id) return;
    const dy = e.clientY - drag.startY;
    const y = Math.max(0, Math.min(drag.max, drag.startScroll + (dy / drag.travel) * drag.max));
    scrollTo(0, y);
    const railH = rail.clientHeight;
    const top = Math.max(0, Math.min(railH - drag.h, (y / drag.max) * drag.travel));
    thumb.style.transform = `translateY(${top}px)`;
    e.preventDefault();
  });

  const endDrag = e => {
    if (!drag || (e && e.pointerId !== drag.id)) return;
    drag = null;
    rail.classList.remove('dragging');
    document.body.classList.remove('bar-dragging');
    wake();
  };
  thumb.addEventListener('pointerup', endDrag);
  thumb.addEventListener('pointercancel', endDrag);

  addEventListener('scroll', wake, { passive: true });
  addEventListener('resize', paint, { passive: true });
  addEventListener('koma:route', () => { endDrag(); paint(); });

  // Moving the pointer to the edge brings the bar back, so there is always a
  // thumb to grab — even on a page that has not been scrolled in a while.
  addEventListener('mousemove', e => {
    if (drag) return;
    const near = e.clientX >= innerWidth - EDGE;
    if (near === rail.classList.contains('hot')) return;
    rail.classList.toggle('hot', near);
    if (near) wake();
  }, { passive: true });

  // The page grows and shrinks as it loads; keep the thumb honest.
  if ('ResizeObserver' in window) new ResizeObserver(paint).observe(document.body);
  paint();
}
