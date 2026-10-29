import { api, mediaByIds } from '../api.js';
import { readJournal, readProgress, watchedIds, watchedMap } from '../store.js';
import { continueWatching, watchedShows } from '../continuing.js';
import { genreWeights, rankCandidates, topGenres } from '../taste.js';
import { $, airedCount, cap, card, genreTile, hero, initHero, initRails, rankCard, row, setTitle, skRow } from '../ui.js';

export async function home(root, { alive }) {
  setTitle();
  document.documentElement.classList.add('has-hero');
  root.innerHTML = `<div class="sk sk-hero"></div><div class="rows" style="margin-top:-84px">${skRow()}${skRow()}</div>`;

  const d = await api('/home');
  if (!alive()) return;
  const now = `${cap(d.season.season)} ${d.season.year}`;
  const next = `${cap(d.nextSeason.season)} ${d.nextSeason.year}`;
  const pool = d.trending || d.airing || [];
  const withBanner = pool.filter(a => a.bannerImage);
  const spotlight = (withBanner.length >= 3 ? withBanner : pool).slice(0, 7);
  if (!spotlight.length) document.documentElement.classList.remove('has-hero');

  root.innerHTML = `
    ${spotlight.length ? hero(spotlight) : ''}
    <div class="rows">
      <div id="continue" hidden></div>
      <div id="foryou" hidden></div>
      ${d.trending ? row({ title: 'Trending now', sub: 'What everyone is watching this week.', link: '/browse?sort=TRENDING_DESC', body: d.trending.map(a => card(a)).join('') }) : ''}
      ${d.airing ? row({ title: `${now} season`, sub: 'Airing right now, most popular first.', link: `/browse?season=${d.season.season}&year=${d.season.year}`, body: d.airing.map(a => card(a)).join('') }) : ''}
      ${d.top ? row({ title: 'Top 10 of all time', sub: 'The highest rated anime on AniList.', link: '/browse?sort=SCORE_DESC', wide: true, body: d.top.map(rankCard).join('') }) : ''}
      ${d.upcoming ? row({ title: `Coming ${next}`, sub: 'Next season’s most anticipated shows.', link: `/browse?season=${d.nextSeason.season}&year=${d.nextSeason.year}`, body: d.upcoming.map(a => card(a)).join('') }) : ''}
      ${d.genres.length ? `<section class="row">
        <div class="row-head"><h2 class="section-title">Browse by genre<span>Jump straight into what you’re in the mood for.</span></h2></div>
        <div class="genre-grid">${d.genres.map(genreTile).join('')}</div>
      </section>` : ''}
    </div>`;

  initHero($('.hero', root));
  initRails(root);
  continueRail($('#continue', root), alive);
  forYou($('#foryou', root), alive);
}

/* "Continue watching" — what you actually watch, in Koma. The evidence is local:
 * episodes you finished here (the journal) and the episode you are in the middle of
 * (the resume point). A show that is only on your list — an AniList watchlist entry
 * especially — is not something you are watching, so it never shows up here. */
async function continueRail(slot, alive) {
  const journal = readJournal();
  const progress = readProgress();
  const ids = watchedShows({ journal, progress });
  if (!ids.length) return;
  let media;
  try { media = await mediaByIds(ids); } catch { return; }
  if (!alive()) return;
  const aired = Object.fromEntries(media.map(a => [a.id, airedCount(a)]));
  const entries = continueWatching({ journal, progress, watched: watchedMap(), aired });
  if (!entries.length) return;
  const byId = new Map(media.map(a => [a.id, a]));
  slot.insertAdjacentHTML('afterend', row({
    title: 'Continue watching',
    sub: 'Only what you actually watch here — watchlist additions stay out.',
    link: '/list',
    body: entries.map(e => {
      const a = byId.get(e.id);
      if (!a) return '';
      const note = e.kind === 'mid'
        ? `Episode ${e.ep}${e.left ? ` · ${e.left} min left` : ''}`
        : `Episode ${e.ep} next`;
      return card(a, { progress: true, note, seen: e.watched });
    }).join(''),
  }));
  const section = slot.nextElementSibling;
  slot.remove();
  initRails(section);
}

/* "For you" — the local taste model. Journal events become genre weights, the two
 * strongest genres pull one top-rated page each, and the merge is ranked by how
 * well it matches what you actually finish. Fewer than five keepers = no rail. */
async function forYou(slot, alive) {
  const journal = readJournal();
  if (journal.length < 5) return; // below that it's noise, not taste
  const meta = {};
  const media = await mediaByIds([...new Set(journal.map(e => e.id))]).catch(() => []) || [];
  for (const m of media) meta[m.id] = { genres: m.genres || [], format: m.format };
  if (!alive()) return;
  const weights = genreWeights(journal, meta);
  const genres = topGenres(weights, 2);
  if (!genres.length) return;
  const pages = await Promise.allSettled(genres.map(g => api(`/browse?genre=${encodeURIComponent(g)}&sort=SCORE_DESC`)));
  const mine = watchedIds();
  const seen = new Set();
  const candidates = [];
  for (const p of pages) {
    if (!p.fulfilled) continue;
    for (const a of p.value.media || []) {
      if (seen.has(a.id)) continue;
      seen.add(a.id);
      if (mine.has(a.id) || a.status === 'NOT_YET_RELEASED') continue;
      if ((a.averageScore || 0) < 60) continue;
      candidates.push(a);
    }
  }
  const picks = rankCandidates(candidates, weights).slice(0, 14);
  if (!alive() || picks.length < 5) return;
  slot.insertAdjacentHTML('afterend', row({
    title: 'For you', sub: 'Grown from what you finish.',
    link: `/browse?genre=${encodeURIComponent(genres[0])}&sort=SCORE_DESC`, linkLabel: 'More like this',
    body: picks.map(a => card(a)).join(''),
  }));
  const section = slot.nextElementSibling;
  slot.remove();
  initRails(section);
}
