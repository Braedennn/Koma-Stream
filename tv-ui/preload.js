// The bridge between the page and the shell. The page asks for data; the shell
// fetches it, because a file:// page may not talk to an http server itself.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('komaTv', {
  config: () => ipcRenderer.invoke('koma:config'),
  // Live data from Koma's server, or a reason it could not be reached.
  fetchHome: base => ipcRenderer.invoke('koma:fetch-home', base),
  fetchAnime: (base, id) => ipcRenderer.invoke('koma:fetch-anime', base, id),
  fetchBrowse: (base, query) => ipcRenderer.invoke('koma:fetch-browse', base, query),
  fetchGenres: base => ipcRenderer.invoke('koma:fetch-genres', base),
  fetchSchedule: (base, from, to) => ipcRenderer.invoke('koma:fetch-schedule', base, from, to),
  fetchSearch: (base, query) => ipcRenderer.invoke('koma:fetch-search', base, query),
  fetchWatch: (base, params) => ipcRenderer.invoke('koma:fetch-watch', base, params),
  // The shell's own window: the study is frameless and drives itself.
  window: action => ipcRenderer.invoke('koma:window', action),
});