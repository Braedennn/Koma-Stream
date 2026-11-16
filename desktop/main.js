// Koma desktop app: starts Koma and both streaming servers in the background,
// shows the site in its own window, and stops what it started when you quit.
// Servers that are already running (start.bat, start-servers.ps1) are reused, not restarted.
const { app, BrowserWindow, shell, Menu, ipcMain, Notification, Tray, dialog } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { DiscordRpc, buildActivity } = require('./discord-rpc');
const { newerVersion, sweep, download, install, fromApp, silentRelaunch } = require('./updater');
const { diagnose, identify, identifyKoma } = require('./diagnose');

const PORT = 4000;
// The streaming server's port. It is 3000 unless something else already sits
// there, in which case it moves (the site is told where it went).
let streamPort = 3000;
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

/** The first free port from here on. */
async function freePort(from) {
  for (let p = from; p < from + 20; p++) if (!(await portOpen(p))) return p;
  return from;
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
    // AniVault (streaming). It wants port 3000 — but a program already sitting
    // there would answer 404 for everything, and the app would look broken
    // with no reason on screen. So the port is checked first: our own server
    // is reused, a stranger's port is stepped over.
    let stream = 3000;
    let streamOurs = false;
    if (await portOpen(stream)) {
      const mine = await identify(`http://127.0.0.1:${stream}/api/ping`, 'anivault', { 'x-anivault-api-key': anivaultKey() }, { status: 403, contains: 'Forbidden' });
      if (mine.ours) streamOurs = true;
      else {
        stream = await freePort(3001);
        status('Port 3000 was busy — the streaming server takes another port…');
      }
    }
    streamPort = stream;
    if (!streamOurs) {
      status('Starting the streaming server…');
      // The streaming server remembers which site entry holds which show on
      // disk, so a restart costs a file read instead of a search: the first
      // show of a session opens in a second, not in ten.
      const dataDir = app.getPath('userData');
      const env = { KOMA_DATA_DIR: dataDir, PORT: String(stream) };
      if (BUNDLED) {
        // The compiled server runs on Electron's own Node — silent, no system Node or npm.
        // It listens on the loopback only: the streaming API is private to this
        // machine, and a server on every interface makes Windows ask for
        // firewall permission for nothing.
        launch('AniVault', process.execPath, [path.join(ANIVAULT, 'dist', 'server.js')],
          { cwd: ANIVAULT, env: { ...env, ELECTRON_RUN_AS_NODE: '1', HOST: '127.0.0.1' }, log: path.join(LOGS, 'anivault.log') });
      } else {
        // npm is a .cmd on Windows, which Node only runs through a shell
        launch('AniVault', IS_WIN ? (process.env.ComSpec || 'cmd.exe') : 'npm', IS_WIN ? ['/d', '/s', '/c', 'npm run dev'] : ['run', 'dev'],
          { cwd: ANIVAULT, env: { ...env, HOST: '127.0.0.1' }, log: path.join(LOGS, 'anivault.log') });
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
    //
    // This port cannot move: the page's own storage and the AniList sign-in
    // both live on this exact address, so a program already holding it is
    // reported instead of quietly serving somebody else's site.
    if (!(await portOpen(PORT))) {
      status('Starting Koma…');
      launch('Koma', process.execPath, [path.join(HOME, 'server.js')],
        { cwd: HOME, env: { ELECTRON_RUN_AS_NODE: '1', PORT: String(PORT), HOST: '127.0.0.1', QUIET: '1', KOMA_ANIVAULT_KEY: anivaultKey(), KOMA_ANIVAULT_URL: `http://127.0.0.1:${streamPort}`, KOMA_VERSION: app.getVersion() }, log: path.join(LOGS, 'koma.log') });
      return { taken: false };
    }
    const mine = await identifyKoma(PORT);
    return { taken: !mine.ours };
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
    title: 'Koma', backgroundColor: '#000000', show: false,
    // No Windows title bar: the minimise/maximise/close buttons are drawn by
    // the page, in the site's own header, so they look like the rest of the
    // app instead of like Windows.
    titleBarStyle: 'hidden',
    icon: path.join(__dirname, 'build', IS_WIN ? 'icon.ico' : 'png/256.png'),
    webPreferences: { contextIsolation: true, sandbox: true, preload: path.join(__dirname, 'preload.js') },
  });
  if (s.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.on('maximize', sendWindowState);
  win.on('unmaximize', sendWindowState);
  win.on('restore', sendWindowState);
  // The event can be swallowed; the size never lies.
  win.on('resize', () => { if (win && !win.isDestroyed() && win.isMaximized() !== lastMax) sendWindowState(); });

  const save = () => {
    if (win.isDestroyed()) return;
    try { fs.writeFileSync(STATE(), JSON.stringify({ ...(win.isMaximized() ? readState() : win.getNormalBounds()), maximized: win.isMaximized() })); } catch { /* not important */ }
  };
  win.on('close', e => {
    save();
    // The X (or the page's own close button) puts Koma in the tray instead of
    // killing it — playback keeps going, and the tray icon brings it back.
    // A quit that means it: a Quit menu item, or an update taking over the exe.
    if (stayInTray && !quitting) {
      e.preventDefault();
      win.hide();
      if (!trayNoticeShown) {
        trayNoticeShown = true;
        try { new Notification({ title: 'Koma is still here', body: 'It keeps playing from the tray. Use the tray icon to bring it back or quit.' }).show(); } catch { /* best effort */ }
      }
      try { fs.appendFileSync(path.join(LOGS, 'koma.log'), `[${new Date().toISOString()}] hid to tray\n`); } catch { /* best effort */ }
    }
  });

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
      .top { background: var(--bg) !important; border-bottom-color: var(--line) !important; -webkit-app-region: drag; }
      .top a, .top button, .top input, .top label, .top .suggest, .top .acct-menu { -webkit-app-region: no-drag; }`).catch(() => {});
    // The card lives in the page, so a navigation takes it with it. Put it back
    // when there is still an update waiting — unless the user said "not now".
    if (update?.ready && !autoDeferred) injectUpdateCard('ready');
    lastGoodLoad = Date.now();
  });

  /* A crashed renderer is not a white screen: bring the site back on its own.
     The guard keeps a crash loop (a build that dies the moment it loads) from
     spinning forever — five seconds between attempts, and a crash that comes
     right after a load reads as poisoning rather than a fluke. */
  let lastGoodLoad = Date.now();
  win.webContents.on('render-process-gone', (_e, details) => {
    try { fs.appendFileSync(path.join(LOGS, 'koma.log'), `[${new Date().toISOString()}] renderer gone: ${details.reason}\n`); } catch { /* best effort */ }
    if (details.reason === 'clean-exit') return;
    if (Date.now() - lastGoodLoad < 5000) { status('The site crashed and it did not look like an accident.'); return; }
    lastGoodLoad = Date.now();
    win.webContents.reload();
  });
  win.webContents.on('unresponsive', () => { try { fs.appendFileSync(path.join(LOGS, 'koma.log'), `[${new Date().toISOString()}] renderer unresponsive\n`); } catch { /* best effort */ } });

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

/* ---------- the window buttons ---------- */
/* The page draws its own minimise/maximise/close buttons, in the site's header,
   so they look like the rest of the app. The shell just does what it is told
   and keeps the page posted about the window's state. */
const sendWindowState = () => {
  if (!win || win.isDestroyed()) return;
  lastMax = win.isMaximized();
  try { win.webContents.send('koma:win:changed', { maximized: lastMax, visible: win.isVisible() && !win.isMinimized() }); } catch { /* page is gone */ }
};
// The last state the page was told about. Windows can swallow the maximise
// event - a window that has just been restored does not always report it -
// and the page would keep the old glyph, so the size is watched as well.
let lastMax = null;

/* ---------- closing into the tray ---------- */
/* The X hides the window and keeps playback going in the background; the tray
   icon brings it back or quits for real. The same close that an update or a
   Quit menu item asks for is a real close — `quitting` is the switch. */
let tray = null;
let quitting = false;      // a real quit is under way (Quit in the menu, or an update)
let stayInTray = true;     // the page's preference; it reports its own on load and on change
let trayNoticeShown = false;

const showKoma = () => {
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
};

function createTray() {
  if (!IS_WIN || tray) return;
  try {
    tray = new Tray(path.join(__dirname, 'build', 'icon.ico'));
    tray.setToolTip('Koma');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Show Koma', click: showKoma },
      { type: 'separator' },
      { label: 'Quit Koma', click: () => { quitting = true; app.quit(); } },
    ]));
    tray.on('click', showKoma); // left click brings the window back
  } catch (err) {
    try { fs.appendFileSync(path.join(LOGS, 'koma.log'), `[${new Date().toISOString()}] tray: ${err.message}\n`); } catch { /* best effort */ }
  }
}

ipcMain.on('koma:tray', (_e, on) => { stayInTray = on !== false; });

/* ---------- the site's data, backed up to a file of the user's choosing ---------- */
/* The page keeps watch progress, lists and preferences in its own storage; it
   serialises them and hands the payload over. The shell only does the part the
   sandbox cannot: the native file dialogs and the file itself. */
ipcMain.handle('koma:data:save', async (_e, payload) => {
  try {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      title: 'Where should the Koma backup go?',
      defaultPath: `koma-backup-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePath) return { ok: false, reason: 'canceled' };
    fs.writeFileSync(filePath, typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2));
    return { ok: true, filePath };
  } catch (err) {
    try { fs.appendFileSync(path.join(LOGS, 'koma.log'), `[${new Date().toISOString()}] backup save: ${err.message}\n`); } catch { /* best effort */ }
    return { ok: false, reason: err.message };
  }
});

