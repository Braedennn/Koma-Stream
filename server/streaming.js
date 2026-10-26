// Proxy to the local AniVault streaming server (anivault-scraper).
// The browser only ever talks to Koma (same-origin): the API key stays on
// this side of the fence, and media flows through /api/proxy/*. AniVault
// builds its proxy URLs with the host it was called on, and since Node's
// fetch won't let us override the Host header, we rewrite every absolute
// http://…:3000 URL it embeds (JSON fields, m3u8 playlists, vtt links) into
// same-origin relative paths instead.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

const BASE = process.env.KOMA_ANIVAULT_URL || 'http://127.0.0.1:3000';

function loadKey() {
  if (process.env.KOMA_ANIVAULT_KEY) return process.env.KOMA_ANIVAULT_KEY;
  const envPath = fileURLToPath(new URL('../Servers - DONT TOUCH/anivault-scraper/.env', import.meta.url));
  return readFile(envPath, 'utf8')
    .then(t => t.match(/^ANIVAULT_API_KEY=(.+)$/m)?.[1]?.trim() || '')
    .catch(() => '');
}
const keyPromise = loadKey();

const OFFLINE = '{"error":"The streaming server isn\'t running. Start it with the start-servers.ps1 script in the Servers folder, then reload."}';
const FORWARDED = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'cache-control'];

async function call(path, search, req, { signal } = {}) {
  const key = await keyPromise;
  if (!key) throw Object.assign(new Error('No AniVault API key configured.'), { status: 500 });
  return fetch(`${BASE}${path}${search || ''}`, {
    headers: {
      'x-anivault-api-key': key,
      ...(req?.headers?.range ? { Range: req.headers.range } : {}),
      ...(req?.headers?.accept ? { Accept: req.headers.accept } : {}),
    },
    signal,
  });
}

const rewrite = text => text.replaceAll('http://127.0.0.1:3000', '').replaceAll('http://localhost:3000', '');

