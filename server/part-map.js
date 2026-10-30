// Which streaming entry actually holds a given part of a show.
//
// A show split into cours is several AniList entries: "… Cour 2" is an entry
// of its own, with its own episode list and its own progress. The streaming
// sites split them too, but they name the parts their own way ("Part 2",
// "Part II", "2nd Season"), and the streaming server picks the site entry by
// scoring titles. So the second cour can land on the first cour's entry and
// play it again — wrong video, nothing on screen to say so.
//
// Koma resolves the entry itself and checks it against the part that was asked
// for before anything is played. When the entry cannot be confirmed, Koma
// refuses rather than playing an episode out of another part.
//
// Pure helpers first (they are the rules), then the two small site readers.

const ANIKOTO = 'https://anikoto.net';
const HEAVEN = 'https://animeheaven.me';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const cache = new Map(); // url -> { at, text }
const TTL = 6 * 3600e3;   // a part of a show does not move for hours

async function get(url, { headers = {}, ttl = TTL } = {}) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < ttl) return hit.text;
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: '*/*', ...headers },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  const text = await res.text();
  cache.set(url, { at: Date.now(), text });
  return text;
}

const entities = t => String(t || '')
  .replace(/&/g, '&').replace(/"/g, '"').replace(/&#0?39;/g, "'")
  .replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ');

const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10 };

/** A title taken apart into { series, season, part }. "… Cour 2" → part 2. */
export function parseTitle(title) {
  let s = String(title || '').toLowerCase();
  let season = null, part = null;
  s = s.replace(/\b(\d+)(?:st|nd|rd|th)?\s*season\b/g, (_, n) => { season = Number(n); return ' '; });
  s = s.replace(/\bseason\s*(\d+)\b/g, (_, n) => { season = Number(n); return ' '; });
  s = s.replace(/\bpart\s*([ivx]+|\d+)\b/g, (_, n) => { part = /^\d+$/.test(n) ? Number(n) : (ROMAN[n] || null); return ' '; });
  s = s.replace(/\bcour(?:t)?\s*(\d+)\b/g, (_, n) => { part = Number(n); return ' '; });
  // A number at the end of the name is the season: the sites write "One Punch
  // Man 2" where the episode list says "One Punch Man Season 2". Numbers big
  // enough to be part of the name ("Mob Psycho 100") are left alone.
  s = s.replace(/\s(\d{1,2})$/, (_, n) => {
    const v = Number(n);
    if (!v || v > 20) return _;
    season = v;
    return ' ';
  });
  return { series: s.replace(/[^a-z0-9]+/g, ' ').trim(), season, part };
}

/**
 * The title to search a site with.
 *
 * The sites name their parts their own way, so searching for "Cour 2" finds
 * nothing. The series name finds every part of it, and the rules above say
 * which one is ours.
 */
