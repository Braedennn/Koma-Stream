// JSON endpoints. Every query lives here, so the browser never talks to AniList directly.
import { gql, UpstreamError } from './anilist.js';
import { audioSnapshot } from './audio.js';
import { dubIndexLoaded, ensureDubIndex, hasDub } from './dubindex.js';

// The trailer rides along with every card: it is what a hovered card plays,
// and it is a couple of dozen bytes per title next to the cover art.
const CARD = `id idMal title{romaji english native} coverImage{extraLarge large medium color} bannerImage
  format episodes averageScore popularity season seasonYear status description(asHtml:false)
  genres studios(isMain:true){nodes{name}} nextAiringEpisode{episode airingAt} trailer{id site}`;
const MINI = `id title{romaji english native} coverImage{large medium color} format episodes averageScore seasonYear trailer{id site}`;

const SEASONS = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];
const FORMATS = ['TV', 'TV_SHORT', 'MOVIE', 'SPECIAL', 'OVA', 'ONA', 'MUSIC'];
const STATUSES = ['RELEASING', 'FINISHED', 'NOT_YET_RELEASED', 'CANCELLED', 'HIATUS'];
const SORTS = ['POPULARITY_DESC', 'TRENDING_DESC', 'SCORE_DESC', 'START_DATE_DESC', 'FAVOURITES_DESC', 'TITLE_ROMAJI'];

// AniList's adult flag does not catch every explicit tag: "Incest", for
// example, is still returned as a normal tag. These never belong in Koma's
// browse list or on a show's details page.
const EXPLICIT_TAGS = new Set([
  '4-koma', 'Body Horror', 'Brainwashing', 'Cannibalism', 'Death Game',
  'Ero Guro', 'Gore', 'Human Experimentation', 'Incest', 'Nudity',
  'Primarily Adult Cast', 'Psychosexual', 'Slavery', 'Succubus', 'Suicide',
  'Torture',
]);
const EXPLICIT_TAG_WORD = /\b(?:adult cast|erotic|erotica|hentai|incest|nsfw|porn(?:ography)?|rape|masturbation|orgasm|penis|vagina|genitals?|nudity|sex(?:ual)?|succubus)\b/i;
const safeTag = tag => !tag?.isAdult
  && !EXPLICIT_TAGS.has(tag?.name)
  && !EXPLICIT_TAG_WORD.test(String(tag?.name || ''));

class BadRequest extends UpstreamError { constructor(m) { super(m, 400); } }

