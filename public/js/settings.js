// Settings. The panel is part of the page, so it opens straight away and
// follows the theme without a round trip to the app shell.
//
// It edits the same preferences the player and the header already use:
// `koma.audio` for the preferred language, and the player's own preference
// bag for everything playback-related.
import { $, $$, esc, toast } from './ui.js';
import { ccLangPref, getPref, pictureMode, setPref } from './player.js';
import { getAudioPref, setAudioPref } from './streaming.js';
import { previewsOn, setPreviewsOn } from './preview.js';
import { motionOn, setMotion } from './motion.js';

/* The preferences the panel shows, and what they mean. */
const PREFS = ['autoNext', 'skipIntro', 'skipOutro', 'autoplay'];

/* The tray switch belongs to the app shell: the page keeps the choice in its
   own storage and tells the shell what it is, at boot and on every change. */
const TRAY_KEY = 'koma.tray';
const getTray = () => {
  try { return localStorage.getItem(TRAY_KEY) !== '0'; } catch { return true; }
};
const setTray = on => {
  try { localStorage.setItem(TRAY_KEY, on ? '1' : '0'); } catch { /* private mode */ }
  try { window.koma?.tray?.set(on); } catch { /* a browser, not the app */ }
};

let dlg = null;

/** Paint the panel from the current preferences. */
function paint() {
  if (!dlg) return;
  for (const b of $$('[data-set-audio]', dlg)) {
    b.setAttribute('aria-checked', String(b.dataset.setAudio === getAudioPref()));
  }
  // The language of the subtitles: the chip of the language that is picked.
  // Automatic is the catch-all - it means English - so it is checked when the
  // panel has nothing else to show.
  const sub = ccLangPref();
  let subHit = false;
  for (const b of $$('[data-set-subs]', dlg)) {
    const on = (b.dataset.setSubs || '') === sub;
    b.setAttribute('aria-checked', String(on));
    if (on) subHit = true;
  }
  if (!subHit) $('[data-set-subs=""]', dlg)?.setAttribute('aria-checked', 'true');
  // The picture in full screen: the screen filled, or the whole frame.
  const pic = pictureMode();
  for (const b of $$('[data-set-picture]', dlg)) {
    b.setAttribute('aria-checked', String(b.dataset.setPicture === pic));
  }
  for (const b of $$('[data-set-theme]', dlg)) {
    b.setAttribute('aria-checked', String(b.dataset.setTheme === (document.documentElement.dataset.theme || 'dark')));
  }
  for (const i of $$('[data-set-pref]', dlg)) {
    i.checked = Boolean(getPref(i.dataset.setPref));
  }
  const previews = $('[data-set-previews]', dlg);
  if (previews) previews.checked = previewsOn();
  const motion = $('[data-set-motion]', dlg);
  if (motion) motion.checked = motionOn();
  const tray = $('[data-set-tray]', dlg);
  if (tray) tray.checked = getTray();
  // the app-only group is pointless in a plain browser
  $$('[data-app-only]', dlg).forEach(g => { g.hidden = !window.koma; });
  // The tray belongs to the desktop app: an Android app has no tray to keep
  // playing in, so the switch is not offered there.
  $$('[data-desktop-only]', dlg).forEach(el => { el.hidden = !!window.KomaAndroid; });
  // The television has no file to write a backup to, and no way to pick one
  // to restore: the whole data section is for the desktop app.
  $$('[data-data-section]', dlg).forEach(el => { el.hidden = document.documentElement.classList.contains('tv'); });
  $$('[data-backup], [data-restore]', dlg).forEach(b => { b.hidden = !window.koma?.data; });
}

/**
 * Wire the settings panel.
 * `onTheme` is called with 'light' or 'dark' when the theme is changed here.
 */
