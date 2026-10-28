// Formatting helpers and shared UI components: cards, rows, hero, dropdowns, episode index.
import { inList, watchedSet } from './store.js';
import { icon } from './icons.js';

export { icon };
export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/* ---------- formatting ---------- */
export const name = a => a.title.english || a.title.romaji;
export const big = a => a.coverImage?.extraLarge || a.coverImage?.large || a.coverImage?.medium || '';
export const small = a => a.coverImage?.medium || a.coverImage?.large || '';
export const tint = a => a.coverImage?.color || '#4b4b8f';
export const score = a => (a.averageScore ? (a.averageScore / 10).toFixed(1) : '');
export const cap = s => (s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : '');
export const pretty = s => (s ? { TV: 'TV', OVA: 'OVA', ONA: 'ONA', TV_SHORT: 'TV Short' }[s] || cap(s).replace(/_/g, ' ') : '');
export const meta = (...xs) => xs.filter(Boolean).join(' · ');
export const eps = a => a.episodes && `${a.episodes} ${a.episodes === 1 ? 'ep' : 'eps'}`;
export const studio = a => a.studios?.nodes?.[0]?.name;
export const ytId = a => (a.trailer?.site === 'youtube' ? a.trailer.id : null);
export const plain = h => (h
  ? new DOMParser().parseFromString(h.replace(/<br\s*\/?>/gi, '\n'), 'text/html').body.textContent.replace(/\n{3,}/g, '\n\n').trim()
  : '');
export const fuzzyDate = d => (d?.year
  ? new Date(d.year, (d.month || 1) - 1, d.day || 1).toLocaleDateString(undefined, { year: 'numeric', month: d.month ? 'short' : undefined, day: d.day ? 'numeric' : undefined })
  : '');