const int = (v, min, max) => {
  if (v == null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new BadRequest(`Expected a whole number from ${min} to ${max}.`);
  return n;
};
const oneOf = (v, list) => {
  if (v == null || v === '') return null;
  if (!list.includes(v)) throw new BadRequest(`Unknown value "${v}".`);
  return v;
};
const text = (v, max) => (v == null || v === '' ? null : String(v).trim().slice(0, max) || null);

function seasonOf(date = new Date()) {
  return { season: SEASONS[Math.floor(date.getMonth() / 3)], year: date.getFullYear() };
}
function nextOf({ season, year }) {
  const i = SEASONS.indexOf(season);
  return { season: SEASONS[(i + 1) % 4], year: i === 3 ? year + 1 : year };
}
// Build a query that only declares the variables it uses (GraphQL rejects unused ones).
function pageQuery(args, perPage, decl) {
  return `query${decl ? `(${decl})` : ''}{Page(perPage:${perPage}){media(type:ANIME,isAdult:false,${args}){${CARD}}}}`;
}
const value = r => (r.status === 'fulfilled' ? r.value : null);

export async function home() {
  const now = seasonOf();
  const next = nextOf(now);
  const seasonal = (s, n) => gql(pageQuery('season:$s,seasonYear:$y,sort:POPULARITY_DESC', n, '$s:MediaSeason,$y:Int'), { s: s.season, y: s.year });
  const [airing, trending, top, upcoming, genres] = await Promise.allSettled([
    seasonal(now, 30),
    gql(pageQuery('sort:TRENDING_DESC', 16), {}, 300),
    gql(pageQuery('sort:SCORE_DESC', 10), {}, 3600),
    seasonal(next, 30),
    gql('query{GenreCollection}', {}, 86400),
  ]);
  if (![airing, trending, top, upcoming].some(r => r.status === 'fulfilled')) throw airing.reason;
  return {
    season: now,
    nextSeason: next,
    airing: value(airing)?.Page.media ?? null,
    trending: value(trending)?.Page.media ?? null,
    top: value(top)?.Page.media ?? null,
    upcoming: value(upcoming)?.Page.media ?? null,
    genres: value(genres)?.GenreCollection.filter(g => g !== 'Hentai') ?? [],
  };
}

export async function genres() {
  const d = await gql('query{GenreCollection}', {}, 86400);
  return { genres: d.GenreCollection.filter(g => g !== 'Hentai') };
}

export async function tags() {
  // isMediaSpoiler is part of the query so the cached answer is keyed to the
  // safe-tag rules as well; AniList can add a new explicit tag at any time.
  const d = await gql('query{MediaTagCollection{id name isAdult isMediaSpoiler}}', {}, 86400);
  return { tags: d.MediaTagCollection.filter(safeTag).map(t => t.name) };
}

export async function browse(q) {
  const search = text(q.get('search'), 100);
  // AniList treats null filter args as "match nothing" (a behavior change that
  // emptied every filtered browse), so only declare and pass filters that are set.
  const vars = { p: int(q.get('page'), 1, 200) ?? 1 };
  const decl = ['$p:Int'];
  const args = ['type:ANIME', 'isAdult:false', 'sort:$sort'];
  // Tags: one or many (comma-separated) — they combine as an AND of includes.
  const tagList = String(q.get('tag') || '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 8);
  // Language: sub/dub comes from the local streaming catalogues, not AniList, so a
  // language-filtered page has to pull a wider AniList slice and keep the matches.
  const lang = oneOf(q.get('lang'), ['sub', 'dub']);
  const filters = [
    ['search', 'q', 'String', search],
    ['genre', 'g', 'String', text(q.get('genre'), 40)],
    ['tag_in', 't', '[String]', tagList.length ? tagList : null],
    ['seasonYear', 'y', 'Int', int(q.get('year'), 1940, 2100)],
    ['season', 's', 'MediaSeason', oneOf(q.get('season'), SEASONS)],
    ['format', 'f', 'MediaFormat', oneOf(q.get('format'), FORMATS)],
    ['status', 'st', 'MediaStatus', oneOf(q.get('status'), STATUSES)],
  ];
  for (const [arg, name, type, value] of filters) {
    if (value == null) continue;
    decl.push(`$${name}:${type}`);
    args.push(`${arg}:$${name}`);
    vars[name] = value;
  }
  const sort = oneOf(q.get('sort'), SORTS);
  vars.sort = sort ? [sort] : search ? ['SEARCH_MATCH', 'POPULARITY_DESC'] : ['POPULARITY_DESC'];
  decl.push('$sort:[MediaSort]');
  const perPage = 50;
  // A dubbed title is a small minority of the catalogue, so one AniList page of
  // 50 would leave a nearly empty screen. Pull a few pages at once and let the
  // client carry on from where this one stopped.
  const chunk = lang === 'dub' ? 3 : 1;
  const query = `query(${decl.join(',')}){Page(page:$p,perPage:${perPage}){pageInfo{total currentPage hasNextPage}
    media(${args.join(',')}){${CARD}}}}`;
  const pages = await Promise.all(Array.from({ length: chunk }, (_, i) =>
    gql(query, { ...vars, p: vars.p + i }).catch(() => null)));
  const first = pages[0];
  if (!first) throw new UpstreamError('AniList did not answer.', 502);
  let media = pages.flatMap(p => p?.Page.media || []);
  let langPending = 0;
  const languageIndex = lang ? await dubIndexLoaded() : true;
  if (lang === 'dub') {
    // The dub index is the truth here: it is AllAnime's own list of everything
    // that has an English dub. The per-title counts are the fallback for a show
    // the index has not matched yet. A title nobody knows about is left out —
    // a language filter that shows what it was asked not to show is worse than
    // a short page — and its lookup is queued, so it turns up on the next pass.
    ensureDubIndex();
    const snap = audioSnapshot(media.map(m => m.id));
    media = media.filter(m => {
      if (hasDub(m)) return true;
      const c = snap[m.id];
      if (c) return c.dub > 0;
      langPending++;
      // With no catalogue at all, an unknown title is not proof that it has
      // no dub. Keeping it is better than turning the whole filter into an
      // empty page; a known zero is still respected.
      return !languageIndex;
    });
  } else if (lang === 'sub') {
    const snap = audioSnapshot(media.map(m => m.id));
    media = media.filter(m => {
      const c = snap[m.id];
      // Japanese subs are the default; only a title known to have none is out.
      return c ? c.sub > 0 : true;
    });
  }
  const info = first.Page.pageInfo;
  const last = pages[chunk - 1]?.Page.pageInfo;
  return {
    pageInfo: {
      // AniList's total counts every title, so it would be a lie once a
      // language filter has thrown most of them out.
      total: lang ? null : info.total,
      currentPage: info.currentPage,
      hasNextPage: !!last?.hasNextPage,
      next: info.currentPage + chunk,
    },
    media,
    langPending,
  };
}

export async function suggest(q) {
  const search = text(q.get('q'), 100);
  if (!search) return { media: [] };
  const d = await gql(`query($q:String){Page(perPage:6){media(search:$q,type:ANIME,isAdult:false,sort:SEARCH_MATCH){${MINI}}}}`, { q: search }, 3600);
  return { media: d.Page.media };
}

export async function many(q) {
  const ids = String(q.get('ids') || '').split(',').filter(Boolean).slice(0, 50).map(id => int(id, 1, 1e7));
  if (!ids.length) return { media: [] };
  const d = await gql(`query($ids:[Int]){Page(perPage:50){media(id_in:$ids,type:ANIME){${CARD}}}}`, { ids }, 300);
  const byId = new Map(d.Page.media.map(m => [m.id, m]));
  return { media: ids.map(id => byId.get(id)).filter(Boolean) };
}

/** Maps MyAnimeList anime ids to Koma's AniList ids for list synchronization. */
export async function mediaByMal(q) {
  const ids = String(q.get('ids') || '').split(',').filter(Boolean).slice(0, 1000)
    .map(id => int(id, 1, 1e7)).filter(id => id != null);
  if (!ids.length) return { media: [] };
  const chunks = [];
  for (let i = 0; i < ids.length; i += 50) chunks.push(ids.slice(i, i + 50));
  const parts = await Promise.all(chunks.map(chunk => gql(
    `query($ids:[Int]){Page(perPage:50){media(idMal_in:$ids,type:ANIME){id idMal}}}`,
    { ids: chunk }, 3600,
  )));
  const byMal = new Map(parts.flatMap(d => d.Page.media).map(m => [m.idMal, m]));
  return { media: ids.map(id => byMal.get(id)).filter(Boolean) };
}

export async function anime(q, [id]) {
  const d = await gql(`query($id:Int){Media(id:$id,type:ANIME){${CARD} idMal siteUrl status duration source favourites synonyms
    startDate{year month day} endDate{year month day}
    externalLinks{site url type color} streamingEpisodes{title thumbnail url site}
    rankings{rank type allTime context} tags{name rank isMediaSpoiler isAdult}
    relations{edges{relationType(version:2) node{id type format status title{romaji english} coverImage{medium color} trailer{id site}}}}
    characters(perPage:12,sort:[ROLE,RELEVANCE]){edges{role node{id name{full} image{medium}} voiceActors(language:JAPANESE){name{full} image{medium}}}}
    recommendations(perPage:12,sort:RATING_DESC){nodes{mediaRecommendation{${MINI}}}}}}`, { id: int(id, 1, 1e7) }, 900);
  if (!d.Media) throw new UpstreamError('No anime has that id.', 404);
  if (Array.isArray(d.Media.tags)) d.Media.tags = d.Media.tags.filter(safeTag);
  return d.Media;
}

export async function episodes(q, [id]) {
  const d = await gql(`query($id:Int,$p:Int){Media(id:$id,type:ANIME){airingSchedule(page:$p,perPage:50){
    pageInfo{hasNextPage} nodes{episode airingAt}}}}`, { id: int(id, 1, 1e7), p: int(q.get('page'), 1, 100) ?? 1 }, 900);
  return d.Media.airingSchedule;
}

export async function schedule(q) {
  const from = int(q.get('from'), 0, 4e9);
  const to = int(q.get('to'), 0, 4e9);
  if (from == null || to == null || to <= from || to - from > 8 * 86400) throw new BadRequest('Give a from/to range of at most 8 days.');
  const out = [];
  for (let p = 1; p <= 8; p++) {
    const d = await gql(`query($from:Int,$to:Int,$p:Int){Page(page:$p,perPage:50){pageInfo{hasNextPage}
      airingSchedules(airingAt_greater:$from,airingAt_lesser:$to,sort:TIME){episode airingAt
        media{id isAdult countryOfOrigin popularity ${MINI}}}}}`, { from, to, p }, 900);
    out.push(...d.Page.airingSchedules.filter(s => s.media && !s.media.isAdult));
    if (!d.Page.pageInfo.hasNextPage) break;
  }
  return { schedules: out };
}
