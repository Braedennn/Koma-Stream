/* The player for the study.
   A picture, a seek bar, and the six things a television remote can reach.
   Nothing moves that the viewer did not ask for, and the controls get out of
   the way the moment the episode is running. */

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const fmt = seconds => {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
};

export class TvPlayer {
  /**
   * @param root element to fill (full screen, black)
   * @param options { title, episode, subtitle, resumeAt, streams, subtitles, onExit, onNext, onProgress }
   *   streams: [{ url, mode }] where mode is 'hls' or 'file'
   */
  constructor(root, options = {}) {
    this.root = root;
    this.options = options;
    this.hls = null;
    this.seeking = false;
    this.hideTimer = null;
    this.ended = false;

    this.build();
    this.bind();
    this.attach(options.streams, options.subtitles);
    this.show(4000);
  }

  build() {
    const o = this.options;
    this.root.className = 'player';
    this.root.innerHTML = `
      <div class="player-art" aria-hidden="true"></div>
      <video class="player-video" playsinline preload="metadata"></video>
      <div class="player-shade" aria-hidden="true"></div>
      <div class="player-toast" id="player-toast" hidden></div>
      <div class="player-center">
        <button class="player-big" type="button" aria-label="Play">
          <svg viewBox="0 0 24 24" class="i"><path d="M8 5.5v13l11-6.5-11-6.5Z"/></svg>
        </button>
      </div>
      <div class="player-end" hidden>
        <div class="player-end-card">
          <p class="player-end-kicker">Up next</p>
          <h3 id="player-end-title">${o.nextTitle || 'Next episode'}</h3>
          <div class="player-end-actions">
            <button class="btn btn-solid" type="button" data-act="next">
              <svg viewBox="0 0 24 24" class="i"><path d="M8 5.5v13l11-6.5-11-6.5Z"/></svg>Play next
            </button>
            <button class="btn btn-quiet" type="button" data-act="back">Back to the episode list</button>
          </div>
        </div>
      </div>
      <header class="player-top">
        <button class="icon-btn" type="button" data-act="back" aria-label="Back">
          <svg viewBox="0 0 24 24" class="i"><path d="M15 5.5 8 12l7 6.5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <div class="player-now">
          <h3>${o.title || ''}</h3>
          <p>${o.subtitle || ''}</p>
        </div>
      </header>
      <footer class="player-foot">
        <div class="player-seek" role="slider" aria-label="Seek" tabindex="0" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
          <div class="player-rail"><i class="player-buf"></i><i class="player-played"></i><span class="player-knob"></span></div>
          <span class="player-bubble" hidden>0:00</span>
        </div>
        <div class="player-row">
          <div class="player-side">
            <button class="icon-btn" type="button" data-act="play" aria-label="Play">
              <svg viewBox="0 0 24 24" class="i i-play"><path d="M8 5.5v13l11-6.5-11-6.5Z"/></svg>
              <svg viewBox="0 0 24 24" class="i i-pause" hidden><path d="M8 5.5h3v13H8zM13 5.5h3v13h-3z"/></svg>
            </button>
            <span class="player-time"><b id="player-cur">0:00</b> / <span id="player-dur">0:00</span></span>
          </div>
          <div class="player-side">
            <button class="icon-btn" type="button" data-act="subs" aria-label="Subtitles">
              <svg viewBox="0 0 24 24" class="i"><rect x="3" y="5.5" width="18" height="13" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M7 11h5M13.5 11h3.5M7 14h3M11.5 14h5.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>
            </button>
            <button class="icon-btn" type="button" data-act="mute" aria-label="Mute">
              <svg viewBox="0 0 24 24" class="i"><path d="M4 9.5h3L11 6v12l-4-3.5H4z"/><path d="M15 9.5a4 4 0 0 1 0 5M17.5 7.5a7 7 0 0 1 0 9" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
            </button>
            <button class="icon-btn" type="button" data-act="next" aria-label="Next episode">
              <svg viewBox="0 0 24 24" class="i"><path d="M6 5.5v13l9-6.5-9-6.5Z"/><path d="M17.5 5.5v13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>
            </button>
            <button class="icon-btn" type="button" data-act="full" aria-label="Fullscreen">
              <svg viewBox="0 0 24 24" class="i"><path d="M4.5 9V4.5H9M15 4.5h4.5V9M19.5 15v4.5H15M9 19.5H4.5V15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>
            </button>
          </div>
        </div>
      </footer>
      <div class="player-subs" id="player-subs" hidden></div>
    `;

    this.video = $('video', this.root);
    this.seek = $('.player-seek', this.root);
    this.buf = $('.player-buf', this.root);
    this.played = $('.player-played', this.root);
    this.knob = $('.player-knob', this.root);
    this.bubble = $('.player-bubble', this.root);
    this.cur = $('#player-cur', this.root);
    this.dur = $('#player-dur', this.root);
    this.big = $('.player-big', this.root);
    this.end = $('.player-end', this.root);
    this.subsMenu = $('#player-subs', this.root);
    this.artEl = $('.player-art', this.root);
    if (this.options.art) this.artEl.style.backgroundImage = `url("${this.options.art}")`;
  }

