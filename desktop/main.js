// Koma desktop app: starts Koma and both streaming servers in the background,
// shows the site in its own window, and stops what it started when you quit.
// Servers that are already running (start.bat, start-servers.ps1) are reused, not restarted.
const { app, BrowserWindow, shell, Menu, ipcMain, Notification } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { DiscordRpc, buildActivity } = require('./discord-rpc');
const { newerVersion, sweep, download, install } = require('./updater');

const PORT = 4000;
// localhost (not 127.0.0.1): it's the address the AniList sign-in sends you back to, and it keeps
// the same saved list/progress as the site opened in a normal browser.
const URL_HOME = `http://localhost:${PORT}/`;
const PROBE = `http://127.0.0.1:${PORT}/`;
const IS_WIN = process.platform === 'win32';

// Where Koma and its servers live. The packaged app carries everything inside
// its resources (app-site, anivault, allanime with its own portable Python), so
// it needs no system Node, npm or Python. While developing, everything runs
// from the WebsiteAnime folder next to desktop\.
const BUNDLED = fs.existsSync(path.join(process.resourcesPath, 'app-site', 'server.js'));
function komaHome() {
  if (process.env.KOMA_HOME) return process.env.KOMA_HOME;
  try { return fs.readFileSync(path.join(process.resourcesPath, 'koma-home.txt'), 'utf8').trim(); } catch { /* dev */ }
  return path.resolve(__dirname, '..');
}
const ROOT = BUNDLED ? process.resourcesPath : komaHome();
const HOME = BUNDLED ? path.join(ROOT, 'app-site') : ROOT;
const ANIVAULT = BUNDLED ? path.join(ROOT, 'anivault') : path.join(ROOT, 'Servers - DONT TOUCH', 'anivault-scraper');
const ALLANIME = BUNDLED ? path.join(ROOT, 'allanime') : path.join(ROOT, 'Servers - DONT TOUCH', 'allanime-api');
const LOGS = path.join(app.getPath('userData'), 'logs');
const anivaultKey = () => {
  try { return fs.readFileSync(path.join(ANIVAULT, '.env'), 'utf8').match(/^ANIVAULT_API_KEY=(.+)$/m)?.[1]?.trim() || ''; } catch { return ''; }
};

/* ---------- background processes ---------- */
const started = []; // { name, child } we launched and must stop on quit

function portOpen(port) {
  return new Promise(resolve => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.setTimeout(800);
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('timeout', () => { s.destroy(); resolve(false); });
    s.once('error', () => resolve(false));
  });
}

