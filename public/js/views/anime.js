import { api, airingSchedule, sourceEpisodes, seasonChain, watchOrder } from '../api.js';
import { addRewatch, setNote, setScore, setTags, take, watchedSet } from '../store.js';
import { presenceAnime, setActivity } from '../presence.js';
import {
  $, $$, big, card, episodeIndex, esc, fuzzyDate, icon, img, initSelect, listBtn, name, plain, pretty, score,
  selectHTML, setTitle, tint, when, ytId,
} from '../ui.js';

const PAGE = 50;

export async function anime(root, { params: [id], query, alive }) {
  document.documentElement.classList.add('has-hero');
  root.innerHTML = `<section class="d-hero"><div class="d-head"><div class="sk d-poster"></div>
    <div><div class="sk sk-line" style="width:40%;height:14px"></div><div class="sk sk-line" style="width:70%;height:46px;margin-top:16px"></div>
    <div class="sk sk-line" style="width:55%;height:30px;margin-top:18px"></div><div class="sk sk-line" style="width:90%;height:70px;margin-top:18px"></div></div></div></section>`;

  const a = await api(`/anime/${id}`);
  if (!alive()) return;
  setTitle(name(a));
  setActivity(presenceAnime(name(a), a.coverImage?.extraLarge || a.coverImage?.large || ''));
  sourceEpisodes(a.idMal); // warm it up: the Episodes tab and the watch page both need it

  const yt = ytId(a);
  const rank = (a.rankings || []).find(r => r.type === 'RATED' && r.allTime);
  const desc = plain(a.description);
  const seen = watchedSet(a.id);
  const cast = a.characters?.edges || [];
  const rel = (a.relations?.edges || []).filter(e => e.node);
  const recs = (a.recommendations?.nodes || []).map(n => n.mediaRecommendation).filter(Boolean);
  const startable = a.status !== 'NOT_YET_RELEASED';
  const sc = take(a.id); // your private score/rewatch/note/tags, rendered into the panel below
  const linked = (rel || []).some(e => (e.relationType === 'PREQUEL' || e.relationType === 'SEQUEL') && e.node?.type === 'ANIME');
  const tabs = [
    ['overview', 'Overview'],
    ['episodes', 'Episodes', a.episodes || ''],
    linked && ['order', 'Watch order', ''],
    cast.length && ['characters', 'Characters', cast.length],
    (rel.length || recs.length) && ['related', 'Related', rel.length + recs.length],
  ].filter(Boolean);
  let tab = tabs.some(t => t[0] === query.get('tab')) ? query.get('tab') : 'overview';

  root.innerHTML = `
    <section class="d-hero">
      <div class="d-backdrop${a.bannerImage ? '' : ' cover'}">${img(a.bannerImage || big(a))}</div>
      <div class="d-head">
        <div class="d-poster">${img(big(a), `Cover of ${name(a)}`)}</div>
        <div class="d-info">
          <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a>${icon('right')}<a href="/browse${a.format ? `?format=${a.format}` : ''}">${esc(pretty(a.format) || 'Anime')}</a>${icon('right')}<span>${esc(name(a))}</span></nav>
          <h1>${esc(name(a))}</h1>
          ${a.title.english && a.title.romaji !== a.title.english ? `<p class="d-alt">${esc(a.title.romaji)}${a.title.native ? ` · <span lang="ja">${esc(a.title.native)}</span>` : ''}</p>`
            : a.title.native ? `<p class="d-alt" lang="ja">${esc(a.title.native)}</p>` : ''}
          <div class="chips">
            ${score(a) ? `<span class="chip star">${icon('star')}${score(a)}</span>` : ''}
            ${a.status === 'RELEASING' ? '<span class="chip live">Airing</span>' : a.status ? `<span class="chip">${esc(pretty(a.status))}</span>` : ''}
            ${a.format ? `<span class="chip">${icon(a.format === 'MOVIE' ? 'film' : 'tv')}${esc(pretty(a.format))}</span>` : ''}
            ${a.episodes ? `<span class="chip">${a.episodes} episodes</span>` : ''}
            ${a.season ? `<a class="chip" href="/browse?season=${a.season}&year=${a.seasonYear}">${icon('calendar')}${esc(pretty(a.season))} ${a.seasonYear}</a>` : ''}
            <span class="chip aud-chips" data-audio-badge="${a.id}"></span>
            ${rank ? `<span class="chip">${icon('trophy')}#${rank.rank} rated</span>` : ''}
            ${(a.genres || []).map(g => `<a class="chip" href="/browse?genre=${encodeURIComponent(g)}">${esc(g)}</a>`).join('')}
          </div>
          ${desc ? `<p class="d-syn clamp">${esc(desc.replace(/\s*\n+\s*/g, ' '))}</p>` : ''}
          <div class="d-actions">
            ${startable ? `<a class="btn btn-primary" href="/watch/${a.id}">${icon('play')}${seen.size ? 'Continue watching' : 'Watch now'}</a>` : ''}
            ${listBtn(a.id)}
            ${yt ? `<button class="btn btn-ghost" type="button" data-trailer>${icon('film')}Trailer</button>` : ''}
          </div>
          <div class="take" id="take">
            <div class="take-head"><h2 class="section-title">My take<span>private to this device</span></h2><span class="take-flash" aria-live="polite"></span></div>
            <div class="take-row">
              <span class="take-label">Score</span>
              <div class="stars" role="radiogroup" aria-label="Your score, 1 to 10">${starsHTML(sc.score)}</div>
              <b class="take-val">${sc.score ? `${sc.score}/10` : ''}</b>
            </div>
            <div class="take-row">
              <span class="take-label">Rewatches</span>
              <div class="stepper" role="group" aria-label="Rewatch count">
                <button type="button" data-rew="-1" aria-label="One rewatch fewer">−</button>
                <b data-rew-n>${sc.rewatch}</b>
                <button type="button" data-rew="1" aria-label="One rewatch more">+</button>
              </div>
            </div>
            <div class="take-row">
              <span class="take-label">Tags</span>
              <div class="tagrow">
                ${sc.tags.map(tagChip).join('')}
                <input class="tag-input" maxlength="24" placeholder="add tag" aria-label="Add a tag">
              </div>
            </div>
            <textarea class="take-note" rows="2" maxlength="500" placeholder="A private note — what landed, where you dropped it…">${esc(sc.note)}</textarea>
          </div>
        </div>
      </div>
    </section>
    <div class="tabs" role="tablist" aria-label="Sections">
      ${tabs.map(([k, label, n]) => `<button class="tab" type="button" role="tab" data-tab="${k}" aria-selected="${k === tab}" aria-controls="panel">${label}${n ? ` <small>${n}</small>` : ''}</button>`).join('')}
    </div>
    <div class="panel" id="panel" role="tabpanel"></div>`;

  const panel = $('#panel', root);
  const show = (k, { scroll = false, play = false } = {}) => {
    tab = k;
    $$('.tab', root).forEach(b => b.setAttribute('aria-selected', b.dataset.tab === k));
    const q = new URLSearchParams(location.search);
    k === 'overview' ? q.delete('tab') : q.set('tab', k);
    history.replaceState(history.state, '', location.pathname + (String(q) ? `?${q}` : ''));
    panel.style.animation = 'none';
    void panel.offsetWidth;
    panel.style.animation = '';
    if (k === 'overview') overview(panel, a);
    else if (k === 'episodes') episodes(panel, a, alive);
    else if (k === 'order') orderTab(panel, a, alive);
    else if (k === 'characters') characters(panel, cast);
    else related(panel, rel, recs);
    if (scroll) $('.tabs', root).scrollIntoView({ behavior: 'smooth' });
    if (play) $('.video-cover', panel)?.click();
  };
  $('.tabs', root).addEventListener('click', e => {
    const b = e.target.closest('.tab');
    if (b && b.dataset.tab !== tab) show(b.dataset.tab);
  });
  $('[data-trailer]', root)?.addEventListener('click', () => show('overview', { scroll: true, play: true }));
  initTake(root, a);
  show(tab);

  // The watch order needs its own walk, so it fills the tab count in later — or drops the tab
  // entirely when this title turns out to stand alone.
  if (linked) watchOrder(a).then(wo => {
    if (!alive()) return;
    const b = $('.tab[data-tab="order"]', root);
    if (!b) return;
    if (wo.line.length < 2) {
      b.hidden = true;
      if (tab === 'order') show('overview', { scroll: true });
      return;
    }
    b.innerHTML = `Watch order <small>${wo.line.length}</small>`;
  });
}

function trailer(id, title) {
  return `<div class="video"><button class="video-cover" type="button" data-yt="${esc(id)}" aria-label="Play the ${esc(title)} trailer">
    <img src="https://i.ytimg.com/vi/${esc(id)}/hqdefault.jpg" alt="" loading="lazy"><span class="big-play">${icon('play')}</span></button></div>`;
}

const starsHTML = on => Array.from({ length: 10 }, (_, i) =>
  `<button type="button" class="star${i < on ? ' on' : ''}" data-star="${i + 1}" aria-label="${i + 1} of 10">${icon('star')}</button>`).join('');

const tagChip = tag => `<span class="tagchip">${esc(tag)}<button type="button" data-untag="${esc(tag)}" aria-label="Remove ${esc(tag)}">${icon('x')}</button></span>`;

/* My take: score, rewatches, tags, note — every touch saves to the store and pings
 * the "saved" flash, so nothing ever feels like it's waiting for a submit button. */
function initTake(root, a) {
  const box = $('#take', root);
  if (!box) return;
  let cur = take(a.id);
  const flash = $('.take-flash', box);
  let ft;
  const ping = () => {
    flash.textContent = 'saved';
    flash.classList.add('in');
    clearTimeout(ft);
    ft = setTimeout(() => flash.classList.remove('in'), 1200);
  };

  $('.stars', box).addEventListener('click', e => {
    const b = e.target.closest('.star');
    if (!b) return;
    const n = Number(b.dataset.star);
    setScore(a.id, n === cur.score ? 0 : n); // clicking your current star clears it
    cur = take(a.id);
    $('.stars', box).innerHTML = starsHTML(cur.score);
    $('.take-val', box).textContent = cur.score ? `${cur.score}/10` : '';
    ping();
  });

  $('.stepper', box).addEventListener('click', e => {
    const b = e.target.closest('[data-rew]');
    if (!b) return;
    addRewatch(a.id, Number(b.dataset.rew));
    cur = take(a.id);
    $('[data-rew-n]', box).textContent = cur.rewatch;
    ping();
  });

  const tagrow = $('.tagrow', box);
  const paintTags = () => {
    for (const c of tagrow.querySelectorAll('.tagchip')) c.remove();
    $('.tag-input', box).insertAdjacentHTML('beforebegin', cur.tags.map(tagChip).join(''));
  };
  tagrow.addEventListener('click', e => {
    const b = e.target.closest('[data-untag]');
    if (!b) return;
    setTags(a.id, cur.tags.filter(t => t !== b.dataset.untag));
    cur = take(a.id);
    paintTags();
    ping();
  });
  $('.tag-input', box).addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const tag = e.target.value.trim().replace(/\s+/g, ' ');
    if (!tag || cur.tags.some(t => t.toLowerCase() === tag.toLowerCase()) || cur.tags.length >= 8) return;
    setTags(a.id, [...cur.tags, tag]);
    cur = take(a.id);
    e.target.value = '';
    paintTags();
    ping();
  });

  const noteEl = $('.take-note', box);
  let nt;
  noteEl.addEventListener('input', () => { // debounced: a save per pause, not per keystroke
    clearTimeout(nt);
    nt = setTimeout(() => {
      setNote(a.id, noteEl.value.trim());
      cur = take(a.id);
      ping();
    }, 600);
  });
  noteEl.addEventListener('blur', () => { // a quick tab-out saves rather than loses
    clearTimeout(nt);
    if (noteEl.value.trim() !== cur.note) {
      setNote(a.id, noteEl.value.trim());
      cur = take(a.id);
      ping();
    }
  });
}

function overview(panel, a) {
  const yt = ytId(a);
  const streams = (a.externalLinks || []).filter(l => l.type === 'STREAMING');
  const end = fuzzyDate(a.endDate);
  const facts = [
    ['Format', pretty(a.format)],
    ['Episodes', a.episodes],
    ['Duration', a.duration && `${a.duration} min${a.format === 'MOVIE' ? '' : ' per ep'}`],
    ['Status', pretty(a.status)],
    ['Next episode', a.nextAiringEpisode && `Ep ${a.nextAiringEpisode.episode}, ${when(a.nextAiringEpisode.airingAt)}`],
    ['Aired', fuzzyDate(a.startDate) && fuzzyDate(a.startDate) + (end ? ` to ${end}` : a.status === 'RELEASING' ? ' to now' : '')],
    ['Season', a.season && `${pretty(a.season)} ${a.seasonYear}`],
    ['Studio', a.studios?.nodes?.map(s => s.name).join(', ')],
    ['Source', pretty(a.source)],
    ['Score', score(a) && `${score(a)} / 10`],
    ['Popularity', a.popularity && `${a.popularity.toLocaleString()} members`],
    ['Favourites', a.favourites?.toLocaleString()],
  ].filter(f => f[1]);
  const tags = (a.tags || []).filter(t => !t.isMediaSpoiler).slice(0, 14);
  const desc = plain(a.description);

  panel.innerHTML = `<div class="overview">
    <div class="stack">
      ${yt ? `<section><h2 class="section-title">Trailer</h2>${trailer(yt, name(a))}</section>` : ''}
      <section><h2 class="section-title">Synopsis</h2><p class="d-syn" style="margin:0">${esc(desc || 'No synopsis yet.')}</p></section>
      ${tags.length ? `<section><h2 class="section-title">Tags</h2><div class="chips" style="margin:0">${tags.map(t => `<span class="chip">${esc(t.name)}</span>`).join('')}</div></section>` : ''}
    </div>
    <aside>
      <div class="box"><h3>Where to watch</h3>${streams.length
        ? `<div class="platforms">${streams.map(s => `<a class="platform" href="${esc(s.url)}" target="_blank" rel="noopener"${s.color ? ` style="--pc:${esc(s.color)}"` : ''}><span class="pdot"></span>${esc(s.site)}${icon('external')}</a>`).join('')}</div>`
        : '<p class="muted" style="font-size:14px">No official streaming service is listed for this title yet.</p>'}</div>
      <div class="box"><h3>Details</h3><dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
        <p style="margin-top:16px"><a class="link-btn" href="${esc(a.siteUrl)}" target="_blank" rel="noopener">View on AniList${icon('external')}</a></p></div>
    </aside>
  </div>`;

  $('.video-cover', panel)?.addEventListener('click', e => {
    const b = e.currentTarget;
    b.outerHTML = `<iframe src="https://www.youtube-nocookie.com/embed/${esc(b.dataset.yt)}?autoplay=1&rel=0" title="${esc(name(a))} trailer"
      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe>`;
  });
}

const scheduleCache = new Map();
async function episodes(panel, a, alive) {
  panel.innerHTML = `<div class="ep-grid">${Array.from({ length: 8 }, () => '<div class="sk" style="aspect-ratio:16/12"></div>').join('')}</div>`;
  if (!scheduleCache.has(a.id)) scheduleCache.set(a.id, airingSchedule(a.id).catch(() => []));
  // The streaming server's list only adds titles/extra episodes: don't hold the tab more than 1.5s for it.
  const [schedule, sourceEps] = await Promise.all([scheduleCache.get(a.id),
    Promise.race([sourceEpisodes(a.idMal), new Promise(r => setTimeout(() => r([]), 1500))])]);
  const list = episodeIndex(a, schedule, sourceEps);
  if (!alive() || !panel.isConnected) return;
  if (!list.length) {
    panel.innerHTML = `<nav class="season-pills" aria-label="Seasons" hidden></nav><div class="empty-state"><div class="bubble">${icon('tv')}</div><h2>No episodes yet</h2><p>AniList hasn’t listed episodes for this title. Check back once it starts airing.</p></div>`;
    seasonPills(panel, a, alive);
    return;
  }
  const seen = watchedSet(a.id);
  const nextUp = list.find(e => !e.later && !seen.has(e.n))?.n;
  const pages = Math.ceil(list.length / PAGE);
  const startPage = nextUp ? Math.floor((nextUp - 1) / PAGE) : 0;

  const draw = p => {
    $('.ep-grid', panel).innerHTML = list.slice(p * PAGE, p * PAGE + PAGE).map(e => `
      <a class="ep${e.later ? ' later' : ''}${e.n === nextUp ? ' next-up' : ''}" href="/watch/${a.id}?ep=${e.n}" style="--c:${esc(tint(a))}"${e.later ? ' tabindex="-1" aria-disabled="true"' : ''}>
        <div class="ep-thumb">
          ${e.thumb ? img(e.thumb) : `<span class="big-n">${e.n}</span>`}
          <span class="ep-tag">EP ${e.n}</span>
          ${seen.has(e.n) ? `<span class="ep-seen" aria-label="Watched">${icon('check')}</span>` : ''}
          <span class="play-hint">${icon('play')}</span>
        </div>
        <div class="ep-body"><b>${esc(e.title || `Episode ${e.n}`)}</b><small>${e.n === nextUp ? 'Up next · ' : ''}${e.at ? esc(when(e.at)) : e.later ? 'Not aired yet' : 'Available'}</small></div>
      </a>`).join('');
  };

  panel.innerHTML = `<nav class="season-pills" aria-label="Seasons" hidden></nav><div class="ep-tools"><span>${list.length} episodes · ${seen.size} watched</span>
      ${pages > 1 ? selectHTML({ name: 'range', label: 'Episodes', any: null, align: 'right', value: String(startPage),
        options: Array.from({ length: pages }, (_, i) => [String(i), `${i * PAGE + 1}–${Math.min(list.length, (i + 1) * PAGE)}`]) }) : ''}</div>
    <div class="ep-grid"></div>`;
  const sel = $('.select', panel);
  if (sel) initSelect(sel, v => draw(Number(v)));
  draw(startPage);
  seasonPills(panel, a, alive);
}

/** Season 1 / Season 2 / … buttons above the episodes, when the show has more than one season. */
function seasonPills(panel, a, alive) {
  seasonChain(a).then(chain => {
    const nav = $('.season-pills', panel);
    if (!nav || !alive() || chain.length < 2) return;
    nav.innerHTML = chain.map((s, i) => `<a href="/anime/${s.id}?tab=episodes"${s.id === a.id ? ' aria-current="page"' : ''}>
      <small>Season ${i + 1}${s.status === 'RELEASING' ? ' · airing' : s.status === 'NOT_YET_RELEASED' ? ' · upcoming' : ''}</small><b>${esc(name(s))}</b></a>`).join('');
    nav.hidden = false;
  });
}

function characters(panel, cast) {
  panel.innerHTML = `<div class="cast">${cast.map(c => {
    const va = c.voiceActors?.[0];
    return `<div class="role">${img(c.node.image?.medium)}
      <span><b>${esc(c.node.name.full)}</b><small>${esc(pretty(c.role))}</small></span>
      ${va ? `<span class="va"><b>${esc(va.name.full)}</b><small>Japanese</small></span>${img(va.image?.medium)}` : '<span></span><span></span>'}</div>`;
  }).join('')}</div>`;
}

function related(panel, rel, recs) {
  const relCard = ({ relationType, node: n }) => (n.type === 'ANIME'
    ? card({ ...n, coverImage: { large: n.coverImage?.medium, color: n.coverImage?.color } }, { note: `${pretty(relationType)}${n.format ? ` · ${pretty(n.format)}` : ''}` })
    : `<article class="card"><div class="poster-wrap"><a class="poster" href="https://anilist.co/${n.type.toLowerCase()}/${n.id}" target="_blank" rel="noopener" tabindex="-1" aria-hidden="true">${img(n.coverImage?.medium)}<span class="badge fmt">${esc(pretty(n.format))}</span></a></div>
       <a class="card-title" href="https://anilist.co/${n.type.toLowerCase()}/${n.id}" target="_blank" rel="noopener">${esc(n.title.english || n.title.romaji)}</a><p class="card-meta">${esc(pretty(relationType))}</p></article>`);
  panel.innerHTML = `<div class="stack">
    ${rel.length ? `<section><h2 class="section-title">Related</h2><div class="grid">${rel.map(relCard).join('')}</div></section>` : ''}
    ${recs.length ? `<section><h2 class="section-title">You might also like</h2><div class="grid">${recs.map(r => card(r)).join('')}</div></section>` : ''}
  </div>`;
}

/** The Watch order tab: the story line in intended watch order, your title highlighted, and the
 *  franchise's side stories and spin-offs after the line as extras. */
async function orderTab(panel, a, alive) {
  panel.innerHTML = `<div class="wo-list">${Array.from({ length: 5 }, () => '<div class="sk wo-sk"></div>').join('')}</div>`;
  const wo = await watchOrder(a);
  if (!alive() || !wo || !panel.isConnected) return;
  const line = wo.line.filter(Boolean);
  if (line.length < 2) {
    panel.innerHTML = `<div class="empty-state"><div class="bubble">${icon('list')}</div><h2>Nothing to order</h2><p>There’s no sequel, prequel or side story here — this title stands on its own.</p></div>`;
    return;
  }
  const meta = m => [pretty(m.format), m.episodes && `${m.episodes} eps`, fuzzyDate(m.startDate),
    m.status === 'RELEASING' ? 'Airing' : m.status === 'NOT_YET_RELEASED' ? 'Upcoming' : ''].filter(Boolean).join(' · ');
  const row = (m, i) => {
    const here = m.id === a.id;
    return `${here
      ? `<div class="wo-row active">`
      : `<a class="wo-row" href="/anime/${m.id}">`}
      <span class="wo-n">${i + 1}</span>
      <span class="wo-poster">${img(m.coverImage?.large || m.coverImage?.medium, here ? `Cover of ${name(m)}` : '')}</span>
      <span class="wo-body"><b>${esc(name(m))}</b><small>${esc(meta(m))}</small></span>
      <span class="wo-chips">${here ? '<span class="chip wo-here">You are here</span>' : i === 0 ? '<span class="chip">Start here</span>' : ''}${m.status === 'RELEASING' ? '<span class="chip live">Airing</span>' : ''}</span>
    </${here ? 'div' : 'a'}>`;
  };
  panel.innerHTML = `<div class="wo-list">${line.map(row).join('')}</div>
    ${wo.extras.length ? `<section class="wo-extras"><h2 class="section-title">Extras<span>side stories & spin-offs · not needed to follow the story</span></h2>
      <div class="grid">${wo.extras.map(({ m, rel }) => card({ ...m, coverImage: { large: m.coverImage?.large || m.coverImage?.medium, color: m.coverImage?.color } }, { note: pretty(rel) })).join('')}</div></section>` : ''}`;
}


