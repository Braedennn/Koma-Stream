// Talks to our own server (/api/*), never to AniList directly. Responses are cached for a few minutes.
const cache = new Map(); // path -> { at, p }
const TTL = 5 * 60e3;

export function api(path) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.at < TTL) return hit.p;
  const p = fetch('/api' + path, { headers: { Accept: 'application/json' } }).then(async res => {
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error || `The server answered with status ${res.status}.`), { status: res.status });
    return body;
  }, () => {
    throw Object.assign(new Error("Can't reach the Koma server. Check that it's still running."), { status: 0 });
  });
  cache.set(path, { at: Date.now(), p });
  p.catch(() => cache.delete(path));
  return p;
}

/** Many titles by id, in order. The server takes 50 per request, so longer lists go in parallel batches. */
export async function mediaByIds(ids) {
  const chunks = [];
  for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));
  const parts = await Promise.all(chunks.map(c => api('/media?ids=' + c.join(','))));
  return parts.flatMap(d => d.media);
}

/** Every page of an anime's airing schedule, up to `maxPages` × 50 episodes. */
export async function airingSchedule(id, maxPages = 6) {
  const nodes = [];
  for (let page = 1; page <= maxPages; page++) {
    const s = await api(`/anime/${id}/episodes?page=${page}`);
    nodes.push(...s.nodes);
    if (!s.pageInfo.hasNextPage) break;
  }
  return nodes;
}

/** The streaming source's episode list (titles, extra episodes). Shared by the title and watch pages. */
const sourceEps = new Map();
export function sourceEpisodes(malId) {
  if (!malId) return Promise.resolve([]);
  if (!sourceEps.has(malId)) {
    sourceEps.set(malId, fetch(`/api/stream/episodes?malId=${malId}&source=anikoto`, { signal: AbortSignal.timeout(10000) })
      .then(r => r.json()).then(d => (Array.isArray(d.episodes) ? d.episodes : []))
      .catch(() => { sourceEps.delete(malId); return []; }));
  }
  return sourceEps.get(malId);
}

/**
 * The seasons around a title, in watch order: follows AniList's PREQUEL/SEQUEL links both ways.
 * Only TV, TV short and web (ONA) entries count as seasons. OVAs, specials, movies and music are
 * skipped, but the walk continues through them so a movie between two seasons doesn't break the chain.
 */
const SEASON_FORMATS = ['TV', 'TV_SHORT', 'ONA'];
const chains = new Map();
export function seasonChain(a) {
  if (chains.has(a.id)) return chains.get(a.id);
  const seen = new Set([a.id]);
  const isSeason = m => SEASON_FORMATS.includes(m.format);
  const walk = async (rel) => {
    const out = [];
    let m = a;
    for (let hop = 0; hop < 8; hop++) {
      const edges = (m.relations?.edges || []).filter(e => e.relationType === rel && e.node?.type === 'ANIME' && !seen.has(e.node.id));
      const e = edges.find(x => SEASON_FORMATS.includes(x.node.format)) || edges[0]; // prefer the TV follow-up over a movie
      if (!e) break;
      seen.add(e.node.id);
      m = await api(`/anime/${e.node.id}`).catch(() => null);
      if (!m) break;
      if (isSeason(m)) out.push(m);
    }
    return out;
  };
  const p = Promise.all([walk('PREQUEL'), walk('SEQUEL')])
    .then(([before, after]) => [...before.reverse(), a, ...after])
    .catch(() => [a]);
  chains.set(a.id, p);
  p.then(list => list.forEach(m => chains.has(m.id) || chains.set(m.id, p))); // same chain from any member
  return p;
}
