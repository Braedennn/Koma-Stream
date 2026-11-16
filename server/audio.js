// Sub/dub episode-count badges for cards. Counts come from the local
// AllAnime server (its search index carries availableEpisodes per show, and
// its thumbnails are AniList CDN URLs, so an AniList id can be matched by the
// "bx<id>" in the URL — no fuzzy guessing needed). Results are cached to
// .data/audio.json so each anime is looked up once, effectively ever.
//
// The upstream AllAnime API rate-limits bursts, so lookups go out in small
// paced batches: one AniList query titles the whole batch, then one search
// per title with a gap between requests. Repeated upstream failures open a
// circuit breaker that idles the queue for a while instead of hammering.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { gql } from './anilist.js';
import { anilistIdOf, countsOf, ensureDubIndex, dubIndexReady, dubIndexSettled } from './dubindex.js';

const ALLANIME = process.env.KOMA_ALLANIME_URL || 'http://127.0.0.1:8000';
const FILE = fileURLToPath(new URL('../.data/audio.json', import.meta.url));
// The packaged app carries the latest known counts with it, so the first
// launch can answer a language filter without the desktop catalogue server.
const SEED_FILE = fileURLToPath(new URL('./data/audio.json', import.meta.url));
const HIT_TTL = 7 * 86400e3;   // known counts: recheck weekly
const MISS_TTL = 86400e3;      // not indexed / offline: retry the next day, not three days later
const SOFT_TTL = 60e3;         // the catalogue answered empty — throttling, most likely: ask again in a minute
const EMPTY_AFTER = 3;         // consecutive empty catalogue answers = the upstream is throttling
const EMPTY_PAUSE_MS = 60e3;   // how long the queue idles when that happens
const CONFIRM_TRIES = 2;       // the catalogue must answer twice before a show is written off
const MAX_SOFT_TRIES = 8;      // ... and not more often than this
const FLIP_WINDOW = 15 * 60e3; // how long two answers for the same title are compared
const BATCH = 8;               // ids resolved per AniList+search round
const PACE_MS = 350;           // gap between upstream searches
const GAP_MS = 250;            // gap between the title variants of one id
const BREAK_AFTER = 4;         // consecutive upstream failures before pausing
const PAUSE_MS = 10 * 60e3;    // how long the breaker stays open

const cache = new Map(); // id -> { sub, dub } | { miss: true } | { soft: true }, plus .at/.tries
let saveTimer;
let running = false;
const queue = [];
let consecFails = 0;
let emptyStreak = 0;   // lookups in a row the catalogue answered with nothing
let pausedUntil = 0;
// What the catalogue answered for a title the last time it was asked. Under
// load its answers change from minute to minute — the same title comes back
// with other shows in it — so two answers that disagree mean the answer
// cannot be trusted.
const querySeen = new Map(); // title -> { sig, at }

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function load() {
  let raw = null;
  for (const file of [SEED_FILE, FILE]) {
    try {
      const candidate = JSON.parse(await readFile(file, 'utf8'));
      if (candidate && typeof candidate === 'object') raw = { ...(raw || {}), ...candidate };
    } catch { /* no file yet, or an unreadable one */ }
  }
  // Hard misses are dropped on boot: they predate the fallback sources, and
  // each one re-attempts as soon as a card asks anyway.
  for (const [id, v] of Object.entries(raw || {})) {
    if (v.miss) continue;
    // Soft misses keep their attempt count (so a show the catalogue never
    // lists can still graduate to a real miss) but start out stale: the
    // throttle that produced them is over by now, so it is worth asking again.
    cache.set(Number(id), v.soft ? { ...v, at: 0 } : { ...v });
  }
}
const ready = load();
ready.catch(() => {});
// The dub catalogue scan is the fallback for every title the per-show search
// can't pin down; warming it at boot means badges converge on first browse.
ready.then(() => ensureDubIndex()).catch(() => {});

function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      await mkdir(new URL('../.data/', import.meta.url), { recursive: true });
      const out = {};
      for (const [id, v] of cache) out[id] = { ...v };
      await writeFile(FILE, JSON.stringify(out));
    } catch { /* counts are a nicety; never crash the server over them */ }
  }, 2000);
}

/** All titles for a batch of ids in ONE AniList query. */
async function titlesBatch(ids) {
  const d = await gql('query($ids:[Int]){Page(perPage:50){media(id_in:$ids){id title{romaji english}}}}', { ids }, 86400);
  const out = {};
  for (const m of (d.Page?.media || [])) out[m.id] = m.title || {};
  return out;
}

