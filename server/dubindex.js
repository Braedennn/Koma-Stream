// Which anime actually have an English dub.
//
// Koma streams from AllAnime, so AllAnime is what knows: its catalogue search
// can list every show that has a dub, and each show's thumbnail carries the
// AniList id ("bx12345-") whenever AllAnime has one. Scanning that list once
// is the whole picture; it is cached to disk for a day and rebuilt in the
// background when it goes stale.
//
// The titles come along for the ride. A show whose thumbnail carried no
// AniList id can still be matched by name, which is how the index covers the
// long tail that the id alone would miss.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ALLANIME = process.env.KOMA_ALLANIME_URL || 'http://127.0.0.1:8000';
const FILE = fileURLToPath(new URL('../.data/dubindex.json', import.meta.url));
// The packaged Android app has no AllAnime catalogue of its own. It carries
// the latest known dub index with the app so the language filter has real
// results from the first launch instead of an empty page.
const SEED_FILE = fileURLToPath(new URL('./data/dubindex.json', import.meta.url));
const TTL = 24 * 3600e3;   // a day is plenty: dubs land with a show, not with the hour
const PAGE = 100;          // AllAnime takes up to 100 per page
const MAX_PAGES = 60;      // the whole dubbed catalogue is ~47 pages; this is the safety net
const PACE_MS = 700;       // a gap between pages, so the upstream is not hammered
const CATV = 3;            // scan payload version; older caches re-scan on the next boot

const norm = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const sleep = ms => new Promise(r => setTimeout(r, ms));

/** The AniList id in a cover URL. AniList names its files "<two letters><id>-<hash>",
 *  and the letters change with the image ("bx12345-…", "nx99634-…"), so the id is
 *  read out of the file name rather than assumed. */
export const anilistIdOf = thumb => {
  const m = /\/[a-z]{1,2}(\d+)-/i.exec(String(thumb || ''));
  return m ? Number(m[1]) : null;
};

let ids = new Set();     // AniList ids of shows with a dub
let names = new Set();   // normalised titles of shows with a dub
let countIds = new Map();  // AniList id -> { sub, dub } episode counts
let countNames = new Map(); // normalised title -> { sub, dub } episode counts
let builtAt = 0;
let catalog = 0;         // payload version of the loaded cache
let scanned = 0;         // how many shows the last scan saw
let building = null;     // the scan in flight, so it only ever runs once
let settled = false;     // the scan has finished (or was not needed)

async function load() {
  let raw = null;
  for (const file of [FILE, SEED_FILE]) {
    try {
      const candidate = JSON.parse(await readFile(file, 'utf8'));
      if (!candidate || !Array.isArray(candidate.ids)) continue;
      if (!raw || Number(candidate.at) > Number(raw.at)) raw = candidate;
    } catch { /* no file yet, or a corrupt one */ }
  }
  if (raw) {
    ids = new Set(raw.ids.map(Number));
    names = new Set(raw.names || []);
    for (const [k, v] of Object.entries(raw.countIds || {})) countIds.set(Number(k), v);
    countNames = new Map(Object.entries(raw.countNames || {}));
    builtAt = Number(raw.at) || 0;
    catalog = Number(raw.v) || 0;
    scanned = Number(raw.scanned) || 0;
  }
}
const ready = load();

async function page(n) {
  const r = await fetch(`${ALLANIME}/anime/search?q=&limit=${PAGE}&translationType=dub&page=${n}`,
    { signal: AbortSignal.timeout(20000) });
  if (!r.ok) throw new Error(`allanime ${r.status}`);
  const d = await r.json();
  return Array.isArray(d.results) ? d.results : [];
}

/** One page, with a couple of retries: the upstream rate-limits bursts, and a
 *  throttled page sometimes comes back empty rather than as an error. */
async function pageRetry(n) {
  let last;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const results = await page(n);
      if (results.length) return results;
      last = new Error('empty page');
    } catch (err) {
      last = err;
    }
    await sleep(1000 * (attempt + 1) * 1.5);
  }
  throw last || new Error('empty page');
}

