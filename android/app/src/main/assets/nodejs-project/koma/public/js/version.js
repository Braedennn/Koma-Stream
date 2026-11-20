// The version line at the very bottom of the footer: which Koma you're on, and
// whether it's the latest build. Inside the app the shell knows both — it owns the
// version and the update check — so it answers in one call. In a plain browser tab
// there's no running app to ask, so all we can report is the newest release.
import { $ } from './ui.js';
import { REPO } from './links.js';

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
  const setVer = v => {
    verEl.textContent = v;
    const sv = $('#settings-version');
    if (sv) sv.textContent = v;
  };
  if (!verEl || !stateEl) return;

  const say = (txt, cls = '') => { stateEl.textContent = txt; stateEl.className = `fv-state ${cls}`; };

  // In the app: the running version and its verdict on being outdated.
  if (window.koma?.version) {
    say('Checking for updates…', 'checking');
    const applyInfo = info => {
      if (!info) return null;
      const latest = info.latest || null;
      const failed = info.state === 'check_failed' || info.state === 'failed';
      setVer(info.current || '—');
      if (info.checking || info.state === 'idle') {
        say('Checking for updates…', 'checking');
        return info;
      }
      if (failed) {
        say(info.error || "Couldn't check for updates", 'unknown');
        btn.textContent = 'Retry';
        btn.hidden = false;
      } else if (latest && info.outdated) {
        say(`Update available — ${latest}`, 'outdated');
        btn.textContent = 'Get the update';
        btn.hidden = false;
      } else if (latest) {
        say('Up to date', 'current');
        btn.hidden = true;
      } else {
        say("Couldn't check for updates", 'unknown');
        btn.textContent = 'Retry';
        btn.hidden = false;
      }
      return info;
    };
    let pollGeneration = 0;
    const waitForResult = async (generation, attempts = 180) => {
      let info = null;
      for (let i = 0; i < attempts; i++) {
        if (generation !== pollGeneration) return info;
        info = await window.koma.version();
        if (generation !== pollGeneration) return info;
        applyInfo(info);
        if (!info?.checking) return info;
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      throw new Error('The update check timed out.');
    };
    const beginPolling = () => {
      const generation = ++pollGeneration;
      return waitForResult(generation).catch(error => {
        if (generation !== pollGeneration) return null;
        say(error.message || "Couldn't check for updates", 'unknown');
        btn.textContent = 'Retry';
        btn.hidden = false;
      });
    };
    beginPolling();

    // "Get the update" asks the shell to check again. The native Android
    // updater checks in the background, so wait briefly for its verdict; the
    // desktop shell reports the finished result straight away.
    btn.addEventListener('click', async () => {
      const generation = ++pollGeneration;
      btn.disabled = true;
      say('Checking…', 'checking');
      try {
        await window.koma.update?.check?.();
        await waitForResult(generation);
      } catch {
        if (generation !== pollGeneration) return;
        say("Couldn't check for updates", 'unknown');
        btn.textContent = 'Retry';
        btn.hidden = false;
      } finally {
        if (generation === pollGeneration) btn.disabled = false;
      }
    });
    return;
  }

  // A plain browser tab: no app version to report, but the newest release still is.
  setVer('web');
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