async function searchAllAnime(q) {
  const r = await fetch(`${ALLANIME}/anime/search?q=${encodeURIComponent(q)}&limit=26`, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`allanime ${r.status}`);
  const d = await r.json();
  return d.results || [];
}

function match(results, id, t, base) {
  for (const r of results) if (anilistIdOf(r.thumbnail) === id) return r; // exact
  // A result whose cover carries a different AniList id is usually a
  // different show. An exact match on the show's own title is still trusted
  // (the two databases disagree about ids all the time); a match on the
  // shortened base title is not — "Dragon Ball Super" is the series, not
  // "Dragon Ball Super: Beerus" — unless the result carries no id at all.
  const nR = norm(t.romaji), nE = norm(t.english);
  let best = null, bestScore = 0;
  for (const r of results) {
    const rid = anilistIdOf(r.thumbnail);
    const n = norm(r.name), nEn = norm(r.englishName);
    let s = 0;
    if (n && (n === nR || n === nE)) s = 100;
    else if (nEn && (nEn === nR || nEn === nE)) s = 100;
    else if (!rid && base && (n === base || nEn === base)) s = 90;
    else if (!rid && nR && (n.startsWith(nR) || nR.startsWith(n))) s = 70;
    else if (!rid && nE && (nEn.startsWith(nE) || nE.startsWith(nEn))) s = 70;
    if (s > bestScore) { bestScore = s; best = r; }
  }
  return bestScore >= 70 ? best : null;
}

/** Titles worth asking the catalogue for: the full names, then the base name
 *  without its season or part suffix — AllAnime lists "Dragon Ball Super"
 *  where AniList says "Dragon Ball Super: Beerus", and the long form never
 *  comes back from the search. `base` marks the shortened ones. */
function titleVariants(t) {
  const seen = new Set();
  const out = [];
  const push = (s, base) => {
    const k = norm(s);
    if (k.length > 1 && !seen.has(k)) { seen.add(k); out.push({ q: String(s).trim(), base }); }
  };
  for (const s of [t.english, t.romaji, t.native]) if (s) push(s, false);
  for (const s of [t.english, t.romaji]) {
    if (!s) continue;
    const base = String(s).split(/[:!]| - | season \d| part \d|第/gi)[0].trim();
    if (base.length > 2) push(base, true);
  }
  return out.slice(0, 4);
}

/** One id, titles already known. Throws only on upstream trouble (network/5xx).
 *  A catalogue that answers with results but no match means the show is not
 *  there (a hard miss); a catalogue that answers with nothing at all is
 *  usually throttling, and that must not be remembered as "no dub". */
async function lookupOne(id, t) {
  const variants = titleVariants(t);
  // The dubbed-catalogue scan already holds the counts of thousands of shows,
  // matched by AniList id first and by title second. Asking it first keeps
  // the upstream quiet: only the shows it does not carry need a search.
  const c = countsOf(id, variants.map(v => v.q));
  if (c && (c.sub || c.dub)) return { sub: c.sub, dub: c.dub, via: 'index' };
  let hit = null;
  let answered = false;  // the catalogue had something to say for at least one title
  let unstable = false;  // its answers for these titles changed under us
  for (let i = 0; i < variants.length; i++) {
    if (i) await sleep(GAP_MS); // the variants are separate searches: pace them
    const q = variants[i].q;
    const results = await searchAllAnime(q);
    if (results.length) {
      answered = true;
      const sig = results.map(r => r._id || r.name || '').join('|');
      const prev = querySeen.get(q);
      if (prev && prev.sig !== sig && Date.now() - prev.at < FLIP_WINDOW) unstable = true;
      querySeen.set(q, { sig, at: Date.now() });
    }
    hit = match(results, id, t, norm(q));
    if (hit) break;
  }
  if (hit?.availableEpisodes) {
    const { sub = 0, dub = 0 } = hit.availableEpisodes;
    if (sub || dub) return { sub, dub, via: 'search' };
  }
  if (!answered) return { soft: true, empty: true }; // nothing at all: throttling
  return { soft: true, empty: false, stable: !unstable }; // it answered, but not with this show
}

