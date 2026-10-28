// App settings: the few things that belong to the desktop app rather than to
// the site itself. Right now that's Discord Rich Presence.
import { $, toast } from './ui.js';
import { presenceStatus, setPresenceClientId, setPresenceEnabled } from './presence.js';

const noteFor = s => {
  if (!s.configured) return 'Paste your own Discord app’s Client ID below to enable this (Koma’s built-in ID is unavailable).';
  if (!s.enabled) return 'Show what you’re watching in Koma on your Discord profile.';
  if (s.connected) return 'Connected — your profile updates as you browse and watch.';
  if (s.error) return `Discord said: ${s.error}`;
  return 'Waiting for Discord. Open Discord and this connects on its own.';
};

function paint(s) {
  const state = s || presenceStatus();
  const on = $('#rp-enabled');
  if (on) on.checked = state.enabled;
  const note = $('#rp-note');
  if (note) note.textContent = noteFor(state);
  const id = $('#rp-client');
  if (id && document.activeElement !== id) id.value = state.clientId || '';
}

export function initSettings() {
  const dlg = $('#app-settings');
  const btn = $('#settings-btn');
  if (!dlg || !btn) return;
  if (!window.koma) { btn.remove(); return; } // plain browser tab: nothing app-side to configure

  btn.addEventListener('click', () => {
    paint();
    $('#rp-err').hidden = true;
    dlg.showModal();
  });

  $('#rp-enabled').addEventListener('change', async e => {
    const on = e.target.checked;
    const state = await setPresenceEnabled(on);
    paint(state);
    if (!state?.configured && on) toast('Add your Discord Client ID to finish setting this up');
  });

  $('#rp-save').addEventListener('click', async () => {
    const id = $('#rp-client').value.trim();
    const err = $('#rp-err');
    try {
      const state = await setPresenceClientId(id);
      paint(state);
      err.hidden = true;
      toast(id ? 'Discord Client ID saved' : 'Discord Client ID cleared');
    } catch (e) {
      err.textContent = e.message || 'That Client ID doesn’t look right.';
      err.hidden = false;
    }
  });

  addEventListener('koma:presence', e => paint(e.detail));
}
