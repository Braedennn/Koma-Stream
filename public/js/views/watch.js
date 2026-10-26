// Watch page: wires the custom player to the local streaming servers.
// Episode and audio changes swap the stream in place — the player element is
// never torn down between episodes, so fullscreen and playback carry over.
import { api, airingSchedule, sourceEpisodes } from '../api.js';
import { addToList, setWatched, watchedSet } from '../store.js';
import { $, $$, big, card, episodeIndex, esc, icon, img, initRails, listBtn, name, plain, row, setTitle, toast, when, ytId } from '../ui.js';
import { Player, ensureHls, getPref, setPref } from '../player.js';
import { streamWatch, getAudioPref, setAudioPref, initAudioBadges, audioCounts } from '../streaming.js';

const PKEY = 'koma.progress';
const readProgress = () => { try { return JSON.parse(localStorage.getItem(PKEY) || '{}'); } catch { return {}; } };
const writeProgress = (id, slot) => { const all = readProgress(); if (slot) all[id] = slot; else delete all[id]; try { localStorage.setItem(PKEY, JSON.stringify(all)); } catch { /* full */ } };

export async function watch(root, { params: [id], query, alive }) {
  root.innerHTML = `<div class="watch"><div class="watch-grid">
    <div class="sk player-shell" style="border:0"></div>
    <div class="sk player-bar" style="height:38px;margin:0"></div>
    <div class="sk ep-panel" style="border:0"></div></div></div>`;

  // Start the slow parts now, while the title and episode list load: the
  // player library, and the stream for the episode we'll most likely open.
  ensureHls();
  const wantType = query.get('type') === 'dub' || query.get('type') === 'sub' ? query.get('type') : getAudioPref();
  const guessEp = Number(query.get('ep')) || readProgress()[id]?.ep;
  if (guessEp) streamWatch({ anilistId: Number(id), ep: guessEp, type: wantType }).catch(() => {});

  // Leaving the page stops the player and drops any stream still resolving.
  let loadSeq = 0;
  let player = null;
  addEventListener('koma:route', () => { loadSeq++; player?.destroy(); player = null; }, { once: true });

  const schedP = airingSchedule(Number(id)).catch(() => []); // doesn't need the title first
  let a = await api(`/anime/${id}`);
  const srcP = sourceEpisodes(a.idMal);
  let schedule = await schedP;
  const asked = Number(query.get('ep'));
  // The streaming server's episode list only adds titles and extra episodes, so don't
  // hold the page for it: give it 1.5s, then draw with AniList's list and merge it in later.
  // Wait for it fully only when AniList alone can't place the episode we're opening.
  let sourceEps = await Promise.race([srcP, new Promise(r => setTimeout(() => r(null), 1500))]);
  if (!sourceEps) {
    const provisional = episodeIndex(a, schedule, []);
    if (!provisional.length || (asked && !provisional.some(e => e.n === asked))) sourceEps = await srcP;
  }
  if (!alive()) return;

  const list = episodeIndex(a, schedule, sourceEps || []);
  let aired = list.filter(e => !e.later);
  let yt = ytId(a);
  let ep = list.find(e => e.n === asked) || aired.find(e => !watchedSet(a.id).has(e.n)) || aired.at(-1) || list[0];
  let type = wantType;
  let mode = (query.get('mode') === 'trailer' || !ep) && yt ? 'trailer' : 'episode';
  let source = 'anikoto';
  let audio = null;
  let recs = (a.recommendations?.nodes || []).map(n => n.mediaRecommendation).filter(Boolean);
  const playable = e => e && !e.later;

  setTitle(ep ? `${name(a)} · Episode ${ep.n}` : name(a));

  root.innerHTML = `
    <div class="watch">
      <nav class="crumbs" aria-label="Breadcrumb"><a href="/">Home</a>${icon('right')}<a href="/anime/${a.id}" data-title-link>${esc(name(a))}</a><span class="crumb-ep"></span></nav>
      <div class="seg" role="tablist" aria-label="Player" data-seg hidden>
        <button type="button" role="tab" data-mode="episode">${icon('tv')}<span class="seg-ep"></span></button>
        <button type="button" role="tab" data-mode="trailer">${icon('film')}Trailer</button>
      </div>
      <div class="watch-grid">
      <div class="player-shell"></div>
      <div class="player-bar">
        <div class="pb-left">
          <button class="btn btn-ghost btn-sm" type="button" data-nav="prev">${icon('prev')}Previous</button>
          <button class="btn btn-primary btn-sm" type="button" data-nav="next">Next episode${icon('next')}</button>
        </div>
        <div class="pb-right">
          <button class="btn btn-ghost btn-sm btn-toggle" type="button" data-pref="autoNext" aria-label="Autoplay next episode" title="Play the next episode when this one ends">${icon('next')}<span class="lbl">Autoplay</span><span class="tg" aria-hidden="true"></span></button>
          <button class="btn btn-ghost btn-sm btn-toggle" type="button" data-pref="skip" aria-label="Skip intro and outro" title="Jump past openings and endings automatically">${icon('skip')}<span class="lbl">Skip intro &amp; outro</span><span class="tg" aria-hidden="true"></span></button>
          <span class="pb-sep" aria-hidden="true"></span>
          <button class="btn btn-ghost btn-sm" type="button" data-seen-btn></button>
          ${listBtn(a.id).replace('class="btn btn-ghost"', 'class="btn btn-ghost btn-sm"')}
        </div>
      </div>
        <aside class="ep-panel" aria-label="Episodes">
          <header>
            <h2>Episodes</h2>
            <p class="sub"></p>
            <div class="prog"><i></i></div>
            <label class="field ep-find"${list.length > 12 ? '' : ' hidden'}>${icon('search')}<span class="sr">Find an episode</span><input type="search" placeholder="Find episode by number or title"></label>
          </header>
          <ol class="ep-list"></ol>
        </aside>
        <div class="watch-info">
          <div class="now">
            ${img(big(a), '', ' data-title-img')}
            <div>
              <h1><a href="/anime/${a.id}" data-title-link>${esc(name(a))}</a></h1>
              <p class="ep-line"></p>
              <p class="syn">${esc(plain(a.description) || 'No synopsis yet.')}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div class="recs-slot"></div>`;

  initRails(root);
  initAudioBadges(root);

  const shell = $('.player-shell', root);
  const $seg = $('[data-seg]', root);
  let prefetched = '';

  audioCounts(a.id).then(c => { if (alive()) { audio = c; syncAudioUI(); player?.setAudio({ type, canDub: !c || c.dub > 0, counts: c }); } });
  const dubAllowed = () => !audio || audio.dub > 0;

  const idx = () => list.indexOf(ep);
  const prevEp = () => list[idx() - 1] || null;
  const nextEp = () => { const n = list[idx() + 1]; return n && !n.later ? n : null; };
  // Next/Previous stay inside this season. The list once grew sections for
  // related seasons here, but those episodes could not be resolved by the
  // streaming sources, so clicking or autoplaying into them broke the player.
  const nextTarget = () => nextEp();
  const prevTarget = () => prevEp();
  const goNext = () => { const t = nextTarget(); if (t) gotoEpisode(t.n); };
  const goPrev = () => { const t = prevTarget(); if (t) gotoEpisode(t.n); };

  const drawerHTML = () => `<div class="kp-ep-scroll">${list.map(e => `
    <button type="button" class="kp-ep-item${e === ep ? ' on' : ''}${e.later ? ' later' : ''}" data-ep="${e.n}">
      <b>${e.n}</b><span>${esc(e.title || `Episode ${e.n}`)}</span>${watchedSet(a.id).has(e.n) ? icon('check') : ''}
    </button>`).join('')}</div>`;

  const hooks = {
    onPrev: goPrev,
    onNext: goNext,
    onEnded: n => { mark(n, true, true); writeProgress(a.id, null); },
    onAudio: t => switchAudio(t),
    onRefresh: () => loadStream({ keepTime: true, fresh: true }),
    onProgress: (t, dur) => {
      if (mode !== 'episode' || !playable(ep)) return;
      if (t > 10 && Number.isFinite(dur) && dur - t > 25) writeProgress(a.id, { ep: ep.n, t, dur, at: Date.now() });
      // Resolve the next episode in the last couple of minutes so autoplay starts instantly.
      const nt = nextTarget();
      if (nt && prefetched !== `${a.id}:${nt.n}` && Number.isFinite(dur) && dur - t < 150) {
        prefetched = `${a.id}:${nt.n}`;
        streamWatch({ anilistId: a.id, ep: nt.n, type, source }).catch(() => {});
      }
    },
    drawerHTML,
    nextLabel: () => { const t = nextTarget(); return t ? `E${t.n}${t.title ? ` · ${t.title}` : ''}` : ''; },
  };

  function ensurePlayer() {
    if (player) return player;
    player = new Player(shell, hooks);
    player.setAudio({ type, canDub: dubAllowed(), counts: audio });
    player.el.drawerBody.addEventListener('click', e => {
      const b = e.target.closest('[data-ep]');
      if (!b || b.classList.contains('later')) return;
      player.toggleDrawer(false);
      gotoEpisode(Number(b.dataset.ep));
    });
    return player;
  }

  function showNote(html) {
    loadSeq++; // any stream still resolving is no longer wanted
    if (player) { player.destroy(); player = null; }
    shell.innerHTML = `<div class="player-note">${html}</div>`;
  }

  function syncUrl() {
    const q = new URLSearchParams();
    if (ep) q.set('ep', String(ep.n));
    if (type === 'dub') q.set('type', 'dub');
    if (mode === 'trailer') q.set('mode', 'trailer');
    history.replaceState(history.state, '', `/watch/${a.id}${String(q) ? `?${q}` : ''}`);
  }

  function renderPlayerArea() {
    // Trailer mode: plain YouTube embed, no custom player.
    if (mode === 'trailer') {
      showNote(`<div class="embed-wrap"><iframe src="https://www.youtube-nocookie.com/embed/${esc(yt)}?rel=0&autoplay=1" title="${esc(name(a))} trailer"
        allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe></div>`);
      return;
    }
    if (!ep) {
      showNote(`<div class="note-center"><span class="note-icon">${icon('tv')}</span><h2>No episodes yet</h2><p>This title hasn’t started airing.</p></div>`);
      return;
    }
    if (ep.later) {
      showNote(`<div class="note-center"><span class="note-icon">${icon('clock')}</span><h2>Episode ${ep.n} hasn’t aired yet</h2>
        <p>${ep.at ? `It airs ${esc(when(ep.at))}, your time.` : 'No air date announced yet.'}</p>
        <a class="btn btn-ghost btn-sm" href="/schedule">${icon('calendar')}Open the schedule</a></div>`);
      return;
    }
    loadStream();
  }

  async function loadStream(opts = {}) {
    const seq = ++loadSeq;
    const p = ensurePlayer();
    p.spinner(true);
    p.el.start.hidden = true;
    p.el.error.hidden = true;

    let r = null, lastErr = null;
    for (const src of [...new Set([source, 'anikoto', 'animeheaven'])]) {
      try { r = await streamWatch({ anilistId: a.id, ep: ep.n, type, source: src, fresh: opts.fresh }); source = src; break; }
      catch (err) { lastErr = err; }
    }
    await ensureHls();
    if (seq !== loadSeq || !alive()) return; // the viewer moved on while this resolved

    // Every source said "not found" for the dub: this episode isn't dubbed yet.
    if (!r && type === 'dub' && lastErr?.status === 404) {
      toast('No English dub for this episode — back to sub');
      type = 'sub'; setAudioPref('sub'); syncUrl(); syncAudioUI();
      return loadStream();
    }

    // 503 = Koma can't reach the streaming server, usually because it's still starting up
    // (that takes up to a minute after a restart). Keep trying for ~2 minutes before giving up.
    if (!r && lastErr?.status === 503 && (opts.wakeTries || 0) < 24) {
      p.showMessage('Streaming server is starting up…', 'This can take up to a minute after a restart. The episode will start on its own.');
      $('[data-retry]', p.el.error).hidden = true;
      p.spinner(true);
      setTimeout(() => { if (seq === loadSeq && alive()) loadStream({ ...opts, wakeTries: (opts.wakeTries || 0) + 1 }); }, 5000);
      return;
    }

    if (!r) {
      p.showMessage('Couldn’t get a stream', `${lastErr?.message || 'No playable source responded.'} You can still track this episode, or try the official services.`);
      return;
    }
    if (r.playbackMode === 'iframe' || !r.hlsProxyUrl && !r.mp4ProxyUrl && !r.streamUrl) {
      if (r.embedUrl) {
        showNote(`<div class="embed-wrap"><iframe src="${esc(r.embedUrl)}" title="${esc(name(a))} — external player" allow="autoplay; fullscreen; encrypted-media" referrerpolicy="no-referrer" allowfullscreen sandbox="allow-scripts allow-same-origin allow-presentation"></iframe></div>`);
        return;
      }
      p.showMessage('Couldn’t get a stream', 'The source site didn’t return a playable file.');
      return;
    }

    const slot = readProgress()[a.id];
    let resumeAt = slot && slot.ep === ep.n && slot.t > 20 && slot.dur - slot.t > 30 ? slot.t : 0;
    if (opts.keepTime && player && player.video.currentTime > 15) resumeAt = player.video.currentTime;
    p.load({
      src: r.hlsProxyUrl || r.mp4ProxyUrl || r.streamUrl,
      mode: r.playbackMode === 'mp4' ? 'mp4' : 'hls',
      title: name(a),
      ep: ep.n, epTitle: ep.title || '',
      type,
      intro: r.intro, outro: r.outro,
      subtitles: r.subtitles || [],
      poster: ep.thumb || a.bannerImage || big(a),
      resumeAt,
      hasNext: Boolean(nextTarget()),
      hasPrev: Boolean(prevTarget()),
    });
    p.setAudio({ type, canDub: dubAllowed(), counts: audio });
  }

  function gotoEpisode(n) {
    const target = list.find(e => e.n === n);
    if (!target || target === ep) return;
    if (ep && n > ep.n && playable(ep) && !watchedSet(a.id).has(ep.n)) mark(ep.n, true, true);
    const slot = readProgress()[a.id];
    if (slot && slot.ep === ep?.n) writeProgress(a.id, null);
    ep = target;
    if (mode === 'trailer' && playable(ep)) mode = 'episode';
    setTitle(`${name(a)} · Episode ${ep.n}`);
    syncUrl();
    updateUI();
    renderPlayerArea();
  }

  function switchAudio(t) {
    if (t === type) return;
    if (t === 'dub' && !dubAllowed()) { toast('No English dub available for this anime'); return; }
    type = t;
    setAudioPref(t);
    syncUrl();
    syncAudioUI();
    loadStream();
  }

  function mark(n, on, quiet) {
    setWatched(a.id, n, on);
    if (!quiet) {
      if (on && addToList(a.id)) toast(`Episode ${n} watched · added to My list`);
      else toast(on ? `Episode ${n} marked as watched` : `Episode ${n} unmarked`);
    } else if (on) addToList(a.id);
    refreshEpList();
  }

  function syncAudioUI() {
    player?.setAudio({ type, canDub: dubAllowed(), counts: audio });
  }

  function syncPrefUI() {
    for (const b of $$('[data-pref]', root)) {
      const on = b.dataset.pref === 'skip' ? getPref('skipIntro') || getPref('skipOutro') : getPref(b.dataset.pref);
      b.setAttribute('aria-pressed', Boolean(on));
    }
  }
  addEventListener('koma:prefs', function onPrefs() { if (!alive()) return removeEventListener('koma:prefs', onPrefs); syncPrefUI(); });

  function refreshEpList() {
    const seen = watchedSet(a.id);
    const pct = aired.length ? Math.min(100, seen.size / aired.length * 100) : 0;
    const ol = $('.ep-list', root);
    const current = list.map(e => `<li class="ep-item${e.later ? ' later' : ''}"${e === ep ? ' aria-current="true"' : ''} data-n="${e.n}" data-t="${esc((e.title || '').toLowerCase())}">
      <a href="/watch/${a.id}?ep=${e.n}"><span class="no">${e.n}</span><span><b>${esc(e.title || `Episode ${e.n}`)}</b>${e.at ? `<small>${esc(when(e.at))}</small>` : ''}</span></a>
      <button class="check" type="button" data-seen="${e.n}" aria-pressed="${seen.has(e.n)}" aria-label="Episode ${e.n} watched"${e.later ? ' disabled' : ''}>${icon('check')}</button>
    </li>`).join('');
    ol.innerHTML = current;
    const cur = $('[aria-current="true"]', ol);
    if (cur) ol.scrollTop = cur.offsetTop - ol.offsetTop - 140;
    $('.ep-panel .sub', root).textContent = `${seen.size} of ${aired.length || list.length} watched${a.nextAiringEpisode ? ` · Ep ${a.nextAiringEpisode.episode} ${when(a.nextAiringEpisode.airingAt)}` : ''}`;
    $('.prog i', root).style.width = `${pct}%`;
    $('.ep-find', root).hidden = list.length <= 12; // the list can grow once the streaming server answers
    if (player) player.el.drawerBody.innerHTML = drawerHTML();
  }

  function updateUI() {
    const seen = watchedSet(a.id);
    $('.crumb-ep', root).innerHTML = ep ? `${icon('right')}<span>Episode ${ep.n}</span>` : '';
    $seg.hidden = !(yt && playable(ep));
    $$('[data-mode]', $seg).forEach(b => b.setAttribute('aria-selected', b.dataset.mode === mode));
    $('.seg-ep', root).textContent = ep ? `Episode ${ep.n}` : '';
    $('[data-nav="prev"]', root).disabled = !prevTarget();
    const next = nextTarget();
    const nextBtn = $('[data-nav="next"]', root);
    nextBtn.hidden = !next;
    nextBtn.innerHTML = `Next episode${icon('next')}`;
    if (player) { player.state.hasNext = Boolean(next); player.el.nextBtn.disabled = !next; player.state.hasPrev = Boolean(prevTarget()); player.el.prev.disabled = !player.state.hasPrev; }
    $('.player-bar', root).hidden = mode === 'trailer';
    const seenBtn = $('[data-seen-btn]', root);
    if (ep && playable(ep)) {
      const done = seen.has(ep.n);
      seenBtn.hidden = false;
      seenBtn.classList.toggle('done', done);
      seenBtn.setAttribute('aria-pressed', done);
      seenBtn.innerHTML = `${icon('check')}${done ? 'Watched' : 'Mark watched'}`;
      seenBtn.dataset.seen = ep.n;
    } else seenBtn.hidden = true;
    $('.now .ep-line', root).textContent = ep ? `Episode ${ep.n}${a.episodes ? ` of ${a.episodes}` : ''}${ep.title ? ` · ${ep.title}` : ''}` : '';
    syncAudioUI();
    refreshEpList();
  }

  /* ---------- events ---------- */
  root.addEventListener('click', e => {
    const modeBtn = e.target.closest('[data-mode]');
    if (modeBtn) { mode = modeBtn.dataset.mode; syncUrl(); updateUI(); renderPlayerArea(); return; }

    const nav = e.target.closest('[data-nav]');
    if (nav && !nav.disabled) { nav.dataset.nav === 'prev' ? goPrev() : goNext(); return; }

    const pref = e.target.closest('[data-pref]');
    if (pref) {
      const on = pref.getAttribute('aria-pressed') !== 'true';
      if (pref.dataset.pref === 'skip') { setPref('skipIntro', on); setPref('skipOutro', on); }
      else setPref(pref.dataset.pref, on);
      toast(`${pref.dataset.pref === 'skip' ? 'Skip intro & outro' : 'Autoplay next episode'} ${on ? 'on' : 'off'}`);
      return;
    }

    const seenBtn = e.target.closest('[data-seen]');
    if (seenBtn) {
      const keep = $('.ep-list', root)?.scrollTop;
      mark(Number(seenBtn.dataset.seen), seenBtn.getAttribute('aria-pressed') !== 'true');
      updateUI();
      if (seenBtn.classList.contains('check')) $('.ep-list', root).scrollTop = keep;
      return;
    }

    const epLink = e.target.closest('.ep-item a[href]');
    if (epLink) {
      e.preventDefault();
      const n = Number(epLink.href.match(/ep=(\d+)/)?.[1]);
      if (epLink.closest('.later')) return;
      gotoEpisode(n);
      return;
    }

    if (e.target.closest('a[href$="mode=trailer"], [data-mode]')) return; // handled above
  });

  $('.ep-find input', root)?.addEventListener('input', e => {
    const q = e.target.value.trim().toLowerCase();
    for (const li of $$('.ep-item', $('.ep-list', root))) li.hidden = Boolean(q) && !(li.dataset.n.startsWith(q) || li.dataset.t.includes(q));
  });

  function renderRecs() {
    const slot = $('.recs-slot', root);
    slot.innerHTML = recs.length ? `<div class="rows" style="padding-top:16px">${row({ title: 'More like this', sub: 'Recommended by AniList users.', body: recs.map(r => card(r)).join('') })}</div>` : '';
    if (recs.length) initRails(slot);
  }
  renderRecs();

  syncPrefUI();
  updateUI();
  renderPlayerArea();

  if (!sourceEps) srcP.then(eps => {
    if (!alive() || !eps.length) return;
    list.splice(0, list.length, ...episodeIndex(a, schedule, eps));
    ep = list.find(e => e.n === ep?.n) || ep;
    aired = list.filter(e => !e.later);
    updateUI();
  });
}
