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
import { gql } from './anilist.js';
import { anikotoEntry, anikotoEpisodes, anikotoSearch, generic, heavenSearch, matchOffset, parseTitle, pickPart, searchTitle } from './part-map.js';

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

/* ---------- which part of a show is this? ----------
 *
 * A show split into cours is several AniList entries, and the streaming
 * server picks the site entry by scoring titles — "Cour 2" on AniList is
 * "Part 2" on the site, so the second cour can land on the first cour's
 * entry and play it again. Koma works out which entry really holds the part
 * that was asked for, and refuses to play anything it cannot confirm.
 */
const MEDIA = `id title{romaji english native} format episodes idMal
  relations{edges{relationType node{id type format episodes title{romaji english}}}}
  streamingEpisodes{title thumbnail url site}`;

async function mediaOf(id) {
  const d = await gql(`query($id:Int){Media(id:$id,type:ANIME){${MEDIA}}}`, { id: Number(id) }, 3600);
  return d?.Media || null;
}

const SEASON_FORMATS = ['TV', 'TV_SHORT', 'ONA'];

/** How many episodes of this season come before this part. */
async function franchiseOffset(media) {
  let total = 0, m = media;
  for (let hop = 0; hop < 8; hop++) {
    const edge = (m.relations?.edges || []).find(e =>
      e.relationType === 'PREQUEL' && e.node?.type === 'ANIME' && SEASON_FORMATS.includes(e.node.format));
    if (!edge) break;
    const prev = await gql(`query($id:Int){Media(id:$id,type:ANIME){id format episodes
      relations{edges{relationType node{id type format episodes title{romaji english}}}}}}`, { id: edge.node.id }, 3600)
      .then(d => d?.Media).catch(() => null);
    if (!prev) break;
    total += prev.episodes || 0;
    m = prev;
  }
  return total;
}

/** Anikoto's own entry for this part: the entry and the episodes it holds. */
async function ourPart(media, want, count) {
  const candidates = await anikotoSearch(searchTitle(media.title.english || media.title.romaji || '')).catch(() => []);
  const pick = pickPart(candidates, want, count);
  if (!pick?.animeId) return null;
  const episodes = await anikotoEpisodes(pick.animeId, pick.slug).catch(() => []);
  if (!episodes.length) return null;
  // The site says which MAL entry the episodes belong to — that is the proof.
  const mals = episodes.filter(e => e.mal).map(e => e.mal);
  if (mals.length && media.idMal && !mals.includes(media.idMal)) return null;
  return { slug: pick.slug, episodes };
}

/**
 * Our part's episode titles, as the episode database has them.
 *
 * The sites copy their titles from there, so this is the common ground for
 * telling which episode of a merged season is ours.
 */
async function malEpisodes(malId) {
  if (!malId) return [];
  const r = await upstreamJson(`/mal/anime/${malId}/episodes`, '', null, 60000).catch(() => null);
  const rows = r?.data?.data || [];
  return rows.map(e => ({ num: Number(e.malId) || 0, title: e.title || '' })).filter(e => e.num > 0);
}

/** Animeheaven's entry for this part — one entry per part, and the streaming server takes its id. */
async function heavenPart(media, want, count) {
  const candidates = await heavenSearch(searchTitle(media.title.english || media.title.romaji || '')).catch(() => []);
  const pick = pickPart(candidates, want, count);
  if (!pick?.id) return null;
  const eps = await upstreamJson('/episodes', `?anilistId=${media.id}&source=animeheaven&heavenId=${pick.id}`, null, 60000).catch(() => null);
  const n = eps?.data?.count || 0;
  if (count && n && n > count) return null; // it holds more than this part — a different entry
  return pick;
}

const plans = new Map(); // anilistId -> { at, plan }
const PLAN_TTL = 30 * 60e3;

/**
 * The plan for one show: which entries really hold the part that was asked
 * for, and how their episodes are numbered.
 *
 * More than one option when the part is not where the streaming server looked:
 * Animeheaven keeps one entry per part, DesiDub holds the whole season in one
 * entry. Which of them has subs or dubs is the streaming server's business —
 * the watch tries them in turn.
 */
async function buildPlan(anilistId) {
  const media = await mediaOf(anilistId).catch(() => null);
  if (!media) return { ok: true, options: [{ source: 'anikoto', offset: 0 }], episodes: [] };
  const title = media.title.english || media.title.romaji || media.title.native || '';
  const want = parseTitle(title);
  const count = media.episodes || 0;

  const anik = await upstreamJson('/episodes', `?anilistId=${anilistId}&source=anikoto`, null, 60000).catch(() => null);
  const entry = anik?.data;
  const own = entry?.siteId ? await anikotoEntry(entry.siteId).catch(() => null) : null;

  // The entry is this part — or the site would not say — so play it as it is.
  if (!own || !own.mal || !media.idMal || own.mal === media.idMal) {
    return { ok: true, options: [{ source: 'anikoto', offset: 0 }], episodes: entry?.episodes || [] };
  }

  // The entry belongs to another part. Find the ones that hold ours.
  const mine = await ourPart(media, want, count);
  const episodes = mine?.episodes || [];
  // Our part's episode titles, from whoever names them the same way the sites
  // do — the site's own entry first, then the episode list the database has.
  const titles = episodes.length ? episodes : await malEpisodes(media.idMal);
  const options = [];

  // The entry the streaming server found may still hold the whole season —
  // then our part starts further in.
  if (titles.length && entry?.episodes?.length) {
    const offset = matchOffset(titles, entry.episodes);
    if (offset >= 0) options.push({ source: 'anikoto', offset });
  }

  const heaven = await heavenPart(media, want, count);
  if (heaven) options.push({ source: 'animeheaven', heavenId: heaven.id, offset: 0 });

  const desi = await upstreamJson('/episodes', `?anilistId=${anilistId}&source=desidub`, null, 60000).catch(() => null);
  if (titles.length && desi?.data?.episodes?.length) {
    const offset = matchOffset(titles, desi.data.episodes);
    if (offset >= 0) options.push({ source: 'desidub', offset });
  }

  if (!options.length) return { ok: false, error: 'This part of the show could not be found on the streaming sources.' };
  return { ok: true, options, episodes: titles, fixed: true };
}

