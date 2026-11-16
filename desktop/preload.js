// The only bridge between the sandboxed site and the app shell. The site
// feature-detects window.koma: present inside the app, absent in a browser.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('koma', {
  notify: payload => ipcRenderer.send('koma:notify', payload),
  // Discord Rich Presence. The app shell owns the connection to Discord;
  // the site only says what should be on the profile.
  presence: {
    state: () => ipcRenderer.invoke('koma:presence:state'),
    activity: activity => ipcRenderer.send('koma:presence:activity', activity),
    clear: () => ipcRenderer.send('koma:presence:clear'),
    onStatus: cb => ipcRenderer.on('koma:presence:status', (_e, state) => cb(state)),
  },
  // Self-update. Running the installer closes the app, so the only exposed verbs
  // are the explicit "Update now" click and the "Not now" that stops the app
  // from installing it on its own — nothing here fires without the app deciding.
  update: {
    apply: () => ipcRenderer.invoke('koma:update:apply'),
    cancel: () => ipcRenderer.invoke('koma:update:cancel'),
    check: () => ipcRenderer.invoke('koma:update:check'),
  },
  // Version and update status for the footer's version line.
  version: () => ipcRenderer.invoke('koma:version'),
  // The diagnosis: what is working on this machine and what is not. The shell
  // owns the network, so it is the one that can ask.
  diagnose: () => ipcRenderer.invoke('koma:diagnose'),
  // The window buttons. The page draws them itself, in the site's own header,
  // so the shell only has to do what it is told.
  window: {
    minimize: () => ipcRenderer.send('koma:win:min'),
    maximize: () => ipcRenderer.send('koma:win:max'),
    close: () => ipcRenderer.send('koma:win:close'),
    state: () => ipcRenderer.invoke('koma:win:state'),
    onChange: cb => ipcRenderer.on('koma:win:changed', (_e, state) => cb(state)),
  },
  // The tray. The page owns the preference (its Settings panel carries the
  // switch); the shell only needs to be told what that preference is.
  tray: { set: on => ipcRenderer.send('koma:tray', on) },
  // Local data backup: watch progress, lists' extras and preferences live in
  // the page's own storage, so the page hands over a JSON payload and the
  // shell handles the file dialogs it cannot reach by itself.
  data: {
    save: payload => ipcRenderer.invoke('koma:data:save', payload),
    read: () => ipcRenderer.invoke('koma:data:read'),
  },
});
