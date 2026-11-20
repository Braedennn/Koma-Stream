// The shell's half of the data bridge: everything the page asks for, and the
// window controls that go with a frameless study. Both the app and the picture
// tool register the same handlers, so the page behaves identically either way.
const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');

const API_CANDIDATES = [process.env.KOMA_API, 'http://127.0.0.1:4000', 'http://127.0.0.1:4100', 'http://127.0.0.1:4101'].filter(Boolean);
const forcedIndex = process.argv.indexOf('--api');
const forcedApi = forcedIndex >= 0 ? process.argv[forcedIndex + 1] : null;

function readSnapshot() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'renderer', 'sample.json'), 'utf8'));
  } catch { return null; }
}

async function getJson(base, route) {
  const started = Date.now();
  try {
    const response = await fetch(`${base}${route}`, { headers: { Accept: 'application/json' } });
    const body = await response.text();
    if (!response.ok) return { ok: false, error: `HTTP ${response.status}`, ms: Date.now() - started };
    return { ok: true, data: JSON.parse(body), ms: Date.now() - started };
  } catch (error) {
    return { ok: false, error: String(error?.message || error), ms: Date.now() - started };
  }
}

const query = params => new URLSearchParams(params).toString();

function registerBridge(ipcMain, BrowserWindow) {
  ipcMain.handle('koma:config', () => ({
    candidates: forcedApi ? [forcedApi] : API_CANDIDATES,
    forced: !!forcedApi,
    version: 'study',
    snapshot: readSnapshot(),
  }));
  ipcMain.handle('koma:fetch-home', (_event, base) => getJson(base, '/api/home'));
  ipcMain.handle('koma:fetch-anime', (_event, base, id) => getJson(base, `/api/anime/${encodeURIComponent(id)}`));
  ipcMain.handle('koma:fetch-browse', (_event, base, params) => getJson(base, `/api/browse?${query(params || {})}`));
  ipcMain.handle('koma:fetch-genres', (_event, base) => getJson(base, '/api/genres'));
  ipcMain.handle('koma:fetch-schedule', (_event, base, from, to) => getJson(base, `/api/schedule?${query({ from, to })}`));
  ipcMain.handle('koma:fetch-search', (_event, base, text) => getJson(base, `/api/browse?${query({ search: text, sort: 'POPULARITY_DESC', page: 1 })}`));
  // The watch resolution the site itself uses: Koma asks its own streaming
  // server, and hands back a playlist its proxy will serve.
  ipcMain.handle('koma:fetch-watch', (_event, base, params) =>
    getJson(base, `/api/stream/watch?${query({ source: 'anikoto', ...params })}`));
  ipcMain.handle('koma:window', (event, action) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return;
    if (action === 'fullscreen') win.setFullScreen(!win.isFullScreen());
    else if (action === 'quit') app.quit();
  });
}

module.exports = { registerBridge, API_CANDIDATES };