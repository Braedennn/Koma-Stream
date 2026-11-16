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
  // In the desktop app, Windows paints the window's own caption buttons and
  // needs to be told which ground to paint them on.
  try { window.koma && window.koma.theme && window.koma.theme.set(theme); } catch (e) { /* not the app */ }
})();