ipcMain.handle('koma:data:read', async () => {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog(win, {
      title: 'Choose a Koma backup to restore',
      properties: ['openFile'],
      filters: [{ name: 'JSON', extensions: ['json'] }],
    });
    if (canceled || !filePaths?.length) return { ok: false, reason: 'canceled' };
    return { ok: true, data: JSON.parse(fs.readFileSync(filePaths[0], 'utf8')) };
  } catch (err) {
    try { fs.appendFileSync(path.join(LOGS, 'koma.log'), `[${new Date().toISOString()}] backup read: ${err.message}\n`); } catch { /* best effort */ }
    return { ok: false, reason: err.message };
  }
});

ipcMain.on('koma:win:min', () => { if (win && !win.isDestroyed()) win.minimize(); });
ipcMain.on('koma:win:max', () => {
  if (!win || win.isDestroyed()) return;
  win.isMaximized() ? win.unmaximize() : win.maximize();
  // The change is told to the page again a moment later: Windows does not
  // always report it, and the button's glyph has to follow.
  setTimeout(sendWindowState, 220);
});
ipcMain.on('koma:win:close', () => { if (win && !win.isDestroyed()) win.close(); });
ipcMain.handle('koma:win:state', () => ({
  maximized: !!(win && !win.isDestroyed() && win.isMaximized()),
  visible: !!(win && !win.isDestroyed() && win.isVisible()),
}));

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
const PENDING = path.join(UPDATES, 'pending.json'); // what we were trying to install
const DEFERRED = path.join(UPDATES, 'deferred.json'); // "not now" — and when it was said
let updateShown = false; // this session has already surfaced this release
let update = null;       // what the card offers: { version, htmlUrl, downloadUrl, notes, ready }
let autoTimer = null;    // the pending "install it myself" run
let autoDeferred = false; // the user said "not now" — leave it alone
let autoAttempts = 0;    // how many self-installs did not take

