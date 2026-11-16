// Koma custom video player: Netflix-style controls over a <video> element.
// The container survives episode changes (only the source swaps), so
// fullscreen and playback carry straight into the next episode.
import { $, $$, esc, icon } from './ui.js';

const PREFS_KEY = 'koma.player';
const prefs = (() => {
  try { return { autoNext: true, skipIntro: false, skipOutro: false, autoplay: true, speed: 1, volume: 1, muted: false, cc: null, quality: null, ccLang: null, picture: null, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; }
  catch { return { autoNext: true, skipIntro: false, skipOutro: false, autoplay: true, speed: 1, volume: 1, muted: false, cc: null, quality: null, ccLang: null, picture: null }; }
})();
const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* private mode */ } };

/**
 * How much the picture may be widened to fit a screen that is wider than it
 * is. A fifth is enough to take the hard edge off a square show on a wide
 * television, and little enough that nobody sees the faces change shape.
 */
const STRETCH = 0.18;

/**
 * How the picture sits on the screen in full screen.
 *
 * 'fill' takes the whole screen: the frame's own bars are cropped away and
 * what is left covers the display edge to edge. 'whole' keeps every pixel of
 * the frame, with the artwork of the episode around it.
 *
 * A four-by-three episode on a wide screen cannot be both: the picture is
 * taller than the screen, so filling the screen cuts into it. A television
 * fills the screen - that is what a set is for - and the desktop keeps the
 * frame whole. The setting in the panel overrides both.
 */
export const pictureMode = () => {
  const v = String(prefs.picture || '').toLowerCase();
  if (v === 'fill' || v === 'whole') return v;
  return document.documentElement.classList.contains('tv') ? 'fill' : 'whole';
};

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

// Caption descriptors arrive as either an ISO code or a human language name
// ("English", "Unknown"); srclang wants the code where one exists.
const CC_CODE = new Map(Object.entries({
  eng: 'en', english: 'en', jpn: 'ja', japan: 'ja', japanese: 'ja', jap: 'ja',
  arb: 'ar', arabic: 'ar', esp: 'es', spanish: 'es', port: 'pt', portuguese: 'pt',
  fra: 'fr', french: 'fr', ger: 'de', german: 'de', ita: 'it', italian: 'it',
  rus: 'ru', russian: 'ru', hin: 'hi', hindi: 'hi', chi: 'zh', zho: 'zh',
  chinese: 'zh', mandarin: 'zh', tur: 'tr', turkish: 'tr', pol: 'pl', polish: 'pl',
  ind: 'id', indonesian: 'id', tha: 'th', thai: 'th', kor: 'ko', korean: 'ko',
}));
/* The labels the sources use are all sorts: "Español", "Français", "日本語".
   The settings panel offers these languages, so a track has to be able to say
   which one it is. */
const CC_NAMES = [
  [/arab|عرب/i, 'ar'],
  [/english|ingles|anglais/i, 'en'],
  [/japan|japon|日本語/i, 'ja'],
  [/espa|span|castellano/i, 'es'],
  [/portug/i, 'pt'],
  [/fran|french/i, 'fr'],
  [/german|deutsch/i, 'de'],
  [/italian|italiano/i, 'it'],
  [/russian|русск/i, 'ru'],
  [/hindi/i, 'hi'],
  [/chinese|mandarin|中文/i, 'zh'],
  [/turkish|türk/i, 'tr'],
  [/polish|polski/i, 'pl'],
  [/indonesian/i, 'id'],
  [/thai|ไทย/i, 'th'],
  [/korean/i, 'ko'],
];
const ccCodeOf = s => {
  const k = String(s || '').toLowerCase().trim();
  if (!k) return '';
  if (CC_CODE.has(k)) return CC_CODE.get(k);
  for (const [re, code] of CC_NAMES) if (re.test(k)) return code;
  // An ISO code, with or without a region: "en", "en-US".
  return (/^[a-z]{2}([-_]|$)/.test(k) ? k.slice(0, 2) : '');
};

/** The language of the subtitles as the settings panel shows it: the code of
 *  the language, or nothing at all for Automatic. */
