// The diagnosis: what is working on this machine, and what is not.
//
// Koma is a local app that leans on other people's servers - the streaming
// sources, the catalogue, the video hosts. When one of them cannot be reached
// from this network, episodes come back as "not found" (404) and the app looks
// broken with no reason on screen. This module asks every one of them and says
// plainly what the answer was.
//
// It also checks the local servers: another program sitting on Koma's port
// answers 404 for everything, and that looks exactly like a broken app.
const dns = require('node:dns').promises;
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The sites the streaming chain reads, and what breaks without each one.
// `critical` marks the ones Koma cannot do without; the rest are spares, and
// a spare being out of reach is worth knowing but is not a broken app.
//
// The path is the one the scraper actually uses: a site that answers the front
// page with a challenge or a refusal still blocks the app, and the report has
// to say so.
const UPSTREAM = [
  { name: 'Anikoto', host: 'anikoto.net', why: 'where most episodes are found', critical: true, path: '/filter?keyword=naruto' },
  { name: 'AnimeHeaven', host: 'animeheaven.me', why: 'the second source', critical: true, path: '/fastsearch.php?xhr=1&s=naruto' },
  { name: 'DesiDub', host: 'www.desidubanime.me', why: 'dubbed episodes', critical: false, path: '/' },
  { name: 'AniVault database', host: 'api.anify.tv', why: 'the entry for each show', critical: true, path: '/info/21' },
  { name: 'AniList', host: 'graphql.anilist.co', why: 'the catalogue', critical: true, body: JSON.stringify({ query: '{Media(id:21){id title{english}}}' }) },
  { name: 'Megaplay', host: 'megaplay.buzz', why: 'the player', critical: true, path: '/' },
  { name: 'Vidwish', host: 'vidwish.live', why: 'a mirror', critical: false, path: '/' },
  { name: 'Vidtube', host: 'vidtube.site', why: 'a mirror', critical: false, path: '/' },
  // These only answer the exact request they are asked for, so what matters is
  // that the network lets this machine through at all.
  { name: 'Nexabloom', host: 'fetch.nexabloom.top', why: 'where the video files come from', critical: true, path: '/', reachOnly: true },
  { name: 'Megacloud keys', host: 'raw.githubusercontent.com', why: 'the keys the player needs', critical: false, path: '/' },
  { name: 'Mapper', host: 'mapper.nekostream.site', why: 'the keys the player needs', critical: false, path: '/', reachOnly: true },
  { name: 'Mapper (mirror)', host: 'mapper.mewcdn.online', why: 'the keys the player needs', critical: false, path: '/', reachOnly: true },
  { name: 'Megacloud resolver', host: 'megacloud-api-nine.vercel.app', why: 'the resolver', critical: false, path: '/', reachOnly: true },
];

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Ask a URL for its answer, without waiting forever. */
async function ask(url, { timeout = 8000, headers = {}, method = 'GET', body = '' } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'manual',
      method,
      body: body || undefined,
      headers: { 'user-agent': UA, ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
    });
    const text = await r.text().catch(() => '');
    return { status: r.status, body: text.slice(0, 400), error: '' };
  } catch (err) {
    return { status: 0, body: '', error: err.name === 'AbortError' ? 'timed out' : (err.cause?.code || err.message || 'failed') };
  } finally {
    clearTimeout(timer);
  }
}

/** Ask a local server who it is. Only Koma and the streaming server say their name. */
async function identify(url, expect, headers = {}, marker = null) {
  const r = await ask(url, { timeout: 4000, headers });
  let app = '';
  let version = '';
  try {
    const data = JSON.parse(r.body);
    app = data.app || '';
    version = data.version || '';
  } catch { /* not something that answers in JSON */ }
  // A server that answers the way ours does, but without the key: still ours.
  const marked = !!marker && r.status === marker.status && (!marker.contains || r.body.includes(marker.contains));
  return { status: r.status, app, version, ours: app === expect || marked, error: r.error };
}

/**
 * Who is on Koma's port.
 *
 * A Koma from before /api/koma existed still answers /api/stream-status, so
 * that is the second question — a program that answers 404 for everything is
 * not Koma, and must not be mistaken for it.
 */
async function identifyKoma(port) {
  const r = await identify(`http://127.0.0.1:${port}/api/koma`, 'koma');
  if (r.ours) return { ...r, old: false };
  const s = await ask(`http://127.0.0.1:${port}/api/stream-status`, { timeout: 4000 });
  if (s.status === 200 || s.status === 503) {
    let ok = false;
    try { ok = typeof JSON.parse(s.body).ok === 'boolean'; } catch { /* not Koma's answer */ }
    if (ok) return { status: s.status, app: 'koma', version: '', ours: true, old: true, error: '' };
  }
  return { ...r, old: false };
}

