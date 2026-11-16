// The window buttons. Inside the app, the page draws its own minimise,
// maximise and close controls in the site header, so they look like part of
// the app instead of like Windows. The shell owns the window; this only asks
// it to do the usual things.

import { $ } from './ui.js';

export function initWindow() {
  const shell = window.koma?.window;
  const group = $('#win-ctl');
  if (!shell || !group) return; // a browser, not the app

  // The app's header carries the window buttons as well, so it needs more
  // room than a plain browser tab does. The stylesheet uses this to move the
  // links into the menu drawer when the window is too narrow for both.
  document.documentElement.classList.add('in-app');

  const min = $('#win-min');
  const max = $('#win-max');
  const close = $('#win-close');
  group.hidden = false;

  const paint = state => {
    const maximized = !!state?.maximized;
    const label = maximized ? 'Restore' : 'Maximise';
    if (max) {
      max.title = label;
      max.setAttribute('aria-label', label);
      max.querySelector('.i-max')?.toggleAttribute('hidden', maximized);
      max.querySelector('.i-restore')?.toggleAttribute('hidden', !maximized);
    }
  };

  min?.addEventListener('click', () => shell.minimize());
  max?.addEventListener('click', () => {
    shell.maximize();
    // Windows can swallow the change, so the state is asked for again in a
    // moment - the button has to show what the window is doing.
    setTimeout(() => shell.state?.().then(paint).catch(() => {}), 260);
  });
  close?.addEventListener('click', () => shell.close());
  shell.onChange?.(paint);
  shell.state?.().then(paint).catch(() => {});
}
