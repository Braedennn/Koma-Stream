// Koma web server: static files, page routes and the /api endpoints. No dependencies; Node 18.17+.
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as api from './server/api.js';
import { proxyJson, proxyMedia, ping } from './server/streaming.js';
import { audioCounts } from './server/audio.js';
import { ensureDubIndex } from './server/dubindex.js';
import { handleRoom, lanAddress, roomInfo, setLanHandler } from './server/room.js';
import * as auth from './server/auth.js';
import * as subtitles from './server/subtitles.js';
import { spawn } from 'node:child_process';

if (typeof fetch !== 'function') {
  console.error(`Koma needs Node.js 18.17 or newer (you have ${process.version}). Get the LTS version from https://nodejs.org`);
  process.exit(1);
}

const PORT = Number(process.env.PORT) || 4000;
const HOST = process.env.HOST || '0.0.0.0';
// The app shell passes its own version, so /api/koma can say which build is
// answering. Standalone, it says "dev".
const VERSION = process.env.KOMA_VERSION || 'dev';
const PUBLIC = fileURLToPath(new URL('./public/', import.meta.url));
const gzipAsync = promisify(gzip);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
};
const PAGES = /^\/(?:anime\/\d+|watch\/\d+|browse|schedule|list|auth\/(?:anilist|myanimelist)|join)?\/?$/;
const API = [
  [/^\/api\/home$/, api.home],
  [/^\/api\/genres$/, api.genres],
  [/^\/api\/tags$/, api.tags],
  [/^\/api\/browse$/, api.browse],
  [/^\/api\/suggest$/, api.suggest],
  [/^\/api\/media$/, api.many],
  [/^\/api\/media\/mal$/, api.mediaByMal],
  [/^\/api\/anime\/(\d+)$/, api.anime],
  [/^\/api\/anime\/(\d+)\/episodes$/, api.episodes],
  [/^\/api\/schedule$/, api.schedule],
];
const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
    'Content-Security-Policy': [
      "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src https://fonts.gstatic.com", "img-src 'self' data: https:",
      // api.github.com is the release feed the footer's version line reads in a
      // plain browser tab (inside the app the shell asks GitHub itself).
      // http://*:* is the local network: a watch-together session talks to the
      // host's own Koma server, wherever it sits on the Wi-Fi.
      "connect-src 'self' http://*:* https://graphql.anilist.co https://api.myanimelist.net https://api.github.com",
      "media-src 'self' blob:", "worker-src 'self' blob:", 'frame-src https:', "base-uri 'self'", "form-action 'self'",
    ].join('; '),
};

async function send(req, res, status, body, type, extra = {}) {
  let buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const headers = { ...SECURITY, 'Content-Type': type, Vary: 'Accept-Encoding', ...extra };
  if (buf.length > 1024 && /text|json|svg|javascript/.test(type) && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    buf = await gzipAsync(buf);
    headers['Content-Encoding'] = 'gzip';
  }
  headers['Content-Length'] = buf.length;
  res.writeHead(status, headers);
  res.end(req.method === 'HEAD' ? undefined : buf);
}

async function readJson(req, limit = 32 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('The request body is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  if (!size) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw Object.assign(new Error('The request body is not valid JSON.'), { status: 400 }); }
}

// Static files are read and gzipped once per version (hls.js alone is 600 KB), not on every request.
const fileCache = new Map(); // path -> { etag, raw, gz }
async function sendFile(req, res, file, status = 200) {
  const info = await stat(file);
  if (!info.isFile()) throw Object.assign(new Error('not a file'), { code: 'ENOENT' });
  const etag = `"${info.size.toString(36)}-${Math.floor(info.mtimeMs).toString(36)}"`;
  if (status === 200 && req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ETag: etag, ...SECURITY });
    return res.end();
  }
  const type = TYPES[extname(file).toLowerCase()] || 'application/octet-stream';
  let hit = fileCache.get(file);
  if (hit?.etag !== etag) {
    const raw = await readFile(file);
    hit = { etag, raw, gz: raw.length > 1024 && /text|json|svg|javascript/.test(type) ? await gzipAsync(raw) : null };
    fileCache.set(file, hit);
  }
  const headers = { ...SECURITY, 'Content-Type': type, Vary: 'Accept-Encoding', ETag: etag, 'Cache-Control': 'no-cache' };
  const gz = hit.gz && /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  const body = gz ? hit.gz : hit.raw;
  if (gz) headers['Content-Encoding'] = 'gzip';
  headers['Content-Length'] = body.length;
  res.writeHead(status, headers);
  res.end(req.method === 'HEAD' ? undefined : body);
}

