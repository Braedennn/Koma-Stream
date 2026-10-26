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

const ALLANIME = process.env.KOMA_ALLANIME_URL || 'http://127.0.0.1:8000';
const FILE = fileURLToPath(new URL('../.data/audio.json', import.meta.url));
const HIT_TTL = 7 * 86400e3;   // known counts: recheck weekly
const MISS_TTL = 3 * 86400e3;  // not indexed / offline: retry after 3 days
const BATCH = 8;               // ids resolved per AniList+search round
const PACE_MS = 350;           // gap between upstream searches
const BREAK_AFTER = 4;         // consecutive upstream failures before pausing
const PAUSE_MS = 10 * 60e3;    // how long the breaker stays open

const cache = new Map(); // id -> { sub, dub } | { miss: true }, plus .at
let saveTimer;
let running = false;
const queue = [];
let consecFails = 0;
let pausedUntil = 0;

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function load() {
  try {
    const raw = JSON.parse(await readFile(FILE, 'utf8'));
    for (const [id, v] of Object.entries(raw)) cache.set(Number(id), { ...v });
  } catch { /* first boot or unreadable */ }
}
const ready = load();

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

function match(results, id, t) {
  const key = `bx${id}-`;
  for (const r of results) if ((r.thumbnail || '').includes(key)) return r; // exact
  const nR = norm(t.romaji), nE = norm(t.english);
  let best = null, bestScore = 0;
  for (const r of results) {
    const n = norm(r.name), nEn = norm(r.englishName);
    let s = 0;
    if (n && (n === nR || n === nE)) s = 100;
    else if (nEn && (nEn === nR || nEn === nE)) s = 100;
    else if (nR && (n.startsWith(nR) || nR.startsWith(n))) s = 70;
    else if (nE && (nEn.startsWith(nE) || nE.startsWith(nEn))) s = 70;
    if (s > bestScore) { bestScore = s; best = r; }
  }
  return bestScore >= 70 ? best : null;
}

/** One id, titles already known. Throws only on upstream trouble (network/5xx). */
async function lookupOne(id, t) {
  let hit = null;
  for (const q of [...new Set([t.english, t.romaji].filter(Boolean))].slice(0, 2)) {
    hit = match(await searchAllAnime(q), id, t);
    if (hit) break;
  }
  if (hit?.availableEpisodes) {
    const { sub = 0, dub = 0 } = hit.availableEpisodes;
    if (sub || dub) return { sub, dub };
  }
  return { miss: true }; // indexed nothing (or nothing with counts) — a legit miss
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
      cache.set(id, { ...(await lookupOne(id, titles[id] || {})), at: Date.now() });
      consecFails = 0;
    } catch {
      consecFails++;
      // Upstream trouble isn't a real "no counts": back-date the miss so it's retried after the pause, not in 3 days.
      cache.set(id, { miss: true, at: Date.now() - MISS_TTL + PAUSE_MS });
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
  for (const id of ids) {
    const c = cache.get(id);
    if (c && !c.miss) out[id] = { sub: c.sub, dub: c.dub };
    else {
      const fresh = c && Date.now() - c.at < MISS_TTL; // recently checked: don't requeue
      if (!fresh && !queue.includes(id)) queue.push(id);
      if (queue.includes(id)) pending.push(id);
    }
  }
  pump();
  return { counts: out, pending: pending.length };
}