function launch(name, file, args, { cwd, env = {}, log }) {
  fs.mkdirSync(path.dirname(log), { recursive: true });
  const out = fs.openSync(log, 'a');
  fs.writeSync(out, `\n[${new Date().toISOString()}] --- started by the Koma app ---\n`);
  const child = spawn(file, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', out, out], windowsHide: true });
  child.on('error', err => fs.appendFileSync(log, `[koma app] couldn't start ${name}: ${err.message}\n`));
  started.push({ name, child });
  return child;
}

  async function startServers(status) {
    // AniVault (streaming, port 3000)
    if (!(await portOpen(3000))) {
      status('Starting the streaming server…');
      if (BUNDLED) {
        // The compiled server runs on Electron's own Node — silent, no system Node or npm.
        launch('AniVault', process.execPath, [path.join(ANIVAULT, 'dist', 'server.js')],
          { cwd: ANIVAULT, env: { ELECTRON_RUN_AS_NODE: '1' }, log: path.join(LOGS, 'anivault.log') });
      } else {
        // npm is a .cmd on Windows, which Node only runs through a shell
        launch('AniVault', IS_WIN ? (process.env.ComSpec || 'cmd.exe') : 'npm', IS_WIN ? ['/d', '/s', '/c', 'npm run dev'] : ['run', 'dev'],
          { cwd: ANIVAULT, log: path.join(LOGS, 'anivault.log') });
      }
    }
    // AllAnime (sub/dub counts, port 8000) — bundled with its own portable Python
    const py = BUNDLED ? path.join(ALLANIME, 'py', 'python.exe')
      : path.join(ALLANIME, '.venv', IS_WIN ? 'Scripts/python.exe' : 'bin/python');
    if (!(await portOpen(8000)) && fs.existsSync(py)) {
      launch('AllAnime', py, ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', '8000'],
        { cwd: ALLANIME, log: path.join(LOGS, 'allanime.log') });
    }
    // Koma itself, run by Electron's own Node so it doesn't depend on the installed one.
    // Bound to this PC only (127.0.0.1): no Windows Firewall prompt for Koma.exe.
    if (!(await portOpen(PORT))) {
      status('Starting Koma…');
      launch('Koma', process.execPath, [path.join(HOME, 'server.js')],
        { cwd: HOME, env: { ELECTRON_RUN_AS_NODE: '1', PORT: String(PORT), HOST: '127.0.0.1', QUIET: '1', KOMA_ANIVAULT_KEY: anivaultKey() }, log: path.join(LOGS, 'koma.log') });
    }
  }

function stopServers() {
  for (const { child } of started.splice(0)) {
    if (child.exitCode !== null || !child.pid) continue;
    // /T takes the whole tree (npm -> ts-node-dev -> node), not just the shell we spawned
    if (IS_WIN) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    else child.kill();
  }
}

async function waitForKoma(ms = 45000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${PROBE}api/stream-status`, { signal: AbortSignal.timeout(2000) });
      if (r.status === 200 || r.status === 503) return true; // 503 = Koma is up, streaming still booting (the player waits for it)
    } catch { /* not yet */ }
    await new Promise(r => setTimeout(r, 400));
  }
  return false;
}

/* ---------- window ---------- */
const STATE = () => path.join(app.getPath('userData'), 'window.json');
const readState = () => { try { return JSON.parse(fs.readFileSync(STATE(), 'utf8')); } catch { return {}; } };

let win;
function createWindow() {
  const s = readState();
  win = new BrowserWindow({
    width: s.width || 1440, height: s.height || 900, x: s.x, y: s.y,
    minWidth: 900, minHeight: 600,
    title: 'Koma', backgroundColor: '#08080D', show: false,
    // No Windows title bar: the minimise/maximise/close buttons sit on the site's own header.
    titleBarStyle: 'hidden',
    titleBarOverlay: IS_WIN ? { color: '#10111B', symbolColor: '#C9CCDA', height: 68 } : false,
    icon: path.join(__dirname, 'build', IS_WIN ? 'icon.ico' : 'png/256.png'),
    webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'preload.js') },
  });
  if (s.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());

  const save = () => {
    if (win.isDestroyed()) return;
    try { fs.writeFileSync(STATE(), JSON.stringify({ ...(win.isMaximized() ? readState() : win.getNormalBounds()), maximized: win.isMaximized() })); } catch { /* not important */ }
  };
  win.on('close', save);

  // Links to other sites (Crunchyroll, …) open in the normal browser; AniList's sign-in page
  // opens in a small window inside the app so the sign-in lands back here.
  const external = url => !url.startsWith(URL_HOME) && !url.startsWith(PROBE) && !url.startsWith('file:');
  win.webContents.setWindowOpenHandler(({ url }) => {
    // Only real external links (Crunchyroll, AniList, …) reach the browser. Same-origin
    // opens — middle-clicked cards, dragged thumbnails — are denied outright: the app is
    // the destination, never a launcher for itself.
    if (/^https?:/.test(url) && external(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!external(url)) return;
    e.preventDefault();
    if (url.startsWith('https://anilist.co/api/v2/oauth/authorize')) signInWindow(url);
    else shell.openExternal(url);
  });

  // Header styling only the app needs: always solid (it carries the window buttons) and draggable.
  win.webContents.on('did-finish-load', () => {
    if (external(win.webContents.getURL())) return;
    win.webContents.insertCSS(`
      .top { background: #10111B !important; border-bottom-color: rgba(255, 255, 255, .055) !important; -webkit-app-region: drag;
        padding-right: calc(100vw - env(titlebar-area-width, 100vw) + 18px) !important; }
      .top a, .top button, .top input, .top label, .top .suggest, .top .acct-menu { -webkit-app-region: no-drag; }`).catch(() => {});
  });

  // Browser-style shortcuts: F5 / Ctrl+R reload, F11 fullscreen, Alt+Left back, F12 dev tools.
  win.webContents.on('before-input-event', (e, i) => {
    if (i.type !== 'keyDown') return;
    const k = i.key;
    if (k === 'F5' || (i.control && k.toLowerCase() === 'r')) win.webContents.reload();
    else if (k === 'F11') win.setFullScreen(!win.isFullScreen());
    else if (k === 'F12') win.webContents.toggleDevTools();
    else if (i.alt && k === 'ArrowLeft' && win.webContents.navigationHistory.canGoBack()) win.webContents.navigationHistory.goBack();
    else if (i.alt && k === 'ArrowRight' && win.webContents.navigationHistory.canGoForward()) win.webContents.navigationHistory.goForward();
    else return;
    e.preventDefault();
  });
  return win;
}

/** AniList's sign-in page in a child window; when AniList sends you back, the token goes to the main window. */
function signInWindow(url) {
  const auth = new BrowserWindow({ parent: win, modal: true, width: 520, height: 760, title: 'Sign in with AniList', backgroundColor: '#0B1622', autoHideMenuBar: true, webPreferences: { contextIsolation: true, sandbox: true } });
  const back = (e, to) => {
    if (!to.startsWith(`${URL_HOME}auth/anilist`)) return;
    e.preventDefault();
    win.loadURL(to);
    auth.close();
  };
  auth.webContents.on('will-redirect', back);
  auth.webContents.on('will-navigate', back);
  auth.webContents.setWindowOpenHandler(({ url: u }) => { shell.openExternal(u); return { action: 'deny' }; });
  auth.loadURL(url);
}

const status = text => { if (win && !win.isDestroyed()) win.webContents.executeJavaScript(`window.setStatus && setStatus(${JSON.stringify(text)})`).catch(() => {}); };

/* ---------- desktop notifications (the site asks through the preload) ---------- */
ipcMain.on('koma:notify', (_e, { title, body, url }) => {
  try {
    if (!Notification.isSupported()) return;
    const n = new Notification({
      title: String(title || 'Koma'),
      body: String(body || ''),
      icon: path.join(__dirname, 'build', 'png', '256.png'),
    });
    n.on('click', () => {
      if (!win || win.isDestroyed()) return;
      if (win.isMinimized()) win.restore();
      win.show(); win.focus();
      if (url) win.loadURL(new URL(String(url), URL_HOME).toString());
    });
    n.show();
  } catch { /* toasts are best-effort */ }
});

/* ---------- Discord Rich Presence ---------- */
// The site says what you're watching; this process keeps the connection to
// Discord alive and pushes it onto your profile.
const SETTINGS = () => path.join(app.getPath('userData'), 'settings.json');
const readSettings = () => { try { return JSON.parse(fs.readFileSync(SETTINGS(), 'utf8')) || {}; } catch { return {}; } };

/** Where the Discord Application's Client ID comes from: the environment first
 *  (handy for testing), then the one saved in the app's settings, then the
 *  one bundled with the build. */
function discordClientId() {
  const env = String(process.env.KOMA_DISCORD_CLIENT_ID || '').trim();
  if (env) return env;
  const saved = String(readSettings().discordClientId || '').trim();
  if (saved) return saved;
  try {
    const bundled = JSON.parse(fs.readFileSync(path.join(__dirname, 'discord.json'), 'utf8'));
    return String(bundled?.clientId || '').trim();
  } catch { return ''; }
}

const presence = { client: null, status: 'off', activity: null };
// The download page rides along under every activity: anyone who sees the presence can reach it.
const DEFAULT_BUTTONS = [{ label: 'Download Koma', url: 'https://www.totallynoire.xyz/koma' }];
const presenceState = () => ({
  connected: Boolean(presence.client?.ready),
  status: presence.status,
  error: String(presence.client?.lastError || ''),
  clientId: discordClientId(),
});
const pushPresenceState = () => {
  if (win && !win.isDestroyed()) win.webContents.send('koma:presence:status', presenceState());
};

function startPresence() {
  const clientId = discordClientId();
  if (!clientId) { presence.status = 'not-configured'; pushPresenceState(); return; }
  presence.client?.close();
  const client = new DiscordRpc({ clientId });
  presence.client = client;
  presence.status = 'connecting';
  client.on('ready', () => { presence.status = 'connected'; pushPresenceState(); });
  client.on('disconnected', () => { presence.status = 'connecting'; pushPresenceState(); });
  client.on('error', err => { presence.status = 'error'; try { fs.appendFileSync(path.join(LOGS, 'presence.log'), `[${new Date().toISOString()}] ${err}\n`); } catch { /* logs are best-effort */ } pushPresenceState(); });
  client.connect();
  if (presence.activity) client.setActivity(presence.activity);
  pushPresenceState();
}

function stopPresence() {
  presence.client?.close();
  presence.client = null;
  presence.status = 'off';
  pushPresenceState();
}

ipcMain.handle('koma:presence:state', () => presenceState());
ipcMain.on('koma:presence:activity', (_e, activity) => {
  const built = activity ? buildActivity({ ...activity, buttons: DEFAULT_BUTTONS }) : null;
  presence.activity = built;
  presence.client?.setActivity(built);
});
ipcMain.on('koma:presence:clear', () => { presence.activity = null; presence.client?.setActivity(null); });

/* ---------- update checks (GitHub releases) ---------- */
const UPDATE_REPO = 'Braedennn/Koma-Stream';
const UPDATES = path.join(app.getPath('userData'), 'update');
const SETUP = path.join(UPDATES, 'Koma-Setup.exe');
const SETUP_META = path.join(UPDATES, 'meta.json');
let updateShown = false; // this session has already surfaced this release
let update = null;       // what the card offers: { version, htmlUrl, downloadUrl, notes, ready }

const updateLog = msg => { try { fs.appendFileSync(path.join(LOGS, 'updater.log'), `[${new Date().toISOString()}] ${msg}\n`); } catch { /* best-effort */ } };

/* The newest release we've seen, and when we saw it. The footer's version line asks
 * for it; the update check fills the same cache, so GitHub is hit once, not twice. */
let latestVersion = null;
let latestCheckedAt = 0;
let latestFetch = null;

async function fetchLatestRelease() {
  const r = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Koma-Desktop' },
    signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/** The newest published version, fetched at most once every 10 minutes. */
function latestRelease() {
  if (latestVersion && Date.now() - latestCheckedAt < 10 * 60e3) return Promise.resolve(latestVersion);
  if (!latestFetch) {
    latestFetch = fetchLatestRelease()
      .then(rel => {
        const v = String(rel.tag_name || '').replace(/^v/, '');
        if (v) { latestVersion = v; latestCheckedAt = Date.now(); }
        return latestVersion;
      })
      .catch(err => { updateLog(`latest check failed: ${err.message}`); return latestVersion; })
      .finally(() => { latestFetch = null; });
  }
  return latestFetch;
}

// The card and notes-modal styles, kept here so the injected script stays readable.
const CARD_CSS = '#koma-update{position:fixed;right:22px;bottom:22px;z-index:95;display:flex;gap:13px;align-items:center;padding:16px 18px;border-radius:14px;'
  + 'background:rgba(13,14,22,.86);border:1px solid rgba(255,255,255,.12);box-shadow:0 24px 60px -16px rgba(0,0,0,.9);'
  + '-webkit-backdrop-filter:blur(22px) saturate(1.5);backdrop-filter:blur(22px) saturate(1.5);font:600 14px/1.5 Inter,system-ui,sans-serif;color:#F4F5FA;'
  + 'max-width:360px;opacity:0;transform:translateY(16px);transition:opacity .3s,transform .35s cubic-bezier(.34,1.4,.5,1)}'
  + '#koma-update.in{opacity:1;transform:none}'
  + '#koma-update [hidden]{display:none!important}'
  + '#koma-update .ku-logo{flex:none;width:34px;height:34px;border-radius:10px;background:linear-gradient(135deg,#7C5CFF,#B249F8 55%,#FF4ECD);display:grid;place-items:center;box-shadow:0 6px 18px -6px rgba(124,92,255,.5)}'
  + '#koma-update .ku-logo svg{width:15px;height:15px;margin-left:1px}'
  + '#koma-update b{display:block;font-size:14.5px;font-weight:800}'
  + '#koma-update span{display:block;color:#A9AEC2;font-size:12.5px}'
  + '#koma-update .ku-actions{display:flex;align-items:center;gap:9px;margin-top:9px}'
  + '#koma-update .ku-now{display:inline-flex;align-items:center;height:30px;padding:0 14px;border-radius:999px;border:0;cursor:pointer;'
  + 'background:linear-gradient(135deg,#7C5CFF,#B249F8 55%,#FF4ECD);color:#fff;font:700 12.5px Inter,system-ui,sans-serif;box-shadow:0 6px 16px -8px rgba(124,92,255,.55)}'
  + '#koma-update .ku-now:hover{filter:brightness(1.1)}'
  + '#koma-update .ku-now:disabled{opacity:.6;cursor:default;filter:none}'
  + '#koma-update a.ku-go{display:inline-flex;align-items:center;height:30px;padding:0 14px;border-radius:999px;text-decoration:none;'
  + 'background:linear-gradient(135deg,#7C5CFF,#B249F8 55%,#FF4ECD);color:#fff;font-size:12.5px;font-weight:700;box-shadow:0 6px 16px -8px rgba(124,92,255,.55)}'
  + '#koma-update a.ku-go:hover{filter:brightness(1.1)}'
  + '#koma-update a.ku-notes{color:#A78BFF;font-size:12.5px;font-weight:700;text-decoration:none;cursor:pointer}'
  + '#koma-update a.ku-notes:hover{color:#fff}'
  + '#koma-update .ku-later{margin-left:auto;border:0;background:none;color:#6E7488;font:700 12.5px Inter,system-ui,sans-serif;cursor:pointer;padding:6px 8px;border-radius:8px}'
  + '#koma-update .ku-later:hover{color:#fff;background:rgba(255,255,255,.08)}'
  + '#koma-notes{position:fixed;inset:0;z-index:200;display:grid;place-items:center;font:600 14px/1.6 Inter,system-ui,sans-serif;color:#F4F5FA;opacity:0;transition:opacity .25s}'
  + '#koma-notes.in{opacity:1}'
  + '#koma-notes .kn-scrim{position:absolute;inset:0;background:rgba(4,4,8,.72);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}'
  + '#koma-notes .kn-panel{position:relative;width:min(560px,calc(100vw - 48px));max-height:min(78vh,720px);display:flex;flex-direction:column;'
  + 'background:#10111B;border:1px solid rgba(255,255,255,.12);border-radius:20px;box-shadow:0 32px 80px -20px rgba(0,0,0,.95);overflow:hidden;'
  + 'transform:translateY(14px) scale(.985);transition:transform .3s cubic-bezier(.34,1.4,.5,1)}'
  + '#koma-notes.in .kn-panel{transform:none}'
  + '#koma-notes header{display:flex;align-items:center;gap:10px;padding:15px 20px;border-bottom:1px solid rgba(255,255,255,.08)}'
  + '#koma-notes header b{font-family:Sora,Inter,system-ui,sans-serif;font-size:16px;font-weight:800;flex:1}'
  + '#koma-notes header button{border:0;background:none;color:#6E7488;font-size:22px;line-height:1;cursor:pointer;padding:2px 8px;border-radius:8px}'
  + '#koma-notes header button:hover{color:#fff;background:rgba(255,255,255,.08)}'
  + '#koma-notes .kn-body{padding:8px 20px 18px;overflow-y:auto;font-size:13.5px;color:#C9CDDC}'
  + '#koma-notes .kn-body p{margin:10px 0}'
  + '#koma-notes .kn-body b{color:#F4F5FA}'
  + '#koma-notes .kn-body i{color:#A9AEC2}'
  + '#koma-notes .kn-body h4{margin:16px 0 2px;font-size:11.5px;font-weight:800;letter-spacing:.07em;color:#A78BFF;text-transform:uppercase}'
  + '#koma-notes .kn-body ul{margin:10px 0;padding-left:18px}'
  + '#koma-notes .kn-body li{margin:5px 0}'
  + '#koma-notes .kn-body li::marker{color:#A78BFF}'
  + '#koma-notes .kn-body code{background:rgba(124,92,255,.14);border:1px solid rgba(124,92,255,.25);border-radius:5px;padding:1px 5px;font:600 12px Consolas,monospace;color:#CDBEFF}'
  + '#koma-notes .kn-body a{color:#A78BFF}';

/** A release body (GitHub-flavored markdown) rendered to HTML. Everything is escaped
 *  first, so a release body can't inject markup; then a small, safe subset — headings,
 *  bullets, bold, italics, code, https links — becomes tags. */
function notesHTML(body, version) {
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const inline = s => s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\*([^*]+)\*/g, '<i>$1</i>')
    .replace(/\[([^\]]+)\]\((https:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  const lines = String(body || '').replace(/\r\n?/g, '\n').split('\n').map(l => l.trim());
  while (lines.length && !lines[0]) lines.shift();
  if (lines[0] && lines[0].includes(version) && /^Koma/i.test(lines[0])) lines.shift(); // the modal title already says it
  let html = '', list = '';
  const flush = () => { if (list) { html += `<ul>${list}</ul>`; list = ''; } };
  for (const line of lines) {
    if (/^[-*]\s+/.test(line)) { list += `<li>${inline(esc(line.replace(/^[-*]\s+/, '')))}</li>`; continue; }
    flush();
    if (!line) continue;
    const h = line.match(/^#{1,4}\s+(.*)/);
    if (h) html += `<h4>${inline(esc(h[1]))}</h4>`;
    else html += `<p>${inline(esc(line))}</p>`;
  }
  flush();
  return html;
}

/** The in-app update card. Injected once, then driven through its states from here:
 *  downloading → ready, where "Update now" is the only thing that can run the
 *  installer, or → failed, with a manual download as the way out. "Later" dismisses
 *  the card; the cached installer is offered again next launch (see the meta check).
 *  "What's new" opens the release notes in-app — no browser redirect. */
function injectUpdateCard(state) {
  if (!win || win.isDestroyed()) return;
  const url = win.webContents.getURL();
  if (!url.startsWith(URL_HOME) && !url.startsWith(PROBE)) return; // only on the app's own pages
  const ver = JSON.stringify(update.version), cur = JSON.stringify(app.getVersion());
  const dl = JSON.stringify(update.downloadUrl || update.htmlUrl || `https://github.com/${UPDATE_REPO}/releases/latest`);
  const notes = JSON.stringify(update.notes || '');
  win.webContents.executeJavaScript(`(() => {
    if (document.getElementById('koma-update')) return;
    const css = document.createElement('style');
    css.textContent = ${JSON.stringify(CARD_CSS)};
    document.head.appendChild(css);
    const card = document.createElement('div');
    card.id = 'koma-update';
    card.innerHTML =
      '<div class="ku-logo"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg></div>'
      + '<div><b>Koma ' + ${ver} + ' is out</b><span class="ku-status"></span>'
      + '<div class="ku-actions">'
      + '<button type="button" class="ku-now" hidden>Update now</button>'
      + '<a class="ku-go" href=' + ${dl} + ' hidden>Download the installer</a>'
      + (${notes} ? '<a class="ku-notes" href="#">What\\'s new</a>' : '')
      + '<button type="button" class="ku-later">Later</button></div></div>';
    document.body.appendChild(card);
    requestAnimationFrame(() => card.classList.add('in'));
    const say = txt => { const s = card.querySelector('.ku-status'); if (s) s.textContent = txt; };
    const st = ${JSON.stringify(state)};
    if (st === 'ready') { say('Koma ' + ${ver} + ' is ready to install. Run it now?'); card.querySelector('.ku-now').hidden = false; }
    else if (st === 'failed') { say('Couldn\\'t download the update — grab it manually below.'); card.querySelector('.ku-go').hidden = false; }
    else say('You have Koma ' + ${cur} + ' — getting the update…');
    card.querySelector('.ku-later').addEventListener('click', () => {
      card.classList.remove('in');
      setTimeout(() => card.remove(), 400);
    });
    card.querySelector('.ku-now').addEventListener('click', async e => {
      const b = e.currentTarget;
      if (b.disabled) return;
      b.disabled = true;
      say('Opening the installer…');
      try {
        const r = await window.koma.update.apply();
        if (!r || !r.ok) throw new Error('not applied');
      } catch {
        say('Couldn\\'t start the installer — grab it manually below.');
        card.querySelector('.ku-go').hidden = false;
        b.disabled = false;
      }
    });
    const notesBtn = card.querySelector('.ku-notes');
    if (notesBtn) notesBtn.addEventListener('click', e => {
      e.preventDefault();
      if (document.getElementById('koma-notes')) return;
      const ov = document.createElement('div');
      ov.id = 'koma-notes';
      ov.innerHTML = '<div class="kn-scrim"></div><div class="kn-panel"><header><b>What\\'s new in Koma ' + ${ver} + '</b><button type="button" aria-label="Close">×</button></header><div class="kn-body">' + ${notes} + '</div></div>';
      document.body.appendChild(ov);
      requestAnimationFrame(() => ov.classList.add('in'));
      const close = () => { ov.classList.remove('in'); setTimeout(() => ov.remove(), 250); };
      ov.querySelector('header button').addEventListener('click', close);
      ov.querySelector('.kn-scrim').addEventListener('click', close);
      document.addEventListener('keydown', function onkey(ev) { if (ev.key === 'Escape') { close(); document.removeEventListener('keydown', onkey); } });
    });
    window.__kuProgress = pct => say('Getting the update — ' + pct + '%…');
    window.__kuReady = () => { say('Koma ' + ${ver} + ' is ready to install. Run it now?'); card.querySelector('.ku-now').hidden = false; };
    window.__kuFailed = () => { say('Couldn\\'t download the update — grab it manually below.'); card.querySelector('.ku-go').hidden = false; };
    return 'rendered';
  })()`).then(() => updateLog('update card rendered'))
    .catch(err => updateLog(`update card failed: ${err.message}`));
}

function cardProgress(pct) {
  if (!win || win.isDestroyed()) return;
  win.webContents.executeJavaScript(`window.__kuProgress && window.__kuProgress(${Math.max(0, Math.min(100, Math.round(pct)))});`).catch(() => {});
}

async function checkForUpdates() {
  if (!BUNDLED || updateShown) return;
  try {
    const rel = await fetchLatestRelease();
    const remote = String(rel.tag_name || '').replace(/^v/, '');
    latestVersion = remote || latestVersion;
    latestCheckedAt = Date.now();
    const asset = (rel.assets || []).find(x => x.name === 'Koma-Setup.exe');
    if (!(remote && asset && newerVersion(remote, app.getVersion()))) { updateLog(`up to date (v${app.getVersion()})`); return; }
    updateShown = true;
    update = { version: remote, htmlUrl: rel.html_url, downloadUrl: asset.browser_download_url, notes: notesHTML(rel.body, remote) };
    updateLog(`update available: v${remote} (running v${app.getVersion()})`);

    // An installer already fetched for exactly this release — a "Later" from a previous
    // session — goes straight to the ask instead of downloading again.
    try {
      const meta = JSON.parse(fs.readFileSync(SETUP_META, 'utf8'));
      if (meta.version === remote && fs.statSync(SETUP).size === meta.size) {
        update.ready = true;
        updateLog('cached installer matches the release — asking, not downloading');
        injectUpdateCard('ready');
        return;
      }
    } catch { /* no usable cache: download fresh */ }

    sweep(UPDATES); // stale installers and partials; only runs when about to replace them
    try { fs.unlinkSync(SETUP_META); } catch { /* fine */ }
    injectUpdateCard('downloading');
    const exe = await download(asset.browser_download_url, { dir: UPDATES, log: updateLog, onPct: cardProgress });
    fs.writeFileSync(SETUP_META, JSON.stringify({ version: remote, size: fs.statSync(exe).size }));
    update.ready = true;
    updateLog(`downloaded ${exe}`);
    if (win && !win.isDestroyed()) win.webContents.executeJavaScript('window.__kuReady && window.__kuReady()').catch(() => {});
  } catch (err) {
    updateLog(`update error: ${err.message}`);
    if (update && !update.ready && win && !win.isDestroyed()) {
      win.webContents.executeJavaScript('window.__kuFailed && window.__kuFailed()').catch(() => {});
    }
  }
}

/** The one destructive step — running the installer — happens only here, and only
 *  because the user clicked "Update now" in the card. */
ipcMain.handle('koma:update:apply', () => {
  try { fs.statSync(SETUP); } catch { return { ok: false }; }
  updateLog('consent given — opening the installer');
  try {
    // The installer overwrites the very files this app is running from, so Koma
    // leaves the stage the moment it hands over: servers stopped, window closed,
    // process gone. A Koma still holding those files is what makes an update
    // crash halfway through the copy.
    install(SETUP, { log: updateLog, quitAfter: () => { updateLog('closing Koma for the installer'); stopServers(); app.quit(); } });
    return { ok: true };
  } catch (err) {
    updateLog(`could not open the installer: ${err.message}`);
    return { ok: false };
  }
});

/** What the footer's version line asks for: the running build, the newest release,
 *  and whether this build is behind it. */
ipcMain.handle('koma:version', async () => {
  const current = app.getVersion();
  const latest = await latestRelease();
  return { current, latest, outdated: latest ? newerVersion(latest, current) : null };
});

/** "Update" in the footer: bring the update card back even if it was dismissed. */
ipcMain.handle('koma:update:check', async () => {
  updateShown = false;
  await checkForUpdates();
  return { shown: updateShown };
});

/* ---------- app lifecycle ---------- */
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required'); // the next episode can start by itself
  if (IS_WIN) app.setAppUserModelId('Koma');
  Menu.setApplicationMenu(null);

  app.whenReady().then(async () => {
    createWindow();
    if (readSettings().discordRp !== false) startPresence();
    await win.loadFile(path.join(__dirname, 'splash.html'));
    if (!fs.existsSync(path.join(HOME, 'server.js'))) {
      status(`Can't find the Koma site in ${HOME}. Rebuild the app with build-app.bat from the WebsiteAnime\\desktop folder.`);
      return;
    }
    await startServers(status);
    status('Almost ready…');
    if (await waitForKoma()) win.loadURL(URL_HOME);
    else status(`Koma didn't start. Check ${path.join(LOGS, 'koma.log')}`);
    if (BUNDLED) { // packaged builds look for a newer GitHub release; dev runs skip this
      fs.mkdirSync(LOGS, { recursive: true });
      setTimeout(checkForUpdates, 9000); // let the page settle before the card slides in
      setInterval(checkForUpdates, 6 * 3600e3); // and re-check every 6 hours of a long session
    }
  });

  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', () => { presence.client?.close(); stopServers(); });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopServers(); process.exit(0); });
}
