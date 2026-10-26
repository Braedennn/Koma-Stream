// Koma desktop app: starts Koma and both streaming servers in the background,
// shows the site in its own window, and stops what it started when you quit.
// Servers that are already running (start.bat, start-servers.ps1) are reused, not restarted.
const { app, BrowserWindow, shell, Menu } = require('electron');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

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
    webPreferences: { contextIsolation: true, sandbox: true },
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

/* ---------- app lifecycle ---------- */
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required'); // the next episode can start by itself
  if (IS_WIN) app.setAppUserModelId('Koma');
  Menu.setApplicationMenu(null);

  app.whenReady().then(async () => {
    createWindow();
    await win.loadFile(path.join(__dirname, 'splash.html'));
    if (!fs.existsSync(path.join(HOME, 'server.js'))) {
      status(`Can't find the Koma site in ${HOME}. Rebuild the app with build-app.bat from the WebsiteAnime\\desktop folder.`);
      return;
    }
    await startServers(status);
    status('Almost ready…');
    if (await waitForKoma()) win.loadURL(URL_HOME);
    else status(`Koma didn't start. Check ${path.join(LOGS, 'koma.log')}`);
  });

  app.on('window-all-closed', () => app.quit());
  app.on('will-quit', stopServers);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { stopServers(); process.exit(0); });
}