export const when = t => new Date(t * 1000).toLocaleString(undefined, t * 1000 > Date.now()
  ? { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
  : { year: 'numeric', month: 'short', day: 'numeric' });
export function relTime(t) {
  const mins = Math.round((t * 1000 - Date.now()) / 60000);
  if (mins <= 0) return 'Aired';
  if (mins < 60) return `In ${mins}m`;
  if (mins < 1440) return `In ${Math.floor(mins / 60)}h ${mins % 60}m`;
  const d = Math.round(mins / 1440);
  return `In ${d} day${d === 1 ? '' : 's'}`;
}
export const hue = s => [...s].reduce((h, c) => (h * 31 + c.charCodeAt(0)) % 360, 7);

/** Episodes aired so far (or the total once finished). */
export const airedCount = a => (a.nextAiringEpisode ? a.nextAiringEpisode.episode - 1 : a.status === 'NOT_YET_RELEASED' ? 0 : a.episodes || 0);

export function setTitle(t) {
  document.title = t ? `${t} | Koma` : 'Koma | Watch anime, track every episode';
}

/* ---------- feedback ---------- */
let toastTimer;
export function toast(msg) {
  const t = $('#toast');
  t.innerHTML = `${icon('check')}<span>${esc(msg)}</span>`;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

export function errorBox(el, err, retry) {
  const missing = err?.status === 404;
  el.innerHTML = `<div class="err" role="alert">
    <div class="bubble">${icon(missing ? 'search' : 'alert')}</div>
    <h2>${missing ? 'We couldn’t find that anime' : 'Something didn’t load'}</h2>
    <p>${esc(missing ? 'It may have been removed from AniList, or the link is wrong.' : err?.message || 'Something went wrong.')}${!missing && err?.status === 429 ? ' AniList is busy right now; wait a few seconds.' : ''}</p>
    ${missing ? `<a class="btn btn-primary" href="/browse">${icon('search')}Browse anime</a>` : `<button class="btn btn-primary" type="button">Try again</button>`}
  </div>`;
  el.querySelector('button')?.addEventListener('click', retry);
}

/* ---------- my list buttons ---------- */
export const listBtn = id => `<button class="btn btn-ghost" type="button" data-list="${id}" aria-pressed="${inList(id)}">${listBtnInner(inList(id))}</button>`;
const listBtnInner = on => `${icon(on ? 'check' : 'plus')}<span>${on ? 'In my list' : 'My list'}</span>`;
const quickBtn = id => `<button class="quick" type="button" data-list="${id}" data-quick aria-pressed="${inList(id)}" aria-label="${inList(id) ? 'Remove from' : 'Add to'} My list">${icon(inList(id) ? 'check' : 'plus')}</button>`;
export function syncListButton(b) {
  const on = inList(Number(b.dataset.list));
  b.setAttribute('aria-pressed', on);
  if (b.hasAttribute('data-quick')) {
    b.innerHTML = icon(on ? 'check' : 'plus');
    b.setAttribute('aria-label', `${on ? 'Remove from' : 'Add to'} My list`);
  } else {
    b.innerHTML = listBtnInner(on);
  }
}

/* ---------- images ---------- */
export const img = (src, alt = '', extra = '') =>
  `<img class="fade" src="${esc(src)}" alt="${esc(alt)}" loading="lazy" decoding="async"${extra}>`;

/* ---------- cards ---------- */
// Let the browser pick the smaller cover when the card is small (laptops, phones): about half the bytes per poster.
const posterSet = a => (a.coverImage?.large && a.coverImage?.extraLarge
  ? ` srcset="${esc(a.coverImage.large)} 230w, ${esc(a.coverImage.extraLarge)} 460w" sizes="(max-width: 560px) 45vw, (max-width: 1150px) 22vw, 15vw"`
  : '');

export function card(a, { progress = false, note = '' } = {}) {
  const href = progress ? `/watch/${a.id}` : `/anime/${a.id}`;
  const seen = progress ? watchedSet(a.id).size : 0;
  const total = a.episodes || airedCount(a);
  const s = score(a);
  const line = note || (progress ? `Episode ${seen + 1} next${total ? ` of ${total}` : ''}` : meta(a.seasonYear, eps(a)));
  return `<article class="card">
    <div class="poster-wrap">
      <a class="poster" href="${href}" tabindex="-1" aria-hidden="true">
        ${img(a.coverImage?.large || big(a), '', posterSet(a))}
        ${s ? `<span class="badge score">${icon('star')}${s}</span>` : a.status === 'NOT_YET_RELEASED' ? '<span class="badge new">Soon</span>' : ''}
        ${a.format ? `<span class="badge fmt">${esc(pretty(a.format))}</span>` : ''}
        <span class="play-hint">${icon('play')}</span>
        ${progress && total ? `<span class="bar"><i style="width:${Math.min(100, (seen / total) * 100)}%"></i></span>` : ''}
      </a>
      <div class="aud-row" data-audio-badge="${a.id}" aria-hidden="true"></div>
      ${quickBtn(a.id)}
      <div class="card-hover">${s ? `<b>${icon('star')}${s}</b>` : ''}<span>${esc(meta(studio(a), (a.genres || [])[0]))}</span></div>
    </div>
    <a class="card-title" href="${href}">${esc(name(a))}</a>
    <p class="card-meta">${esc(line)}</p>
  </article>`;
}

export const rankCard = (a, i) => `<div class="rank-card"><span class="rank-num" aria-hidden="true">${i + 1}</span>${card(a)}</div>`;

export const genreTile = g => `<a class="genre" style="--h:${hue(g)}" href="/browse?genre=${encodeURIComponent(g)}">${esc(g)}</a>`;

export const skCard = () => '<div class="card" aria-hidden="true"><div class="sk sk-poster"></div><div class="sk sk-line"></div><div class="sk sk-line short"></div></div>';
export const skCards = n => Array.from({ length: n }, skCard).join('');
export const skRow = () => `<section class="row" aria-hidden="true"><div class="row-head"><div class="sk sk-line" style="width:220px;height:24px;margin:0"></div></div>
  <div class="rail"><div class="track">${skCards(9)}</div></div></section>`;

/* ---------- rows ---------- */
export const row = ({ title, sub = '', link = '', linkLabel = 'View all', body, wide = false, id = '' }) => `
  <section class="row"${id ? ` id="${id}"` : ''}>
    <div class="row-head"><div><h2>${title}</h2>${sub ? `<p>${sub}</p>` : ''}</div>${link ? `<a class="link-btn" href="${link}">${linkLabel}${icon('right')}</a>` : ''}</div>
    <div class="rail${wide ? ' wide' : ''}">
      <button class="rail-btn prev" type="button" aria-label="Scroll left" disabled><span>${icon('left')}</span></button>
      <div class="track">${body}</div>
      <button class="rail-btn next" type="button" aria-label="Scroll right"><span>${icon('right')}</span></button>
    </div>
  </section>`;

export function initRails(root) {
  for (const rail of $$('.rail', root)) {
    const track = $('.track', rail);
    const [prev, next] = $$('.rail-btn', rail);
    if (!prev) continue;
    const update = () => {
      prev.disabled = track.scrollLeft < 8;
      next.disabled = track.scrollLeft + track.clientWidth >= track.scrollWidth - 8;
    };
    const size = () => {
      const p = $('.poster', track);
      if (p) rail.style.setProperty('--poster-h', `${p.offsetHeight}px`);
      update();
    };
    prev.addEventListener('click', () => track.scrollBy({ left: -track.clientWidth * 0.85, behavior: 'smooth' }));
    next.addEventListener('click', () => track.scrollBy({ left: track.clientWidth * 0.85, behavior: 'smooth' }));
    track.addEventListener('scroll', update, { passive: true });
    new ResizeObserver(size).observe(track);
    size();
  }
}

/* ---------- hero spotlight ---------- */
const heroMeta = a => [
  score(a) && `<span class="star">${icon('star')}${score(a)}</span>`,
  pretty(a.format), eps(a), a.seasonYear, a.status === 'RELEASING' && 'Airing',
].filter(Boolean).map(x => `<span>${x}</span>`).join('')
  + `<span class="hero-aud" data-audio-badge="${a.id}"></span>`;

export function hero(list) {
  return `<section class="hero" aria-roledescription="carousel" aria-label="Spotlight">
    ${list.map((a, i) => { const seen = watchedSet(a.id).size;
      return `<article class="slide${i ? '' : ' on'}" aria-roledescription="slide" aria-label="${i + 1} of ${list.length}"${i ? ' aria-hidden="true" inert' : ''}>
      <div class="slide-bg${a.bannerImage ? '' : ' cover'}"><img src="${esc(a.bannerImage || big(a))}" alt="" ${i ? 'loading="lazy"' : 'fetchpriority="high"'} decoding="async"></div>
      <div class="slide-body">
        <span class="spot">#${i + 1} Spotlight</span>
        <h2>${esc(name(a))}</h2>
        <div class="meta">${heroMeta(a)}</div>
        <p class="syn">${esc(plain(a.description))}</p>
        <div class="hero-actions">
          <a class="btn btn-primary" href="/watch/${a.id}">${icon('play')}${seen ? 'Continue watching' : a.episodes === 1 || a.format === 'MOVIE' ? 'Watch now' : 'Watch Episode 1'}</a>
          ${listBtn(a.id)}
        </div>
      </div>
    </article>`; }).join('')}
    ${list.length > 1 ? `<div class="hero-ctrl">
      <button class="icon-btn" type="button" data-step="-1" aria-label="Previous slide">${icon('left')}</button>
      <div class="dots">${list.map((_, i) => `<button class="dot${i ? '' : ' on'}" type="button" aria-label="Show slide ${i + 1}"><i></i></button>`).join('')}</div>
      <button class="icon-btn" type="button" data-step="1" aria-label="Next slide">${icon('right')}</button>
    </div>` : ''}
  </section>`;
}

export function initHero(el) {
  if (!el) return;
  const slides = $$('.slide', el);
  const dots = $$('.dot', el);
  if (slides.length < 2) return;
  let cur = 0;
  const show = n => {
    cur = (n + slides.length) % slides.length;
    slides.forEach((s, i) => {
      const on = i === cur;
      s.classList.toggle('on', on);
      s.toggleAttribute('inert', !on);
      on ? s.removeAttribute('aria-hidden') : s.setAttribute('aria-hidden', 'true');
    });
    dots.forEach((d, i) => {
      d.classList.remove('on');
      if (i === cur) { void d.offsetWidth; d.classList.add('on'); }
    });
  };
  // The progress bar's animation drives autoplay, so pausing the bar pauses the carousel.
  if (!matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.addEventListener('animationend', e => { if (e.animationName === 'fill') show(cur + 1); });
  } else {
    el.classList.add('paused');
  }
  dots.forEach((d, i) => d.addEventListener('click', () => show(i)));
  $$('[data-step]', el).forEach(b => b.addEventListener('click', () => show(cur + Number(b.dataset.step))));
  const pause = on => { if (!matchMedia('(prefers-reduced-motion: reduce)').matches) el.classList.toggle('paused', on); };
  el.addEventListener('mouseenter', () => pause(true));
  el.addEventListener('mouseleave', () => pause(false));
  el.addEventListener('focusin', () => pause(true));
  el.addEventListener('focusout', () => pause(false));
  let x0 = null;
  el.addEventListener('pointerdown', e => { x0 = e.clientX; });
  el.addEventListener('pointerup', e => {
    if (x0 != null && Math.abs(e.clientX - x0) > 60) show(cur + (e.clientX < x0 ? 1 : -1));
    x0 = null;
  });
}

/* ---------- custom dropdown ---------- */
export function selectHTML({ name: key, label, options, value = '', any = 'Any', find = options.length > 12, align = '', multi = false }) {
  if (multi) {
    // Multi-selects hold a comma-joined value; the button shows a chip per pick.
    const sel = String(value).split(',').map(s => s.trim()).filter(Boolean);
    const labelOf = v => options.find(([ov]) => String(ov) === String(v))?.[1] || v;
    const chips = sel.map(v => `<span class="sel-chip" data-val="${esc(v)}">${esc(labelOf(v))}<i role="button" tabindex="-1" aria-label="Remove">${icon('x')}</i></span>`).join('');
    return `<div class="select multi${sel.length ? ' set' : ''}${align ? ` ${align}` : ''}" data-name="${key}" data-value="${esc(sel.join(','))}" data-multi="true">
      <button type="button" class="select-btn" aria-haspopup="listbox" aria-expanded="false"><small>${esc(label)}</small><span class="val">${chips || `<span class="ph">Any ${esc(label.toLowerCase())}</span>`}</span>${icon('down')}</button>
      <div class="select-menu" role="listbox" aria-multiselectable="true" aria-label="${esc(label)}" tabindex="-1">
        ${find ? `<div class="select-find"><input type="text" placeholder="Filter ${esc(label.toLowerCase())}" aria-label="Filter ${esc(label)}" autocomplete="off"></div>` : ''}
        ${options.map(([v, l]) => `<div class="opt" role="option" data-value="${esc(v)}" aria-selected="${sel.includes(String(v))}"><span>${esc(l)}</span>${icon('check')}</div>`).join('')}
        <div class="opt-empty" hidden>No matches</div>
      </div>
    </div>`;
  }
  const all = any == null ? options : [['', any], ...options];
  const cur = all.find(([v]) => String(v) === String(value)) || all[0];
  return `<div class="select${value !== '' && any != null ? ' set' : ''}${align ? ` ${align}` : ''}" data-name="${key}" data-value="${esc(cur[0])}">
    <button type="button" class="select-btn" aria-haspopup="listbox" aria-expanded="false"><small>${esc(label)}</small><span class="val">${esc(cur[1])}</span>${icon('down')}</button>
    <div class="select-menu" role="listbox" aria-label="${esc(label)}" tabindex="-1">
      ${find ? `<div class="select-find"><input type="text" placeholder="Filter ${esc(label.toLowerCase())}" aria-label="Filter ${esc(label)}" autocomplete="off"></div>` : ''}
      ${all.map(([v, l]) => `<div class="opt" role="option" data-value="${esc(v)}" aria-selected="${String(v) === String(cur[0])}"><span>${esc(l)}</span>${icon('check')}</div>`).join('')}
      <div class="opt-empty" hidden>No matches</div>
    </div>
  </div>`;
}

function closeSelects(except) {
  for (const s of $$('.select.open')) if (s !== except) s._close(false);
}
document.addEventListener('pointerdown', e => { if (!e.target.closest('.select')) closeSelects(); });

export function initSelect(el, onChange) {
  const multi = el.dataset.multi === 'true';
  const btn = $('.select-btn', el);
  const menu = $('.select-menu', el);
  const find = $('.select-find input', el);
  const visible = () => $$('.opt:not([hidden])', menu);
  const labelOf = v => $(`.opt[data-value="${v}"] span`, menu)?.textContent || v;
  let active = -1;
  let typed = '';
  let typedAt = 0;

  const setActive = (i, scroll = true) => {
    const o = visible();
    o.forEach(x => x.classList.remove('active'));
    active = Math.max(0, Math.min(o.length - 1, i));
    if (o[active]) { o[active].classList.add('active'); if (scroll) o[active].scrollIntoView({ block: 'nearest' }); }
  };
  const filter = q => {
    let n = 0;
    for (const o of $$('.opt', menu)) {
      const hit = o.textContent.toLowerCase().includes(q.toLowerCase());
      o.hidden = !hit;
      n += hit;
    }
    $('.opt-empty', menu).hidden = n > 0;
    setActive(0);
  };
  const open = () => {
    if (el.classList.contains('open')) return;
    closeSelects(el);
    el.classList.add('open');
    el.classList.remove('flip');
    if (menu.getBoundingClientRect().right > document.documentElement.clientWidth - 8) el.classList.add('flip');
    btn.setAttribute('aria-expanded', 'true');
    setActive(Math.max(0, visible().findIndex(x => x.getAttribute('aria-selected') === 'true')));
    (find || menu).focus({ preventScroll: true });
  };
  const close = (focus = true) => {
    if (!el.classList.contains('open')) return;
    el.classList.remove('open');
    btn.setAttribute('aria-expanded', 'false');
    if (find) { find.value = ''; filter(''); }
    if (focus) btn.focus({ preventScroll: true });
  };
  const paintMultiBtn = () => {
    const list = el.dataset.value ? el.dataset.value.split(',').filter(Boolean) : [];
    $('.val', el).innerHTML = list.map(v => `<span class="sel-chip" data-val="${esc(v)}">${esc(labelOf(v))}<i role="button" tabindex="-1" aria-label="Remove">${icon('x')}</i></span>`).join('')
      || `<span class="ph">Any ${esc($('small', btn).textContent.toLowerCase())}</span>`;
    el.classList.toggle('set', list.length > 0);
  };
  const set = (v, notify) => {
    if (multi) {
      const list = el.dataset.value ? el.dataset.value.split(',').filter(Boolean) : [];
      const at = list.indexOf(String(v));
      at >= 0 ? list.splice(at, 1) : list.push(String(v));
      el.dataset.value = list.join(',');
      $$('.opt', menu).forEach(x => x.setAttribute('aria-selected', list.includes(x.dataset.value)));
      paintMultiBtn();
      if (notify) onChange?.(el.dataset.value);
      return;
    }
    const o = $$('.opt', menu).find(x => x.dataset.value === String(v)) || $('.opt', menu);
    el.dataset.value = o.dataset.value;
    $$('.opt', menu).forEach(x => x.setAttribute('aria-selected', x === o));
    $('.val', el).textContent = o.textContent.trim();
    el.classList.toggle('set', o.dataset.value !== '' && $('.opt', menu).dataset.value === '');
    if (notify) onChange?.(o.dataset.value);
  };
  el._close = close;
  el.setValue = v => {
    if (multi) { el.dataset.value = String(v ?? ''); $$('.opt', menu).forEach(x => x.setAttribute('aria-selected', el.dataset.value.split(',').includes(x.dataset.value))); paintMultiBtn(); }
    else set(v, false);
  };

  btn.addEventListener('click', e => {
    const x = e.target.closest('.sel-chip i');
    if (x) { set(x.closest('.sel-chip').dataset.val, true); return; } // remove one chip without opening the menu
    el.classList.contains('open') ? close() : open();
  });
  btn.addEventListener('keydown', e => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(); } });
  menu.addEventListener('click', e => {
    const o = e.target.closest('.opt');
    if (!o) return;
    set(o.dataset.value, multi ? true : o.getAttribute('aria-selected') !== 'true');
    if (!multi) close();
  });
  menu.addEventListener('mousemove', e => {
    const o = e.target.closest('.opt');
    if (o && !o.classList.contains('active')) setActive(visible().indexOf(o), false);
  });
  find?.addEventListener('input', () => filter(find.value));
  el.addEventListener('keydown', e => {
    if (!el.classList.contains('open')) return;
    const o = visible();
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
    else if (e.key === 'Home' && !find) { e.preventDefault(); setActive(0); }
    else if (e.key === 'End' && !find) { e.preventDefault(); setActive(o.length - 1); }
    else if (e.key === 'Enter') { e.preventDefault(); if (o[active]) { set(o[active].dataset.value, true); if (!multi) close(); } }
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Tab') close(false);
    else if (!find && e.key.length === 1) {
      // Type-ahead: letters typed in quick succession build a prefix, like a native <select>.
      typed = Date.now() - typedAt > 700 ? e.key : typed + e.key;
      typedAt = Date.now();
      const i = o.findIndex(x => x.textContent.trim().toLowerCase().startsWith(typed.toLowerCase()));
      if (i >= 0) setActive(i);
    }
  });
}