async function planFor(anilistId) {
  const hit = plans.get(anilistId);
  if (hit && Date.now() - hit.at < PLAN_TTL) return hit.plan;
  const plan = await buildPlan(anilistId).catch(err => ({ ok: false, error: err?.message || 'The streaming sources could not be checked.' }));
  plans.set(anilistId, { at: Date.now(), plan });
  return plan;
}

/** The episode list of this part, with the titles and pictures that belong to it. */
async function partEpisodes(anilistId, plan) {
  const media = await mediaOf(anilistId).catch(() => null);
  const count = media?.episodes || 0;
  const offset = media && (media.streamingEpisodes?.length || 0) > count ? await franchiseOffset(media).catch(() => 0) : 0;
  const listed = new Map();
  for (const e of media?.streamingEpisodes || []) {
    const n = Number(e.title.match(/Episode\s+(\d+)/i)?.[1]);
    if (Number.isFinite(n)) listed.set(n, e);
  }
  const strip = t => String(t || '').replace(/^Episode\s+\d+\s*[-:–]\s*/i, '');
  // A title that says nothing ("Episode 12") does not count as a title.
  const said = t => { const v = strip(t || ''); return v && !generic(v) ? v : ''; };
  const source = new Map((plan.episodes || []).map(e => [Number(e.num), e]));
  const total = count || source.size;
  const out = [];
  for (let n = 1; n <= total; n++) {
    const s = source.get(n);
    const l = listed.get(n + offset);
    out.push({
      num: n,
      title: said(s?.title) || said(l?.title) || strip(s?.title || '') || `Episode ${n}`,
      thumb: l?.thumbnail || s?.thumbnail || '',
    });
  }
  return { episodes: out, offset };
}


async function resolveWatch(search, req) {
  const q = new URLSearchParams(search);
  const type = q.get('type') || 'sub';
  const options = [];
  const anilistId = q.get('anilistId');
  if (anilistId) {
    // The plan says which entries really hold this part of the show, and how
    // their episodes are numbered. Without it a second cour can play the first.
    const plan = await planFor(anilistId);
    if (!plan.ok) return { status: 404, body: JSON.stringify({ error: plan.error }) };
    options.push(...(plan.options?.length ? plan.options : [{ source: q.get('source') || 'anikoto', offset: 0 }]));
  } else {
    options.push({ source: q.get('source') || 'anikoto', offset: 0 });
  }
  let last = null;
  for (const opt of options) {
    const r = await watchOn(opt, q, req, type);
    if (r.status === 200) return r;
    last = r;
    if (r.status !== 404) break; // anything else is not "this source has no such episode"
  }
  return last || { status: 404, body: JSON.stringify({ error: 'No source could play that episode.' }) };
}

/** One source, one episode — the episode number the way that source counts it. */
async function watchOn(opt, q, req, type) {
  const p = new URLSearchParams(q);
  p.set('source', opt.source);
  if (opt.heavenId) p.set('heavenId', opt.heavenId); else p.delete('heavenId');
  const ep = Number(p.get('ep') || 0) + (opt.offset || 0);
  if (Number.isFinite(ep)) p.set('ep', String(ep));
  const key = `${opt.source}:${type}`;
  const remembered = !p.has('server') && goodServer.get(key);
  if (remembered) p.set('server', remembered);
  const r = await upstreamJson('/watch', String(p) ? `?${p}` : '', req, 120000);
  if (r.status === 200 && r.data?.server) goodServer.set(key, r.data.server);
  else if (remembered) goodServer.delete(key);
  return r;
}

/** The episode list of this part of the show — titles and pictures that belong to it. */
async function partList(search) {
  const q = new URLSearchParams(search || '');
  const anilistId = q.get('anilistId');
  if (!anilistId) return null;
  const plan = await planFor(anilistId);
  if (!plan.ok) return { error: plan.error };
  const { episodes, offset } = await partEpisodes(anilistId, plan);
  return { episodes, offset, count: episodes.length, source: plan.options?.[0]?.source || 'anikoto', fixed: !!plan.fixed };
}

export async function proxyJson(req, res, rest, search) {
  // The episode list of a part of a show comes from Koma, not from the
  // streaming server: only Koma knows which entry holds the part that was
  // asked for, and which titles belong to it.
  if (rest === '/episodes' && /(^|[?&])anilistId=/.test(search || '')) {
    const list = await partList(search).catch(() => null);
    if (list) {
      if (list.error) return sendJson(res, 404, JSON.stringify({ error: list.error }));
      return sendJson(res, 200, JSON.stringify(list));
    }
  }
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