export function initSettings({ onTheme, onAudio } = {}) {
  dlg = $('#settings');
  if (!dlg) return;
  const btn = $('#settings-btn');

  btn?.addEventListener('click', () => {
    paint();
    dlg.showModal();
  });
  dlg.querySelector('[data-close]')?.addEventListener('click', () => dlg.close());
  // clicking the backdrop closes it too
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close(); });

  dlg.addEventListener('click', e => {
    const audio = e.target.closest('[data-set-audio]');
    if (audio) {
      setAudioPref(audio.dataset.setAudio);
      paint();
      onAudio?.(audio.dataset.setAudio);
      return;
    }
    // The language of the subtitles. The player is listening: the track on the
    // screen follows the pick at once.
    const sub = e.target.closest('[data-set-subs]');
    if (sub) {
      setPref('ccLang', sub.dataset.setSubs || '');
      paint();
      return;
    }
    // The picture in full screen: the player is listening, and the picture
    // moves at once.
    const pic = e.target.closest('[data-set-picture]');
    if (pic) {
      setPref('picture', pic.dataset.setPicture === 'whole' ? 'whole' : 'fill');
      paint();
      return;
    }
    const theme = e.target.closest('[data-set-theme]');
    if (theme) {
      onTheme?.(theme.dataset.setTheme);
      paint();
      return;
    }
    const backup = e.target.closest('[data-backup]');
    if (backup) {
      saveBackup();
      return;
    }
    const restore = e.target.closest('[data-restore]');
    if (restore) {
      restoreBackup();
      return;
    }
    const diagnose = e.target.closest('[data-diagnose]');
    if (diagnose) {
      runDiagnose();
      return;
    }
    const copy = e.target.closest('[data-diagnose-copy]');
    if (copy) {
      const text = copy.closest('[data-diagnose-out]')?.dataset.report || '';
      navigator.clipboard?.writeText(text).then(
        () => toast('The report is on the clipboard'),
        () => toast('The report could not be copied'),
      );
      return;
    }
    const reset = e.target.closest('[data-reset]');
    if (reset) {
      // Two steps: clearing your progress and list is not something to do
      // by accident.
      if (reset.dataset.armed !== '1') {
        reset.dataset.armed = '1';
        reset.textContent = 'Really clear it?';
        reset.classList.add('danger');
        setTimeout(() => {
          if (!reset.isConnected) return;
          reset.dataset.armed = '0';
          reset.textContent = 'Reset';
          reset.classList.remove('danger');
        }, 4000);
        return;
      }
      // Clear the local progress and list. The account and the preferences
      // are left alone.
      for (const k of ['koma.v1', 'koma.shelf.v1', 'koma.progress', 'koma.journal.v1', 'koma.take.v1']) {
        try { localStorage.removeItem(k); } catch { /* private mode */ }
      }
      location.reload();
    }
  });

  dlg.addEventListener('change', e => {
    if (e.target.matches('[data-set-tray]')) {
      setTray(e.target.checked);
      toast(e.target.checked ? 'Closing the window keeps Koma playing in the tray' : 'Closing the window quits Koma');
      return;
    }
    if (e.target.matches('[data-set-previews]')) {
      setPreviewsOn(e.target.checked);
      toast(e.target.checked ? 'Cards play their trailer when you point at them' : 'Hover previews are off');
      return;
    }
    if (e.target.matches('[data-set-motion]')) {
      setMotion(e.target.checked);
      toast(e.target.checked ? 'The app moves again' : 'The app holds still now');
      return;
    }
    const i = e.target.closest('[data-set-pref]');
    if (!i) return;
    setPref(i.dataset.setPref, i.checked);
  });

  // Another part of the app may have changed a preference (the player's own
  // menu); keep the panel in step when it is next opened.
  addEventListener('koma:prefs', paint);
  addEventListener('koma:audio', paint);

  // the shell learns the tray preference now, not the first time the panel opens
  try { window.koma?.tray?.set(getTray()); } catch { /* a browser, not the app */ }
}

/* ---------- the diagnosis ---------- */
//
// The app shell owns the network, so it is the one that can ask what is
// reachable from this machine. The report says what is broken in plain words:
// the local servers (another program sitting on Koma's port looks exactly like
// a broken app) and the sites the streaming chain reads (a site that cannot be
// reached from this network means episodes come back as "not found").

const diagRow = (ok, name, detail) =>
  `<div class="diag-row ${ok ? 'ok' : 'bad'}"><span class="diag-dot" aria-hidden="true"></span><span><b>${esc(name)}</b><em>${esc(detail)}</em></span></div>`;

function diagHtml(r) {
  if (r?.error) return `<p class="diag-note diag-bad">The check itself failed: ${esc(r.error)}</p>`;
  const servers = r.servers || [];
  const hosts = r.hosts || [];
  const broken = servers.filter(s => !s.ok).length + hosts.filter(h => !h.ok && h.critical).length;
  const spares = hosts.filter(h => !h.ok && !h.critical).length;
  const out = [];
  out.push(broken
    ? `<p class="diag-sum diag-bad">${broken} thing${broken === 1 ? '' : 's'} need${broken === 1 ? 's' : ''} attention.</p>`
    : `<p class="diag-sum">Everything is working${spares ? ' (a spare is out of reach)' : ''}.</p>`);
  out.push('<div class="diag-sec">On this computer</div>');
  for (const s of servers) out.push(diagRow(s.ok, `${s.name} — port ${s.port}`, s.detail));
  out.push('<div class="diag-sec">The sites Koma reads</div>');
  for (const h of hosts) {
    const how = h.error || (h.status >= 400 ? `refused (${h.status})` : `answered ${h.status}`);
    const detail = h.ok
      ? `reachable${h.reachOnly ? '' : ` (answered ${h.status})`} — ${h.why}`
      : `${how} — ${h.why}${h.critical ? '' : ' (a spare: it only matters if the others fail too)'}`;
    out.push(diagRow(h.ok, h.name, detail));
  }
  const addrs = (r.addresses || []).map(a => `${a.address} (${a.name})`).join(', ');
  out.push('<div class="diag-sec">This machine</div>');
  out.push(`<p class="diag-note">Koma only ever listens on 127.0.0.1 — the loopback of this computer. It is never bound to an address on the network, and no address of one computer is written into the app.<br>${addrs ? `This machine is on ${esc(addrs)}.` : 'No network address was found.'}</p>`);
  const logs = (r.logs || []).filter(l => l.problems?.length);
  if (logs.length) {
    out.push('<div class="diag-sec">What the logs complained about</div>');
    for (const l of logs) {
      out.push(`<p class="diag-note"><b>${esc(l.name)}</b></p>`);
      for (const p of l.problems) out.push(`<p class="diag-log">${esc(p)}</p>`);
    }
  }
  out.push('<button class="btn btn-ghost btn-sm diag-copy" type="button" data-diagnose-copy>Copy this report</button>');
  return out.join('');
}