/* How often the running app looks for a new release. A release that drops while
 * Koma is open has to be picked up in minutes, not at the next restart — that is
 * the whole difference between an app that updates itself and one that does not. */
const UPDATE_POLL = 10 * 60e3;
const CHECK_MIN = 60e3;        // no two checks closer together than this
const AUTO_GRACE = 25e3;        // how long the card sits before the app installs by itself
const AUTO_RETRY = 20e3;        // how often it looks again once it is waiting
const DEFER_MS = 6 * 3600e3;    // how long "not now" means not now

const updateLog = msg => { try { fs.appendFileSync(path.join(LOGS, 'updater.log'), `[${new Date().toISOString()}] ${msg}\n`); } catch { /* best-effort */ } };

/* The newest release we've seen, and when we saw it. The footer's version line asks
 * for it; the update check fills the same cache, so GitHub is hit once, not twice. */
let latest = null;
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

/** The newest published release, for the footer's version line. Cached for ten
 *  minutes so a page reload does not ask GitHub every time. The update check
 *  below does NOT use this cache — it always asks GitHub, so a release that
 *  drops while Koma is open is never hidden behind a stale answer. */
function latestRelease() {
  if (latest && Date.now() - latestCheckedAt < 10 * 60e3) return Promise.resolve(latest);
  if (!latestFetch) {
    latestFetch = fetchLatestRelease()
      .then(rel => {
        const v = String(rel?.tag_name || '').replace(/^v/, '');
        if (v) { latest = rel; latestCheckedAt = Date.now(); }
        return latest;
      })
      .catch(err => { updateLog(`latest check failed: ${err.message}`); return latest; })
      .finally(() => { latestFetch = null; });
  }
  return latestFetch;
}

