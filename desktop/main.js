// Koma desktop app: starts Koma and both streaming servers in the background,
// shows the site in its own window, and stops what it started when you quit.
// Servers that are already running (start.bat, start-servers.ps1) are reused, not restarted.
const { app, BrowserWindow, shell, Menu, ipcMain, Notification } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { DiscordRpc, buildActivity } = require('./discord-rpc');
const { newerVersion, apply: applyAsset } = require('./updater');

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
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
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
let updateShown = false;

/** A small in-app card — never a native dialog. It never asks for a click to apply:
 *  updates download and open the installer on their own; the card just says so and
 *  breaks the only way out of a blocked download (a manual link) if that happens. */
function injectUpdateCard(remote, releaseUrl, downloadUrl, failure) {
  if (!win || win.isDestroyed()) return;
  const url = win.webContents.getURL();
  if (!url.startsWith(URL_HOME) && !url.startsWith(PROBE)) return; // only on the app's own pages
  const ver = JSON.stringify(remote), cur = JSON.stringify(app.getVersion());
  const rn = JSON.stringify(releaseUrl), dl = JSON.stringify(downloadUrl || releaseUrl), fail = JSON.stringify(failure || '');
  win.webContents.executeJavaScript(`(() => {
    if (document.getElementById('koma-update')) return;
    const css = document.createElement('style');
    css.textContent = '#koma-update{position:fixed;right:22px;bottom:22px;z-index:95;display:flex;gap:13px;align-items:center;padding:16px 18px;border-radius:14px;'
      + 'background:rgba(13,14,22,.86);border:1px solid rgba(255,255,255,.12);box-shadow:0 24px 60px -16px rgba(0,0,0,.9);'
      + '-webkit-backdrop-filter:blur(22px) saturate(1.5);backdrop-filter:blur(22px) saturate(1.5);font:600 14px/1.5 Inter,system-ui,sans-serif;color:#F4F5FA;'
      + 'max-width:340px;opacity:0;transform:translateY(16px);transition:opacity .3s,transform .35s cubic-bezier(.34,1.4,.5,1)}'
      + '#koma-update.in{opacity:1;transform:none}'
      + '#koma-update .ku-logo{flex:none;width:34px;height:34px;border-radius:10px;background:linear-gradient(135deg,#7C5CFF,#B249F8 55%,#FF4ECD);display:grid;place-items:center;box-shadow:0 6px 18px -6px rgba(124,92,255,.5)}'
      + '#koma-update .ku-logo svg{width:15px;height:15px;margin-left:1px}'
      + '#koma-update b{display:block;font-size:14.5px;font-weight:800}'
      + '#koma-update span{display:block;color:#A9AEC2;font-size:12.5px}'
      + '#koma-update .ku-actions{display:flex;gap:7px;margin-top:9px}'
      + '#koma-update a.ku-go{display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 14px;border-radius:999px;text-decoration:none;'
      + 'background:linear-gradient(135deg,#7C5CFF,#B249F8 55%,#FF4ECD);color:#fff;font-size:12.5px;font-weight:700;box-shadow:0 6px 16px -8px rgba(124,92,255,.55)}'
      + '#koma-update a.ku-go:hover{filter:brightness(1.1)}'
      + '#koma-update a.ku-notes{color:#A78BFF;font-size:12.5px;font-weight:700;text-decoration:none;align-self:center}'
      + '#koma-update a.ku-notes:hover{color:#fff}'
      + '#koma-update button{margin-left:auto;border:0;background:none;color:#6E7488;font-size:12.5px;font-weight:700;cursor:pointer;align-self:center;padding:6px 8px;border-radius:8px}'
      + '#koma-update button:hover{color:#fff;background:rgba(255,255,255,.08)}';
    document.head.appendChild(css);
    const card = document.createElement('div');
    card.id = 'koma-update';${'' /* auto mode: say what's happening and help exactly when the auto path failed */}
    card.innerHTML = ${'' }
      '<div class="ku-logo"><svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg></div>'
      + '<div><b>' + 'Koma ' + ${ver} + ' is out' + '</b>'
      + '<span class="ku-status">' + (${fail} ? 'Couldn\\''t update automatically: ' + ${fail} : ${'You'} + ' have Koma ' + ${cur} + ' — updating automatically, nothing to click.') + '</span>'
      + '<div class="ku-actions">'
      + (${fail} ? '<a class="ku-go" href=' + ${dl} + '>Download the installer</a>' : '')
      + '<a class="ku-notes" href=' + ${rn} + '>What changed</a>'
      + '<button type="button">Later</button></div></div>';
    document.body.appendChild(card);
    requestAnimationFrame(() => card.classList.add('in'));
    card.querySelector('button').addEventListener('click', () => { card.classList.remove('in'); setTimeout(() => card.remove(), 400); });
    window.__kuProgress = pct => {
      const s = document.querySelector('#koma-update .ku-status');
      if (s) s.textContent = 'Updating automatically — downloading ' + pct + '%…';
    };
    return 'rendered';
  })()`).then(() => { try { fs.appendFileSync(path.join(LOGS, 'updater.log'), `[${new Date().toISOString()}] update card rendered (auto)\n`); } catch { /* best-effort */ } })
    .catch(err => { try { fs.appendFileSync(path.join(LOGS, 'updater.log'), `[${new Date().toISOString()}] update card failed: ${err.message}\n`); } catch { /* best-effort */ } });
}