  bind() {
    const v = this.video;
    const on = (event, handler) => v.addEventListener(event, handler);
    on('loadedmetadata', () => {
      this.dur.textContent = fmt(v.duration);
      this.paint();
      if (this.options.resumeAt && v.duration && this.options.resumeAt < v.duration - 30) v.currentTime = this.options.resumeAt;
    });
    on('timeupdate', () => { if (!this.seeking) { this.paint(); this.saveProgress(); } });
    on('progress', () => this.paintBuf());
    on('play', () => { this.paintButtons(); this.root.classList.add('is-playing'); this.show(3200); });
    on('pause', () => { this.paintButtons(); this.root.classList.remove('is-playing'); this.show(0); });
    on('waiting', () => this.root.classList.add('is-busy'));
    on('playing', () => this.root.classList.remove('is-busy'));
    on('ended', () => this.finish());
    on('error', () => this.toast('This episode could not be played here.'));
    on('volumechange', () => this.paintButtons());

    this.big.addEventListener('click', () => this.toggle());
    this.root.addEventListener('pointermove', () => this.show(3200));
    this.root.addEventListener('pointerdown', () => this.show(3200));

    this.seek.addEventListener('pointerdown', event => this.beginScrub(event));
    this.seek.addEventListener('pointermove', event => this.moveScrub(event));
    addEventListener('pointerup', () => this.endScrub());
    this.seek.addEventListener('keydown', event => {
      if (event.key === 'ArrowRight') { v.currentTime += 10; event.preventDefault(); }
      if (event.key === 'ArrowLeft') { v.currentTime -= 10; event.preventDefault(); }
    });

    this.root.addEventListener('click', event => {
      const act = event.target.closest('[data-act]')?.dataset.act;
      if (act === 'play') this.toggle();
      else if (act === 'back') this.exit();
      else if (act === 'next') this.next();
      else if (act === 'mute') { v.muted = !v.muted; }
      else if (act === 'subs') this.pickSubs();
      else if (act === 'full') this.fullscreen();
    });
    this.subsMenu.addEventListener('click', event => {
      const button = event.target.closest('[data-track]');
      if (!button) return;
      this.useSub(Number(button.dataset.track));
      this.subsMenu.hidden = true;
    });
  }

  attach(streams, subtitles) {
    const v = this.video;
    const hls = streams?.find(stream => stream.mode === 'hls');
    const file = streams?.find(stream => stream.mode === 'file');
    this.stream = hls || file || null;
    if (!this.stream) return;
    if (this.stream.mode === 'hls') {
      if (window.Hls?.isSupported()) {
        this.hls = new window.Hls({ enableWorker: true, backBufferLength: 90 });
        this.hls.loadSource(this.stream.url);
        this.hls.attachMedia(v);
        this.hls.on(window.Hls.Events.ERROR, (_event, data) => {
          window.__playerError = `${data?.type}:${data?.details}:${data?.fatal ? 'fatal' : 'soft'}`;
          if (data?.fatal) this.toast('The stream dropped — trying again…');
        });
      } else if (v.canPlayType('application/vnd.apple.mpegurl')) {
        v.src = this.stream.url;
      } else {
        this.toast('This browser cannot play HLS.');
      }
    } else {
      v.src = this.stream.url;
    }
    this.tracks = subtitles || [];
    window.__playerUrl = this.stream?.url || '';
    window.__playerError = '';
    if (this.tracks.length) {
      for (const [index, track] of this.tracks.entries()) {
        const el = document.createElement('track');
        el.kind = 'subtitles';
        el.label = track.label || `Track ${index + 1}`;
        el.srclang = track.code || 'en';
        el.src = track.url;
        if (index === 0) el.default = true;
        v.append(el);
      }
      this.subsButton = $('[data-act="subs"]', this.root);
    }
  }

  /* ---------- doing things ---------- */

  toggle() { if (this.video.paused) this.play(); else this.video.pause(); }

  play() {
    if (this.ended) { this.video.currentTime = 0; this.ended = false; this.end.hidden = true; }
    this.video.play().catch(() => this.show(0));
  }

  finish() {
    this.ended = true;
    this.saveProgress(true);
    this.end.hidden = false;
    this.show(0);
    this.options.onEnded?.();
  }

  next() {
    this.saveProgress(true);
    if (this.options.onNext) this.options.onNext();
    else this.exit();
  }