async function handle(req, res, { lan = false } = {}) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  // OAuth exchanges use Koma's private application credentials. They are a
  // local-browser operation even when standalone Koma is serving the network.
  if (path.startsWith('/api/auth/')) {
    const address = String(req.socket?.remoteAddress || '');
    const local = /^(127\.|::1$|::ffff:127\.)/i.test(address);
    if (!local) return send(req, res, 403, '{"error":"Account sign-in is available only on this device."}', TYPES['.json']);
  }

  // The network door only answers for sessions: the room's API and the
  // invite page. The rest of Koma stays on the loopback.
  if (lan && !path.startsWith('/api/room/') && !/^\/join\/[A-Za-z0-9]{4,10}\/?$/.test(path)) {
    return send(req, res, 404, 'Not found', TYPES['.txt']);
  }

  if (path.startsWith('/api/')) {
    // Subtitle credentials and download quota stay on this device. Even a
    // standalone network-facing Koma must not offer these routes to the LAN.
    if (path.startsWith('/api/subtitles/')) {
      const address = String(req.socket?.remoteAddress || '');
      if (!/^(127\.|::1$|::ffff:127\.)/i.test(address)) return send(req, res, 403, '{"error":"Subtitle search is available only on this device."}', TYPES['.json']);
      const apiKey = String(req.headers['x-opensubtitles-key'] || '');
      const token = String(req.headers['x-opensubtitles-token'] || '');
      try {
        if (path === '/api/subtitles/status' && req.method === 'GET') {
          return send(req, res, 200, JSON.stringify({ configured: Boolean(apiKey || process.env.KOMA_OPENSUBTITLES_API_KEY), builtIn: Boolean(process.env.KOMA_OPENSUBTITLES_API_KEY), signedIn: Boolean(token) }), TYPES['.json'], { 'Cache-Control': 'no-store' });
        }
        if (path === '/api/subtitles/search' && req.method === 'GET') {
          const result = await subtitles.searchSubtitles({
            apiKey, token,
            query: url.searchParams.get('query') || '',
            language: url.searchParams.get('language') || 'en',
            year: url.searchParams.get('year') || 0,
            season: url.searchParams.get('season') || 0,
            episode: url.searchParams.get('episode') || 0,
            type: url.searchParams.get('type') || 'episode',
            page: url.searchParams.get('page') || 1,
          });
          return send(req, res, 200, JSON.stringify(result), TYPES['.json'], { 'Cache-Control': 'no-store' });
        }
        if (path === '/api/subtitles/login' && req.method === 'POST') {
          const body = await readJson(req);
          const result = await subtitles.loginSubtitles({ apiKey, username: body.username, password: body.password });
          return send(req, res, 200, JSON.stringify(result), TYPES['.json'], { 'Cache-Control': 'no-store' });
        }
        if (path === '/api/subtitles/download' && req.method === 'POST') {
          const body = await readJson(req);
          const result = await subtitles.downloadSubtitles({ apiKey, token, fileId: body.fileId, language: body.language || 'en', releaseName: body.releaseName || '' });
          return send(req, res, 200, JSON.stringify(result), TYPES['.json'], { 'Cache-Control': 'no-store' });
        }
        const file = /^\/api\/subtitles\/file\/(\d+)$/.exec(path);
        if (file && (req.method === 'GET' || req.method === 'HEAD')) {
          const data = await subtitles.readSubtitle(file[1]);
          if (!data) return send(req, res, 404, JSON.stringify({ error: 'This subtitle is not in the local cache.' }), TYPES['.json'], { 'Cache-Control': 'no-store' });
          return send(req, res, 200, data, 'text/vtt; charset=utf-8', { 'Cache-Control': 'public, max-age=86400, immutable' });
        }
        return send(req, res, 404, JSON.stringify({ error: 'No such subtitle endpoint.' }), TYPES['.json'], { 'Cache-Control': 'no-store' });
      } catch (error) {
        const status = error.status || 502;
        return send(req, res, status, JSON.stringify({ error: error.message, resetAt: error.resetAt || '', retryAfter: error.retryAfter || 0 }), TYPES['.json'], { 'Cache-Control': 'no-store' });
      }
    }
    if (path === '/api/auth/config') {
      return send(req, res, 200, JSON.stringify(auth.publicConfig()), TYPES['.json'], { 'Cache-Control': 'no-store' });
    }
    if (path.startsWith('/api/auth/')) {
      if (req.method !== 'POST') return send(req, res, 405, '{"error":"Use POST."}', TYPES['.json'], { Allow: 'POST' });
      try {
        const body = await readJson(req);
        let result;
        if (path === '/api/auth/anilist/exchange') result = await auth.exchangeAniList(body);
        else if (path === '/api/auth/myanimelist/exchange') result = await auth.exchangeMyAnimeList(body);
        else if (path === '/api/auth/myanimelist/refresh') result = await auth.refreshMyAnimeList(body);
        else return send(req, res, 404, '{"error":"No such endpoint."}', TYPES['.json']);
        return send(req, res, 200, JSON.stringify(result), TYPES['.json'], { 'Cache-Control': 'no-store' });
      } catch (err) {
        const status = err.status || 502;
        if (status >= 500) console.error(`[auth] ${path}: ${err.message}`);
        return send(req, res, status, JSON.stringify({ error: err.message }), TYPES['.json'], { 'Cache-Control': 'no-store' });
      }
    }
    // Watch-together rooms: the host's server is talked to from another
    // machine, so these take POST and answer with CORS headers.
    if (path.startsWith('/api/room/')) {
      if (req.method === 'OPTIONS') {
        return send(req, res, 204, '', TYPES['.txt'], {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'content-type',
          'Access-Control-Max-Age': '600',
        });
      }
      try { return await handleRoom(req, res, path, url, { lan }); }
      catch (err) {
        console.error(`[room] ${path}: ${err.message}`);
        return send(req, res, 500, JSON.stringify({ error: 'The room could not answer.' }), TYPES['.json'], { 'Access-Control-Allow-Origin': '*' });
      }
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(req, res, 405, '{"error":"Use GET."}', TYPES['.json'], { Allow: 'GET, HEAD' });
    // Streaming-server passthrough routes come before the JSON API table.
    if (/^\/api\/proxy\/(hls|video|subtitle)$/.test(path)) return proxyMedia(req, res, path, url.search);
    if (path.startsWith('/api/stream/')) return proxyJson(req, res, path.slice('/api/stream'.length), url.search);
    if (path === '/api/stream-status') {
      const ok = await ping().catch(() => false);
      return send(req, res, ok ? 200 : 503, JSON.stringify({ ok }), TYPES['.json'], { 'Cache-Control': 'no-store' });
    }
    // Who is answering on this port? The app shell asks this before it reuses
    // a port, so a program that happens to sit on 4000 is never mistaken for
    // Koma (it would answer 404 for everything, and the app would look broken).
    if (path === '/api/koma') {
      return send(req, res, 200, JSON.stringify({ app: 'koma', version: VERSION }), TYPES['.json'], { 'Cache-Control': 'no-store' });
    }
    if (path === '/api/audio') {
      const data = await audioCounts(url.searchParams.get('ids'));
      return send(req, res, 200, JSON.stringify(data), TYPES['.json'], { 'Cache-Control': 'no-store' });
    }
    const route = API.find(([re]) => re.test(path));
    if (!route) return send(req, res, 404, '{"error":"No such endpoint."}', TYPES['.json']);
    try {
      const data = await route[1](url.searchParams, path.match(route[0]).slice(1));
      return send(req, res, 200, JSON.stringify(data), TYPES['.json'], { 'Cache-Control': 'public, max-age=60' });
    } catch (err) {
      const status = err.status || 500;
      if (status >= 500) console.error(`[api] ${path}: ${err.message}`);
      return send(req, res, status, JSON.stringify({ error: status === 500 ? 'Something went wrong on the server.' : err.message }), TYPES['.json']);
    }
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return send(req, res, 405, 'Method not allowed', TYPES['.txt'], { Allow: 'GET, HEAD' });

  // A session invite: /join/CODE on the host's machine. It hands the viewer
  // over to their own Koma (so their video keeps streaming from their own
  // server) and carries the host's address along.
  const invite = path.match(/^\/join\/([A-Za-z0-9]{4,10})\/?$/);
  if (invite) {
    const code = invite[1].toUpperCase();
    const local = `http://127.0.0.1:${PORT}/join?code=${code}&host=${encodeURIComponent(lanAddress())}&port=${PORT}`;
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Joining a Koma session…</title>
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <style>body{font:15px/1.65 system-ui,-apple-system,Segoe UI,sans-serif;background:#0b0c10;color:#e8e9ee;display:grid;place-items:center;height:100vh;margin:0}
      main{max-width:36ch;text-align:center}h1{font-size:19px;margin:0 0 8px}b{letter-spacing:.08em}a{color:#9db4ff}
      p{color:#a4a7b4}</style>
      </head><body><main><h1>Opening Koma…</h1><p id="say">Taking you to the session <b>${code}</b>.</p>
      <p id="alt" hidden>If Koma isn’t running on this machine, open it, choose <b>Watch together → Join a session</b> and type the code <b>${code}</b>.</p>
      </main><script>
      (function(){
        var done=false;
        function go(){ if(done) return; done=true; location.replace(${JSON.stringify(local)}); }
        try { fetch('http://127.0.0.1:${PORT}/api/stream-status',{mode:'no-cors'}).then(go).catch(fail); } catch(e){ fail(); }
        setTimeout(go, 2500); setTimeout(fail, 1500);
        function fail(){ if(done) return; done=true; document.getElementById('say').textContent='Koma is not running on this machine.'; document.getElementById('alt').hidden=false; }
      })();
      </script></body></html>`;
    return send(req, res, 200, html, 'text/html; charset=utf-8', {
      // This page stands alone: it has one inline script and one inline style.
      'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src http://127.0.0.1:*",
    });
  }

  if (PAGES.test(path)) return sendFile(req, res, join(PUBLIC, 'index.html'));

  let file;
  try { file = normalize(join(PUBLIC, decodeURIComponent(path))); }
  catch { return send(req, res, 400, 'Bad request', TYPES['.txt']); }
  if (!file.startsWith(PUBLIC) || file.slice(PUBLIC.length).split(sep).some(p => p.startsWith('.'))) return send(req, res, 403, 'Forbidden', TYPES['.txt']);
  try { await sendFile(req, res, file); }
  catch (err) {
    if (err.code !== 'ENOENT' && err.code !== 'EISDIR') throw err;
    // Unknown path: let the app render its own "not found" page.
    await sendFile(req, res, join(PUBLIC, 'index.html'), 404);
  }
}

const server = http.createServer((req, res) => {
  const start = Date.now();
  res.on('finish', () => {
    if (process.env.QUIET) return;
    // Authorization callbacks carry codes and state. Keep those out of logs.
    const shown = req.url?.startsWith('/auth/') ? req.url.split('?')[0] : req.url;
    console.log(`${res.statusCode} ${req.method} ${shown} ${Date.now() - start}ms`);
  });
  handle(req, res).catch(err => {
    console.error(err);
    if (!res.headersSent) send(req, res, 500, 'Server error', TYPES['.txt']).catch(() => res.end());
    else res.end();
  });
});

// The app's own server listens on the loopback. A session needs a way in
// from the network, so the room opens a door of its own while it lasts.
const LOOPBACK_ONLY = /^127\.|^localhost$|^\[?::1\]?$/.test(HOST);
if (LOOPBACK_ONLY) setLanHandler((req, res) => {
  handle(req, res, { lan: true }).catch(err => {
    console.error(err);
    if (!res.headersSent) send(req, res, 500, 'Server error', TYPES['.txt']).catch(() => res.end());
    else res.end();
  });
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Close the other program or run with a different port, e.g. PORT=3001.`);
  else console.error(err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}`;
  const room = roomInfo();
  console.log(`Koma is running at ${url}  (press Ctrl+C to stop)`);
  console.log(`Watch together: sessions are reachable at http://${room.lan}:${PORT} (code beacon on UDP ${room.beacon})`);
  api.home().catch(() => {}); // warm the AniList cache so the first visit is instant
  ensureDubIndex(); // and the list of what has an English dub, for the browse filter
  // start.bat sets OPEN=1 so the browser opens only once the server is ready.
  if (process.env.OPEN) {
    const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  }
});

