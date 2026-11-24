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
import { AUDIO_LANG, audioLanguageName, chooseAudio, normalizeDubLang, trackLang } from './audio-lang.js';
import { anikotoCandidates, anikotoEntry, anikotoEpisodes, findProven, generic, heavenSearch, matchOffset, parseTitle, pickPart, samePart, sameSeries, searchTitle } from './part-map.js';

const BASE = process.env.KOMA_ANIVAULT_URL || 'http://127.0.0.1:3000';
// The streaming server's port. It is 3000 unless the app shell had to move it
// (something else was already on that port), so the addresses it hands out are
// rewritten with the port it is actually on.
const BASE_PORT = (() => { try { return new URL(BASE).port || '80'; } catch { return '3000'; } })();

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

const rewrite = text => text
  .replaceAll(`http://127.0.0.1:${BASE_PORT}`, '')
  .replaceAll(`http://localhost:${BASE_PORT}`, '');

// The playlists and files the player itself loads are served by the streaming
// server directly when it lives on this same machine: the player's segment
// then takes one hop instead of crossing Koma's Node a second time, which is
// the whole difference on a small processor. A remote streaming server stays
// behind the same fence as everything else.
const BASE_ORIGIN = (() => { try { return new URL(BASE).origin; } catch { return BASE; } })();
const DIRECT = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(BASE_ORIGIN) ? BASE_ORIGIN : '';
const absoluteMedia = text => DIRECT
  ? text.replaceAll(`http://127.0.0.1:${BASE_PORT}`, DIRECT).replaceAll(`http://localhost:${BASE_PORT}`, DIRECT)
  : text;