async function runBatch() {
  const batch = queue.splice(0, BATCH);
  let titles = {};
  try {
    titles = await titlesBatch(batch);
    consecFails = 0;
  } catch {
    consecFails++;
    if (consecFails >= BREAK_AFTER) pausedUntil = Date.now() + PAUSE_MS;
    queue.unshift(...batch); // try again after the pause
    return;
  }
  for (let i = 0; i < batch.length; i++) {
    const id = batch[i];
    try {
      const res = await lookupOne(id, titles[id] || {});
      if (res.soft) {
        // "Nothing" is not proof. The catalogue's answers change from minute
        // to minute while it is under load, so a show is only written off
        // once the catalogue has answered twice — the same way both times.
        const prev = cache.get(id);
        const tries = (prev?.tries || 0) + 1;
        if (res.empty) {
          // The catalogue said nothing at all: throttling, most likely.
          cache.set(id, { soft: true, at: Date.now(), tries });
          emptyStreak++;
          if (emptyStreak >= EMPTY_AFTER) {
            pausedUntil = Date.now() + EMPTY_PAUSE_MS;
            console.warn(`audio: catalogue answers empty (${emptyStreak} in a row) — pausing ${Math.round(EMPTY_PAUSE_MS / 1000)}s`);
          }
        } else if (res.stable && tries >= CONFIRM_TRIES) {
          // The same answer twice: the catalogue is up and does not carry
          // this show. Remember it — but not for a whole day of flapping.
          cache.set(id, { miss: true, at: Date.now(), tries });
        } else if (tries >= MAX_SOFT_TRIES) {
          // The catalogue will not settle down about this title. Stop asking.
          cache.set(id, { miss: true, at: Date.now(), tries });
        } else {
          // Ask again in a minute: the answer may be better next time.
          cache.set(id, { soft: true, at: Date.now(), tries });
        }
      } else {
        emptyStreak = 0;
        cache.set(id, { ...res, at: Date.now() });
      }
      consecFails = 0;
    } catch {
      consecFails++;
      // Upstream trouble isn't a real "no counts": leave the id uncached so the
      // next request tries it again (the breaker keeps the retries paced).
      cache.delete(id);
      if (consecFails >= BREAK_AFTER) {
        pausedUntil = Date.now() + PAUSE_MS;
        queue.unshift(...batch.slice(i + 1).filter(x => !cache.has(x)));
        break;
      }
    }
    save();
    if (i < batch.length - 1) await sleep(PACE_MS);
  }
}

function pump() {
  if (running || !queue.length || Date.now() < pausedUntil) return;
  running = true;
  runBatch().catch(() => {}).finally(() => {
    running = false;
    save();
    if (queue.length && Date.now() >= pausedUntil) setTimeout(pump, PACE_MS);
  });
}

/** Known counts right now; still-unknown ids are queued and will appear on later polls. */
export async function audioCounts(idsParam) {
  await ready;
  const ids = [...new Set(String(idsParam || '').split(',').map(Number).filter(Number.isInteger))].slice(0, 60);
  const out = {};
  const pending = [];
  // While the catalogue scan is still running, badge lookups would compete
  // with it for the same upstream — and a throttled upstream answers both
  // with nothing. They wait for the index instead: it answers most of them
  // outright, and the few it does not cover are looked up afterwards.
  const usable = dubIndexReady() || dubIndexSettled();
  for (const id of ids) {
    const c = cache.get(id);
    if (c && !c.miss && !c.soft) out[id] = { sub: c.sub, dub: c.dub, via: c.via || 'cache' };
    else {
      pending.push(id);
      // A hard miss is remembered for a day; a soft one (the catalogue
      // answered with nothing) only for a minute, because it usually means
      // throttling rather than "this show has no dub".
      const ttl = c?.soft ? SOFT_TTL : MISS_TTL;
      const fresh = c && Date.now() - c.at < ttl;
      if (usable && !fresh && !queue.includes(id)) queue.push(id);
    }
  }
  if (usable) pump();
  return { counts: out, pending: pending.length };
}

/** Synchronous view of the count cache; unknown ids get lookups queued behind
 *  the scenes so filtered results converge as the user keeps browsing. */
export function audioSnapshot(ids) {
  audioCounts(String(ids)).catch(() => {});
  const out = {};
  for (const id of ids) {
    const c = cache.get(id);
    if (c && !c.miss && !c.soft) out[id] = { sub: c.sub, dub: c.dub, via: c.via || 'cache' };
  }
  return out;
}