function cardProgress(pct) {
  if (!win || win.isDestroyed()) return;
  win.webContents.executeJavaScript(`window.__kuProgress && window.__kuProgress(${Math.max(0, Math.min(100, Math.round(pct)))});`).catch(() => {});
}

async function checkForUpdates() {
  if (!BUNDLED || updateShown) return;
  try {
    const r = await fetch(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Koma-Desktop' },
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) { fs.appendFileSync(path.join(LOGS, 'updater.log'), `[${new Date().toISOString()}] check failed: HTTP ${r.status}\n`); return; }
    const rel = await r.json();
    const remote = String(rel.tag_name || '').replace(/^v/, '');
    const asset = (rel.assets || []).find(x => x.name === 'Koma-Setup.exe');
    if (remote && asset && newerVersion(remote, app.getVersion())) {
      updateShown = true;
      fs.appendFileSync(path.join(LOGS, 'updater.log'), `[${new Date().toISOString()}] auto-update: v${remote} (running v${app.getVersion()})\n`);
      injectUpdateCard(remote, rel.html_url);
      applyAsset({
        url: asset.browser_download_url,
        dir: UPDATES,
        log: msg => { try { fs.appendFileSync(path.join(LOGS, 'updater.log'), `[${new Date().toISOString()}] ${msg}\n`); } catch { /* best-effort */ } },
        onPct: cardProgress,
        quitAfter: () => app.quit(), // the installer takes over; its NSIS script restarts Koma on finish
      }).then(exe => {
        try { fs.appendFileSync(path.join(LOGS, 'updater.log'), `[${new Date().toISOString()}] installer opened at ${exe}\n`); } catch { /* best-effort */ }
      }).catch(err => {
        fs.appendFileSync(path.join(LOGS, 'updater.log'), `[${new Date().toISOString()}] auto-update error: ${err.message}\n`);
        injectUpdateCard(remote, rel.html_url, asset.browser_download_url, err.message); // the manual way, only when automation failed
      });
    } else {
      fs.appendFileSync(path.join(LOGS, 'updater.log'), `[${new Date().toISOString()}] up to date (v${app.getVersion()})\n`);
    }
  } catch (err) {
    try { fs.appendFileSync(path.join(LOGS, 'updater.log'), `[${new Date().toISOString()}] check error: ${err.message}\n`); } catch { /* logs are best-effort */ }
  }
}

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
