// The shell of the TV UI study.
//
// A television has no window furniture: the app opens on the whole screen,
// owns the remote, and gets out of the way. Nothing here but the window, the
// bridge, and the two ways out (Escape leaves the screen full, Alt+F4 quits).
const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('node:path');
const { registerBridge } = require('./bridge');
const { createRendererServer } = require('./serve');

let site = null;

function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: 640,
    minHeight: 400,
    backgroundColor: '#05060a',
    frame: false,
    show: false,
    title: 'Koma TV',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => {
    win.show();
    // A television app fills the screen. Escape still walks back through the
    // app, so the screen is left with F (or F11), the way a real app does it.
    win.setFullScreen(true);
  });
  // The window must never stay invisible: if the page never says it is ready,
  // the viewer is left with nothing at all and no way to tell why.
  setTimeout(() => { if (!win.isDestroyed() && !win.isVisible()) win.show(); }, 3000);
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.loadURL(site.url);
  return win;
}

registerBridge(ipcMain, BrowserWindow);

app.whenReady().then(async () => {
  site = await createRendererServer(path.join(__dirname, 'renderer'));
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  site?.server.close();
  app.quit();
});