function diagText(r) {
  if (r?.error) return `Koma diagnosis\nThe check itself failed: ${r.error}\n`;
  const lines = ['Koma diagnosis', `when: ${r.at}`, `version: ${r.version}`, '', 'On this computer'];
  for (const s of r.servers || []) lines.push(`  [${s.ok ? 'ok' : 'BAD'}] ${s.name} (port ${s.port}): ${s.detail}`);
  lines.push('', 'The sites Koma reads');
  for (const h of r.hosts || []) {
    const mark = h.ok ? 'ok' : h.critical ? 'BAD' : 'spare';
    const how = h.error || (h.status >= 400 ? `refused (${h.status})` : `answered ${h.status}`);
    lines.push(`  [${mark}] ${h.name} (${h.host}): ${h.ok ? `answered ${h.status}` : how} - ${h.why}`);
  }
  lines.push('', 'This machine');
  lines.push(`  addresses: ${(r.addresses || []).map(a => `${a.address} (${a.name})`).join(', ') || 'none'}`);
  lines.push('  Koma only listens on 127.0.0.1 - it is never bound to an address on the network.');
  for (const l of r.logs || []) {
    if (!l.problems?.length) continue;
    lines.push('', `Problems in ${l.name}`);
    for (const p of l.problems) lines.push(`  ${p}`);
  }
  return lines.join('\n');
}

async function runDiagnose() {
  const out = $('[data-diagnose-out]', dlg);
  if (!out) return;
  const shell = window.koma?.diagnose;
  if (!shell) {
    out.hidden = false;
    // The check belongs to the desktop app. The Android apps keep their own
    // log, but the page cannot read it - so say where it is instead of
    // pretending the app is missing.
    out.innerHTML = window.KomaAndroid
      ? '<p class="diag-note">The full check is in the desktop app. The app on this device keeps its own log in its private files folder (<b>koma-log.txt</b>).</p>'
      : '<p class="diag-note">The check needs the app itself — open Koma, not a browser tab.</p>';
    return;
  }
  out.hidden = false;
  out.innerHTML = '<p class="diag-note">Checking…</p>';
  const r = await shell().catch(err => ({ error: err?.message || 'the check failed' }));
  out.dataset.report = diagText(r);
  out.innerHTML = diagHtml(r);
}

/* Backup header: what this payload is, and which way it moves. */
const BACKUP = { app: 'koma', kind: 'local-data', version: 1 };
// Access and refresh tokens are account credentials, not ordinary local data.
// They stay on the device and never enter a shareable backup file.
const SENSITIVE_KEYS = new Set(['koma.anilist', 'koma.myanimelist']);
const localKeys = () => {
  const out = [];
  try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k?.startsWith('koma.') && !SENSITIVE_KEYS.has(k)) out.push(k); } } catch { /* private mode */ }
  return out;
};

/** Write the page's own storage to a file the shell puts where the user says. */
async function saveBackup() {
  const shell = window.koma?.data;
  if (!shell) return;
  const keys = {};
  for (const k of localKeys()) {
    try { keys[k] = localStorage.getItem(k); } catch { /* private mode */ }
  }
  const payload = JSON.stringify({ ...BACKUP, saved: new Date().toISOString(), keys });
  const { ok, filePath, reason } = await shell.save(payload).catch(() => ({ ok: false, reason: 'the file dialog failed' }));
  if (!ok) {
    if (reason !== 'canceled') toast(`Backup failed: ${reason}`);
    return;
  }
  toast(`Backup saved to ${filePath.split(/[\\/]/).pop()}`);
}

/** Read a backup file and put its keys back into the page's storage. */
async function restoreBackup() {
  const shell = window.koma?.data;
  if (!shell) return;
  const res = await shell.read().catch(() => ({ ok: false, reason: 'the file dialog failed' }));
  if (!res.ok) {
    if (res.reason !== 'canceled') toast(`Restore failed: ${res.reason}`);
    return;
  }
  const d = res.data;
  if (d?.app !== 'koma' || d?.kind !== 'local-data' || typeof d.keys !== 'object') {
    toast('That file is not a Koma backup');
    return;
  }
  let n = 0;
  for (const [k, v] of Object.entries(d.keys)) {
    if (!k.startsWith('koma.') || SENSITIVE_KEYS.has(k) || typeof v !== 'string') continue;
    try { localStorage.setItem(k, v); n++; } catch { /* too full, private mode */ }
  }
  toast(n ? `Restored ${n} piece${n === 1 ? '' : 's'} of data — reloading` : 'That backup was empty');
  if (n) setTimeout(() => location.reload(), 900);
}