// The card and notes-modal styles, kept here so the injected script stays readable.
// Everything is written with the page's own tokens -- --bg, --text, --line, --r
// and the rest -- so the card is the same object as the rest of the app and it
// follows the theme without being told to.
const CARD_CSS = `
#koma-update{position:fixed;right:20px;bottom:20px;z-index:95;width:min(360px,calc(100vw - 40px));
display:grid;grid-template-columns:auto minmax(0,1fr);gap:14px;padding:16px;
background:var(--bg-1);border:1px solid var(--line-2);border-radius:var(--r-xl);box-shadow:var(--shadow-3);
color:var(--text);font:500 14px/1.5 var(--font);
opacity:0;transform:translateY(18px);transition:opacity .34s var(--ease-out),transform .46s var(--ease-out)}
#koma-update.in{opacity:1;transform:none}
#koma-update [hidden]{display:none!important}
#koma-update .ku-logo{width:36px;height:36px;border-radius:var(--r);background:var(--primary);color:var(--primary-fg);
display:grid;place-items:center;transition:box-shadow .4s var(--ease-soft),background .3s var(--ease-soft)}
#koma-update .ku-logo .i{width:14px;height:14px}
#koma-update[data-state="ready"] .ku-logo{box-shadow:0 0 0 3px var(--accent-soft),0 10px 24px -12px color-mix(in srgb,var(--one) 70%,transparent)}
#koma-update[data-state="failed"] .ku-logo{background:var(--live);color:#fff;box-shadow:0 10px 24px -12px color-mix(in srgb,var(--live) 65%,transparent)}
#koma-update b{display:block;font-size:14.5px;font-weight:700;letter-spacing:-.01em;color:var(--text)}
#koma-update .ku-status{display:block;margin-top:3px;color:var(--text-2);font-size:12.5px;line-height:1.45}
#koma-update .ku-bar{grid-column:1/-1;height:3px;border-radius:999px;background:var(--bg-3);overflow:hidden}
#koma-update .ku-bar i{display:block;height:100%;width:0;border-radius:999px;background:var(--primary);
box-shadow:0 0 12px -3px color-mix(in srgb,var(--one) 80%,transparent);transition:width .4s var(--ease-out)}
#koma-update .ku-actions{grid-column:1/-1;display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:3px}
#koma-update .ku-actions .btn{font-weight:600}
#koma-update a.ku-notes{color:var(--text-2);font-size:13px;font-weight:600;text-decoration:none;cursor:pointer;
padding:7px 9px;border-radius:var(--r-sm);transition:color .2s var(--ease-soft),background .2s var(--ease-soft)}
#koma-update a.ku-notes:hover{color:var(--text);background:var(--accent-soft)}
#koma-update .ku-later{margin-left:auto;border:0;background:none;color:var(--text-3);font:600 13px var(--font);cursor:pointer;
padding:7px 9px;border-radius:var(--r-sm);transition:color .2s var(--ease-soft),background .2s var(--ease-soft)}
#koma-update .ku-later:hover{color:var(--text);background:var(--accent-soft)}
body.koma-has-update #toast{bottom:var(--ku-lift,20px);transition:bottom .34s var(--ease-out)}
#koma-notes{position:fixed;inset:0;z-index:450;display:grid;place-items:center;padding:24px;
font:500 14px/1.65 var(--font);color:var(--text);opacity:0;transition:opacity .3s var(--ease-soft)}
#koma-notes.in{opacity:1}
#koma-notes .kn-scrim{position:absolute;inset:0;background:rgba(0,0,0,.55);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px)}
#koma-notes .kn-panel{position:relative;width:min(560px,calc(100vw - 40px));max-height:min(78vh,720px);display:flex;flex-direction:column;
background:var(--bg);border:1px solid var(--line-2);border-radius:var(--r-lg);box-shadow:var(--shadow-3);overflow:hidden;
transform:translateY(14px) scale(.985);transition:transform .34s var(--ease-out)}
#koma-notes.in .kn-panel{transform:none}
#koma-notes header{display:flex;align-items:center;gap:12px;padding:16px 22px;border-bottom:1px solid var(--line);background:var(--bg)}
#koma-notes header b{font-size:16px;font-weight:700;letter-spacing:-.02em;flex:1;color:var(--text)}
#koma-notes header button{flex:none;width:30px;height:30px;display:grid;place-items:center;border:1px solid var(--line-2);
border-radius:var(--r-sm);background:var(--bg);color:var(--text-2);font-size:18px;line-height:1;cursor:pointer;
transition:color .2s var(--ease-soft),background .2s var(--ease-soft),border-color .2s var(--ease-soft)}
#koma-notes header button:hover{color:var(--text);background:var(--bg-2);border-color:var(--text-3)}
#koma-notes .kn-body{padding:16px 22px 24px;overflow-y:auto;font-size:13.5px;color:var(--text-2)}
#koma-notes .kn-body p{margin:10px 0}
#koma-notes .kn-body b{color:var(--text);font-weight:600}
#koma-notes .kn-body i{color:var(--text-2)}
#koma-notes .kn-body h4{margin:20px 0 4px;font-size:11.5px;font-weight:650;letter-spacing:.08em;text-transform:uppercase;color:var(--text-3)}
#koma-notes .kn-body ul{margin:10px 0;padding-left:20px}
#koma-notes .kn-body li{margin:6px 0}
#koma-notes .kn-body li::marker{color:var(--text-3)}
#koma-notes .kn-body code{background:var(--bg-2);border:1px solid var(--line-2);border-radius:6px;padding:1px 6px;
font:600 12px Consolas,monospace;color:var(--text)}
#koma-notes .kn-body a{color:var(--text);text-decoration:underline;text-underline-offset:3px;text-decoration-color:var(--line-2)}
#koma-notes .kn-body a:hover{text-decoration-color:var(--text-2)}`;

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
 *  downloading → ready, where "Update now" runs the installer right away, or →
 *  failed, with a manual download as the way out. "Not now" dismisses the card and
 *  stops the app from installing by itself; the cached installer is offered again
 *  next launch (see the meta check). "What's new" opens the release notes in-app —
 *  no browser redirect. */
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
    const PLAY = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M5.4 4.8v14.4a1 1 0 0 0 1.5.86l11.5-7.2a1 1 0 0 0 0-1.72L6.9 3.94A1 1 0 0 0 5.4 4.8z" fill="currentColor"/></svg>';
    const WARN = '<svg class="i" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/></svg>';
    const card = document.createElement('div');
    card.id = 'koma-update';
    card.setAttribute('role', 'status');
    card.innerHTML =
      '<div class="ku-logo">' + PLAY + '</div>'
      + '<div><b>Koma ' + ${ver} + ' is out</b><span class="ku-status" aria-live="polite"></span></div>'
      + '<div class="ku-bar" hidden><i></i></div>'
      + '<div class="ku-actions">'
      + '<button type="button" class="btn btn-primary btn-sm ku-now" hidden>Update now</button>'
      + '<a class="btn btn-ghost btn-sm ku-go" href=' + ${dl} + ' hidden>Download installer</a>'
      + (${notes} ? '<a class="ku-notes" href="#">What\\'s new</a>' : '')
      + '<button type="button" class="ku-later">Not now</button></div>';
    document.body.appendChild(card);
    document.body.classList.add('koma-has-update');
    // the toast lives in the same corner: lift it clear of the card
    const lift = () => document.body.style.setProperty('--ku-lift', (card.offsetHeight + 20) + 'px');
    requestAnimationFrame(() => { card.classList.add('in'); lift(); });
    const status = card.querySelector('.ku-status');
    const bar = card.querySelector('.ku-bar');
    const fill = card.querySelector('.ku-bar i');
    const logo = card.querySelector('.ku-logo');
    const nowBtn = card.querySelector('.ku-now');
    const goBtn = card.querySelector('.ku-go');
    const laterBtn = card.querySelector('.ku-later');
    const setState = (st, msg) => {
      card.dataset.state = st;
      logo.innerHTML = st === 'failed' ? WARN : PLAY;
      if (msg) status.textContent = msg;
      nowBtn.hidden = st !== 'ready';
      goBtn.hidden = st !== 'failed';
      laterBtn.hidden = st === 'installing';
      bar.hidden = st !== 'downloading';
      lift();
    };
    const st = ${JSON.stringify(state)};
    if (st === 'ready') setState('ready', 'Koma ' + ${ver} + ' is ready to install. Run it now?');
    else if (st === 'installing') setState('installing', 'Installing Koma ' + ${ver} + ' now…');
    else if (st === 'failed') setState('failed', 'Couldn\\'t download the update — grab it manually below.');
    else setState('downloading', 'You have Koma ' + ${cur} + ' — getting the update…');
    laterBtn.addEventListener('click', () => {
      card.classList.remove('in');
      document.body.classList.remove('koma-has-update');
      setTimeout(() => card.remove(), 400);
      // "Not now" means not now: the app stops installing it on its own.
      window.koma.update?.cancel?.();
    });
    nowBtn.addEventListener('click', async e => {
      const b = e.currentTarget;
      if (b.disabled) return;
      b.disabled = true;
      status.textContent = 'Opening the installer…';
      try {
        const r = await window.koma.update.apply();
        if (!r || !r.ok) throw new Error('not applied');
      } catch {
        status.textContent = 'Couldn\\'t start the installer — grab it manually below.';
        goBtn.hidden = false;
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
      const close = () => { ov.classList.remove('in'); setTimeout(() => ov.remove(), 300); };
      ov.querySelector('header button').addEventListener('click', close);
      ov.querySelector('.kn-scrim').addEventListener('click', close);
      document.addEventListener('keydown', function onkey(ev) { if (ev.key === 'Escape') { close(); document.removeEventListener('keydown', onkey); } });
    });
    window.__kuProgress = pct => {
      setState('downloading');
      status.textContent = 'Getting the update — ' + pct + '%…';
      fill.style.width = pct + '%';
    };
    window.__kuReady = () => setState('ready', 'Koma ' + ${ver} + ' is ready to install. Run it now?');
    window.__kuInstalling = () => setState('installing', 'Installing Koma ' + ${ver} + ' now…');
    window.__kuFailed = () => setState('failed', 'Couldn\\'t download the update — grab it manually below.');
    return 'rendered';
  })()`).then(() => updateLog('update card rendered'))
    .catch(err => updateLog(`update card failed: ${err.message}`));
}

function cardProgress(pct) {
  if (!win || win.isDestroyed()) return;
  win.webContents.executeJavaScript(`window.__kuProgress && window.__kuProgress(${Math.max(0, Math.min(100, Math.round(pct)))});`).catch(() => {});
}

/** Ask GitHub what the newest release is, and get the app ready for it. Runs on a
 *  timer while the app is open — a release that drops mid-session is found in
 *  minutes — and again whenever the window comes back to the front. */
let lastCheckAt = 0;
async function checkForUpdates({ force = false } = {}) {
  if (!BUNDLED) return;
  if (!force && Date.now() - lastCheckAt < CHECK_MIN) return;
  lastCheckAt = Date.now();
  try {
    // Always a fresh answer from GitHub here: the cached one is for the footer's
    // version line, and a release that drops while Koma is open must never be
    // hidden behind it.
    const rel = await fetchLatestRelease();
    const remote = String(rel?.tag_name || '').replace(/^v/, '');
    latest = rel; latestCheckedAt = Date.now();
    const asset = (rel?.assets || []).find(x => x.name === 'Koma-Setup.exe');
    if (!(remote && asset && newerVersion(remote, app.getVersion()))) { updateLog(`up to date (v${app.getVersion()})`); return; }

    // The same release again: the installer is already here, so go straight to
    // installing it rather than downloading a second copy.
    if (update?.version === remote) {
      if (update.ready) {
        if (!updateShown) { updateShown = true; injectUpdateCard('ready'); }
        scheduleAutoInstall();
      }
      return;
    }

    updateShown = true;
    autoDeferred = false;   // a new release is a new thing — "not now" was about the old one
    update = { version: remote, htmlUrl: rel.html_url, downloadUrl: asset.browser_download_url, notes: notesHTML(rel.body, remote) };
    updateLog(`update available: v${remote} (running v${app.getVersion()})`);

    // An installer already fetched for exactly this release — a "Not now" from a
    // previous session — goes straight to installing instead of downloading again.
    try {
      const meta = JSON.parse(fs.readFileSync(SETUP_META, 'utf8'));
      if (meta.version === remote && fs.statSync(SETUP).size === meta.size) {
        update.ready = true;
        updateLog('cached installer matches the release — ready');
        injectUpdateCard('ready');
        scheduleAutoInstall();
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
    scheduleAutoInstall();
  } catch (err) {
    updateLog(`update error: ${err.message}`);
    if (update && !update.ready && win && !win.isDestroyed()) {
      win.webContents.executeJavaScript('window.__kuFailed && window.__kuFailed()').catch(() => {});
    }
  }
}

/** Is a video playing right now? The app must not close over someone's episode —
 *  an update waits for the credits. */
async function somethingPlaying() {
  if (!win || win.isDestroyed()) return false;
  try {
    return await win.webContents.executeJavaScript(
      `(() => { const v = document.querySelector('video'); return !!(v && !v.paused && !v.ended && v.readyState > 2); })()`, true);
  } catch { return false; }
}

/** Install the update without waiting for the user to restart anything: the
 *  installer runs silently over the app, and it brings Koma back up when it is
 *  done. It waits out a playing video first, and gives the card a moment to be
 *  dismissed with "Not now" before it goes. */
function scheduleAutoInstall() {
  if (autoTimer || autoDeferred || !update?.ready) return;
  if (deferredFor(update.version)) { updateLog(`v${update.version} was put off — leaving it alone`); return; }
  autoTimer = setTimeout(autoAttempt, AUTO_GRACE);
}

/** Did the user put this release off, and is it still within the cooling-off
 *  time? "Not now" has to mean not now even after a restart — the app would
 *  otherwise install it seconds after the user comes back, which is exactly
 *  what they said no to. */
function deferredFor(version) {
  try {
    const d = JSON.parse(fs.readFileSync(DEFERRED, 'utf8'));
    if (d.version === version && Date.now() - Number(d.at || 0) < DEFER_MS) return true;
  } catch { /* nothing deferred */ }
  return false;
}

async function autoAttempt() {
  autoTimer = null;
  if (!update?.ready || autoDeferred) return;
  if (await somethingPlaying()) { autoTimer = setTimeout(autoAttempt, AUTO_RETRY); return; }
  // Two tries that did not take is enough: stop taking the app down on its own
  // and leave the card up for the user to run the installer themselves.
  if (autoAttempts >= 2) { updateLog('auto-install gave up — leaving it to the card'); return; }
  autoAttempts++;
  updateLog(`auto-installing v${update.version} (attempt ${autoAttempts})`);
  applyUpdate({ auto: true });
}

/** The one destructive step — running the installer. The app quits the moment it
 *  hands over, because the installer overwrites the very files this app runs
 *  from; a Koma still holding them is what makes an update die halfway. */
function applyUpdate({ auto = false } = {}) {
  try { fs.statSync(SETUP); } catch { return { ok: false }; }
  updateLog(auto ? 'applying the update on its own' : 'consent given — opening the installer');
  try {
    // Remember what we were trying to install: if the app comes back on the old
    // version, the install did not take and we say so instead of pretending.
    try { fs.writeFileSync(PENDING, JSON.stringify({ from: app.getVersion(), to: update?.version || '', attempts: autoAttempts })); } catch { /* best effort */ }
    if (auto && win && !win.isDestroyed()) win.webContents.executeJavaScript('window.__kuInstalling && window.__kuInstalling()').catch(() => {});
    install(SETUP, {
      log: updateLog,
      args: auto ? silentRelaunch() : fromApp(),
      quitAfter: () => { updateLog('closing Koma for the installer'); stopServers(); app.quit(); },
    });
    return { ok: true };
  } catch (err) {
    updateLog(`could not open the installer: ${err.message}`);
    return { ok: false };
  }
}

/** "Update now" in the card: run the installer now. */
ipcMain.handle('koma:update:apply', () => applyUpdate({ auto: false }));

/** "Not now" in the card: stop the app from installing this release by itself.
 *  It lasts for a few hours, so the app does not install it seconds after the
 *  user comes back — and the card stays where they can get it when they want it. */
ipcMain.handle('koma:update:cancel', () => {
  autoDeferred = true;
  if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
  try { fs.writeFileSync(DEFERRED, JSON.stringify({ version: update?.version || '', at: Date.now() })); } catch { /* best effort */ }
  updateLog(`the user put ${update?.version || 'the update'} off`);
  return { ok: true };
});

/** What the footer's version line asks for: the running build, the newest release,
 *  and whether this build is behind it. */
ipcMain.handle('koma:version', async () => {
  const current = app.getVersion();
  const rel = await latestRelease();
  const newest = String(rel?.tag_name || '').replace(/^v/, '');
  return { current, latest: newest, outdated: newest ? newerVersion(newest, current) : null };
});

/** The diagnosis: the local servers, the sites they lean on, and the addresses
 *  this machine has. It is what turns "it does not work" into a sentence. */
ipcMain.handle('koma:diagnose', async () => {
  try {
    return await diagnose({
      port: PORT,
      streamPort,
      allAnimePort: 8000,
      anivaultKey: anivaultKey(),
      logs: LOGS,
      version: app.getVersion(),
    });
  } catch (err) {
    return { error: err?.message || 'the diagnosis failed' };
  }
});

/** "Update" in the footer: bring the update card back even if it was dismissed.
 *  Asking for it by hand clears the "not now" the user left earlier. */
ipcMain.handle('koma:update:check', async () => {
  updateShown = false;
  autoDeferred = false;
  try { fs.unlinkSync(DEFERRED); } catch { /* nothing deferred */ }
  await checkForUpdates({ force: true });
  return { shown: updateShown };
});

/** Did the last update take? The app writes down what it was installing before it
 *  hands over; if it comes back on the old version, the install did not happen
 *  and the count of failed tries says how hard to try again. */
function pendingUpdate() {
  let p = null;
  try { p = JSON.parse(fs.readFileSync(PENDING, 'utf8')); } catch { return null; }
  const current = app.getVersion();
  if (p.to && current === p.to) {
    try { fs.unlinkSync(PENDING); } catch { /* fine */ }
    updateLog(`updated to v${current}`);
    return { ok: true };
  }
  if (p.from && current === p.from) {
    autoAttempts = Number(p.attempts) || 0;
    updateLog(`the update to v${p.to} did not take — still on v${current}`);
    return { ok: false, to: p.to };
  }
  try { fs.unlinkSync(PENDING); } catch { /* fine */ }
  return null;
}

/* ---------- app lifecycle ---------- */
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { showKoma(); if (win.isMinimized()) win.restore(); win.focus(); } });
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required'); // the next episode can start by itself
  if (IS_WIN) app.setAppUserModelId('Koma');
  Menu.setApplicationMenu(null);

  app.whenReady().then(async () => {
    createWindow();
    createTray();
    if (readSettings().discordRp !== false) startPresence();
    await win.loadFile(path.join(__dirname, 'splash.html'));
    if (!fs.existsSync(path.join(HOME, 'server.js'))) {
      status(`Can't find the Koma site in ${HOME}. Rebuild the app with build-app.bat from the WebsiteAnime\\desktop folder.`);
      return;
    }
    const started = await startServers(status);
    // Another program owns the address Koma serves its pages from. Say so
    // plainly instead of loading that program's site and looking broken.
    if (started.taken) {
      status('Another program is using port 4000 — close it and start Koma again.');
      try { fs.appendFileSync(path.join(LOGS, 'koma.log'), `[${new Date().toISOString()}] port ${PORT} is held by another program\n`); } catch { /* best effort */ }
      dialog.showMessageBox(win, {
        type: 'error',
        title: 'Koma cannot start',
        message: `Port ${PORT} is already in use by another program.`,
        detail: 'Koma serves its pages from this address, so it cannot run alongside the other program. Close that program (or restart Windows, if it starts by itself) and open Koma again.',
        buttons: ['Quit'],
        defaultId: 0,
      }).finally(() => app.quit());
      return;
    }
    status('Almost ready…');
    if (await waitForKoma()) win.loadURL(URL_HOME);
    else status(`Koma didn't start. Check ${path.join(LOGS, 'koma.log')}`);
    if (BUNDLED) { // packaged builds look for a newer GitHub release; dev runs skip this
      fs.mkdirSync(LOGS, { recursive: true });
      pendingUpdate(); // did the last update take, or did it leave us on the old build?
      setTimeout(checkForUpdates, 9000); // let the page settle before the card slides in
      setInterval(checkForUpdates, UPDATE_POLL); // and keep looking: a release that drops while
      // Koma is open is found in minutes, not at the next restart.
      win.on('focus', () => setTimeout(() => checkForUpdates(), 2000)); // coming back to the window
    }
  });

  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => { quitting = true; }); // a quit is a quit, even when the tray is on
  app.on('will-quit', () => { presence.client?.close(); stopServers(); });
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopServers(); process.exit(0); });
}