export function searchTitle(title) {
  return String(title || '')
    .replace(/\b(\d+)(?:st|nd|rd|th)?\s*season\b/gi, ' ')
    .replace(/\bseason\s*\d+\b/gi, ' ')
    .replace(/\bpart\s*([ivx]+|\d+)\b/gi, ' ')
    .replace(/\bcour(?:t)?\s*\d+\b/gi, ' ')
    .replace(/[\s\-–—:|]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** Words that say nothing about which show a title names. */
const ARTICLES = new Set(['the', 'a', 'an']);

/** A series name the way the comparison sees it: no articles, no punctuation. */
export function seriesWords(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
    .split(' ').filter(w => w && !ARTICLES.has(w)).join(' ');
}

/** Do two titles name the same series? */
export function sameSeries(a, b) {
  if (!a || !b) return false;
  const x = seriesWords(a);
  const y = seriesWords(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.length < 3) return false;
  // The shorter name is usually the series without its suffix ("Mushoku
  // Tensei" for "Mushoku Tensei: Jobless Reincarnation").
  if (long.startsWith(short)) return true;
  if (long.includes(short) && short.length / long.length >= 0.5) return true;
  // Or the same words with a few more in between ("Demon Slayer Movie: Mugen
  // Train" for "Demon Slayer -Kimetsu no Yaiba- The Movie: Mugen Train").
  const own = short.split(' ');
  if (own.length < 2) return false;
  const words = new Set(long.split(' '));
  return own.every(w => words.has(w));
}

/**
 * Is a candidate the same part as the one we want?
 *
 * A title that says nothing about seasons and parts is the first season, so
 * "no marker" and "1" mean the same thing; anything else has to agree.
 */
export function samePart(want, cand) {
  if (!sameSeries(want.series, cand.series)) return false;
  const ok = (a, b) => a === b || (a === null && b === 1) || (b === null && a === 1);
  return ok(want.season, cand.season) && ok(want.part, cand.part);
}

/**
 * The candidate that holds the wanted part.
 *
 * Candidates that name the same part win; among those, one whose episode
 * count matches the part's count wins; then the one that says the most about
 * the part, and the shortest title.
 */
export function pickPart(candidates, want, count = 0) {
  const parsed = candidates.map(c => ({ ...c, parsed: parseTitle(c.title) }));
  const exact = parsed.filter(c => samePart(want, c.parsed));
  const pool = exact.length ? exact : parsed.filter(c => sameSeries(want.series, c.parsed.series));
  if (!pool.length) return null;
  const withCount = count ? pool.filter(c => !c.count || c.count === count) : [];
  const use = withCount.length ? withCount : pool;
  const info = c => (c.parsed.season != null ? 1 : 0) + (c.parsed.part != null ? 1 : 0);
  // An entry that says exactly how many episodes our part has beats one that
  // does not say.
  const says = c => (count && c.count === count ? 1 : 0);
  use.sort((a, b) => says(b) - says(a) || info(b) - info(a) || a.parsed.series.length - b.parsed.series.length);
  return use[0];
}

/** The shows anikoto has for a title. */
export async function anikotoSearch(title) {
  const html = await get(`${ANIKOTO}/filter?keyword=${encodeURIComponent(title)}`);
  const out = [];
  for (const chunk of html.split('<div class="item ').slice(1)) {
    const slug = chunk.match(/\/watch\/([a-z0-9-]+)\/ep-/)?.[1];
    const name = chunk.match(/alt="([^"]+)"/)?.[1];
    if (!slug || !name) continue;
    out.push({
      slug,
      animeId: chunk.match(/data-tip="(\d+)"/)?.[1] || '',
      title: entities(name),
      count: Number(chunk.match(/ep-status total"><span>\s*(\d+)/)?.[1] || 0),
    });
  }
  return out;
}

/** The episodes anikoto holds in one of its entries, and the MAL id of the part they belong to. */
export async function anikotoEpisodes(animeId, slug) {
  const json = await get(`${ANIKOTO}/ajax/episode/list/${animeId}`, {
    headers: { 'X-Requested-With': 'XMLHttpRequest', Referer: `${ANIKOTO}/watch/${slug}` },
  });
  let html = '';
  try { html = JSON.parse(json)?.result || ''; } catch { return []; }
  const out = [];
  for (const chunk of html.split('<li ').slice(1)) {
    const num = Number(chunk.match(/data-num="([0-9.]+)"/)?.[1]);
    if (!Number.isFinite(num)) continue;
    out.push({
      num,
      title: entities(chunk.match(/title="([^"]*)"/)?.[1] || `Episode ${num}`),
      mal: Number(chunk.match(/data-mal="(\d*)"/)?.[1] || 0),
    });
  }
  return out;
}

/** The anikoto entry behind a slug: its episodes and the part they belong to. */
export async function anikotoEntry(slug) {
  if (!slug) return null;
  const html = await get(`${ANIKOTO}/watch/${slug}`);
  const animeId = html.match(/id="watch-main"[^>]{0,400}?data-id="(\d+)"/)?.[1] || html.match(/data-id="(\d+)"/)?.[1];
  if (!animeId) return null;
  const episodes = await anikotoEpisodes(animeId, slug);
  if (!episodes.length) return null;
  return { slug, animeId, episodes, mal: episodes.find(e => e.mal)?.mal || 0 };
}

/**
 * The entries a site has for a title.
 *
 * The full name finds the part ("My Hero Academia Season 4"), and the series
 * name alone finds every part of it ("My Hero Academia 2", "… 3", "… 4") —
 * one of the two usually holds the part, and which one depends on how the
 * site names its entries.
 */
export async function anikotoCandidates(title) {
  const terms = [...new Set([String(title || '').trim(), searchTitle(title)])].filter(Boolean);
  const lists = await Promise.all(terms.map(t => anikotoSearch(t).catch(() => [])));
  const out = new Map();
  for (const list of lists) for (const c of list) if (!out.has(c.slug)) out.set(c.slug, c);
  return [...out.values()];
}

/**
 * The entry that carries our MAL id.
 *
 * Anikoto stamps every episode with the MAL id of the part it belongs to, so
 * the site itself says which entry holds which part. That is proof. A title
 * that reads alike is only a guess — the sites name parts their own way
 * ("Rocky Joe 2", "Demon Slayer Movie: Mugen Train", "Gintama: The Final"),
 * so the guess misses exactly the shows where it matters.
 *
 * The candidates come from a title search, so they are checked in the order
 * the site returned them and the first one that proves itself wins.
 */
export async function findProven(candidates, malId, { limit = 30, width = 4 } = {}) {
  if (!malId || !candidates?.length) return null;
  const list = candidates.slice(0, limit);
  for (let i = 0; i < list.length; i += width) {
    const batch = await Promise.all(list.slice(i, i + width).map(async c => {
      const episodes = await anikotoEpisodes(c.animeId, c.slug).catch(() => []);
      const mals = episodes.filter(e => e.mal).map(e => e.mal);
      return mals.includes(malId) ? { ...c, episodes } : null;
    }));
    const hit = batch.find(Boolean);
    if (hit) return hit;
  }
  return null;
}

/** The entries animeheaven has for a title. */
export async function heavenSearch(title) {
  const html = await get(`${HEAVEN}/fastsearch.php?xhr=1&s=${encodeURIComponent(title)}`, {
    headers: { Accept: 'text/html,*/*' },
  });
  const out = [];
  const re = /href=['"]\/anime\.php\?([a-z0-9]+)['"][^>]*>[\s\S]*?class=['"]fastname['"]>([^<]*)</gi;
  for (const m of html.matchAll(re)) out.push({ id: m[1], title: entities(m[2]).trim() });
  return out;
}

/** Titles as they are compared: letters and digits only. */
export const plain = t => String(t || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Is this title just "Episode 12" with nothing to say? */
export const generic = t => /^episode\s*\d+(\s*\(\d+\))?$/i.test(String(t || '').trim());

/**
 * Where our part starts inside a bigger entry.
 *
 * Some sites hold a whole season in one entry, numbered straight through, so
 * the second cour's first episode is episode 12 there and episode 1 here. The
 * titles say which: the entry's own episode titles have to line up with ours.
 *
 * A title that says nothing ("Episode 12") says nothing here either — two
 * different parts that both number their episodes plainly would otherwise
 * look like the same part, and the wrong one would be played.
 */
export function matchOffset(mine, theirs) {
  if (!mine?.length || !theirs?.length) return -1;
  const byNum = new Map(theirs.map(e => [Number(e.num), e]));
  const want = mine.map(e => plain(e.title));
  const enough = Math.min(3, mine.length);
  for (let off = 0; off < 300; off++) {
    let hits = 0;
    for (let i = 0; i < mine.length; i++) {
      const a = want[i], b = plain(byNum.get(i + 1 + off)?.title);
      if (!a || !b || generic(a) || generic(b)) continue;
      if (a === b || a.includes(b) || b.includes(a)) hits++;
    }
    if (hits >= enough) return off;
  }
  return -1;
}
