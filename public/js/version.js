// The version line at the very bottom of the footer: which Koma you're on, and
// whether it's the latest build. Inside the app the shell knows both — it owns the
// version and the update check — so it answers in one call. In a plain browser tab
// there's no running app to ask, so all we can report is the newest release.
import { $ } from './ui.js';

const REPO = 'Braedennn/Koma-Stream';
const CACHE_KEY = 'koma.release.v1';   // what the newest release was, and when we saw it
const CACHE_MS = 10 * 60e3;

/** The newest release, cached so a page reload doesn't ask GitHub every time. */
function cachedRelease() {
  try {
    const raw = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    if (raw?.v && Date.now() - Number(raw.at || 0) < CACHE_MS) return raw.v;
  } catch { /* no cache, no problem */ }
  return null;
}

function rememberRelease(v) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ v, at: Date.now() })); } catch { /* private mode */ }
}

export function initVersion() {
  const verEl = $('#fv-version');
  const stateEl = $('#fv-state');
  const btn = $('#fv-update');
  if (!verEl || !stateEl) return;

  const say = (txt, cls = '') => { stateEl.textContent = txt; stateEl.className = `fv-state ${cls}`; };

  // In the app: the running version and its verdict on being outdated.
  if (window.koma?.version) {
    say('Checking for updates…', 'checking');
    let latest = null;
    window.koma.version().then(info => {
      if (!info) return;
      latest = info.latest || null;
      verEl.textContent = info.current || '—';
      if (latest && info.outdated) {
        say(`Update available — ${latest}`, 'outdated');
        btn.hidden = false;
      } else if (latest) {
        say('Up to date', 'current');
        btn.hidden = true;
      } else {
        say("Couldn't check for updates", 'unknown');
        btn.hidden = true;
      }
    }).catch(() => say("Couldn't check for updates", 'unknown'));

    // "Get the update" brings the update card back, even if it was dismissed.
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      say('Checking…', 'checking');
      try {
        await window.koma.update?.check?.();
        say(latest ? `Update available — ${latest}` : "Couldn't check for updates", latest ? 'outdated' : 'unknown');
      } catch {
        say("Couldn't check for updates", 'unknown');
      }
      btn.disabled = false;
    });
    return;
  }

  // A plain browser tab: no app version to report, but the newest release still is.
  verEl.textContent = 'web';
  btn.hidden = true;
  const known = cachedRelease();
  if (known) {
    say(`Latest release ${known}`, 'current');
    return;
  }
  say('Checking…', 'checking');
  fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } })
    .then(r => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
    .then(rel => {
      const v = String(rel.tag_name || '').replace(/^v/, '');
      if (v) rememberRelease(v);
      say(v ? `Latest release ${v}` : 'Latest release unknown', 'current');
    })
    .catch(() => say("Couldn't check for updates", 'unknown'));
}
