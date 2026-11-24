// The theme, decided before the first paint.
// This file is a plain script (not a module) so the browser runs it while the
// document is still parsing - the page never flashes the wrong colours.
// It has to live in its own file: the site's Content-Security-Policy allows
// scripts from this origin only, so an inline script would be blocked.
// Dark is the default, the same as the reference design; a stored choice wins.
(function () {
  var saved = null;
  try { saved = localStorage.getItem('koma.theme'); } catch (e) { /* private mode */ }
  var theme = saved === 'light' ? 'light' : 'dark';
  document.documentElement.dataset.theme = theme;
  // Apply stillness before the stylesheet's first paint too. The module boot
  // repeats this later, after it has installed the system-preference listener.
  var motion = null;
  try { motion = localStorage.getItem('koma.motion'); } catch (e) { /* private mode */ }
  var systemReduced = false;
  try { systemReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch (e) { /* old WebView */ }
  if (motion === '0' || systemReduced) document.documentElement.classList.add('no-motion');
  // In the desktop app, Windows paints the window's own caption buttons and
  // needs to be told which ground to paint them on.
  try { window.koma && window.koma.theme && window.koma.theme.set(theme); } catch (e) { /* not the app */ }
})();
