// Takes a picture of the study without a person.
//   node_modules/.bin/electron.cmd tools/shot.js [out.png] [delayMs] [mode]
//
//   mode: sheet · find · browse · tv · library · settings · list · scroll:0.5
//
// It opens the very same window the app opens, walks to the part asked for,
// writes a PNG and prints a one-line report of what is on the screen.
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, ipcMain } = require('electron');
const { registerBridge } = require('../bridge');
const { createRendererServer } = require('../serve');

const out = path.resolve(process.argv[2] || path.join(__dirname, '..', 'shot.png'));
const delay = Number(process.argv[3] || 4500);
const mode = process.argv[4] || '';
console.log('[shot] argv:', JSON.stringify(process.argv), 'mode:', mode);
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const run = (win, script) => win.webContents.executeJavaScript(script);

app.whenReady().then(async () => {
  registerBridge(ipcMain, BrowserWindow);
  const site = await createRendererServer(path.join(__dirname, '..', 'renderer'));
  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    backgroundColor: '#05060a',
    frame: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
    },
  });
  win.webContents.on('console-message', (_event, message) => console.log('[page]', message));
  win.webContents.on('render-process-gone', () => console.log('[page] the renderer died'));
  try {
    await win.loadURL(site.url);
    await wait(delay);

    if (mode.startsWith('scroll')) {
      const fraction = Number(mode.split(':')[1]);
      await run(win, `(() => { const s = document.getElementById('stage'); s.scrollTop = s.scrollHeight * ${fraction}; })()`);
      await wait(2200);
    }
    if (mode === 'top') {
      await run(win, `[...document.querySelectorAll('.shelf')].find(s => s.querySelector('h2')?.textContent === 'Top 10')?.scrollIntoView({ block: 'start' })`);
      await wait(2200);
    }
    if (mode === 'backtest') {
      await run(win, `document.querySelector('[data-nav="browse"]').click()`);
      await wait(6000);
      await run(win, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
      await wait(1200);
      await run(win, `document.querySelector('[data-nav="tv"]').click()`);
      await wait(4000);
      await run(win, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))`);
      await wait(1500);
    }
    if (mode === 'sheet') {
      await run(win, `document.querySelector('.card').click()`);
      await wait(2200);
    }
    if (mode === 'watch') {
      await run(win, `document.querySelector('.card').click()`);
      await wait(7000);
    }
    if (mode === 'playing') {
      await run(win, `document.querySelector('.card[data-id="21"]')?.click() || document.querySelector('.card').click()`);
      await wait(7500);
      await run(win, `[...document.querySelectorAll('.ep')][0]?.click()`);
      await wait(12000);
      await run(win, `document.querySelector('.player-big')?.click()`);
      await wait(9000);
      console.log('[shot] playing:', await run(win, `JSON.stringify({ time: document.querySelector('.player-video')?.currentTime, dur: document.querySelector('.player-video')?.duration, paused: document.querySelector('.player-video')?.paused })`));
    }
    if (mode === 'play') {
      const picked = await run(win, `(() => { const c = document.querySelector('.card[data-id="21"]') || document.querySelector('.card'); c.click(); return c.dataset.id + ':' + (c.querySelector('h3')?.textContent || ''); })()`);
      console.log('[shot] picked:', picked);
      await wait(7500);
      console.log('[shot] watch page:', await run(win, `document.querySelector('.watch-title')?.textContent || 'none'`));
      await run(win, `[...document.querySelectorAll('.ep')][0]?.click()`);
      await wait(14000);
      console.log('[shot] after play:', await run(win, `JSON.stringify({ player: !!document.querySelector('.player'), time: document.querySelector('.player-video')?.currentTime, toast: document.getElementById('toast')?.textContent || '' })`));
    }
    if (mode === 'list') {
      await run(win, `document.querySelector('.card').click()`);
      await wait(1200);
      await run(win, `[...document.querySelectorAll('.sheet-panel .btn')].find(b => b.textContent.includes('my list'))?.click()`);
      await wait(1200);
      await run(win, `document.querySelector('.sheet-close')?.click()`);
      await wait(600);
      await run(win, `document.querySelector('[data-nav="library"]').click()`);
      await wait(2200);
    }
    if (mode === 'find') {
      await run(win, `document.querySelector('[data-nav="search"]').click()`);
      await wait(500);
      await run(win, `(() => { const box = document.querySelector('.find-head input'); box.value = 'sword'; box.dispatchEvent(new Event('input', { bubbles: true })); })()`);
      await wait(3200);
    }
    if (['browse', 'tv', 'library', 'settings'].includes(mode)) {
      await run(win, `document.querySelector('[data-nav="${mode}"]').click()`);
      await wait(mode === 'browse' ? 6500 : 3600);
      if (mode === 'browse') {
        await run(win, `document.querySelector('.pill:not(.is-on)')?.click()`);
        await wait(5500);
      }
      if (mode === 'tv') {
        await run(win, `document.querySelectorAll('.day')[1]?.click()`);
        await wait(4500);
      }
    }

    const report = await run(win, `(() => {
      const art = document.querySelector('.backdrop-art[data-show="1"]');
      return JSON.stringify({
        page: document.querySelector('.page') ? 'on' : 'none',
        nav: document.querySelector('.nav-item.is-on')?.textContent?.trim() || 'none',
        hero: document.querySelector('.hero-title')?.textContent || '',
        meta: document.querySelector('.hero-meta')?.textContent?.replace(/\\s+/g, ' ').trim() || '',
        shelves: [...document.querySelectorAll('.shelf h2')].map(h => h.textContent + ':' + h.closest('.shelf').querySelectorAll('.card').length),
        watchTitle: document.querySelector('.watch-title')?.textContent || '',
        native: document.querySelector('.watch-native')?.textContent || '',
        episodes: document.querySelectorAll('.ep').length,
        seasons: document.querySelectorAll('.day').length,
        player: (() => { const p = document.querySelector('.player'); if (!p) return 'none'; const v = document.querySelector('.player-video'); return 'mounted:' + (window.Hls ? 'hls' : 'no-hls') + '/rs' + v?.readyState + '/ns' + v?.networkState + '/err' + (v?.error?.message || 'none') + '/hls' + (window.__playerError || 'none') + '/src' + (v?.currentSrc || window.__playerUrl || '').slice(0, 60); })(),
        toast: document.getElementById('toast')?.textContent || '',
        log: [...document.querySelectorAll('#boot-error')].map(e => e.textContent.slice(0, 200)).join(' '),
        videoTime: document.querySelector('.player-video')?.currentTime ?? null,
        videoDur: document.querySelector('.player-video')?.duration ?? null,
        pills: document.querySelectorAll('.pill').length,
        grid: document.querySelectorAll('.grid .card').length,
        rows: document.querySelectorAll('.row-item').length,
        settings: document.querySelectorAll('.setting').length,
        source: document.querySelector('.status')?.classList.contains('is-off') ? 'snapshot' : 'live',
        focus: document.activeElement?.classList?.contains('card') ? 'card:' + (document.activeElement.querySelector('h3')?.textContent || '').slice(0, 24) : document.activeElement?.tagName,
        art: art ? getComputedStyle(art).backgroundImage.slice(0, 50) : 'none',
        images: [...document.querySelectorAll('.card img')].map(i => i.naturalWidth).filter(Boolean).length + '/' + document.querySelectorAll('.card img').length,
        error: (document.getElementById('boot-error')?.textContent || '').slice(0, 300),
      });
    })()`);
    console.log(report);
    const image = await win.webContents.capturePage();
    fs.writeFileSync(out, image.toPNG());
    console.log(`wrote ${out}`);
  } catch (error) {
    console.log('[shot] failed:', String(error?.message || error));
    process.exitCode = 1;
  } finally {
    app.exit(process.exitCode || 0);
  }
});