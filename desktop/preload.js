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
});
