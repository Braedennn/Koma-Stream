// The television's canvas.
//
// A television is a screen ten feet away, and the picture has to look the
// same on every set whatever its resolution or density. The page is
// therefore drawn on a fixed canvas - 1920 by 1080 - and the whole drawing
// is scaled to the screen. A 1080p television, a 4K one and a small set all
// show the same picture, drawn at the size their own screen asks for.
//
// The canvas is asked for with the viewport: the page is laid out on it, and
// the browser fits it to the screen. Every length in the stylesheet - the
// rail, the gaps, the type - then keeps its share of the picture, because
// the viewport's own units are the canvas's units.
//
// The script sits in the head of the page so that the first paint is already
// the right size: there is no flash of a differently sized television.

(function () {
  const W = 1920;   // the canvas is this many pixels wide
  const H = 1080;   // and this many lines high

  /* Is this the television? The URL asks for it outright - the television
     app opens the site with ?tv=1, and it makes the television layout
     testable on a phone - and the app's own shell knows which build it is. */
  function wanted() {
    if (/(^|[?&])tv=1(&|$)/.test(location.search)) return true;
    try { return !!(window.KomaAndroid && window.KomaAndroid.isTv && window.KomaAndroid.isTv()); } catch (e) { return false; }
  }

  /* The size of the screen the drawing is shown on, in the screen's own
     pixels. */
  function screenSize() {
    const w = Math.round(screen.width || innerWidth || W);
    const h = Math.round(screen.height || innerHeight || H);
    return [Math.max(1, w), Math.max(1, h)];
  }

  /* Draw the canvas at the size the screen asks for.
     The scale is asked for as well: the browser has to be told how much of
     the canvas the set can show, or it draws the canvas at its own size and
     cuts the picture off at the edge of the screen. One scale for both
     directions, so the picture keeps its shape; a set of another shape gets
     the canvas whole, with the edges of the screen left plain. */
  function fit() {
    const [sw, sh] = screenSize();
    const scale = Math.max(0.1, Math.min(sw / W, sh / H));
    const m = document.querySelector('meta[name="viewport"]');
    if (m) m.content = 'width=' + W + ', height=' + H + ', initial-scale=' + scale + ', viewport-fit=cover';
    document.documentElement.classList.add('tv');
  }

  window.__komaCanvas = { fit, wanted, canvas: [W, H] };

  if (wanted()) fit();
})();
