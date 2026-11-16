// AniList GraphQL client with an in-memory cache, request coalescing,
// a small concurrency limit and stale-on-error fallback.
//
// The cache also lives on disk: the app starts with its catalogue already in
// hand, and an AniList outage goes unanswered for the content, not the logo.
const UPSTREAM = process.env.ANILIST_URL || 'https://graphql.anilist.co';
const MAX_ENTRIES = 600;
const MAX_IN_FLIGHT = 3;

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CACHE_FILE = fileURLToPath(new URL('../.data/anilist-cache.json', import.meta.url));
const cache = new Map(); // key -> { at, data, pending }
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* The disk cache on the way in: whatever was remembered last time the app ran,
   freshest entries first, capped the same as the live one. A first run finds
   nothing and the server warms the usual way. */
try {
  const disk = JSON.parse(readFileSync(CACHE_FILE, 'utf8'));
  if (Array.isArray(disk?.e)) {
    for (const [k, v] of disk.e) {
      if (typeof k === 'string' && v && typeof v.at === 'number' && v.data !== undefined) cache.set(k, { at: v.at, data: v.data });
    }
    while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
  }
} catch { /* no file yet, or a corrupt one: start clean */ }

let saveTimer = null;
function saveNow() {
  saveTimer = null;
  try {
    mkdirSync(fileURLToPath(new URL('../.data', import.meta.url)), { recursive: true });
    const out = { saved: Date.now(), e: [] };
    let size = 24;
    for (const [k, v] of cache) {
      if (!v || v.pending || v.data === undefined) continue;
      const payload = JSON.stringify(v.data);
      size += k.length + payload.length + 24;
      if (size > 12e6) break; // the worth of a huge catalogue page does not make this file a second catalogue
      out.e.push([k, { at: v.at, data: v.data }]);
    }
    writeFileSync(CACHE_FILE, JSON.stringify(out));
  } catch { /* a full disk is not worth stopping the site over */ }
}
function scheduleSave() {
  if (saveTimer) return; // changes keep landing while the flush waits; one write covers them
  saveTimer = setTimeout(saveNow, 2000);
  saveTimer.unref?.(); // the flush must not hold the process open
}
process.on('exit', () => { if (saveTimer) saveNow(); });

let inFlight = 0;
const waiting = [];
async function slot(fn) {
  if (inFlight >= MAX_IN_FLIGHT) await new Promise(r => waiting.push(r));
  inFlight++;
  try { return await fn(); }
  finally { inFlight--; waiting.shift()?.(); }
}

export class UpstreamError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

async function request(query, variables, tries = 3) {
  let res;
  try {
    res = await fetch(UPSTREAM, {
      method: 'POST',
      // AniList asks for a User-Agent: without one the request can be turned
      // down, and from some networks it is turned down with a 404 - which
      // looks exactly like "this anime does not exist".
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'User-Agent': 'Koma (https://github.com/Braedennn/Koma-Stream)',
        Referer: 'https://anilist.co/',
        Origin: 'https://anilist.co',
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (err) {
    if (tries > 1) { await sleep(1000); return request(query, variables, tries - 1); }
    throw new UpstreamError(`Couldn't reach AniList (${err.cause?.code || err.name}).`, 503);
  }
  if ((res.status === 429 || res.status >= 500) && tries > 1) {
    const wait = Math.min(Number(res.headers.get('retry-after')) || 2, 10);
    await sleep(wait * 1000);
    return request(query, variables, tries - 1);
  }
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.errors) {
    const msg = json?.errors?.[0]?.message || `AniList answered with status ${res.status}.`;
    // AniList answers an anime that does not exist with 200 and no data - it
    // never answers 404 for one. So a 404 here is the request being turned
    // down, and saying "not found" about it would be a lie.
    if (res.status === 404) throw new UpstreamError(`AniList turned the request down from this network (404). ${msg}`, 502);
    throw new UpstreamError(msg, res.status === 429 ? 429 : 502);
  }
  return json.data;
}

/** Run a query, served from cache for `ttl` seconds. Concurrent identical calls share one request. */
export function gql(query, variables = {}, ttl = 600) {
  const key = query + JSON.stringify(variables);
  const hit = cache.get(key);
  const age = hit?.data ? Date.now() - hit.at : Infinity;
  if (age < ttl * 1000) return Promise.resolve(hit.data);
  // Stale but under a day old: answer instantly with it and refresh in the background.
  const stale = age < 86400e3;
  if (hit?.pending) return stale ? Promise.resolve(hit.data) : hit.pending;

  const pending = slot(() => request(query, variables)).then(
    data => {
      cache.delete(key);
      cache.set(key, { at: Date.now(), data });
      while (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value);
      scheduleSave();
      return data;
    },
    err => {
      // The oldest fallback wins now, too: the disk copy answers when AniList
      // cannot, for however long the outage lasts.
      if (hit?.data && err.status !== 404) { cache.set(key, { at: hit.at, data: hit.data }); return hit.data; }
      cache.delete(key);
      throw err;
    },
  );
  cache.set(key, { ...hit, pending });
  if (stale) { pending.catch(() => {}); return Promise.resolve(hit.data); }
  return pending;
}
