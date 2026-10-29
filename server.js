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
import { spawn } from 'node:child_process';

if (typeof fetch !== 'function') {
  console.error(`Koma needs Node.js 18.17 or newer (you have ${process.version}). Get the LTS version from https://nodejs.org`);
  process.exit(1);
}

const PORT = Number(process.env.PORT) || 4000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC = fileURLToPath(new URL('./public/', import.meta.url));
const gzipAsync = promisify(gzip);

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
};
const PAGES = /^\/(?:anime\/\d+|watch\/\d+|browse|schedule|list|auth\/anilist)?\/?$/;
const API = [
  [/^\/api\/home$/, api.home],
  [/^\/api\/genres$/, api.genres],
  [/^\/api\/tags$/, api.tags],
  [/^\/api\/browse$/, api.browse],
  [/^\/api\/suggest$/, api.suggest],
  [/^\/api\/media$/, api.many],
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
      "connect-src 'self' https://graphql.anilist.co https://api.github.com",
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

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname;

  if (path.startsWith('/api/')) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(req, res, 405, '{"error":"Use GET."}', TYPES['.json'], { Allow: 'GET, HEAD' });
    // Streaming-server passthrough routes come before the JSON API table.
    if (/^\/api\/proxy\/(hls|video|subtitle)$/.test(path)) return proxyMedia(req, res, path, url.search);
    if (path.startsWith('/api/stream/')) return proxyJson(req, res, path.slice('/api/stream'.length), url.search);
    if (path === '/api/stream-status') {
      const ok = await ping().catch(() => false);
      return send(req, res, ok ? 200 : 503, JSON.stringify({ ok }), TYPES['.json'], { 'Cache-Control': 'no-store' });
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
    console.log(`${res.statusCode} ${req.method} ${req.url} ${Date.now() - start}ms`);
  });
  handle(req, res).catch(err => {
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
  console.log(`Koma is running at ${url}  (press Ctrl+C to stop)`);
  api.home().catch(() => {}); // warm the AniList cache so the first visit is instant
  // start.bat sets OPEN=1 so the browser opens only once the server is ready.
  if (process.env.OPEN) {
    const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
      : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  }
});

