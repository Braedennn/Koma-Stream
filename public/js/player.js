// Koma custom video player: Netflix-style controls over a <video> element.
// The container survives episode changes (only the source swaps), so
// fullscreen and playback carry straight into the next episode.
import { $, $$, esc, icon } from './ui.js';

const PREFS_KEY = 'koma.player';
const prefs = (() => {
  try { return { autoNext: true, skipIntro: false, skipOutro: false, autoplay: true, speed: 1, volume: 1, muted: false, cc: null, quality: null, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; }
  catch { return { autoNext: true, skipIntro: false, skipOutro: false, autoplay: true, speed: 1, volume: 1, muted: false, cc: null, quality: null }; }
})();
const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* private mode */ } };

/** Playback toggles live under the player (watch page) and in its settings menu; both go through here. */
export const getPref = key => prefs[key];
export function setPref(key, value) {
  prefs[key] = value;
  savePrefs();
  dispatchEvent(new CustomEvent('koma:prefs', { detail: { key, value } }));
}

/** Load hls.js on first use instead of on every page (it's ~600 KB). */
let hlsPromise;
export const ensureHls = () => (hlsPromise ??= window.Hls ? Promise.resolve() : new Promise(resolve => {
  const done = () => { clearTimeout(timer); resolve(); };
  const timer = setTimeout(() => { hlsPromise = null; done(); }, 15000); // a hung script load must not hang the player
  const s = document.createElement('script');
  s.src = '/js/lib/hls.min.js';
  s.onload = done;
  s.onerror = () => { hlsPromise = null; done(); }; // falls back to native HLS / error message
  document.head.appendChild(s);
}));