/** One pass over the dubbed catalogue. */
async function scan() {
  const foundIds = new Set();
  const foundNames = new Set();
  const foundCountIds = new Map();
  const foundCountNames = new Map();
  const skipped = [];   // pages the upstream refused to serve this time
  let shows = 0;
  let misses = 0;
  let lastCount = PAGE; // a short page means the next empty page is the end of the list

  const take = results => {
    shows += results.length;
    for (const r of results) {
      const id = anilistIdOf(r.thumbnail);
      // The pages carry ready-made sub/dub episode counts — kept both by
      // AniList id and by title so the badge fallback can match either way.
      const ep = r.availableEpisodes || {};
      const epCount = Number(ep.dub) || Number(ep.sub) ? { sub: Number(ep.sub) || 0, dub: Number(ep.dub) || 0 } : null;
      const namesOf = [r.name, r.englishName, ...(Array.isArray(r.altNames) ? r.altNames : [])];
      if (id) {
        foundIds.add(id);
        if (epCount) foundCountIds.set(id, epCount);
      }
      for (const nme of namesOf) {
        const key = norm(nme);
        if (key.length > 1) {
          foundNames.add(key);
          if (epCount) foundCountNames.set(key, epCount);
        }
      }
    }
  };

  for (let n = 1; n <= MAX_PAGES; n++) {
    let results;
    try {
      results = await pageRetry(n);
    } catch (err) {
      if (lastCount < PAGE) break; // the list ended here
      // A page we cannot read is not a reason to throw the whole index away:
      // keep what we have, and come back for this page at the end.
      misses++;
      skipped.push(n);
      console.warn(`dub index: page ${n} failed (${err.message})`);
      if (misses >= 3) break;
      await sleep(1500);
      continue;
    }
    misses = 0;
    lastCount = results.length;
    take(results);
    if (n < MAX_PAGES) await sleep(PACE_MS);
  }

  // Second go at the pages that were skipped: a throttled page must not thin
  // the index out, or the shows on it lose their badges.
  for (const n of skipped) {
    try {
      const results = await pageRetry(n);
      take(results);
      console.log(`dub index: page ${n} recovered`);
    } catch (err) {
      console.warn(`dub index: page ${n} still failing (${err.message})`);
    }
    await sleep(PACE_MS);
  }

  ids = foundIds;
  names = foundNames;
  countIds = foundCountIds;
  countNames = foundCountNames;
  builtAt = Date.now();
  scanned = shows;
  try {
    await mkdir(new URL('../.data/', import.meta.url), { recursive: true });
    await writeFile(FILE, JSON.stringify({
      at: builtAt, scanned, v: CATV, ids: [...foundIds], names: [...foundNames],
      countIds: Object.fromEntries(foundCountIds), countNames: Object.fromEntries(foundCountNames),
    }));
  } catch { /* the index is a nicety; never crash the server over it */ }
  return { shows, ids: foundIds.size, names: foundNames.size, counts: foundCountIds.size };
}

/** Scan now if the index is missing or stale. Resolves when the scan is done. */
export function ensureDubIndex() {
  if (building) return building;
  building = ready
    .then(() => (Date.now() - builtAt < TTL && catalog >= CATV ? null : scan()))
    .then(r => {
      if (r) console.log(`dub index: ${r.shows} dubbed shows, ${r.ids} by id, ${r.names} by name, ${r.counts} counted`);
      return r;
    })
    .catch(err => { console.warn(`dub index: scan failed (${err.message})`); return null; })
    .finally(() => { building = null; settled = true; });
  return building;
}

/** True when the index has a completed scan to answer from. */
export function dubIndexReady() {
  return builtAt > 0;
}

/** Wait for the bundled or saved index to be read before using it. */
export async function dubIndexLoaded() {
  await ready;
  return builtAt > 0;
}

/** True once the scan has finished, one way or another. Badge lookups wait
 *  for this: while the scan is running they would compete with it for the
 *  same upstream, and both would come back empty. */
export function dubIndexSettled() {
  return settled;
}

/** Does this title have an English dub? */
export function hasDub(media) {
  if (!media) return false;
  if (media.id && ids.has(Number(media.id))) return true;
  const t = media.title || {};
  if (names.has(norm(t.romaji)) || names.has(norm(t.english))) return true;
  return false;
}

/** Episode counts from the scan, matched the way badges ask: AniList id
 *  first, then any known title. Null while no completed scan exists. */
export function countsOf(id, titles) {
  if (!builtAt) return null;
  if (id && countIds.has(Number(id))) return countIds.get(Number(id));
  for (const t of titles || []) {
    const c = countNames.get(norm(t));
    if (c) return c;
  }
  return null;
}

/** A short summary for the log. */
export function dubIndexInfo() {
  return { at: builtAt, scanned, ids: ids.size, names: names.size, counts: countIds.size, building: !!building };
}