function sendJson(res, status, body) {
  const buf = Buffer.from(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
  res.end(buf);
}

/** JSON API passthrough: /api/stream/<rest> -> AniVault /api/<rest>. */
const watchCache = new Map(); // "path?search" -> { at, status, body } — watch resolves take seconds upstream
const inflight = new Map();   // same key -> pending { status, body }, so a prefetch and the real request share one resolve
const WATCH_TTL = 60e3, WATCH_CAP = 32;

// The whole watch resolution has a budget. The browser gives up after two
// minutes (public/js/streaming.js), and a player that says "couldn't get a
// stream" while the server is still working says nothing useful: the reason
// never reaches the screen. So the server finishes inside its own budget and
// names what stopped it.
const WATCH_BUDGET = 90e3;

// AniVault tries a source's video servers one after another, and a dead one can burn 8-16s on
// timeouts before it moves on. So Koma remembers which server last worked (per source + sub/dub)
// and asks for it first (AniVault still falls back to the others if it fails).
// ponytail: one request per lookup on purpose. Racing all servers in parallel looked faster, but
// every AniVault request re-runs its site lookups (DesiDub's queue is one-at-a-time), so parallel
// requests just queue up behind each other.
const goodServer = new Map(); // "anikoto:sub" -> "HD-1"

async function upstreamJson(rest, search, req, ms) {
  const r = await call(`/api${rest}`, search, req, { signal: AbortSignal.timeout(ms) });
  let body = rewrite(await r.text().catch(() => '{"error":"The streaming server sent an unreadable response."}'));
  let data = null;
  try { data = JSON.parse(body); } catch { /* leave null */ }
  // A direct file the player is going to load can be served by the streaming
  // server itself, on this machine, without crossing Koma a second time.
  if (DIRECT && data?.mp4ProxyUrl?.startsWith('/')) {
    data.mp4ProxyUrl = DIRECT + data.mp4ProxyUrl;
    body = JSON.stringify(data);
  }
  return { status: r.status, body, data };
}

/* ---------- which language is the stream in? ----------
 *
 * The sites put several audio tracks into one playlist and mark the first as
 * the default, so the player takes Hindi when English was asked for. The
 * playlist says which track is which, and the track that was asked for is the
 * one that gets played — or, when the stream has no track in that language,
 * the stream is passed over for another one.
 */

const masters = new Map(); // search -> { at, text } — the master playlist of a stream
const MASTER_TTL = 10 * 60e3;

/**
 * The master playlist of a stream, as the streaming server proxies it.
 *
 * It is needed twice: once to see which languages the stream offers, and once
 * to hand it to the player. Keeping it here makes the second one a copy
 * instead of another trip to the site.
 */
async function masterPlaylist(search, ms = 30000) {
  const hit = masters.get(search);
  if (hit && Date.now() - hit.at < MASTER_TTL) return hit.text;
  const r = await call('/api/proxy/hls', search, null, { signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw Object.assign(new Error(`The playlist could not be read (${r.status}).`), { body: (await r.text().catch(() => '')).slice(0, 200) });
  const text = await r.text();
  masters.set(search, { at: Date.now(), text });
  return text;
}

/** The query behind a watch answer's playlist URL. */
function playlistQuery(r) {
  const url = r?.data?.hlsProxyUrl;
  if (!url) return '';
  const query = String(url).split('?')[1] || '';
  return query ? `?${query}` : '';
}

/**
 * Read the playlist the player is about to load.
 *
 * Null when the host refused it (a 502) or sent something that is not a
 * playlist at all. This is the file the viewer waits for, so a dead one has
 * to be caught here rather than in the player's spinner.
 */
async function readPlaylist(r, ms = 30000) {
  const search = playlistQuery(r);
  if (!search) return null;
  const text = await masterPlaylist(search, ms).catch(err => {
    console.error('[stream] the playlist did not load:', err?.message, '|', err?.body || '');
    return null;
  });
  if (!text || !text.trimStart().startsWith('#EXTM3U')) {
    console.error('[stream] the host did not send a playlist');
    return null;
  }
  return text;
}

/** Language declared by the selected source server, when the site provides it. */
function declaredLanguage(r) {
  const data = r?.data || {};
  return trackLang({ lang: data.dubGroup, name: data.dubGroup })
    || trackLang({ name: data.server })
    || (Array.isArray(data.audioTracks) && data.audioTracks.length === 1 ? trackLang(data.audioTracks[0]) : '');
}

/** The language the stream has to be in for the type that was asked for. */
function languageCheck(r, type, master, want = AUDIO_LANG[type]) {
  const mode = r?.data?.playbackMode;
  if (!want || r.status !== 200 || !['hls', 'mp4', 'iframe'].includes(mode)) return null;
  // English/sub sources historically carry one undocumented mixed track, so
  // their existing behavior stays intact. An explicit non-English dub must be
  // verified; otherwise an English source could silently win the request.
  const strict = type === 'dub' && want !== 'en';
  if (!strict && (mode === 'mp4' || mode === 'iframe')) return null;
  if (mode !== 'hls' || !r.data?.hlsProxyUrl) {
    const declared = declaredLanguage(r);
    return {
      ok: declared === want, want, tracks: [], unverified: !declared,
    };
  }
  if (!master) {
    const declared = strict ? declaredLanguage(r) : '';
    return strict ? { ok: declared === want, want, tracks: [], unverified: !declared } : null;
  }
  const chosen = chooseAudio(master, want, { strict });
  // DesiDub's direct playlists often have one muxed track and no EXT-X-MEDIA
  // tags. Its selected server can still explicitly name that track's language.
  if (strict && !chosen.tracks.length) {
    const declared = declaredLanguage(r);
    if (declared === want) return { ok: true, master, lang: null, tracks: [], want, verified: true };
    return { ...chosen, ok: false, want, unverified: !declared };
  }
  return { ...chosen, want };
}

function languageFailure(want, unverified = false) {
  const language = audioLanguageName(want);
  const error = unverified ? `This stream's ${language} audio could not be verified.` : `This stream has no ${language} audio.`;
  return { status: 404, body: JSON.stringify({ error }), data: { error }, langMismatch: true };
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

/**
 * Anikoto's own entry for this part: the entry and the episodes it holds.
 *
 * The title says which entry looks right; the site says which one is right.
 * Anikoto stamps every episode with the MAL id of the part it belongs to, so
 * when the names do not line up ("Rocky Joe 2" for "Tomorrow's Joe 2") the
 * stamp still proves which entry holds our part.
 */
async function ourPart(media, want, count, candidates) {
  const list = candidates || await anikotoCandidates(media.title.english || media.title.romaji || '').catch(() => []);

  const pick = pickPart(list, want, count);
  if (pick?.animeId) {
    const episodes = await anikotoEpisodes(pick.animeId, pick.slug).catch(() => []);
    if (episodes.length) {
      const mals = episodes.filter(e => e.mal).map(e => e.mal);
      if (!mals.length || !media.idMal || mals.includes(media.idMal)) {
        return { slug: pick.slug, episodes, proven: !!(media.idMal && mals.includes(media.idMal)) };
      }
    }
  }

  // The title says nothing useful. Ask the site which entry holds our part.
  const hit = await findProven(list, media.idMal).catch(() => null);
  return hit ? { slug: hit.slug, episodes: hit.episodes, proven: true } : null;
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

/**
 * Our part's episode titles, in our numbering.
 *
 * The sites copy their titles from the episode database, so it is the common
 * ground for telling which episode of a merged season is ours. Where the
 * site's own list says nothing ("Episode 12"), the database's title is used
 * instead — a title that says nothing cannot be matched against anything.
 */
async function ourTitles(media, siteEpisodes) {
  const titles = new Map();
  for (const e of siteEpisodes || []) if (e?.num) titles.set(Number(e.num), e);
  const named = [...titles.values()].every(e => !generic(e.title));
  if (!named) {
    const mal = await malEpisodes(media.idMal).catch(() => []);
    for (const e of mal) {
      const cur = titles.get(Number(e.num));
      if (!cur) titles.set(Number(e.num), e);
      else if (generic(cur.title) && !generic(e.title)) titles.set(Number(e.num), { ...cur, title: e.title });
    }
  }
  return [...titles.values()].sort((a, b) => a.num - b.num);
}

/**
 * Animeheaven's entry for this part — one entry per part, and the streaming
 * server takes its id.
 *
 * Two things have to agree before an entry is ours: its name and its number
 * of episodes. The name alone points at the wrong show ("My Hero Academia:
 * Vigilantes" is not "My Hero Academia Season 3"), and the count alone points
 * at the wrong season ("One Punch Man" and "One Punch Man 2" both hold
 * twelve).
 */
async function heavenPart(media, want, count) {
  const candidates = await heavenSearch(searchTitle(media.title.english || media.title.romaji || '')).catch(() => []);
  if (!candidates.length) return null;

  const named = candidates
    .map(c => ({ ...c, parsed: parseTitle(c.title) }))
    .filter(c => sameSeries(want.series, c.parsed.series));
  if (!named.length) return null;

  const checked = await Promise.all(named.map(async c => {
    const eps = await upstreamJson('/episodes', `?anilistId=${media.id}&source=animeheaven&heavenId=${c.id}`, null, 60000).catch(() => null);
    return { ...c, count: eps?.data?.count || 0, episodes: eps?.data?.episodes || [] };
  }));

  // The part holds as many episodes as the episode list says.
  const sized = count ? checked.filter(c => c.count === count) : checked;
  if (!sized.length) return null;
  // Of those, the one that names our part is ours.
  const same = sized.filter(c => samePart(want, c.parsed));
  if (!same.length) return null;
  return same[0];
}

const plans = new Map(); // anilistId -> { at, plan }
const PLAN_TTL = 30 * 60e3;

/* ---------- can this machine reach the sources at all? ---------- *
 *
 * The source sites are other people's servers. On a network that filters or
 * blocks them, every episode comes back as "not found" with no reason at all,
 * and the app looks broken rather than blocked. So when a watch fails, the
 * sites are asked directly - from this machine - and the answer can name the
 * one that is out of reach.
 *
 * The answer is remembered for a minute: the next attempt fails the same way,
 * and the check should not be paid for twice.
 */
const SOURCE_SITES = process.env.KOMA_SOURCE_SITES
  // A different set of sources can be named, for a mirror or for a test.
  ? process.env.KOMA_SOURCE_SITES.split(',').filter(Boolean).map(s => {
    const [group, name, host] = s.split('|');
    return { group: group || 'catalogue', name: name || host, host: host || name };
  })
  : [
    { group: 'catalogue', name: 'Anikoto', host: 'anikoto.net' },
    { group: 'catalogue', name: 'AnimeHeaven', host: 'animeheaven.me' },
    { group: 'playback', name: 'Megaplay', host: 'megaplay.buzz' },
    { group: 'playback', name: 'Vidwish', host: 'vidwish.live' },
    { group: 'playback', name: 'Vidtube', host: 'vidtube.site' },
  ];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

let sourceHealth = { at: 0, sites: [] };
async function checkSources() {
  if (Date.now() - sourceHealth.at < 60e3) return sourceHealth.sites;
  const sites = await Promise.all(SOURCE_SITES.map(async s => {
    try {
      const r = await fetch(`https://${s.host}/`, {
        method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(6000),
        headers: { 'user-agent': UA, accept: 'text/html,*/*' },
      });
      // The sites that only answer the exact request they are given still
      // count as reachable as soon as they answer at all.
      return { ...s, ok: r.status > 0 && r.status < 400, status: r.status };
    } catch (err) {
      return { ...s, ok: false, error: err.cause?.code || err.name || 'no answer' };
    }
  }));
  sourceHealth = { at: Date.now(), sites };
  return sites;
}

/** What is out of reach, in a sentence that can be shown to the viewer. */
async function sourceProblem(sites = null) {
  const list = sites || await checkSources().catch(() => []);
  const catalogue = list.filter(s => s.group === 'catalogue' && !s.ok);
  const playback = list.filter(s => s.group === 'playback' && !s.ok);
  const parts = [];
  if (catalogue.length) parts.push(`the source sites ${catalogue.map(s => s.name).join(' and ')} could not be reached (${catalogue.map(s => s.error || `answered ${s.status}`).join(', ')})`);
  if (playback.length) parts.push(`the video hosts ${playback.map(s => s.name).join(' and ')} could not be reached (${playback.map(s => s.error || `answered ${s.status}`).join(', ')})`);
  return parts.length ? ` ${parts.join('; ')}.` : '';
}

/**
 * The plan for one show: which entries really hold the part that was asked
 * for, and how their episodes are numbered.
 *
 * More than one option when the part is not where the streaming server looked:
 * Anikoto and AnimeHeaven can split a show into different entries. Which of
 * them has subs or English dubs is the streaming server's business — the watch
 * tries them in turn.
 */
async function buildPlan(anilistId) {
  const media = await mediaOf(anilistId).catch(() => null);
  // The catalog could not be reached, so nothing about the part can be checked.
  // This plan is weak: it is never kept, so the next attempt tries again.
  if (!media) return { ok: true, weak: true, options: [{ source: 'anikoto', offset: 0 }], episodes: [] };
  const title = media.title.english || media.title.romaji || media.title.native || '';
  const want = parseTitle(title);
  const count = media.episodes || 0;

  const anik = await upstreamJson('/episodes', `?anilistId=${anilistId}&source=anikoto`, null, 60000).catch(() => null);
  const entry = anik?.data;
  const own = entry?.siteId ? await anikotoEntry(entry.siteId).catch(() => null) : null;

  // The entry is this part — or the site would not say — so play it as it is.
  if (entry?.siteId && (!own || !own.mal || !media.idMal || own.mal === media.idMal)) {
    // The site could not be read to check the entry, or came back empty. That
    // is a weak answer: it is not kept, so the next attempt reads the site
    // again instead of living with it for half an hour.
    const weak = !own || !entry.episodes?.length;
    // The site's own list often says nothing but "Episode 12" — the episode
    // database names them, and a grid of numbers is not a list of episodes.
    const episodes = await ourTitles(media, entry.episodes).catch(() => entry.episodes || []);
    return { ok: true, weak, options: [{ source: 'anikoto', siteId: entry.siteId, offset: 0 }], episodes };
  }

  // The entry belongs to another part — or the streaming server has no entry
  // for this show at all. Find the ones that hold ours.
  const mine = await ourPart(media, want, count);
  // Our part's episode titles, from whoever names them the same way the sites
  // do — the site's own entry first, then the episode list the database has.
  const titles = await ourTitles(media, mine?.episodes || []);
  const options = [];

  // The entry that proves it holds our part, played by name. The streaming
  // server picks its entry by comparing titles, which is how a second cour
  // ended up on the first one's entry; this is the entry the site itself
  // stamps as ours, and it is handed over instead of guessed at.
  //
  // The entry has to hold the whole part: one that holds only some of its
  // episodes is not this part, and playing it would leave the rest missing.
  if (mine?.proven && (!count || mine.episodes.length === count)) {
    options.push({ source: 'anikoto', anikotoId: mine.slug, siteId: mine.slug, offset: 0 });
  }

  // The entry the streaming server found may still hold the whole season —
  // then our part starts further in.
  if (titles.length && entry?.episodes?.length) {
    const offset = matchOffset(titles, entry.episodes);
    if (offset >= 0) options.push({ source: 'anikoto', siteId: entry?.siteId, offset });
  }

  const heaven = await heavenPart(media, want, count);
  if (heaven) options.push({ source: 'animeheaven', heavenId: heaven.id, siteId: heaven.id, offset: 0 });

  if (!options.length) {
    // The sites have this part — we know which entry — but the streaming
    // server is serving another part of the show and cannot be pointed at
    // ours. Say that, instead of pretending the part is not there.
    // And if the sites could not be reached at all, say that too: a network
    // that blocks them looks exactly like a show that is not there.
    const blocked = await sourceProblem();
    return {
      ok: false,
      error: (mine
        ? 'This part of the show is on the sites, but the streaming server is serving another part of it.'
        : 'This part of the show could not be found on the streaming sources.') + blocked,
    };
  }
  return { ok: true, options, episodes: titles, fixed: true };
}

async function planFor(anilistId) {
  const hit = plans.get(anilistId);
  if (hit && Date.now() - hit.at < PLAN_TTL) return hit.plan;
  const plan = await buildPlan(anilistId).catch(err => ({ ok: false, error: err?.message || 'The streaming sources could not be checked.' }));
  // A plan that could not be checked is not kept: the next attempt tries again
  // instead of living with a bad answer for half an hour.
  if (!plan.weak) plans.set(anilistId, { at: Date.now(), plan });
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
  const want = type === 'dub' ? AUDIO_LANG.dub : AUDIO_LANG.sub;
  // Everything below happens inside this budget. A source that hangs must not
  // push the answer past the browser's patience - and the viewer has to be
  // told what stopped it.
  //
  // The browser says how long it is still waiting (x-koma-deadline), so the
  // server finishes a little before the browser gives up. Its answer - with
  // the reason in it - still reaches the screen.
  const askedMs = Number(req?.headers?.['x-koma-deadline']);
  const room = Number.isFinite(askedMs) && askedMs > 0 ? askedMs : WATCH_BUDGET;
  const deadline = Date.now() + Math.max(5000, Math.min(WATCH_BUDGET, room - 8000));
  const options = [];
  const anilistId = q.get('anilistId');
  if (anilistId) {
    // The plan says which entries really hold this part of the show, and how
    // their episodes are numbered. Without it a second cour can play the first.
    // It is built by asking the sites, so on a network that filters them it
    // can take minutes - and the viewer cannot wait that long.
    const plan = await firstAnswer(planFor(anilistId), deadline - Date.now(), null);
    if (!plan) return timedOut('The streaming sources took too long to answer from this network.');
    if (!plan.ok) return { status: 404, body: JSON.stringify({ error: plan.error }) };
    options.push(...(plan.options?.length ? plan.options : [{ source: q.get('source') || 'anikoto', offset: 0 }]));
  } else {
    options.push({ source: q.get('source') || 'anikoto', offset: 0 });
  }
  // The source the page asked for is tried as well: a site that refuses its
  // playlists should not stop the other site from playing the episode.
  const asked = q.get('source');
  if (asked && !options.some(o => o.source === asked)) options.push({ source: asked, offset: 0 });
  if (type === 'dub') {
    // English dub only: never send an old regional deep link to DesiDub.
    const english = options.filter(o => o.source !== 'desidub');
    options.splice(0, options.length, ...(english.length ? english : [{ source: 'anikoto', offset: 0 }]));
  }
  let last = null, mismatch = null, ranOut = false;
  for (const opt of options) {
    if (Date.now() >= deadline) { ranOut = true; break; }
    const r = await watchOn(opt, q, req, type, deadline, want);
    if (r.status === 200) return r;
    if (r.langMismatch) mismatch = r;
    last = r;
    // 404: this source has no such episode. 502: it has one, but the host
    // refuses to serve it — the next source may still play it.
    if (r.status !== 404 && r.status !== 502) break;
  }
  // The stream was there, but not in the language that was asked for: that is
  // the more useful answer than "no source could play that episode".
  if (mismatch) return mismatch;

  // The sources did not answer in time. That is worth saying plainly, and the
  // sites are asked what was wrong with them - a site that cannot be reached
  // from this network is the reason the answer was late.
  if (ranOut) {
    return timedOut('The streaming sources took too long to answer from this network.');
  }

  // The streaming server's own answer is often a bare "Not found" - it cannot
  // know that the source site is out of reach, because that is a question
  // about this network and only this machine can answer it. So the sites are
  // asked from here, and the answer is put into the message the viewer reads.
  const blocked = await sourceProblem();
  const final = last || { status: 404, data: null };
  if (final.status === 404 || final.status === 502) {
    const said = String(final.data?.error || '').trim();
    const bare = !said || /^(not found|notfound|all servers failed|no source could play that episode\.?)$/i.test(said);
    // The reason is added once: a message that already carries it is left alone.
    const reason = blocked && !said.includes(blocked.trim()) ? blocked : '';
    const error = (bare ? 'This part of the show could not be found on the streaming sources.' : said) + reason;
    const data = { ...(final.data || {}), error };
    return { ...final, body: JSON.stringify(data), data };
  }
  return final;
}

/** The answer when something did not answer in time - and what was wrong with it. */
async function timedOut(sentence) {
  const error = sentence + await sourceProblem();
  return { status: 504, body: JSON.stringify({ error }), data: { error } };
}

/**
 * The answer has to arrive while the browser is still waiting.
 *
 * The browser says how long it is willing to wait (x-koma-deadline). The work
 * goes on in the background - it fills the caches, and it may still find the
 * stream - but the viewer gets an answer that says what is wrong instead of a
 * spinner that never ends.
 *
 * `late` is the answer for "it took too long". It is a function so that the
 * check of the source sites only runs when it is actually needed.
 */
function firstAnswer(work, ms, late) {
  let timer;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve(typeof late === 'function' ? late() : late), Math.max(0, ms));
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

/** The same watch request, pinned to one mirror of the episode. */
function pinnedTo(p, server, fresh = false) {
  const q = new URLSearchParams(String(p));
  q.set('server', server);
  q.set('strict', '1'); // this mirror only — the walk wants to know this one
  if (fresh) q.set('nocache', '1'); // resolve the link from scratch, not from what was kept
  return q;
}

/** One source, one episode — the episode number the way that source counts it. */
export { checkSources, sourceProblem };

export async function watchOn(opt, q, req, type, deadline, want = AUDIO_LANG[type] || AUDIO_LANG.sub) {
  // Every call in here is given only the time that is left. A mirror that
  // hangs must not eat the whole budget: the other mirrors and the other
  // sources still have to be tried inside it.
  const until = deadline || (Date.now() + WATCH_BUDGET);
  const left = () => Math.max(0, until - Date.now());
  const p = new URLSearchParams(q);
  p.set('source', opt.source);
  if (opt.heavenId) p.set('heavenId', opt.heavenId); else p.delete('heavenId');
  if (opt.anikotoId) p.set('anikotoId', opt.anikotoId); else p.delete('anikotoId');
  if (opt.desidubId) p.set('desidubId', opt.desidubId); else p.delete('desidubId');
  p.delete('dubLang'); // Koma's preference is not part of AniVault's API.
  const ep = Number(p.get('ep') || 0) + (opt.offset || 0);
  if (Number.isFinite(ep)) p.set('ep', String(ep));
  const key = `${opt.source}:${type}:${want || ''}`;
  const remembered = !p.has('server') && goodServer.get(key);
  if (remembered) p.set('server', remembered);
  let r = null, why = '';
  try {
    r = await upstreamJson('/watch', String(p) ? `?${p}` : '', req, Math.min(120000, left() || 1));
  } catch (err) {
    // A refused connection means the server is not there; a timeout means it
    // is there and busy. Those are different problems and get different words.
    why = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'down';
  }
  if (!r) {
    if (why === 'down') return { status: 503, body: OFFLINE, data: { error: JSON.parse(OFFLINE).error } };
    if (left() <= 0) return timedOut('The streaming sources took too long to answer from this network.');
    // The streaming server did not answer in time. That is the reason, and it
    // is said: "not running" would be a guess. The sites are asked as well -
    // a source site that cannot be reached is what makes it hang.
    return timedOut('The streaming server took too long to answer.');
  }
  if (r.status !== 200) {
    if (remembered) goodServer.delete(key);
    return r;
  }

  // Which entry is playing: the one that was proven to hold this part of the
  // show. The streaming server does not say, so it is said here.
  if (r.data && opt.siteId && !r.data.siteId) {
    r.data.siteId = opt.siteId;
    r.body = JSON.stringify(r.data);
  }

  // Direct files retain their historic English/sub behavior. Regional dubs
  // still walk the other mirrors: a later one may be HLS or name its language.
  if ((r.data?.playbackMode === 'mp4' || r.data?.playbackMode === 'iframe') && (type !== 'dub' || want === 'en')) return r;

  // The answer names the playlist the player will load, and a mirror can hand
  // back a link the host then refuses — the playlist answers 502 and the
  // viewer gets a spinner and nothing else. So the playlist is read here, and
  // the other mirrors of the episode are tried until one actually answers.
  const mirrors = [...new Set([r.data?.server, ...(r.data?.availableServers || [])].filter(s => typeof s === 'string' && s))];
  let answer = null, answerLang = null, mismatch = null;
  for (const server of mirrors) {
    if (left() <= 0) break;
    let candidate = server === r.data?.server
      ? r
      : await upstreamJson('/watch', `?${pinnedTo(p, server)}`, req, Math.min(120000, left() || 1)).catch(() => ({ status: 0, body: '', data: null }));
    if (candidate.status !== 200) continue;
    const direct = candidate.data?.playbackMode === 'mp4' || candidate.data?.playbackMode === 'iframe';
    if (!direct && !candidate.data?.hlsProxyUrl) continue;
    let text = null;
    if (!direct) {
      text = await readPlaylist(candidate, Math.min(30000, left() || 1));
      if (!text) {
        // The host refused the link. It may be the link that was signed with a
        // key the site has since changed, so the mirror is resolved once more
        // from scratch before it is given up on.
        if (left() <= 0) break;
        const again = await upstreamJson('/watch', `?${pinnedTo(p, server, true)}`, req, Math.min(120000, left() || 1)).catch(() => ({ status: 0, body: '', data: null }));
        if (again.status === 200 && again.data?.hlsProxyUrl) {
          candidate = again;
          text = await readPlaylist(again, Math.min(30000, left() || 1));
        }
        if (!text) {
          console.error(`[stream] ${server}: the playlist did not load — trying the next mirror`);
          continue;
        }
      }
    }
    // A playable mirror in the wrong language is not a match. Keep walking:
    // another mirror of the same episode may carry the requested track.
    const lang = languageCheck(candidate, type, text, want);
    if (lang && !lang.ok) { mismatch = lang; continue; }
    answer = candidate;
    answerLang = lang;
    break;
  }
  if (!answer) {
    if (mismatch) {
      if (remembered) goodServer.delete(key);
      return languageFailure(mismatch.want, mismatch.unverified);
    }
    // The host refused the playlist. When the host itself cannot be reached
    // from this network, that is worth saying: it is not the episode's fault.
    // And when the budget ran out, the mirrors were never all tried - that is
    // the honest reason.
    const late = left() <= 0;
    if (remembered) goodServer.delete(key);
    const error = (late
      ? 'The streaming sources took too long to answer from this network.'
      : 'The streaming host refused the playlist for this episode.') + await sourceProblem();
    return { status: late ? 504 : 502, body: JSON.stringify({ error }), data: { error } };
  }
  // Only a playable mirror in the requested language is worth remembering.
  if (answer.data?.server && answer.data?.playbackMode !== 'iframe') goodServer.set(key, answer.data.server);
  else goodServer.delete(key);

  // The playlist says which track to play, so the player is told.
  if (answerLang?.ok && !answerLang.verified && answer.data?.hlsProxyUrl) {
    answer.data.hlsProxyUrl += (answer.data.hlsProxyUrl.includes('?') ? '&' : '?') + `lang=${encodeURIComponent(answerLang.want)}`;
    answer.body = JSON.stringify(answer.data);
  }
  return answer;
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

/* ---------- episode thumbnails for the grid ---------- *
 *
 * The sources and AniList only carry pictures for the handful of episodes
 * their own listings name (a Crunchyroll page's latest cour, say), so a long
 * show's grid is numbers instead of pictures. The episode database has a
 * still for every episode, and AniVault reads it per episode — so a page of
 * the grid asks for its own range, and the answers are kept.
 */
const thumbsCache = new Map(); // "anilistId:from:to" -> { at, thumbs }
const THUMBS_TTL = 24 * 60e3;

async function episodeThumbs(search) {
  const q = new URLSearchParams(search || '');
  const anilistId = q.get('anilistId');
  if (!anilistId) return null;
  const from = Math.max(1, Number(q.get('from')) || 1);
  const to = Math.min(3000, Math.max(from, Number(q.get('to')) || from));
  const key = `${anilistId}:${from}:${to}`;
  const hit = thumbsCache.get(key);
  if (hit && Date.now() - hit.at < THUMBS_TTL) return { thumbs: hit.thumbs };
  const media = await mediaOf(anilistId).catch(() => null);
  if (!media?.idMal) return { thumbs: {} };
  const nums = [];
  for (let n = from; n <= to; n++) nums.push(n);
  const thumbs = { ...(hit?.thumbs || {}) };
  await Promise.all(nums.map(async n => {
    if (thumbs[n]) return;
    const r = await upstreamJson('/kitsu/episode-thumb', `?malId=${media.idMal}&ep=${n}`, null, 20000).catch(() => null);
    if (r?.data?.data?.thumbnail) thumbs[n] = r.data.data.thumbnail;
  }));
  thumbsCache.set(key, { at: Date.now(), thumbs });
  return { thumbs };
}

export async function proxyJson(req, res, rest, search) {
  // Pictures for a page of the episode grid: asked for lazily, per page.
  if (rest === '/episode-thumbs' && /(^|[?&])anilistId=/.test(search || '')) {
    const t = await episodeThumbs(search).catch(() => null);
    if (t) return sendJson(res, 200, JSON.stringify(t));
  }
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
  // Old regional links share the English answer instead of creating their own
  // cache entries or triggering a source path Koma no longer offers.
  if (q.get('type') === 'dub') q.set('dubLang', 'en');
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
  if (cacheable) {
    inflight.set(key, job);
    // The inflight entry goes when the work is really done. An answer that
    // was sent early - because the viewer stopped waiting - does not end the
    // work: it may still find the stream, and the next request can have it.
    job.catch(() => {}).finally(() => { if (inflight.get(key) === job) inflight.delete(key); });
  }
  let r;
  try {
    if (rest !== '/watch') {
      r = await job;
    } else {
      // The browser says how long it is willing to wait. The answer has to be
      // written before that time is up - and the check of the source sites
      // needs a moment of its own.
      const askedMs = Number(req?.headers?.['x-koma-deadline']);
      const room = Number.isFinite(askedMs) && askedMs > 0 ? askedMs : WATCH_BUDGET;
      r = await firstAnswer(job, Math.max(3000, room - 12000), () => timedOut('The streaming sources took too long to answer from this network.'));
    }
  } catch {
    // A watch that threw is a watch that ran out of time: the answer says so,
    // and names the site that is out of reach when there is one.
    if (rest === '/watch') {
      const late = await timedOut('The streaming sources took too long to answer from this network.');
      return sendJson(res, late.status, late.body);
    }
    return sendJson(res, 503, OFFLINE);
  }
  if (cacheable && r.status === 200) {
    if (watchCache.size >= WATCH_CAP) watchCache.delete(watchCache.keys().next().value);
    watchCache.set(key, { at: Date.now(), status: r.status, body: r.body });
  }
  sendJson(res, r.status, r.body);
}

/** Take one parameter out of a query, leaving the others exactly as they were. */
function withoutParam(search, name) {
  const q = String(search || '').replace(/^\?/, '');
  if (!q) return { value: '', search: '' };
  const kept = [];
  let value = '';
  for (const part of q.split('&')) {
    const key = part.split('=')[0].trim().toLowerCase();
    if (key === name) {
      try { value = decodeURIComponent(part.slice(key.length + 1)); } catch { value = part.slice(key.length + 1); }
    } else kept.push(part);
  }
  return { value, search: kept.length ? `?${kept.join('&')}` : '' };
}

/** Media passthrough: /api/proxy/hls|video|subtitle -> AniVault, streamed.
 * Playlists and subtitles get the host rewrite; everything else is streamed
 * as raw bytes. CDNs sometimes disguise MPEG-TS segments with a text/html
 * content-type, so never trust the content-type alone — peek at the first
 * bytes of hls payloads to tell playlists from media.
 *
 * A playlist that says which language it wants is served with only that
 * language's track in it, so the player cannot pick the wrong one. */
export async function proxyMedia(req, res, path, search) {
  const isHls = path.startsWith('/api/proxy/hls');
  const { value: wantLang, search: forwarded } = withoutParam(search, 'lang');
  const strictLang = Boolean(wantLang) && !['en', 'ja'].includes(normalizeDubLang(wantLang));

  // The master playlist was read when the stream was resolved: serve that
  // copy, narrowed to the language that was asked for.
  if (isHls && wantLang) {
    const hit = masters.get(forwarded);
    if (hit && Date.now() - hit.at < MASTER_TTL) {
      const chosen = chooseAudio(hit.text, wantLang, { strict: strictLang });
      if (chosen.ok) {
        const out = Buffer.from(absoluteMedia(chosen.master));
        res.writeHead(200, {
          'Access-Control-Allow-Origin': '*',
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Content-Length': out.length,
          'Cache-Control': 'no-store',
        });
        return res.end(req.method === 'HEAD' ? undefined : out);
      }
    }
  }

  let upstream;
  try {
    upstream = await call(path, forwarded, req, { signal: AbortSignal.timeout(60000) });
  } catch {
    return sendJson(res, 503, OFFLINE);
  }
  const type = String(upstream.headers.get('content-type') || '');
  const headers = { 'Access-Control-Allow-Origin': '*' };
  for (const h of FORWARDED) {
    const v = upstream.headers.get(h);
    if (v && h !== 'content-length') headers[h] = v;
  }

  /** The playlist, with only the language that was asked for left in it. */
  const narrow = text => {
    if (!isHls || !wantLang) return { ok: true, text };
    if (!text.trimStart().startsWith('#EXTM3U')) return { ok: true, text };
    const chosen = chooseAudio(text, wantLang, { strict: strictLang });
    return { ok: chosen.ok, text: chosen.master };
  };
  const noLanguage = () => sendJson(res, 404, JSON.stringify({ error: 'This stream has no audio in the language that was asked for.' }));

  const asText = path.startsWith('/api/proxy/subtitle') || /vtt|mpegurl/i.test(type);
  if (asText) {
    const body = await upstream.text().catch(() => '');
    const narrowed = narrow(body);
    if (!narrowed.ok) return noLanguage();
    // A playlist is the player's to load: its media points at the streaming
    // server itself. A subtitle stays same-origin with the master it rode in.
    const out = Buffer.from(isHls ? absoluteMedia(narrowed.text) : rewrite(narrowed.text));
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

  if (!isHls) { res.writeHead(upstream.status, headers); return stream.pipe(res); } // video: pure binary

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
    const narrowed = narrow(Buffer.concat(chunks).toString('utf8'));
    if (!narrowed.ok) return noLanguage();
    const out = Buffer.from(absoluteMedia(narrowed.text));
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