const fmt = s => {
  if (!Number.isFinite(s)) return '0:00';
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(x).padStart(2, '0')}` : `${m}:${String(x).padStart(2, '0')}`;
};

/** The language of an audio track, as far as the playlist says. */
const trackLang = t => {
  const code = String(t?.lang || '').toLowerCase().split(/[-_]/)[0];
  if (code && code !== 'und') return code;
  const name = String(t?.name || '').toLowerCase();
  if (/english|ingles|anglais/.test(name)) return 'en';
  if (/japanese|japonais|日本語/.test(name)) return 'ja';
  return '';
};

export class Player {
  /**
   * @param container element that gets .kplayer
   * @param {object} hooks - onPrev, onNext, onEnded(ep), onAudio(type), onProgress(t, dur), onSeek(t, dur), drawerHTML()
   */
  constructor(container, hooks) {
    this.hooks = hooks || {};
    this.container = container;
    container.classList.add('kplayer');
    container.innerHTML = `
      <video playsinline preload="metadata"></video>
      <div class="kp-shade"></div>
      <div class="kp-top"><div class="kp-now"><h3></h3><p></p></div></div>
      <div class="kp-start">
        <div class="kp-start-bg"></div>
        <button class="kp-bigplay" type="button" aria-label="Play">${icon('play')}</button>
        <p class="kp-start-note"></p>
      </div>
      <div class="kp-busy" hidden><span class="kp-spin"></span></div>
      <div class="kp-error" hidden>
        <h3>Playback trouble</h3><p></p>
        <button class="btn btn-primary btn-sm" type="button" data-retry>${icon('reload')}Try again</button>
      </div>
      <button class="kp-skipbtn" type="button" hidden></button>
      <div class="kp-nextcard" hidden></div>
      <div class="kp-drawer" hidden><header><h4>Episodes</h4><button type="button" class="kp-x" aria-label="Close">${icon('x')}</button></header><div class="kp-drawer-body"></div></div>
      <div class="kp-bottom">
        <div class="kp-scrub" aria-label="Seek">
          <div class="kp-tip" hidden>0:00</div>
          <div class="kp-rail"><i class="kp-buf"></i><i class="kp-played"></i><span class="kp-knob"></span></div>
        </div>
        <div class="kp-row">
          <div class="kp-side">
            <button class="kp-ic" data-act="play" aria-label="Play">${icon('play')}</button>
            <button class="kp-ic" data-act="prev" aria-label="Previous episode">${icon('prev')}</button>
            <button class="kp-ic" data-act="next" aria-label="Next episode">${icon('next')}</button>
            <div class="kp-vol">
              <button class="kp-ic" data-act="mute" aria-label="Mute">${icon('vol')}</button>
              <div class="kp-vol-rail" role="slider" aria-label="Volume" aria-valuemin="0" aria-valuemax="100" tabindex="0"><i></i><span></span></div>
            </div>
            <span class="kp-time"><b class="kp-cur">0:00</b><span class="kp-dur">0:00</span></span>
          </div>
          <div class="kp-side">
            <div class="kp-audio" role="group" aria-label="Audio" hidden>
              <button type="button" data-audio="sub" aria-pressed="false">SUB</button>
              <button type="button" data-audio="dub" aria-pressed="false">DUB</button>
            </div>
            <button class="kp-ic" data-act="cc" aria-label="Subtitles" hidden>${icon('cc')}</button>
            <button class="kp-ic" data-act="settings" aria-label="Settings" aria-haspopup="menu">${icon('gear')}</button>
            <button class="kp-ic" data-act="eps" aria-label="Episodes" hidden>${icon('list')}</button>
            <button class="kp-ic" data-act="pip" aria-label="Picture in picture" hidden>${icon('pip')}</button>
            <button class="kp-ic" data-act="full" aria-label="Fullscreen">${icon('full')}</button>
          </div>
        </div>
      </div>
      <div class="kp-menu" role="menu" hidden></div>`;

    this.video = $('video', container);
    this.el = {
      top: $('.kp-top', container), now: $('.kp-now', container),
      start: $('.kp-start', container), bigPlay: $('.kp-bigplay', container), startBg: $('.kp-start-bg', container), startNote: $('.kp-start-note', container),
      busy: $('.kp-busy', container), error: $('.kp-error', container), errMsg: $('.kp-error p', container),
      skip: $('.kp-skipbtn', container),
      next: $('.kp-nextcard', container),
      drawer: $('.kp-drawer', container), drawerBody: $('.kp-drawer-body', container),
      bottom: $('.kp-bottom', container), scrub: $('.kp-scrub', container), rail: $('.kp-rail', container),
      played: $('.kp-played', container), buf: $('.kp-buf', container), knob: $('.kp-knob', container), tip: $('.kp-tip', container),
      play: $('[data-act="play"]', container), prev: $('[data-act="prev"]', container), nextBtn: $('[data-act="next"]', container),
      mute: $('[data-act="mute"]', container), volRail: $('.kp-vol-rail', container), volFill: $('.kp-vol-rail i', container), volKnob: $('.kp-vol-rail span', container),
      cur: $('.kp-cur', container), dur: $('.kp-dur', container),
      audio: $('.kp-audio', container), cc: $('[data-act="cc"]', container),
      settings: $('[data-act="settings"]', container), menu: $('.kp-menu', container),
      eps: $('[data-act="eps"]', container), pip: $('[data-act="pip"]', container), full: $('[data-act="full"]', container),
    };

    this.state = { ep: null, type: 'sub', intro: null, outro: null, next: null, hasNext: false, hasPrev: false, started: false, introJumped: false, heuristicOffered: false, nextShown: false, nextTimer: null, nextCountdown: null, retryCount: 0 };
    this.hls = null;

    this.video.volume = prefs.volume;
    this.video.muted = prefs.muted;
    this.video.defaultPlaybackRate = this.video.playbackRate = prefs.speed;
    if (document.pictureInPictureEnabled) this.el.pip.hidden = false;

    this.bind();
    this.updateVolumeUI();
  }

  /* ---------- public API ---------- */

  /** Load an episode into the player without touching the container. */
  load({ src, mode = 'hls', title, ep, epTitle = '', type, intro, outro, subtitles = [], poster, resumeAt = 0, hasNext, hasPrev, nextLabel = 'Next episode' }) {
    this.teardownHls();
    clearTimeout(this.state.nextTimer); clearInterval(this.state.nextCountdown);
    Object.assign(this.state, {
      ep, type, intro: intro || null, outro: outro || null, hasNext, hasPrev,
      started: false, introJumped: false, outroJumped: false, heuristicOffered: false, nextShown: false, retryCount: 0,
      fatal: 0, refreshed: false, advancing: false,
    });

    this.el.now.querySelector('h3').textContent = title || '';
    this.el.now.querySelector('p').textContent = epTitle ? `E${ep} · ${epTitle}` : `Episode ${ep}`;
    this.el.startBg.style.backgroundImage = poster ? `url("${poster}")` : '';
    this.el.startNote.textContent = resumeAt > 20 ? `Resuming from ${fmt(resumeAt)}` : '';
    this.el.start.hidden = false;
    this.el.error.hidden = true;
    this.el.next.hidden = true;
    this.el.skip.hidden = true;
    this.el.prev.disabled = !hasPrev;
    this.el.nextBtn.disabled = !hasNext;
    this.el.dur.textContent = '0:00';
    this.el.cur.textContent = fmt(resumeAt);
    this.el.played.style.width = '0%';
    this.el.buf.style.width = '0%';
    this.setAudioButtons();
    $$('track', this.video).forEach(t => t.remove()); // old tracks out before the new ones go in
    this.setCC(subtitles, type);
    this.el.eps.hidden = !this.hooks.drawerHTML;
    if (this.hooks.drawerHTML) this.el.drawerBody.innerHTML = this.hooks.drawerHTML();

    const v = this.video;
    v.poster = '';
    v.removeAttribute('src');
    try { v.load(); } catch { /* swapping */ }
    this._pending = { src, mode, subtitles, resumeAt, type };

    if (mode === 'hls' && window.Hls && Hls.isSupported()) {
      this.hls = new Hls({
        enableWorker: true, lowLatencyMode: false, backBufferLength: 90, abrEwmaDefaultEstimate: 3e6,
        maxBufferLength: 30, maxMaxBufferLength: 90, capLevelToPlayerSize: false,
        manifestLoadingMaxRetry: 4, manifestLoadingRetryDelay: 800, manifestLoadingMaxRetryTimeout: 8000,
        levelLoadingMaxRetry: 4, levelLoadingRetryDelay: 800, levelLoadingMaxRetryTimeout: 8000,
        fragLoadingMaxRetry: 8, fragLoadingRetryDelay: 700, fragLoadingMaxRetryTimeout: 10000,
      });
      // A quality the viewer picked sticks across episodes (stored as a height, since
      // level numbers differ per stream). Otherwise ABR starts from a ~3 Mbps guess:
      // first frame comes fast, then it climbs to the best the connection holds.
      this.hls.on(Hls.Events.MANIFEST_PARSED, () => {
        try {
          const i = prefs.quality ? this.hls.levels.findIndex(l => l.height === prefs.quality) : -1;
          if (i >= 0) this.hls.currentLevel = i;
        } catch { /* leave default */ }
        this.pickAudioTrack();
      });
      this.hls.on(Hls.Events.ERROR, (_, data) => this.onHlsError(data));
      this.hls.loadSource(src);
      this.hls.attachMedia(v);
    } else if (mode === 'hls' && v.canPlayType('application/vnd.apple.mpegurl')) {
      v.src = src; // Safari: native HLS
    } else if (mode === 'hls') {
      this.showError('This browser can’t play HLS streams.');
      return;
    } else {
      v.src = src;
    }

    this.spinner(true);
    if (resumeAt > 20) {
      const seek = () => { try { v.currentTime = this._pending.resumeAt; } catch { /* not yet */ } };
      v.addEventListener('loadedmetadata', seek, { once: true });
    }
    // Autoplay the episode straight away — browsers allow this once the page
    // has sticky user activation (any earlier click); a fresh cold load falls
    // back to the big play button.
    if (prefs.autoplay !== false) {
      v.defaultPlaybackRate = v.playbackRate = prefs.speed; // load() resets the rate
    const pr = v.play();
      if (pr?.then) pr.then(() => { this.el.start.hidden = true; }).catch(() => { this.el.start.hidden = false; });
    }
    this.container.dispatchEvent(new CustomEvent('koma:loaded', { bubbles: true }));
    this.armStall(); // if this never becomes playable, tryRefresh takes over instead of an endless spinner
  }

  setAudio({ type, canDub, counts }) {
    this.state.type = type;
    this.state.canDub = canDub !== false;
    this.el.audio.hidden = false;
    $$('button', this.el.audio).forEach(b => {
      const on = b.dataset.audio === type;
      b.setAttribute('aria-pressed', on);
      const n = b.dataset.audio === 'dub' ? counts?.dub : counts?.sub;
      b.innerHTML = `${b.dataset.audio.toUpperCase()}${n ? `<small>${n}</small>` : ''}`;
      if (b.dataset.audio === 'dub') {
        b.disabled = !this.state.canDub;
        b.title = this.state.canDub ? (n ? `${n} dubbed episodes` : 'English dub') : 'No English dub available';
      } else {
        b.title = n ? `${n} subbed episodes` : 'Japanese audio, subtitles';
      }
    });
  }

  /** Disable all interactivity and show a message (streaming offline etc). */
  showMessage(title, msg) {
    this.el.start.hidden = true;
    this.el.error.hidden = false;
    this.el.error.querySelector('h3').textContent = title;
    this.el.errMsg.textContent = msg;
    $('[data-retry]', this.el.error).hidden = !this._pending;
    this.spinner(false);
  }

  destroy() {
    this.teardownHls();
    this.video.pause();
    this.video.removeAttribute('src');
    try { this.video.load(); } catch { /* gone */ }
    clearTimeout(this._stateTimer);
    clearTimeout(this._stallTimer);
    clearInterval(this.saveInterval);
    clearTimeout(this.state.nextTimer); clearInterval(this.state.nextCountdown);
    this.removeListeners?.();
    this.container.classList.remove('kplayer');
    this.container.innerHTML = '';
  }

  /* ---------- internals ---------- */

  showError(msg, retryable = true) {
    this.spinner(false);
    this.el.error.hidden = false;
    this.el.errMsg.textContent = msg;
    $('[data-retry]', this.el.error).hidden = !retryable;
    this.el.start.hidden = true;
  }

  onHlsError(data) {
    console.warn('[koma player] hls error:', data.type, data.details, data.fatal ? '(fatal)' : '', data.frag?.url || data.url || '');
    if (!data.fatal || !this.hls) return;
    const s = this.state;
    s.fatal = (s.fatal || 0) + 1;
    // Escalating ladder: give hls.js room to ride out upstream blips first,
    // then recover the engine, then re-resolve a fresh signed URL, and
    // only then surface the error to the viewer.
    if (data.type === Hls.ErrorTypes.NETWORK_ERROR && s.fatal <= 4) {
      const delay = 400 * s.fatal;
      setTimeout(() => { try { this.hls?.startLoad(); } catch { /* replaced */ } }, delay);
      this.toastState('Connection hiccup — retrying');
      return;
    }
    if (data.type === Hls.ErrorTypes.MEDIA_ERROR && s.fatal <= 5) {
      try { this.hls.recoverMediaError(); } catch { /* replaced */ }
      return;
    }
    if (!s.refreshed) {
      s.refreshed = true;
      this.tryRefresh('Stream broke — getting a fresh link');
      return;
    }
    this.showError('The stream stopped responding. Press Try again for a fresh link.');
  }

  /** One shared re-resolve path for mid-episode breakage and stalled loads.
   *  A bad source can fail forever, so silent re-resolves are budgeted: two
   *  inside five minutes, then the error screen with a manual retry. */
  tryRefresh(reason) {
    const now = Date.now();
    if ((this._refreshTally || 0) >= 2 && now - (this._lastRefreshAt || 0) < 5 * 60e3) {
      this.showError('The stream keeps failing — the source may be down. Try again in a moment, or pick another episode.', true);
      return false;
    }
    this._refreshTally = (this._refreshTally || 0) + 1;
    this._lastRefreshAt = now;
    this.toastState(reason);
    this.saveProgressNow();
    this.hooks.onRefresh?.();
    return true;
  }

  /** If an episode never becomes playable, don't spin forever: try one more
   *  fresh link (through the same budget), then show the error screen. */
  armStall(ms = 60000) {
    clearTimeout(this._stallTimer);
    this._stallTimer = setTimeout(() => {
      if (!this.state.started && !this.el.busy.hidden) this.tryRefresh('Still loading — trying a fresh link');
    }, ms);
  }

  /** Tiny non-blocking notice inside the player (reconnects etc). */
  toastState(msg) {
    clearTimeout(this._stateTimer);
    const t = this.el.stateToast ?? (() => {
      const el = document.createElement('div');
      el.className = 'kp-state';
      this.container.appendChild(el);
      this.el.stateToast = el;
      return el;
    })();
    t.textContent = msg;
    t.hidden = false;
    this._stateTimer = setTimeout(() => { t.hidden = true; }, 2400);
  }

  teardownHls() {
    if (this.hls) { try { this.hls.destroy(); } catch { /* gone */ } this.hls = null; }
  }

  /**
   * The audio track that was asked for.
   *
   * A dub playlist can carry Hindi, English and Japanese side by side. The
   * server narrows the playlist down to the language that was asked for; this
   * is the other half of that, for the playlists the server had no say over.
   */
  pickAudioTrack() {
    const tracks = this.hls?.audioTracks || [];
    if (tracks.length < 2) return;
    const want = this.state.type === 'dub' ? 'en' : 'ja';
    const i = tracks.findIndex(t => trackLang(t) === want);
    if (i < 0 || i === this.hls.audioTrack) return;
    try { this.hls.audioTrack = i; } catch { /* leave the default */ }
  }

  retry() {
    this._refreshTally = 0; // the viewer asked for it — grant a fresh recovery budget
    if (!this._pending) return;
    const p = this._pending;
    this.load({ ...p, resumeAt: this.video.currentTime || p.resumeAt, hasNext: this.state.hasNext, hasPrev: this.state.hasPrev, title: this.el.now.querySelector('h3').textContent, ep: this.state.ep, type: this.state.type });
  }

  spinner(on) {
    if (!on) clearTimeout(this._stallTimer); // playback began or an error screen is up — the watchdog is off
    this.el.busy.hidden = !on;
  }

  setCC(subtitles, type) {
    const v = this.video;
    subtitles.slice(0, 4).forEach(s => {
      const t = document.createElement('track');
      t.kind = 'subtitles';
      t.label = s.lang || 'Subtitles';
      t.srclang = /jpn|ja\b/i.test(s.lang) ? 'ja' : 'en';
      t.src = s.url;
      v.appendChild(t);
    });
    const has = v.querySelectorAll('track').length > 0;
    this.el.cc.hidden = !has;
    const wantOn = prefs.cc === true || (prefs.cc === null && type === 'sub');
    requestAnimationFrame(() => {
      const tracks = v.textTracks;
      for (let i = 0; i < tracks.length; i++) tracks[i].mode = wantOn && i === 0 ? 'showing' : 'disabled';
      this.el.cc.classList.toggle('on', wantOn);
    });
  }

  setAudioButtons() {
    $$('button', this.el.audio).forEach(b => b.setAttribute('aria-pressed', b.dataset.audio === this.state.type));
  }

  play() {
    this.el.start.hidden = true;
    this.video.play().catch(() => {});
  }

  togglePlay() {
    if (!this.state.started) return this.play();
    this.video.paused ? this.play() : this.video.pause();
  }

  seekTo(t) { try { this.video.currentTime = Math.max(0, Math.min((this.video.duration || 1e9) - 0.5, t)); } catch { /* not ready */ } }

  nextEpisode() {
    if (this.state.advancing || !this.state.hasNext) return; // one transition at a time — a second fire double-skips
    this.saveProgressNow(); // save the outgoing episode's position before freezing writes
    this.state.advancing = true;
    this.hooks.onNext?.();
  }

  saveProgressNow() {
    if (this.state.advancing) return; // mid-transition: the old video's timestamps must not poison the next episode's resume slot
    if (this.state.started && Number.isFinite(this.video.currentTime)) this.hooks.onProgress?.(this.video.currentTime, this.video.duration);
  }

  /* ---------- bindings ---------- */

  bind() {
    const v = this.video;
    const on = (el, ev, fn, opts) => { el.addEventListener(ev, fn, opts); (this._bound ??= []).push([el, ev, fn]); };
    this.removeListeners = () => (this._bound || []).forEach(([el, ev, fn]) => el.removeEventListener(ev, fn));
    const root = this.container;

    on(v, 'loadedmetadata', () => { this.el.dur.textContent = fmt(v.duration); this.spinner(false); });
    on(v, 'canplay', () => this.spinner(false));
    on(v, 'waiting', () => this.spinner(true));
    on(v, 'playing', () => {
      this.spinner(false); this.state.started = true; this.el.play.innerHTML = icon('pause'); root.classList.add('playing');
      if (this.video.currentTime > 120) this._refreshTally = 0; // healthy deep playback earns a fresh recovery budget
      this.hooks.onPlay?.();
    });
    on(v, 'pause', () => { this.el.play.innerHTML = icon('play'); root.classList.remove('playing'); this.saveProgressNow(); this.hooks.onPause?.(); });
    on(v, 'ended', () => this.onEnded());
    on(v, 'timeupdate', () => this.onTime());
    on(v, 'seeked', () => this.hooks.onSeek?.(v.currentTime, v.duration)); // scrub drop, skip jumps, resume points: the profile bar must follow instantly
    on(v, 'progress', () => {
      try {
        const b = v.buffered;
        const end = b.length ? b.end(b.length - 1) : 0;
        if (v.duration) this.el.buf.style.width = `${Math.min(100, end / v.duration * 100)}%`;
      } catch { /* mid-swap */ }
    });
    on(v, 'volumechange', () => { prefs.volume = v.volume; prefs.muted = v.muted; savePrefs(); this.updateVolumeUI(); });
    on(v, 'ratechange', () => { prefs.speed = v.playbackRate; savePrefs(); });

    // single click = play/pause (slightly delayed), double click = fullscreen
    let clickTimer;
    on(v, 'click', e => {
      if (!this.state.started || Date.now() - (this._closedAt || 0) < 400) return;
      if (e.detail === 2) { clearTimeout(clickTimer); this.toggleFullscreen(); }
      else clickTimer = setTimeout(() => this.togglePlay(), 220);
    });

    on(this.el.bigPlay, 'click', () => this.play());
    // Click anywhere outside the settings menu or episode drawer to close it (without also pausing).
    on(document, 'pointerdown', e => {
      const t = e.target;
      let closed = false;
      if (!this.el.menu.hidden && !this.el.menu.contains(t) && !t.closest?.('[data-act="settings"]')) { this.toggleMenu(false); closed = true; }
      if (!this.el.drawer.hidden && !this.el.drawer.contains(t) && !t.closest?.('[data-act="eps"]')) { this.toggleDrawer(false); closed = true; }
      if (closed) this._closedAt = Date.now();
    });
    on(root, 'click', e => {
      const act = e.target.closest('[data-act]')?.dataset.act;
      if (act === 'play') this.togglePlay();
      else if (act === 'prev') this.state.hasPrev && this.hooks.onPrev?.();
      else if (act === 'next') this.nextEpisode();
      else if (act === 'mute') { v.muted = !v.muted; this.updateVolumeUI(); }
      else if (act === 'full') this.toggleFullscreen();
      else if (act === 'pip') { if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {}); else v.requestPictureInPicture?.().catch(() => {}); }
      else if (act === 'eps') this.toggleDrawer();
      else if (act === 'cc') this.toggleCC();
      else if (act === 'settings') this.toggleMenu();
      if (e.target.closest('[data-retry]')) this.retry();
      const a = e.target.closest('[data-audio]');
      if (a && !a.disabled && a.dataset.audio !== this.state.type) this.hooks.onAudio?.(a.dataset.audio);
    });
    on(this.el.drawer, 'click', e => { if (e.target.closest('.kp-x')) this.toggleDrawer(false); });
    on(this.el.menu, 'click', e => this.onMenuClick(e));

    // scrubbing
    this.state.scrubbing = false;
    const scrub = this.el.scrub;
    const railPos = e => { const r = this.el.rail.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
    let scrubbing = false;
    on(scrub, 'pointerdown', e => { scrubbing = true; this.state.scrubbing = true; scrub.setPointerCapture(e.pointerId); this.scrubPreview(railPos(e)); });
    on(scrub, 'pointermove', e => {
      const p = railPos(e);
      this.el.tip.hidden = false;
      this.el.tip.textContent = fmt(p * (v.duration || 0));
      const r = this.el.rail.getBoundingClientRect();
      this.el.tip.style.left = `${Math.max(14, Math.min(r.width - 14, e.clientX - r.left))}px`;
      if (scrubbing) this.scrubPreview(p);
    });
    on(scrub, 'pointerup', e => { if (scrubbing) { scrubbing = false; this.state.scrubbing = false; this.seekTo(railPos(e) * (v.duration || 0)); } });
    on(scrub, 'pointerleave', () => { this.el.tip.hidden = true; });

    // volume
    const volPos = e => { const r = this.el.volRail.getBoundingClientRect(); return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)); };
    let volDrag = false;
    on(this.el.volRail, 'pointerdown', e => { volDrag = true; this.el.volRail.setPointerCapture(e.pointerId); v.volume = volPos(e); v.muted = false; });
    on(this.el.volRail, 'pointermove', e => { if (volDrag) { v.volume = volPos(e); v.muted = false; } });
    on(this.el.volRail, 'pointerup', () => { volDrag = false; });
    on(root, 'wheel', e => {
      if (!e.target.closest('.kp-bottom')) return;
      e.preventDefault();
      v.volume = Math.max(0, Math.min(1, v.volume + (e.deltaY < 0 ? 0.08 : -0.08)));
      v.muted = false;
    }, { passive: false });

    // auto-hide
    let hideTimer;
    const wake = () => {
      root.classList.remove('idle');
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => { if (!v.paused && this.el.menu.hidden && this.el.drawer.hidden) root.classList.add('idle'); }, 2600);
    };
    on(root, 'pointermove', wake);
    on(root, 'pointerdown', wake);
    on(v, 'pause', () => root.classList.remove('idle'));

    // fullscreen
    on(document, 'fullscreenchange', () => {
      const fs = document.fullscreenElement === root;
      root.classList.toggle('is-full', fs);
      this.el.full.innerHTML = icon(fs ? 'full-exit' : 'full');
      this.el.top.classList.toggle('with-back', fs);
    });

    // keyboard
    this.keyHandler = e => {
      if (!root.isConnected) return this.removeListeners();
      if (e.target.closest('input, textarea, select, [contenteditable="true"]') || e.metaKey || e.ctrlKey || e.altKey) return;
      // Only act when the player (or nothing in particular) has focus, so the
      // page's own buttons, links and arrow-key scrolling keep working.
      const inPlayer = root.contains(e.target) || document.fullscreenElement === root;
      if (!inPlayer && e.target.closest('a, button, [tabindex]:not(#app)')) return;
      if (e.target === this.el.volRail && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
        e.preventDefault(); v.muted = false; v.volume = Math.max(0, Math.min(1, v.volume + (e.key === 'ArrowRight' ? 0.1 : -0.1))); return;
      }
      if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && !inPlayer && !root.matches(':hover')) return;
      const k = e.key.toLowerCase();
      if (e.key === ' ' || k === 'k') { e.preventDefault(); this.togglePlay(); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); this.seekTo(v.currentTime + 5); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); this.seekTo(v.currentTime - 5); }
      else if (k === 'l') { e.preventDefault(); this.seekTo(v.currentTime + 10); }
      else if (k === 'j') { e.preventDefault(); this.seekTo(v.currentTime - 10); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); v.volume = Math.min(1, v.volume + 0.1); v.muted = false; }
      else if (e.key === 'ArrowDown') { e.preventDefault(); v.volume = Math.max(0, v.volume - 0.1); }
      else if (k === 'f') { e.preventDefault(); this.toggleFullscreen(); }
      else if (k === 'm') { v.muted = !v.muted; }
      else if (k === 'n') { this.nextEpisode(); }
      else if (k === 'c') { this.toggleCC(); }
      else if (k === 's') { if (!this.el.skip.hidden) this.el.skip.click(); }
      else if (e.key === 'Escape') { this.toggleMenu(false); this.toggleDrawer(false); }
      wake();
    };
    document.addEventListener('keydown', this.keyHandler);
    this._bound.push([document, 'keydown', this.keyHandler]);

    // autoplay turned off (from the page or the menu): drop a pending countdown
    on(window, 'koma:prefs', e => {
      if (e.detail.key === 'autoNext' && !e.detail.value) { clearTimeout(this.state.nextTimer); clearInterval(this.state.nextCountdown); this.el.next.hidden = true; }
    });

    // save progress on unload
    this.unloadHandler = () => this.saveProgressNow();
    addEventListener('pagehide', this.unloadHandler);
    this._bound.push([window, 'pagehide', this.unloadHandler]);
    this.saveInterval = setInterval(() => this.saveProgressNow(), 5000);
  }

  scrubPreview(p) {
    this.el.played.style.width = `${p * 100}%`;
    this.el.knob.style.left = `${p * 100}%`;
    this.el.cur.textContent = fmt(p * (this.video.duration || 0));
  }

  updateVolumeUI() {
    const v = this.video;
    const level = v.muted ? 0 : v.volume;
    this.el.volFill.style.width = `${level * 100}%`;
    this.el.volKnob.style.left = `${level * 100}%`;
    this.el.volRail.setAttribute('aria-valuenow', Math.round(level * 100));
    this.el.mute.innerHTML = icon(v.muted || v.volume === 0 ? 'vol-mute' : v.volume < 0.5 ? 'vol-low' : 'vol');
  }

  toggleFullscreen() {
    if (document.fullscreenElement === this.container) document.exitFullscreen().catch(() => {});
    else this.container.requestFullscreen?.().catch(() => {});
  }

  toggleDrawer(force) {
    const d = this.el.drawer;
    const show = force ?? d.hidden;
    d.hidden = !show;
    // Opening the drawer closes the menu; toggleMenu(false) early-returns and
    // never writes drawer state, so there is no re-entry into this method.
    if (show) this.toggleMenu(false);
  }

  toggleCC() {
    const tracks = this.video.textTracks;
    if (!tracks.length) return;
    const anyOn = [...tracks].some(t => t.mode === 'showing');
    prefs.cc = !anyOn; savePrefs();
    for (const t of tracks) t.mode = !anyOn && t === tracks[0] ? 'showing' : 'disabled';
    this.el.cc.classList.toggle('on', !anyOn);
  }

  onEnded() {
    this.saveProgressNow();
    this.hooks.onEnded?.(this.state.ep, this.video?.duration);
    if (prefs.autoNext && this.state.hasNext && !this.state.advancing) this.nextEpisode();
  }

  /* ---------- skip intro / outro / next card ---------- */

  onTime() {
    const v = this.video, t = v.currentTime, dur = v.duration || 0;
    if (!this.state.scrubbing) {
      const p = dur ? t / dur * 100 : 0;
      this.el.played.style.width = `${p}%`;
      this.el.knob.style.left = `${p}%`;
      this.el.cur.textContent = fmt(t);
    }

    const s = this.state;
    // Skip Intro button
    // Skip Intro button. Auto-jump only when the marker is plausible: some
    // sources stamp "intros" that start at 0:00 (the whole cold open) — jump
    // cut those only when the viewer presses the button, never silently.
    let skipLabel = null, skipTarget = null;
    if (s.intro && t >= Math.max(0, s.intro.start - 2) && t < s.intro.end - 4) {
      skipLabel = 'Skip Intro'; skipTarget = s.intro.end;
      const plausible = s.intro.start >= 3 && s.intro.end - s.intro.start >= 20;
      if (plausible && prefs.skipIntro && !s.introJumped && !v.paused) {
        s.introJumped = true;
        this.toastState('Skipping intro');
        this.seekTo(s.intro.end);
        return;
      }
    } else if (!s.intro && dur > 900 && t > 28 && t < 140 && (!s.heuristicOffered || t < s.heuristicOffered + 12)) {
      s.heuristicOffered ||= t; // ponytail: guesses an ~85s opening; real timestamps win whenever the source has them
      skipLabel = 'Skip Opening'; skipTarget = s.heuristicOffered + 85;
    }
    // Skip Outro / next
    if (s.outro && t >= s.outro.start && t < s.outro.end - 2 && prefs.skipOutro && !s.outroJumped && !v.paused
      && s.outro.end - s.outro.start >= 20) {
      s.outroJumped = true;
      if (s.hasNext) { this.toastState('Skipping outro'); this.nextEpisode(); return; }
      this.seekTo(s.outro.end);
      return;
    }
    if (s.outro && t >= s.outro.start - 2 && t < s.outro.end && s.hasNext) {
      skipLabel = 'Next Episode'; skipTarget = null;
    }
    if (skipLabel) {
      this.el.skip.textContent = skipLabel;
      this.el.skip.hidden = false;
      this.el.skip.onclick = () => { this.el.skip.hidden = true; skipTarget != null ? this.seekTo(skipTarget) : this.nextEpisode(); };
    } else this.el.skip.hidden = true;

    // Next-episode card (outro window or final seconds)
    const nearEnd = s.hasNext && (s.outro ? t >= s.outro.start - 1 : dur - t < 22 && dur > 60);
    if (nearEnd && !s.nextShown && (s.outro ? t < s.outro.end : true)) {
      s.nextShown = true;
      this.showNextCard();
    } else if (!nearEnd) {
      if (s.nextShown && !this.el.next.hidden) { s.nextShown = false; clearTimeout(s.nextTimer); clearInterval(s.nextCountdown); this.el.next.hidden = true; }
    }
  }

  showNextCard() {
    const s = this.state;
    const label = this.hooks.nextLabel?.() || 'Next episode';
    this.el.next.innerHTML = `
      <div class="kp-next-info"><small>Up next</small><b>${esc(label)}</b></div>
      <button class="kp-next-go btn btn-primary btn-sm" type="button">${icon('play')}Play now</button>
      <div class="kp-next-count"><svg viewBox="0 0 36 36"><circle class="track" cx="18" cy="18" r="16"/><circle class="fill" cx="18" cy="18" r="16"/></svg><b>10</b></div>
      <button class="kp-next-cancel" type="button" aria-label="Cancel autoplay">Cancel</button>`;
    this.el.next.hidden = false;
    this.el.next.querySelector('.kp-next-go').onclick = () => this.nextEpisode();
    this.el.next.querySelector('.kp-next-cancel').onclick = () => { clearTimeout(s.nextTimer); clearInterval(s.nextCountdown); this.el.next.hidden = true; };
    let left = 10;
    const C = 2 * Math.PI * 16; // ring circumference for r=16
    const ring = this.el.next.querySelector('.fill');
    const setRing = () => ring.style.strokeDashoffset = String(C * (1 - left / 10));
    setRing();
    clearInterval(s.nextCountdown);
    s.nextCountdown = setInterval(() => {
      left--;
      this.el.next.querySelector('.kp-next-count b').textContent = Math.max(0, left);
      setRing();
      if (left <= 0) clearInterval(s.nextCountdown);
    }, 1000);
    clearTimeout(s.nextTimer);
    if (prefs.autoNext) s.nextTimer = setTimeout(() => { clearInterval(s.nextCountdown); this.nextEpisode(); }, 10000);
  }

  /* ---------- settings menu ---------- */

  toggleMenu(force) {
    const m = this.el.menu;
    const show = force ?? m.hidden;
    if (!show) { m.hidden = true; this.el.settings.classList.remove('on'); return; }
    m.innerHTML = this.menuHTML();
    m.hidden = false;
    this.el.settings.classList.add('on');
    // Close the drawer directly: routing through toggleDrawer would re-enter
    // toggleMenu and instantly re-hide this menu again.
    this.el.drawer.hidden = true;
  }

  menuHTML() {
    const rates = [0.5, 0.75, 1, 1.25, 1.5, 2];
    const sec = (title, rows) => `<div class="kp-sec"><h5>${title}</h5>${rows}</div>`;
    const opt = (row, val, cur, label) =>
      `<button type="button" role="menuitemradio" data-set="${row}" data-val="${esc(val)}" aria-checked="${String(val) === String(cur)}"><span>${esc(label)}</span>${icon('check')}</button>`;

    // Quality: one row per height (best bitrate wins), highest first, plus Auto showing what it picked.
    let quality = '';
    const lv = this.hls?.levels || [];
    if (lv.length > 1) {
      const heights = [...new Set(lv.map(l => l.height).filter(Boolean))].sort((a, b) => b - a);
      const now = lv[this.hls.currentLevel]?.height;
      const cur = this.hls.autoLevelEnabled ? 'auto' : now;
      quality = sec('Quality', opt('quality', 'auto', cur, `Auto${this.hls.autoLevelEnabled && now ? ` · ${now}p` : ''}`)
        + heights.map(h => opt('quality', h, cur, `${h}p${h >= 1080 ? ' HD' : ''}`)).join(''));
    }
    // Subtitles: Off or a specific track (the CC button just flips the first one on/off).
    const tracks = [...this.video.textTracks];
    const showing = tracks.findIndex(t => t.mode === 'showing');
    const subs = tracks.length
      ? sec('Subtitles', opt('cc', -1, showing, 'Off') + tracks.map((t, i) => opt('cc', i, showing, t.label || `Track ${i + 1}`)).join(''))
      : '';
    const speeds = `<div class="kp-speeds" role="group" aria-label="Speed">${rates.map(r =>
      `<button type="button" role="menuitemradio" data-set="speed" data-val="${r}" aria-checked="${r === prefs.speed}">${r === 1 ? 'Normal' : `${r}×`}</button>`).join('')}</div>`;
    return ''
      + quality
      + subs
      + sec('Speed', speeds)
      + sec('Playback', ''
        + `<label class="kp-toggle"><input type="checkbox" data-set="autoplay"${prefs.autoplay !== false ? ' checked' : ''}><span class="knob"></span>Autoplay on open</label>`
        + `<label class="kp-toggle"><input type="checkbox" data-set="autoNext"${prefs.autoNext ? ' checked' : ''}><span class="knob"></span>Autoplay next episode</label>`
        + `<label class="kp-toggle"><input type="checkbox" data-set="skipIntro"${prefs.skipIntro ? ' checked' : ''}><span class="knob"></span>Auto-skip intro</label>`
        + `<label class="kp-toggle"><input type="checkbox" data-set="skipOutro"${prefs.skipOutro ? ' checked' : ''}><span class="knob"></span>Auto-skip outro</label>`);
  }

  onMenuClick(e) {
    const t = e.target.closest('[data-set]');
    if (!t) return;
    const { set } = t.dataset;
    if (set === 'quality') {
      const h = t.dataset.val === 'auto' ? null : Number(t.dataset.val);
      if (this.hls) {
        // the best-bitrate level at that height
        const i = h == null ? -1 : this.hls.levels.reduce((best, l, j) => (l.height === h && (best < 0 || l.bitrate > this.hls.levels[best].bitrate) ? j : best), -1);
        this.hls.currentLevel = i;
      }
      prefs.quality = h; savePrefs();
      this.toggleMenu(false);
      this.toastState(h ? `Quality: ${h}p` : 'Quality: Auto');
      return;
    }
    if (set === 'cc') {
      const n = Number(t.dataset.val);
      [...this.video.textTracks].forEach((tr, i) => { tr.mode = i === n ? 'showing' : 'disabled'; });
      prefs.cc = n >= 0; savePrefs();
      this.el.cc.classList.toggle('on', n >= 0);
      this.toggleMenu(false);
      return;
    }
    if (set === 'speed') {
      const r = Number(t.dataset.val);
      this.video.defaultPlaybackRate = this.video.playbackRate = r;
      prefs.speed = r; savePrefs();
      $$('[data-set="speed"]', this.el.menu).forEach(b => b.setAttribute('aria-checked', b === t));
      return;
    }
    if (set === 'autoplay' || set === 'autoNext' || set === 'skipIntro' || set === 'skipOutro') setPref(set, t.checked);
  }
}
