// AniList GraphQL client with an in-memory cache, request coalescing,
// a small concurrency limit and stale-on-error fallback.
const UPSTREAM = process.env.ANILIST_URL || 'https://graphql.anilist.co';
const MAX_ENTRIES = 600;
const MAX_IN_FLIGHT = 3;

const cache = new Map(); // key -> { at, data, pending }
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
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
    throw new UpstreamError(msg, res.status === 404 ? 404 : res.status === 429 ? 429 : 502);
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
      return data;
    },
    err => {
      if (hit?.data && err.status !== 404) { cache.set(key, { at: hit.at, data: hit.data }); return hit.data; }
      cache.delete(key);
      throw err;
    },
  );
  cache.set(key, { ...hit, pending });
  if (stale) { pending.catch(() => {}); return Promise.resolve(hit.data); }
  return pending;
}