/** One of the outside sites: can this machine reach it at all? */
async function hostCheck(h) {
  const out = { ...h, dns: '', status: 0, ok: false, error: '' };
  // DNS has no timeout of its own, and a resolver that never answers would
  // hold the whole report hostage.
  try {
    const addrs = await Promise.race([
      dns.lookup(h.host, { all: true }),
      new Promise((_, no) => setTimeout(() => no(new Error('DNS timed out')), 5000)),
    ]);
    out.dns = addrs.map(a => a.address).join(', ');
  } catch (err) {
    out.error = `DNS failed (${err.code || err.message})`;
  }
  const r = await ask(`https://${h.host}${h.path || '/'}`, { timeout: 9000, method: h.body ? 'POST' : 'GET', body: h.body || '' });
  out.status = r.status;
  if (r.error) out.error = out.error || r.error;
  // A site that answers with a refusal (403, 429) is reachable but refuses to
  // serve the app - that is a problem, and the report says so. The hosts that
  // only answer the exact request they are given are counted as reachable as
  // soon as they answer at all.
  out.ok = r.status > 0 && (h.reachOnly || r.status < 400);
  return out;
}

/** The addresses this machine has. Koma itself only ever listens on 127.0.0.1. */
function addresses() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family !== 'IPv4' && ni.family !== 4) continue;
      if (ni.internal) continue;
      out.push({ name, address: ni.address });
    }
  }
  return out;
}

/** The last complaints in the logs - the lines that say what went wrong. */
function logProblems(logDir) {
  const out = [];
  for (const name of ['koma.log', 'anivault.log', 'allanime.log']) {
    const file = path.join(logDir, name);
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const lines = text.split('\n').filter(Boolean).slice(-600);
    const problems = lines.filter(l => /error|fail|refus|timeout|ENOTFOUND|ECONN|403|404|429|blocked|certificate|offline|empty/i.test(l));
    out.push({ name, lines: lines.length, problems: problems.slice(-12) });
  }
  return out;
}

/**
 * The whole report.
 *
 * `port` is the port Koma's own site runs on, `streamPort` the one the
 * streaming server ended up on (it moves when 3000 is taken by something else).
 */
async function diagnose({ port = 4000, streamPort = 3000, allAnimePort = 8000, anivaultKey = '', logs = '', version = '' } = {}) {
  const key = anivaultKey ? { 'x-anivault-api-key': anivaultKey } : {};

  // The three local servers are asked at the same time: one that is not
  // answering must not hold the others up.
  const [koma, stream, allAnime] = await Promise.all([
    identifyKoma(port),
    identify(`http://127.0.0.1:${streamPort}/api/ping`, 'anivault', key, { status: 403, contains: 'Forbidden' }),
    ask(`http://127.0.0.1:${allAnimePort}/`, { timeout: 4000 }),
  ]);

  const servers = [
    {
      name: 'Koma (the site)',
      port,
      ok: koma.ours,
      detail: koma.ours
        ? `running here${koma.version ? `, version ${koma.version}` : koma.old ? ' (an older Koma)' : ''}`
        : koma.status
          ? `another program is on port ${port} (it answered ${koma.status})`
          : koma.error
            ? `not answering (${koma.error})`
            : 'not running',
    },
    {
      name: 'Streaming server',
      port: streamPort,
      ok: stream.ours,
      detail: stream.ours
        ? 'running here'
        : stream.status
          ? `another program is on port ${streamPort} (it answered ${stream.status})`
          : stream.error
            ? `not answering (${stream.error})`
            : 'not running',
    },
    {
      name: 'Sub and dub counter',
      port: allAnimePort,
      ok: allAnime.status === 200,
      detail: allAnime.status === 200
        ? 'running here'
        : allAnime.error
          ? `not answering (${allAnime.error})`
          : `answered ${allAnime.status}`,
    },
  ];

  const hosts = await Promise.all(UPSTREAM.map(hostCheck));

  return {
    at: new Date().toISOString(),
    version,
    port,
    streamPort,
    servers,
    hosts,
    addresses: addresses(),
    logs: logProblems(logs),
  };
}

module.exports = { diagnose, identify, identifyKoma, ask, hostCheck, addresses, logProblems, UPSTREAM };
