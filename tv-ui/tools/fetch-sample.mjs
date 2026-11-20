// Bakes a live AniList snapshot into renderer/sample.json so the TV UI demo
// opens with real artwork even when the Koma server is not running.
//   node tools/fetch-sample.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const QUERY = `query($page:Int){Page(perPage:$page){media(type:ANIME,sort:TRENDING_DESC){
  id title{romaji english native}
  coverImage{extraLarge large color}
  bannerImage
  format episodes averageScore seasonYear season status description(asHtml:false)
  genres studios(isMain:true){nodes{name}}
}}}`;

const response = await fetch('https://graphql.anilist.co', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
  body: JSON.stringify({ query: QUERY, variables: { page: 15 } }),
});
if (!response.ok) throw new Error(`AniList answered ${response.status}`);
const data = await response.json();
const media = data?.data?.Page?.media;
if (!Array.isArray(media) || !media.length) throw new Error('AniList returned no media');

const rows = [
  { name: 'Trending', items: media.slice(0, 8) },
  { name: 'Popular this season', items: media.slice(4, 12) },
  { name: 'Top 10', items: media.slice(0, 10), numbered: true },
  { name: 'Upcoming', items: media.slice(7, 15) },
];

const out = {
  generatedAt: new Date().toISOString(),
  spotlight: media[0],
  rows,
};
const target = join(dirname(fileURLToPath(import.meta.url)), '..', 'renderer', 'sample.json');
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(out, null, 2)}\n`);
console.log(`wrote ${target}: ${media.length} titles`);