function sendJson(res, status, body) {
  const buf = Buffer.from(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
  res.end(buf);
}

/** JSON API passthrough: /api/stream/<rest> -> AniVault /api/<rest>. */
const watchCache = new Map(); // "path?search" -> { at, status, body } — watch resolves take seconds upstream
const inflight = new Map();   // same key -> pending { status, body }, so a prefetch and the real request share one resolve
const WATCH_TTL = 60e3, WATCH_CAP = 32;

// AniVault tries a source's video servers one after another, and a dead one can burn 8-16s on
// timeouts before it moves on. So Koma remembers which server last worked (per source + sub/dub)
// and asks for it first (AniVault still falls back to the others if it fails).
// ponytail: one request per lookup on purpose. Racing all servers in parallel looked faster, but
// every AniVault request re-runs its site lookups (DesiDub's queue is one-at-a-time), so parallel
// requests just queue up behind each other.
const goodServer = new Map(); // "anikoto:sub" -> "HD-1"

async function upstreamJson(rest, search, req, ms) {
  const r = await call(`/api${rest}`, search, req, { signal: AbortSignal.timeout(ms) });
  const body = rewrite(await r.text().catch(() => '{"error":"The streaming server sent an unreadable response."}'));
  let data = null;
  try { data = JSON.parse(body); } catch { /* leave null */ }
  return { status: r.status, body, data };
}

async function resolveWatch(search, req) {
  const q = new URLSearchParams(search);
  const key = `${q.get('source') || 'anikoto'}:${q.get('type') || 'sub'}`;
  const remembered = !q.has('server') && goodServer.get(key);
  if (remembered) q.set('server', remembered);
  const r = await upstreamJson('/watch', String(q) ? `?${q}` : '', req, 120000);
  if (r.status === 200 && r.data?.server) goodServer.set(key, r.data.server);
  else if (remembered) goodServer.delete(key);
  return r;
}

export async function proxyJson(req, res, rest, search) {
  const cacheable = rest.startsWith('/watch') && req.method === 'GET';
  // ?fresh=1 (the player asking for a new link after a stream broke) skips the cache and is not forwarded.
  const q = new URLSearchParams(search || '');
  const fresh = q.get('fresh') === '1';
  q.delete('fresh');
  search = String(q) ? `?${q}` : '';
  const key = `${rest}${search}`;
  if (cacheable && !fresh) {
    const hit = watchCache.get(key);
    if (hit && Date.now() - hit.at < WATCH_TTL) return sendJson(res, hit.status, hit.body);
    if (inflight.has(key)) {
      const r = await inflight.get(key).catch(() => null);
      return r ? sendJson(res, r.status, r.body) : sendJson(res, 503, OFFLINE);
    }
  }
  const job = rest === '/watch' ? resolveWatch(search, req)
    : upstreamJson(rest, search, req, 120000);
  if (cacheable) inflight.set(key, job);
  let r;
  try {
    r = await job;
  } catch {
    return sendJson(res, 503, OFFLINE);
  } finally {
    if (inflight.get(key) === job) inflight.delete(key);
  }
  if (cacheable && r.status === 200) {
    if (watchCache.size >= WATCH_CAP) watchCache.delete(watchCache.keys().next().value);
    watchCache.set(key, { at: Date.now(), status: r.status, body: r.body });
  }
  sendJson(res, r.status, r.body);
}

/** Media passthrough: /api/proxy/hls|video|subtitle -> AniVault, streamed.
 * Playlists and subtitles get the host rewrite; everything else is streamed
 * as raw bytes. CDNs sometimes disguise MPEG-TS segments with a text/html
 * content-type, so never trust the content-type alone — peek at the first
 * bytes of hls payloads to tell playlists from media. */
export async function proxyMedia(req, res, path, search) {
  let upstream;
  try {
    upstream = await call(path, search, req, { signal: AbortSignal.timeout(60000) });
  } catch {
    return sendJson(res, 503, OFFLINE);
  }
  const type = String(upstream.headers.get('content-type') || '');
  const headers = { 'Access-Control-Allow-Origin': '*' };
  for (const h of FORWARDED) {
    const v = upstream.headers.get(h);
    if (v && h !== 'content-length') headers[h] = v;
  }

  const asText = path.startsWith('/api/proxy/subtitle') || /vtt|mpegurl/i.test(type);
  if (asText) {
    const body = await upstream.text().catch(() => '');
    const out = Buffer.from(rewrite(body));
    headers['content-type'] = type || 'application/octet-stream';
    headers['content-length'] = out.length;
    res.writeHead(upstream.status, headers);
    return res.end(req.method === 'HEAD' ? undefined : out);
  }

  const len = upstream.headers.get('content-length');
  if (len) headers['content-length'] = len;
  if (req.method === 'HEAD' || !upstream.body) { res.writeHead(upstream.status, headers); return res.end(); }

  const stream = Readable.fromWeb(upstream.body);
  stream.on('error', () => res.destroy());

  if (!path.startsWith('/api/proxy/hls')) { res.writeHead(upstream.status, headers); return stream.pipe(res); } // video: pure binary

  // HLS: playlists must be rewritten, media must not. Peek at the first chunk
  // BEFORE sending headers: a rewritten playlist is shorter than the upstream length.
  const first = await new Promise(resolve => {
    stream.once('readable', () => resolve(stream.read()));
    stream.once('end', () => resolve(null));
    stream.once('error', () => resolve(null));
  });
  const head = Buffer.isBuffer(first) ? first : Buffer.alloc(0);
  if (head.slice(0, 512).toString('latin1').trimStart().startsWith('#EXTM3U')) {
    const chunks = [head];
    for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
    const out = Buffer.from(rewrite(Buffer.concat(chunks).toString('utf8')));
    headers['content-type'] = 'application/vnd.apple.mpegurl';
    headers['content-length'] = out.length;
    res.writeHead(upstream.status, headers);
    return res.end(out);
  }
  res.writeHead(upstream.status, headers);
  if (!head.length) return res.end();
  res.write(head);
  stream.pipe(res);
}

let pingAt = 0;
let pingOk = false;
/** Is the streaming server up? Cached for 10s so cards don't stampede it. */
export async function ping(force = false) {
  if (!force && Date.now() - pingAt < 10000) return pingOk;
  pingAt = Date.now();
  try {
    const r = await call('/api/health', '', null, { signal: AbortSignal.timeout(5000) });
    pingOk = r.ok;
  } catch {
    pingOk = false;
  }
  return pingOk;
}