export const ccLangPref = () => {
  const v = String(prefs.ccLang || '').trim().toLowerCase();
  if (!v) return '';
  return ccCodeOf(v) || v;
};

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
      <div class="kp-ambient" aria-hidden="true"></div>
      <video playsinline preload="metadata"></video>
      <div class="kp-shade"></div>
      <div class="kp-top"><div class="kp-now"><h3></h3><p></p></div></div>
      <div class="kp-start">
        <div class="kp-start-bg"></div>
        <button class="kp-bigplay" type="button" aria-label="Play">${icon('play')}</button>
        <p class="kp-start-note"></p>
        <div class="kp-resume" hidden>
          <h4>Continue watching?</h4>
          <div class="kp-resume-row">
            <button class="kp-resume-go" type="button">Continue</button>
            <button class="kp-resume-start" type="button">Start from the beginning</button>
          </div>
        </div>
      </div>
      <div class="kp-busy" hidden><span class="kp-spin"></span><span class="kp-busy-note" hidden></span></div>
      <div class="kp-error" hidden>
        <h3>Playback trouble</h3><p></p>
        <button class="btn btn-primary btn-sm" type="button" data-retry>${icon('reload')}Try again</button>
      </div>
      <button class="kp-skipbtn" type="button" hidden></button>
      <div class="kp-nextcard" hidden></div>
      <div class="kp-drawer" hidden><header><h4>Episodes</h4><button type="button" class="kp-x" aria-label="Close">${icon('x')}</button></header><div class="kp-drawer-body"></div></div>
      <div class="kp-bottom">
        <div class="kp-scrub" role="slider" tabindex="0" aria-label="Seek" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
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
      ambient: $('.kp-ambient', container),
      top: $('.kp-top', container), now: $('.kp-now', container),
      start: $('.kp-start', container), bigPlay: $('.kp-bigplay', container), startBg: $('.kp-start-bg', container), startNote: $('.kp-start-note', container),
      resume: $('.kp-resume', container), resumeGo: $('.kp-resume-go', container), resumeStart: $('.kp-resume-start', container),
      busy: $('.kp-busy', container), busyNote: $('.kp-busy-note', container), error: $('.kp-error', container), errMsg: $('.kp-error p', container),
      skip: $('.kp-skipbtn', container),
      next: $('.kp-nextcard', container),
      drawer: $('.kp-drawer', container), drawerBody: $('.kp-drawer-body', container),
      bottom: $('.kp-bottom', container), scrub: $('.kp-scrub', container), rail: $('.kp-rail', container),
      played: $('.kp-played', container), buf: $('.kp-buf', container), knob: $('.kp-knob', container), tip: $('.kp-tip', container),
      play: $('[data-act="play"]', container), prev: $('[data-act="prev"]', container), nextBtn: $('[data-act="next"]', container),
      mute: $('[data-act="mute"]', container), volRail: $('.kp-vol-rail', container), volFill: $('.kp-vol-rail i', container), volKnob: $('.kp-vol-rail span', container),
      cur: $('.kp-cur', container), dur: $('.kp-dur', container),
      audio: $('.kp-audio', container), audioRow: $('.kp-audio', container)?.parentElement, cc: $('[data-act="cc"]', container),
      settings: $('[data-act="settings"]', container), menu: $('.kp-menu', container),
      eps: $('[data-act="eps"]', container), pip: $('[data-act="pip"]', container), full: $('[data-act="full"]', container),
    };

    this.state = { ep: null, type: 'sub', intro: null, outro: null, next: null, hasNext: false, hasPrev: false, started: false, introJumped: false, heuristicOffered: false, nextShown: false, nextTimer: null, nextCountdown: null, retryCount: 0 };
    this.hls = null;
    this._media = null;
    this.frame = null;   // where the picture ends and the bars of the frame begin
    this._frameTry = null; this._frameBars = false; this._frameTries = 0;
    this._ccWant = false;   // should a caption be showing right now

    this.video.volume = prefs.volume;
    this.video.muted = prefs.muted;
    this.video.defaultPlaybackRate = this.video.playbackRate = prefs.speed;
    if (document.pictureInPictureEnabled) this.el.pip.hidden = false;

    this.bind();
    this.updateVolumeUI();
    this.measureBar();

    // Attaching the source runs the media load algorithm, which takes every
    // text track off the list; the tracks come back as new objects with every
    // caption off. So the pick is re-applied whenever the tracks change and
    // whenever the media loads — the caption the viewer asked for stays.
    this.video.textTracks.addEventListener('addtrack', () => { this.applyCC(); this.hookTracks(); });
    this.video.addEventListener('loadstart', () => this.applyCC());
    this.hookTracks();
  }

  /**
   * Watch the caption tracks.
   *
   * A caption that starts while the show is paused has to be put on the
   * screen as soon as it appears, not at the next tick of the clock - and the
   * clock does not tick while the show is paused.
   */
  hookTracks() {
    for (const track of this.video.textTracks) {
      if (track._komaHook) continue;
      track._komaHook = true;
      track.addEventListener('cuechange', () => this.placeCues());
    }
  }

  /* ---------- public API ---------- */

  /** The player takes the shape of the video it is showing, so there are no
   *  black bands beside it, and the phone layout knows how much room its
   *  control bar takes under the picture. */
  setShape() {
    const v = this.video;
    const ar = v.videoWidth && v.videoHeight ? v.videoWidth / v.videoHeight : 16 / 9;
    this.container.style.setProperty('--ar', String(Math.round(ar * 10000) / 10000));
    this.measureBar();
  }

  /**
   * Where the picture ends and the bars of the frame begin.
   *
   * A lot of streams carry black bars in the frame itself: the file says
   * 1440x1080 and the show is inside it. The player looks at a small copy of
   * the picture and finds the edges of the show, so those bars never reach
   * the screen. A dark scene is not a bar - if the "picture" turns out to be
   * a small part of the frame, the frame is the picture.
   */
  detectFrame() {
    const v = this.video;
    if (!v.videoWidth || v.readyState < 2) return null;
    const W = 160;
    const H = Math.max(2, Math.round(W * v.videoHeight / v.videoWidth));
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true });
    let data;
    try {
      g.drawImage(v, 0, 0, W, H);
      data = g.getImageData(0, 0, W, H).data;
    } catch { return null; }   // a picture from another host cannot be read
    const lum = (x, y) => { const i = (y * W + x) * 4; return 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]; };
    const TH = 26;
    let top = -1, bottom = -1, left = -1, right = -1;
    for (let y = 0; y < H; y++) {
      let hit = false;
      for (let x = 0; x < W; x += 2) if (lum(x, y) > TH) { hit = true; break; }
      if (hit) { if (top < 0) top = y; bottom = y; }
    }
    for (let x = 0; x < W; x++) {
      let hit = false;
      for (let y = 0; y < H; y += 2) if (lum(x, y) > TH) { hit = true; break; }
      if (hit) { if (left < 0) left = x; right = x; }
    }
    if (top < 0 || left < 0) return null;
    const cw = right - left + 1, ch = bottom - top + 1;
    if (cw < W * 0.6 || ch < H * 0.6) return null;
    // The margins have to be dark. A night scene that happens to be darker at
    // the edges is not a letterboxed picture, and cutting it to pieces would
    // be worse than leaving it alone.
    const strip = (x0, x1, y0, y1) => {
      let sum = 0, n = 0;
      for (let y = y0; y < y1; y += 2) for (let x = x0; x < x1; x += 2) { sum += lum(x, y); n++; }
      return n ? sum / n : -1;
    };
    const dark = (x0, x1, y0, y1) => {
      const m = strip(x0, x1, y0, y1);
      return m < 0 || m <= 24;   // no margin at all: nothing to cut away
    };
    if (!dark(0, left, 0, H) || !dark(right + 1, W, 0, H)) return null;
    if (!dark(0, W, 0, top) || !dark(0, W, bottom + 1, H)) return null;
    const sx = v.videoWidth / W, sy = v.videoHeight / H;
    return { w: v.videoWidth, h: v.videoHeight, cx: left * sx, cy: top * sy, cw: cw * sx, ch: ch * sy };
  }

  /**
   * Look for the bars of the frame.
   *
   * The first frames of an episode are a title card or a fade in, and they
   * say nothing about the shape of the show - a card that fills the frame
   * would have the player cut the show to pieces. So a picture is only
   * believed when two looks in a row agree, and a look that finds real dark
   * margins may correct one that found nothing.
   */
  lookForFrame() {
    const f = this.detectFrame();
    if (!f) { this._frameTry = null; return; }
    const last = this._frameTry;
    this._frameTry = f;
    const agrees = last && Math.abs(last.cy - f.cy) <= 24 && Math.abs(last.ch - f.ch) <= 48
      && Math.abs(last.cx - f.cx) <= 24 && Math.abs(last.cw - f.cw) <= 48;
    if (!agrees) return;
    const bars = x => x.cw < x.w - 8 || x.ch < x.h - 8;
    const stored = this.frame;
    if (!stored || (!bars(stored) && bars(f))) {
      this.frame = f;
      this._frameBars = bars(f);
      this.layoutPicture();
    }
  }

  /**
   * Put the picture on the screen.
   *
   * In full screen the screen is the box, and the picture is fitted onto it:
   * the bars of the frame are cropped away, and what is left covers the
   * display edge to edge - no black bands, whatever the shape of the set.
   *
   * A show made for a square screen and a wide television cannot both be
   * whole and edge to edge: something has to give. Cutting the picture hard
   * is what a television's Zoom mode does, and it takes a slice of the show
   * away with it. So the picture is widened a little - never more than a
   * fifth - and only what is left over is cropped. A show that already has
   * the shape of the screen is not touched at all.
   *
   * Outside full screen nothing is touched: there the box already has the
   * shape of the video.
   */
  layoutPicture() {
    const v = this.video;
    const set = (name, value) => {
      if (value == null) this.container.style.removeProperty(name);
      else this.container.style.setProperty(name, value);
    };
    if (!this.isFullscreen) {
      set('--kp-v-w', null); set('--kp-v-h', null); set('--kp-v-left', null); set('--kp-v-top', null);
      this.container.classList.remove('kp-whole', 'kp-fill');
      this.placeCues();
      return;
    }
    const box = this.container.getBoundingClientRect();
    const w = box.width, h = box.height;
    const fw = v.videoWidth, fh = v.videoHeight;
    if (!w || !h || !fw || !fh) return;
    const f = this.frame && this.frame.w === fw && this.frame.h === fh ? this.frame : null;
    const mode = pictureMode();
    if (mode === 'whole') {
      // The whole frame, the way it was made: the box takes care of it.
      set('--kp-v-w', null); set('--kp-v-h', null); set('--kp-v-left', null); set('--kp-v-top', null);
      this.container.classList.remove('kp-fill');
      this.container.classList.add('kp-whole');
      this.placeCues();
      return;
    }
    // The picture: the part of the frame that is the show, with the bars of
    // the frame taken off.
    const cx = f?.cx ?? 0, cy = f?.cy ?? 0, cw = f?.cw ?? fw, ch = f?.ch ?? fh;
    // How much wider the screen is than the picture - more than one means
    // the screen is wider, less than one means it is taller.
    const ratio = (w / h) / (cw / ch);
    let vx = cx, vy = cy, vw = cw, vh = ch;
    if (ratio >= 1) {
      // A wide screen: widen the picture a little, crop what is left over
      // from the top and the bottom.
      const stretch = Math.min(ratio - 1, STRETCH);
      const crop = 1 - (1 + stretch) / ratio;
      vy = cy + ch * crop / 2;
      vh = ch * (1 - crop);
    } else {
      // A tall screen: the other way about.
      const inv = 1 / ratio;
      const stretch = Math.min(inv - 1, STRETCH);
      const crop = 1 - (1 + stretch) / inv;
      vx = cx + cw * crop / 2;
      vw = cw * (1 - crop);
    }
    // The part of the frame that is on the screen is stretched onto the
    // screen exactly.
    const kx = w / vw, ky = h / vh;
    set('--kp-v-w', `${fw * kx}px`);
    set('--kp-v-h', `${fh * ky}px`);
    set('--kp-v-left', `${-vx * kx}px`);
    set('--kp-v-top', `${-vy * ky}px`);
    this.container.classList.remove('kp-whole');
    this.container.classList.add('kp-fill');
    this.placeCues();
  }

  /**
   * Keep the captions on the screen.
   *
   * The captions sit at the bottom of the picture. When the picture is
   * bigger than the screen - which is what happens when a square show is
   * fitted onto a wide television - the bottom of the picture is off the
   * screen, and the captions go with it. They are moved up into the part of
   * the picture that is on the screen.
   */
  placeCues() {
    const v = this.video;
    const box = this.container.getBoundingClientRect();
    const r = v.getBoundingClientRect();
    if (!r.height || !box.height) return;
    // The part of the picture that is on the screen.
    const botF = Math.min(1, (box.bottom - r.top) / r.height);
    const over = botF < 0.999 || r.top < box.top - 1;
    // How far up the caption sits: a little above the bottom of the screen.
    const lift = 0.12 * box.height / r.height;
    for (const track of v.textTracks) {
      if (track.mode !== 'showing') continue;
      for (const cue of track.activeCues || []) {
        if (!cue || typeof cue !== 'object') continue;
        if (!over) {
          // Nothing is off the screen: the captions go back where they were.
          if (cue._komaMoved) { cue.snapToLines = true; cue.line = 'auto'; cue._komaMoved = false; }
          continue;
        }
        // The caption sits just above the bottom of the part of the picture
        // that is on the screen.
        cue.snapToLines = false;
        cue.line = Math.max(0, Math.min(100, (botF - lift) * 100));
        cue._komaMoved = true;
      }
    }
  }

  /** How tall the control bar is right now. */
  measureBar() {
    const h = this.el.bottom?.offsetHeight || 0;
    this.container.style.setProperty('--kp-bar-measured', `${h}px`);
  }

  /** Load an episode into the player without touching the container. */
  load({ src, mode = 'hls', title, ep, epTitle = '', type, intro, outro, subtitles = [], poster, resumeAt = 0, resumeAsk = true, hasNext, hasPrev, nextLabel = 'Next episode' }) {
    this.teardownHls();
    // A new episode may come with bars of its own.
    this.frame = null; this._frameTry = null; this._frameBars = false; this._frameTries = 0;
    clearTimeout(this.state.nextTimer); clearInterval(this.state.nextCountdown);
    Object.assign(this.state, {
      ep, type, intro: intro || null, outro: outro || null, hasNext, hasPrev,
      started: false, introJumped: false, outroJumped: false, heuristicOffered: false, nextShown: false, retryCount: 0,
      fatal: 0, refreshed: false, advancing: false,
    });

    this.el.now.querySelector('h3').textContent = title || '';
    this.el.now.querySelector('p').textContent = epTitle ? `E${ep} · ${epTitle}` : `Episode ${ep}`;
    this.el.startBg.style.backgroundImage = poster ? `url("${poster}")` : '';
    // The room around the picture, when the picture keeps its own shape: the
    // artwork of the episode, blurred, instead of black bars.
    if (this.el.ambient) this.el.ambient.style.backgroundImage = poster ? `url("${poster}")` : '';
    this._media = title ? { title, ep, epTitle, poster } : null;
    this.paintMedia();
    this.syncMedia();
    // A resume point is a choice, not a fait accompli: the viewer is asked
    // whether to pick up where they left off or to start over. Only a reload
    // inside the same episode (an audio switch, a stream refresh) takes the
    // point silently — there the viewer is already watching.
    const ask = resumeAsk && resumeAt > 20;
    this.el.resume.hidden = !ask;
    this.el.bigPlay.hidden = ask;
    this.el.start.classList.toggle('kp-asking', ask);
    if (ask) this.el.resumeGo.textContent = `Continue from ${fmt(resumeAt)}`;
    this.el.startNote.textContent = !ask && resumeAt > 20 ? `Resuming from ${fmt(resumeAt)}` : '';
    this.el.start.hidden = false;
    // A television needs to know that a question is on the screen: the
    // remote has to point at the answer. The event goes out once the overlay
    // is actually on the screen - before that the answer is not there to be
    // pointed at.
    if (ask) this.container.dispatchEvent(new CustomEvent('koma:player-ask', { bubbles: true }));
    // And it needs to know that the player is ready at all - that is when
    // the play button can be pointed at.
    this.container.dispatchEvent(new CustomEvent('koma:player-ready', { bubbles: true, detail: { ask } }));
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
    this.el.eps.hidden = !this.hooks.drawerHTML;
    if (this.hooks.drawerHTML) this.el.drawerBody.innerHTML = this.hooks.drawerHTML();

    const v = this.video;
    v.poster = '';
    v.removeAttribute('src');
    try { v.load(); } catch { /* swapping */ }
    // The caption tracks go in *after* the reset: loading the media element
    // takes every text track off the list, so tracks added before it are
    // wiped — and the caption that should have been showing never is.
    this.setCC(subtitles, type);
    this._pending = { src, mode, subtitles, resumeAt, type, resumeAsk };

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
    if (!ask && resumeAt > 20) {
      const seek = () => { try { v.currentTime = this._pending.resumeAt; } catch { /* not yet */ } };
      v.addEventListener('loadedmetadata', seek, { once: true });
    }
    // Autoplay the episode straight away — browsers allow this once the page
    // has sticky user activation (any earlier click); a fresh cold load falls
    // back to the big play button. A resume point waits for the viewer to say
    // where to start.
    v.defaultPlaybackRate = v.playbackRate = prefs.speed; // load() resets the rate
    if (!ask && prefs.autoplay !== false) {
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
    // A television has no mouse to reach for the button under this message,
    // so the page is told that the player wants the focus.
    this.container.dispatchEvent(new CustomEvent('koma:player-error', { bubbles: true }));
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
    this.load({ ...p, resumeAt: this.video.currentTime || p.resumeAt, resumeAsk: false, hasNext: this.state.hasNext, hasPrev: this.state.hasPrev, title: this.el.now.querySelector('h3').textContent, ep: this.state.ep, type: this.state.type });
  }

  spinner(on) {
    if (!on) clearTimeout(this._stallTimer); // playback began or an error screen is up — the watchdog is off
    this.el.busy.hidden = !on;
  }

  /** A line under the spinner: what the player is still waiting for. */
  busyNote(msg) {
    const el = this.el.busyNote;
    if (!el) return;
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  setCC(subtitles, type) {
    const v = this.video;
    // Hard reset first. A previous episode or an audio switch leaves its
    // tracks behind: a detached element's TextTrack keeps living in
    // textTracks, and the old code re-enabled whatever ended up first — a
    // frozen sub track that kept rendering over the new one.
    for (const t of [...v.textTracks]) { try { t.mode = 'disabled'; } catch { /* mid-teardown */ } }
    $$('track', v).forEach(t => t.remove());

    // Fresh picks, in the order the source sends them. The user's remembered
    // caption language wins (prefs.ccLang), then literal English — sources
    // lead with all sorts (Arabic often landed on top otherwise).
    const list = subtitles.slice(0, 4);
    // The table is ours, because Chrome leaves TextTrack.srclang empty even
    // when the element carries the attribute: the label and the code have to
    // be remembered here to pick the right track later.
    this._ccList = list.map(s => ({ label: s.lang || 'Subtitles', code: ccCodeOf(s.lang), url: s.url }));
    this._ccList.forEach(m => {
      const t = document.createElement('track');
      t.kind = 'subtitles';
      t.label = m.label;
      t.srclang = m.code;
      t.src = m.url;
      v.appendChild(t);
    });
    this.el.cc.hidden = list.length === 0;
    const wantOn = prefs.cc === true || (prefs.cc === null && type === 'sub');
    this._ccWant = wantOn;
    this.applyCC();
  }

  /** The fresh caption tracks of this stream, with their labels and codes.
   *  Paired by URL, not by position: a track element from elsewhere (the
   *  source's own manifest, a leftover) must never be mistaken for ours. */
  ccTracks() {
    const list = this._ccList || [];
    const els = [...this.video.querySelectorAll('track')];
    const tts = [...this.video.textTracks];
    const out = [];
    list.forEach((m, i) => {
      let ei = els.findIndex(e => e.getAttribute('src') === m.url);
      if (ei < 0) ei = els.length - list.length + i; // our own elements are the last ones we added
      if (ei < 0 || !tts[ei]) return;
      out.push({ track: tts[ei], label: m.label, code: m.code || els[ei].getAttribute('srclang') || '' });
    });
    return out;
  }

  /** The track the user wants: their remembered pick, else English, else the first fresh one. */
  preferredCC() {
    const fresh = this.ccTracks();
    const rank = t => {
      const sr = (t.code || '').toLowerCase(), lb = String(t.label || '').toLowerCase();
      const key = String(prefs.ccLang || '').toLowerCase();
      if (key && (key === sr || key === lb || sr.startsWith(key) || lb.includes(key))) return 0;
      if (/^(en|eng)/.test(sr) || /english|eng\b/.test(lb)) return 1;
      return 2;
    };
    return fresh.length ? fresh.reduce((best, t) => (rank(t) < rank(best) ? t : best)) : null;
  }

  /** Exactly one fresh track showing, or none: the old cue layers never. */
  applyCC() {
    const v = this.video;
    for (const t of [...v.textTracks]) { try { t.mode = 'disabled'; } catch { /* mid-teardown */ } }
    const pick = this._ccWant ? this.preferredCC() : null;
    if (pick) pick.track.mode = 'showing';
    this.el.cc?.classList.toggle('on', Boolean(pick));
  }

  /** Show the caption the viewer wants — or none at all. */
  showChosen(on) {
    this._ccWant = !!on;
    this.applyCC();
  }

  setAudioButtons() {
    $$('button', this.el.audio).forEach(b => b.setAttribute('aria-pressed', b.dataset.audio === this.state.type));
  }

  play() {
    // While the resume prompt is up, "play" means "pick up where I left off".
    if (!this.el.resume.hidden) return this.beginAt(this._pending?.resumeAt || 0);
    this.el.start.hidden = true;
    this.video.play().catch(() => {});
  }

  /** Start playback at a point the viewer chose: the resume point, or zero. */
  beginAt(t) {
    const v = this.video;
    this.el.resume.hidden = true;
    this.el.bigPlay.hidden = false;
    this.el.startNote.textContent = t > 0 ? `Resuming from ${fmt(t)}` : '';
    if (this._pending) this._pending.resumeAt = t;
    if (t > 0) {
      const seek = () => { try { v.currentTime = t; } catch { /* not yet */ } };
      if (v.readyState >= 1) seek();
      else v.addEventListener('loadedmetadata', seek, { once: true });
    }
    if (!t) this.hooks.onRestart?.(); // "start from the beginning" drops the saved point
    const pr = v.play();
    if (pr?.then) pr.then(() => { this.el.start.hidden = true; }).catch(() => { this.el.start.hidden = false; });
    else this.el.start.hidden = true;
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

  /* ---------- the Windows media flyout and the keyboard's media keys ---------- */

  /** What Windows shows for this video: title, episode line, cover art. */
  paintMedia() {
    if (!('mediaSession' in navigator)) return;
    if (!this._media) { navigator.mediaSession.metadata = null; return; }
    const { title, ep, epTitle, poster } = this._media;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: epTitle ? `E${ep} · ${epTitle}` : `Episode ${ep}`,
      artist: title,
      artwork: poster ? [{ src: poster, sizes: '256x256', type: 'image/jpeg' }] : [],
    });
  }

  /** Playback state + exact position: the flyout's timeline stays honest. */
  syncMedia() {
    if (!('mediaSession' in navigator)) return;
    const v = this.video;
    navigator.mediaSession.playbackState = v.paused || !this.state.started ? 'paused' : 'playing';
    if (Number.isFinite(v.duration) && v.duration > 0) {
      try {
        navigator.mediaSession.setPositionState({
          duration: v.duration, playbackRate: v.playbackRate, position: Math.min(v.currentTime, v.duration),
        });
      } catch { /* mid-swap durations lie */ }
    }
  }

  bindSession() {
    if (!('mediaSession' in navigator)) return;
    const v = this.video;
    const ms = navigator.mediaSession;
    try {
      ms.setActionHandler('play', () => this.play());
      ms.setActionHandler('pause', () => this.video.pause());
      ms.setActionHandler('previoustrack', () => { if (this.state.hasPrev) this.hooks.onPrev?.(); });
      ms.setActionHandler('nexttrack', () => { if (this.state.hasNext) this.nextEpisode(); });
      ms.setActionHandler('seekbackward', d => { v.currentTime = Math.max(0, v.currentTime - (d?.seekOffset || 10)); });
      ms.setActionHandler('seekforward', d => { if (Number.isFinite(v.duration)) v.currentTime = Math.min(v.duration - .5, v.currentTime + (d?.seekOffset || 10)); });
      ms.setActionHandler('seekto', d => { if (Number.isFinite(d.seekTime) && d.seekTime <= v.duration) v.currentTime = d.seekTime; });
      ms.setActionHandler('stop', () => this.pause());
      ms.setActionHandler('enterpictureinpicture', () => v.requestPictureInPicture?.().catch(() => {}));
      ms.setActionHandler('exitpictureinpicture', () => { if (document.pictureInPictureElement) document.exitPictureInPicture().catch(() => {}); });
    } catch { /* an unimplemented handler is not a problem */ }
    this._sessionBound = true;
  }

  /* ---------- bindings ---------- */

  bind() {
    const v = this.video;
    const on = (el, ev, fn, opts) => { el.addEventListener(ev, fn, opts); (this._bound ??= []).push([el, ev, fn]); };
    this.removeListeners = () => (this._bound || []).forEach(([el, ev, fn]) => el.removeEventListener(ev, fn));
    const root = this.container;

    on(v, 'loadedmetadata', () => { this.el.dur.textContent = fmt(v.duration); this.spinner(false); this.syncMedia(); this.setShape(); this.layoutPicture(); });
    on(v, 'loadeddata', () => { this.layoutPicture(); });
    on(v, 'canplay', () => this.spinner(false));
    on(v, 'waiting', () => this.spinner(true));
    on(v, 'playing', () => {
      this.spinner(false); this.state.started = true; this.el.play.innerHTML = icon('pause'); root.classList.add('playing');
      if (this.video.currentTime > 120) this._refreshTally = 0; // healthy deep playback earns a fresh recovery budget
      this.hooks.onPlay?.();
      if (!this._sessionBound) this.bindSession();
      this.syncMedia();
      this.lookForFrame();
    });
    on(v, 'pause', () => { this.el.play.innerHTML = icon('play'); root.classList.remove('playing'); this.saveProgressNow(); this.hooks.onPause?.(); this.syncMedia(); });
    on(v, 'ended', () => this.onEnded());
    on(v, 'timeupdate', () => this.onTime());
    on(v, 'seeked', () => { this.hooks.onSeek?.(v.currentTime, v.duration); this.syncMedia(); }); // scrub drop, skip jumps, resume points: the profile bar must follow instantly
    on(v, 'progress', () => {
      try {
        const b = v.buffered;
        const end = b.length ? b.end(b.length - 1) : 0;
        if (v.duration) this.el.buf.style.width = `${Math.min(100, end / v.duration * 100)}%`;
      } catch { /* mid-swap */ }
    });
    on(v, 'volumechange', () => { prefs.volume = v.volume; prefs.muted = v.muted; savePrefs(); this.updateVolumeUI(); });
    on(v, 'ratechange', () => { prefs.speed = v.playbackRate; savePrefs(); this.syncMedia(); });

    // single click = play/pause (slightly delayed), double click = fullscreen
    let clickTimer;
    on(v, 'click', e => {
      if (!this.state.started || Date.now() - (this._closedAt || 0) < 400) return;
      if (e.detail === 2) { clearTimeout(clickTimer); this.toggleFullscreen(); }
      else clickTimer = setTimeout(() => this.togglePlay(), 220);
    });

    on(this.el.bigPlay, 'click', () => this.play());
    on(this.el.resumeGo, 'click', () => this.beginAt(this._pending?.resumeAt || 0));
    on(this.el.resumeStart, 'click', () => this.beginAt(0));
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
    });
    on(this.el.drawer, 'click', e => { if (e.target.closest('.kp-x')) this.toggleDrawer(false); });
    on(this.el.menu, 'click', e => this.onMenuClick(e));
    // The screen changes shape when the window does, and the picture has to
    // follow it.
    on(window, 'resize', () => this.layoutPicture());
    on(window, 'orientationchange', () => setTimeout(() => this.layoutPicture(), 250));
    // The audio switch listens on itself, not on the picture: on a television
    // it hangs in the band under the picture, and it still has to work.
    on(this.el.audio, 'click', e => {
      const a = e.target.closest('[data-audio]');
      if (a && !a.disabled && a.dataset.audio !== this.state.type) this.hooks.onAudio?.(a.dataset.audio);
    });

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
    // A television is watched from the sofa and the remote is pressed rarely,
    // so the controls stay a little longer before they go away.
    const idleMs = document.documentElement.classList.contains('tv') ? 4200 : 2600;
    const wake = () => {
      root.classList.remove('idle');
      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => { if (!v.paused && this.el.menu.hidden && this.el.drawer.hidden) root.classList.add('idle'); }, idleMs);
    };
    // The television's remote has no pointer to move: the controls are woken
    // by the keys themselves, so the page can ask for them.
    this.wake = wake;
    on(root, 'pointermove', wake);
    on(root, 'pointerdown', wake);
    on(v, 'pause', () => root.classList.remove('idle'));

    // fullscreen
    on(document, 'fullscreenchange', () => {
      const fs = document.fullscreenElement === root;
      root.classList.toggle('is-full', fs);
      this.el.full.innerHTML = icon(fs ? 'full-exit' : 'full');
      this.el.top.classList.toggle('with-back', fs);
      this.moveAudio(fs);
      this.fullscreenEvent(fs);
      requestAnimationFrame(() => this.layoutPicture());
    });

    // keyboard
    this.keyHandler = e => {
      if (!root.isConnected) return this.removeListeners();
      if (e.target.closest('input, textarea, select, [contenteditable="true"]') || e.metaKey || e.ctrlKey || e.altKey) return;
      // On a television the remote drives the focus, not the keyboard: the
      // page's own navigation owns the pad unless the video is the screen.
      if (document.documentElement.classList.contains('tv') && !this.isFullscreen) return;
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
      // The language of the subtitles changed: the track on the screen follows
      // it straight away.
      if (e.detail.key === 'ccLang') this.applyCC();
      // How the picture sits on the screen changed: the picture follows.
      if (e.detail.key === 'picture') this.layoutPicture();
    });

    // save progress on unload
    this.unloadHandler = () => this.saveProgressNow();
    addEventListener('pagehide', this.unloadHandler);
    this._bound.push([window, 'pagehide', this.unloadHandler]);
    this.saveInterval = setInterval(() => this.saveProgressNow(), 5000);

    // The phone layout puts the control bar under the picture, so the
    // overlays over the picture need to know how tall that bar is.
    on(window, 'resize', () => this.measureBar());
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

  /**
   * Where the audio switch lives.
   *
   * On a television the switch hangs in the band under the picture, because
   * the picture's own controls belong to the picture. When the picture takes
   * the whole screen there is no band under it, so the switch goes back onto
   * the picture - where it has to be, or there is no way to change the
   * language in full screen.
   */
  moveAudio(onPicture) {
    // Only a television moves the switch. On a phone and on the desktop it
    // belongs to the picture, and it stays there.
    if (!document.documentElement.classList.contains('tv')) return;
    const audio = this.el.audio;
    if (!audio) return;
    if (onPicture) { this.el.audioRow?.append(audio); return; }
    const band = document.querySelector('.player-bar .pb-right');
    band?.append(audio);
  }

  /**
   * Tell the page that the picture took the screen, or gave it back.
   *
   * The television needs to know: when the picture has the screen, the remote
   * belongs to the picture and to nothing else.
   */
  fullscreenEvent(on) {
    this.container.dispatchEvent(new CustomEvent('koma:fullscreen', { bubbles: true, detail: { on: !!on } }));
  }

  toggleFullscreen() {
    // The Android shell can give the video the whole window, system bars and
    // all; a browser uses the page's own fullscreen.
    const shell = window.KomaAndroid;
    if (shell?.immersive) {
      const on = !this.container.classList.contains('fs-video');
      this.container.classList.toggle('fs-video', on);
      // The page's own view is transformed while it arrives, and a
      // transformed ancestor is what a fixed box is measured against - so
      // the fullscreen player would sit below the header instead of over
      // it. The class on the root lets the stylesheet stand that down.
      document.documentElement.classList.toggle('fs-video', on);
      this.el.full.innerHTML = icon(on ? 'full-exit' : 'full');
      this.el.top.classList.toggle('with-back', on);
      this.moveAudio(on);
      this.fullscreenEvent(on);
      requestAnimationFrame(() => this.layoutPicture());
      shell.immersive(on);
      return;
    }
    if (document.fullscreenElement === this.container) {
      document.exitFullscreen().catch(() => {});
      this.moveAudio(false);
    } else {
      this.container.requestFullscreen?.().catch(() => {});
      this.moveAudio(true);
    }
  }

  /** Leave fullscreen, whichever way it was entered. */
  exitFullscreen() {
    if (this.container.classList.contains('fs-video')) {
      this.container.classList.remove('fs-video');
      document.documentElement.classList.remove('fs-video');
      this.el.full.innerHTML = icon('full');
      this.el.top.classList.remove('with-back');
      this.moveAudio(false);
      this.fullscreenEvent(false);
      requestAnimationFrame(() => this.layoutPicture());
      window.KomaAndroid?.immersive?.(false);
      return true;
    }
    if (document.fullscreenElement === this.container) { document.exitFullscreen().catch(() => {}); this.moveAudio(false); return true; }
    return false;
  }

  /** True when the video is playing full screen. */
  get isFullscreen() {
    return this.container.classList.contains('fs-video') || document.fullscreenElement === this.container;
  }

  toggleDrawer(force) {
    const d = this.el.drawer;
    const show = force ?? d.hidden;
    d.hidden = !show;
    // Opening the drawer closes the menu; toggleMenu(false) early-returns and
    // never writes drawer state, so there is no re-entry into this method.
    if (show) this.toggleMenu(false);
    // The remote has to know: a list of episodes is a list the pad walks.
    this.container.dispatchEvent(new CustomEvent('koma:player-drawer', { bubbles: true, detail: { open: !!show } }));
  }

  toggleCC() {
    // On means the remembered (or English) pick, not "whatever track sits first".
    const on = this.ccTracks().some(t => t.track.mode === 'showing');
    prefs.cc = !on; savePrefs();
    this.showChosen(!on);
  }

  onEnded() {
    this.saveProgressNow();
    this.hooks.onEnded?.(this.state.ep, this.video?.duration);
    if (prefs.autoNext && this.state.hasNext && !this.state.advancing) this.nextEpisode();
  }

  /* ---------- skip intro / outro / next card ---------- */

  onTime() {
    const v = this.video, t = v.currentTime, dur = v.duration || 0;
    // The bars of the frame are looked for while the show runs: the first
    // frames are often black or a title card, and they say nothing. The
    // looking stops once the frame is known, or after a while - a show that
    // fills the frame has no bars to find.
    if (v.readyState >= 2 && !this._frameBars && this._frameTries < 60
        && Date.now() - (this._frameAt || 0) > 2000) {
      this._frameAt = Date.now();
      this._frameTries++;
      this.lookForFrame();
    }
    // The captions follow the picture: when the picture is bigger than the
    // screen, they are moved up into the part of it that is on the screen.
    if (this.isFullscreen) this.placeCues();
    if (!this.state.scrubbing) {
      const p = dur ? t / dur * 100 : 0;
      this.el.played.style.width = `${p}%`;
      this.el.knob.style.left = `${p}%`;
      this.el.cur.textContent = fmt(t);
      // The time line is a slider: it says where it is, so a screen reader
      // and a remote both know.
      this.el.scrub?.setAttribute('aria-valuenow', String(Math.round(p)));
      this.el.scrub?.setAttribute('aria-valuetext', `${fmt(t)} of ${fmt(dur)}`);
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
    // An outro skip that hops into the next episode is an autoNext move, so it
    // belongs behind that switch: with auto-advance off, "skip the outro" means
    // skip the credits of THIS episode, not queue up another one.
    if (s.outro && t >= s.outro.start && t < s.outro.end - 2 && prefs.skipOutro && !s.outroJumped && !v.paused
      && s.outro.end - s.outro.start >= 20) {
      s.outroJumped = true;
      if (s.hasNext && prefs.autoNext) { this.toastState('Skipping outro'); this.nextEpisode(); return; }
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
    // The card is the auto-advance UI — its ring counts down to the timer that
    // loads the next episode. With auto-advance off it has nothing to count
    // down to, so it never shows; the next button, the N key and the outro
    // chip still give the move by hand.
    const nearEnd = prefs.autoNext && s.hasNext && (s.outro ? t >= s.outro.start - 1 : dur - t < 22 && dur > 60);
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
    if (!show) {
      m.hidden = true;
      this.el.settings.classList.remove('on');
      this.menuEvent(false);
      return;
    }
    m.innerHTML = this.menuHTML();
    m.hidden = false;
    this.el.settings.classList.add('on');
    // The menu is open: the remote has to be able to walk it.
    this.menuEvent(true);
    // Close the drawer directly: routing through toggleDrawer would re-enter
    // toggleMenu and instantly re-hide this menu again.
    this.el.drawer.hidden = true;
  }

  /** Tell the page that the menu opened or closed. */
  menuEvent(open) {
    this.container.dispatchEvent(new CustomEvent('koma:player-menu', { bubbles: true, detail: { open: !!open } }));
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
    // Subtitles: Off or a specific track. Only the fresh tracks of the loaded
    // stream — the video's textTracks list keeps ghosts of old streams, and
    // those must never appear in the picker again.
    const fresh = this.ccTracks();
    const showing = fresh.findIndex(t => t.track.mode === 'showing');
    const subs = fresh.length
      ? sec('Subtitles', opt('cc', -1, showing, 'Off') + fresh.map((t, i) => opt('cc', i, showing, t.label)).join(''))
      : '';
    const speeds = `<div class="kp-speeds" role="group" aria-label="Speed">${rates.map(r =>
      `<button type="button" role="menuitemradio" data-set="speed" data-val="${r}" aria-checked="${r === prefs.speed}">${r === 1 ? 'Normal' : `${r}×`}</button>`).join('')}</div>`;
    // The picture: the screen filled, or the whole frame with the artwork
    // around it. A four-by-three episode on a wide screen cannot be both -
    // this is the choice between them.
    const picture = sec('Picture', opt('picture', 'fill', pictureMode(), 'Fit to the screen') + opt('picture', 'whole', pictureMode(), 'The whole frame'));
    return ''
      + quality
      + subs
      + picture
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
      if (n < 0) {
        prefs.cc = false;
        this.showChosen(false);
      } else {
        // Remember the language so the next episode — and any stream after an
        // audio switch — opens with the same captions (English until you pick).
        // The code is what is kept, so the settings panel and the player agree
        // on what "English" means.
        const pick = this.ccTracks()[n];
        if (pick) prefs.ccLang = ccCodeOf(pick.label) || pick.code || pick.label.toLowerCase();
        prefs.cc = true;
        this.showChosen(true);
      }
      savePrefs();
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
    if (set === 'picture') {
      const mode = t.dataset.val === 'whole' ? 'whole' : 'fill';
      prefs.picture = mode; savePrefs();
      this.layoutPicture();
      this.toggleMenu(false);
      this.toastState(mode === 'fill' ? 'The picture is fitted to the screen' : 'The whole frame, with the artwork around it');
      return;
    }
    if (set === 'autoplay' || set === 'autoNext' || set === 'skipIntro' || set === 'skipOutro') setPref(set, t.checked);
  }
}