export const switchHTML = (id, label, checked) =>
  `<label class="switch"><input type="checkbox" id="${id}"${checked ? ' checked' : ''}><span class="knob"></span>${esc(label)}</label>`;

/* ---------- episodes ---------- */
/**
 * Merge AniList's airing schedule (numbers, dates) with streaming-service episode
 * listings (titles, thumbnails, links) into one list of episodes. When the local
 * streaming source carries more episodes than AniList lists (source-side extras,
 * AniList undercounts), `sourceEps` extends the list so nothing playable is hidden.
 */
export function episodeIndex(a, schedule, sourceEps = []) {
  const named = new Map();
  (a.streamingEpisodes || []).forEach((e, i) => {
    const n = Number(e.title.match(/Episode\s+(\d+)/i)?.[1] ?? i + 1);
    if (!named.has(n)) named.set(n, { ...e, title: e.title.replace(/^Episode\s+\d+\s*[-:–]\s*/i, '') });
  });
  const stripNum = t => String(t || '').replace(/^Episode\s+\d+\s*[-:–]\s*/i, '');
  const srcTitles = new Map(sourceEps.filter(e => Number.isFinite(Number(e.num))).map(e => [Number(e.num), stripNum(e.title)]));
  const dates = new Map(schedule.map(s => [s.episode, s.airingAt]));
  // AniList's streamingEpisodes and the local streaming source both sometimes
  // carry a whole franchise listing (every season merged) on one entry, which
  // would leak other seasons' episodes into this one as unplayable ghosts.
  // When AniList declares how many episodes this entry has — or where its
  // airing currently is — neither list may extend past that; only an entry
  // with no declared count at all trusts them fully.
  const listsMax = (arrs) => Math.max(0, ...arrs.flat());
  const cap = Math.max(a.episodes || 0, a.nextAiringEpisode ? a.nextAiringEpisode.episode - 1 : 0);
  const highest = listsMax([[...named.keys()], [...srcTitles.keys()], [...dates.keys()]]);
  const total = Math.min(3000, Math.max(a.episodes || 0, cap ? Math.min(highest, cap) : highest,
    a.nextAiringEpisode?.episode || 0, a.format === 'MOVIE' ? 1 : 0));
  const aired = a.nextAiringEpisode ? a.nextAiringEpisode.episode - 1 : a.status === 'NOT_YET_RELEASED' ? 0 : Infinity;
  return Array.from({ length: total }, (_, i) => {
    const n = i + 1;
    const s = named.get(n);
    return {
      n, title: s?.title || srcTitles.get(n) || (a.format === 'MOVIE' && total === 1 ? 'Feature' : ''),
      thumb: s?.thumbnail, url: s?.url, site: s?.site, at: dates.get(n), later: n > aired,
    };
  });
}
