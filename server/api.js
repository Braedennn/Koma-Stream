// JSON endpoints. Every query lives here, so the browser never talks to AniList directly.
import { gql, UpstreamError } from './anilist.js';
import { audioSnapshot } from './audio.js';

const CARD = `id title{romaji english native} coverImage{extraLarge large medium color} bannerImage
  format episodes averageScore popularity season seasonYear status description(asHtml:false)
  genres studios(isMain:true){nodes{name}} nextAiringEpisode{episode airingAt}`;
const MINI = `id title{romaji english native} coverImage{large medium color} format episodes averageScore seasonYear`;

const SEASONS = ['WINTER', 'SPRING', 'SUMMER', 'FALL'];
const FORMATS = ['TV', 'TV_SHORT', 'MOVIE', 'SPECIAL', 'OVA', 'ONA', 'MUSIC'];
const STATUSES = ['RELEASING', 'FINISHED', 'NOT_YET_RELEASED', 'CANCELLED', 'HIATUS'];
const SORTS = ['POPULARITY_DESC', 'TRENDING_DESC', 'SCORE_DESC', 'START_DATE_DESC', 'FAVOURITES_DESC', 'TITLE_ROMAJI'];

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
  const d = await gql('query{MediaTagCollection{id name isAdult}}', {}, 86400);
  return { tags: d.MediaTagCollection.filter(t => !t.isAdult).map(t => t.name) };
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
  // Language: sub/dub comes from the local episode counts, not AniList, so a
  // language-filtered page fetches a wider AniList slice and keeps the matches.
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
  const perPage = lang ? 90 : 30;
  const d = await gql(`query(${decl.join(',')}){Page(page:$p,perPage:${perPage}){pageInfo{total currentPage hasNextPage}
    media(${args.join(',')}){${CARD}}}}`, vars);
  let media = d.Page.media;
  if (lang) {
    const snap = audioSnapshot(media.map(m => m.id));
    media = media.filter(m => (m.id in snap ? (lang === 'dub' ? snap[m.id].dub : snap[m.id].sub) > 0 : true));
  }
  return { pageInfo: d.Page.pageInfo, media };
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

export async function anime(q, [id]) {
  const d = await gql(`query($id:Int){Media(id:$id,type:ANIME){${CARD} idMal siteUrl status duration source favourites synonyms
    startDate{year month day} endDate{year month day} trailer{id site thumbnail}
    externalLinks{site url type color} streamingEpisodes{title thumbnail url site}
    rankings{rank type allTime context} tags{name rank isMediaSpoiler}
    relations{edges{relationType(version:2) node{id type format status title{romaji english} coverImage{medium color}}}}
    characters(perPage:12,sort:[ROLE,RELEVANCE]){edges{role node{id name{full} image{medium}} voiceActors(language:JAPANESE){name{full} image{medium}}}}
    recommendations(perPage:12,sort:RATING_DESC){nodes{mediaRecommendation{${MINI}}}}}}`, { id: int(id, 1, 1e7) }, 900);
  if (!d.Media) throw new UpstreamError('No anime has that id.', 404);
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