  exit() {
    this.saveProgress(true);
    this.stop();
    this.options.onExit?.();
  }

  fullscreen() { window.komaTv?.window('fullscreen'); }

  pickSubs() {
    if (!this.tracks?.length) { this.toast('This episode has no subtitles.'); return; }
    if (this.subsMenu.children.length) { this.subsMenu.hidden = !this.subsMenu.hidden; return; }
    for (const [index, track] of this.tracks.entries()) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.track = String(index);
      button.textContent = track.label || `Track ${index + 1}`;
      this.subsMenu.append(button);
    }
    const off = document.createElement('button');
    off.type = 'button';
    off.dataset.track = '-1';
    off.textContent = 'Off';
    this.subsMenu.append(off);
    this.subsMenu.hidden = false;
  }

  useSub(index) {
    for (const [i, track] of [...this.video.textTracks].entries()) {
      track.mode = i === index ? 'showing' : 'disabled';
    }
    this.toast(index < 0 ? 'Subtitles off' : `Subtitles: ${this.tracks[index]?.label || 'on'}`);
  }

  stop() {
    try { this.video.pause(); } catch { /* already gone */ }
    this.video.removeAttribute('src');
    this.video.load();
    this.hls?.destroy();
    this.hls = null;
  }

  toast(message) {
    const toast = $('#player-toast', this.root);
    if (!toast) return;
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => { toast.hidden = true; }, 2600);
  }

  /* ---------- the seek bar ---------- */

  ratio(event) {
    const rail = $('.player-rail', this.root).getBoundingClientRect();
    return Math.max(0, Math.min(1, (event.clientX - rail.left) / rail.width));
  }

  beginScrub(event) {
    this.seeking = true;
    this.seek.setPointerCapture?.(event.pointerId);
    const r = this.ratio(event);
    this.video.currentTime = r * (this.video.duration || 0);
    this.show(0);
  }

  moveScrub(event) {
    const rail = $('.player-rail', this.root).getBoundingClientRect();
    const r = this.ratio(event);
    this.bubble.hidden = false;
    this.bubble.textContent = fmt(r * (this.video.duration || 0));
    this.bubble.style.left = `${r * rail.width}px`;
    if (this.seeking) this.video.currentTime = r * (this.video.duration || 0);
  }

  endScrub() { this.seeking = false; this.show(2400); }

  /* ---------- painting ---------- */

  paint() {
    const v = this.video;
    const at = v.currentTime || 0;
    const total = v.duration || 0;
    const part = total ? at / total * 100 : 0;
    this.played.style.width = `${part}%`;
    this.knob.style.left = `${part}%`;
    this.cur.textContent = fmt(at);
    this.dur.textContent = fmt(total);
    this.seek.setAttribute('aria-valuenow', String(Math.round(part)));
    this.paintBuf();
  }

  paintBuf() {
    const v = this.video;
    let end = 0;
    try {
      const b = v.buffered;
      for (let i = 0; i < b.length; i++) if (b.start(i) <= v.currentTime) end = Math.max(end, b.end(i));
    } catch { /* mid-swap */ }
    this.buf.style.width = `${v.duration ? end / v.duration * 100 : 0}%`;
  }

  paintButtons() {
    const v = this.video;
    $('.i-play', this.root).hidden = !v.paused;
    $('.i-pause', this.root).hidden = v.paused;
    this.big.hidden = !v.paused;
    const mute = $('[data-act="mute"]', this.root);
    mute.classList.toggle('is-on', v.muted);
    const sub = this.subsButton;
    if (sub) sub.classList.toggle('is-on', [...v.textTracks].some(track => track.mode === 'showing'));
  }

  show(ms) {
    this.root.classList.add('is-chrome');
    clearTimeout(this.hideTimer);
    if (!ms) return;
    this.hideTimer = setTimeout(() => {
      if (!this.video.paused && !this.ended) this.root.classList.remove('is-chrome');
    }, ms);
  }

  saveProgress(force = false) {
    if (!this.options.progressKey) return;
    try {
      const all = JSON.parse(localStorage.getItem('koma.tv.progress') || '{}');
      all[this.options.progressKey] = { at: Math.floor(this.video.currentTime || 0), dur: Math.floor(this.video.duration || 0), at2: Date.now() };
      localStorage.setItem('koma.tv.progress', JSON.stringify(all));
    } catch { /* no storage */ }
    if (force) this.options.onProgress?.(Math.floor(this.video.currentTime || 0), Math.floor(this.video.duration || 0));
  }
}

/* Where the viewer stopped, for the watch page's resume. */
export function progressFor(key) {
  try { return JSON.parse(localStorage.getItem('koma.tv.progress') || '{}')[key] || null; } catch { return null; }
}