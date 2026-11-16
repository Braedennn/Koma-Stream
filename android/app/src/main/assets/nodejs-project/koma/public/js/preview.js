// Hover previews.
//
// A card plays its trailer while the pointer rests on it; an episode plays
// itself. Both are passive - nothing is clicked, nothing is announced, and the
// preview stops the moment the pointer moves away.
//
// One YouTube player serves the whole app. The embed is made the first time a
// card is hovered and then reused: YouTube's command API swaps the video
// inside the same player, so the next card starts in a fraction of a second
// instead of loading a second embed.
import { ensureHls } from './player.js';
import { streamWatch } from './streaming.js';
import { icon } from './icons.js';

const KEY = 'koma.previews';

/* ---------- the switch ---------- */

/* The television has no pointer: the card that has the focus is the card
   that is pointed at. The trailer is the same one, in the same window - only
   the trigger is different. */
const tvMode = () => document.documentElement.classList.contains('tv');

/**
 * Are the previews on?
 *
 * They are on unless the viewer turns them off - but on a television they
 * start off, because a trailer that starts under the focus is loud and
 * surprising when the viewer is only moving around. The choice is theirs to
 * make, and once they have made it, it sticks.
 */
export const previewsOn = () => {
  try {
    const v = localStorage.getItem(KEY);
    if (v === null) return !tvMode();
    return v !== '0';
  } catch { return true; }
};

export const setPreviewsOn = on => {
  try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* private mode */ }
  if (!on) stop();
  else initPreviews();
  dispatchEvent(new CustomEvent('koma:previews', { detail: { on } }));
};

// How long the pointer has to rest before anything starts. A sweep across a
// row should not start a video in every card it passes.
const DELAY = 450;

// The strip that hangs under the trailer: the title and the buttons.
const INFO_H = 84;

/* ---------- the shared YouTube player ---------- */

const YT = 'https://www.youtube-nocookie.com';

let stage = null;   // the box that sits over the card
let inner = null;   // the part that pops
let still = null;   // the artwork, shown until the trailer takes over
let frame = null;   // the embed inside it
let info = null;    // the strip under the trailer: title and buttons
let infoTitle = null;
let infoMeta = null;
let infoPlay = null;
let infoActions = null;
let ready = false;  // the embed answers commands
let want = null;    // the video id we want playing
let live = null;    // the card whose trailer is playing
let anchor = null;  // the card the window is over
let hover = null;   // the card under the pointer, previewed or not
let wait = 0;       // the hover timer
let blink = 0;      // the timer that gives up on a video that never starts
let pings = 0;      // how often we have announced ourselves to the embed
let pingTimer = 0;  // the next announcement
let loadedAt = 0;   // when the current video was asked for
let placed = '';    // the last geometry written to the stage
let fromSize = '';  // the last start size of the window
let glideTimer = 0; // when the slide between two cards ends

const embed = id => {
  const p = new URLSearchParams({
    autoplay: '1', mute: '1', controls: '0', rel: '0', playsinline: '1',
    modestbranding: '1', enablejsapi: '1', iv_load_policy: '3',
  });
  // The embed only talks to the page that framed it when it knows who that is.
  if (location.origin && location.origin !== 'null') p.set('origin', location.origin);
  return `${YT}/embed/${encodeURIComponent(id)}?${p}`;
};

const say = data => { try { frame?.contentWindow?.postMessage(JSON.stringify(data), '*'); } catch { /* the frame went away */ } };
const cmd = (func, args = []) => say({ event: 'command', func, args });

function onMessage(e) {
  if (!frame || e.source !== frame.contentWindow) return;
  let d = e.data;
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch { return; } }
  if (!d || typeof d.event !== 'string') return;

  if (d.event === 'onReady') {
    ready = true;
    cmd('mute');
    cmd('setPlaybackQuality', ['large']); // the box is wide: 480p is enough
    if (want) send(want);
    return;
  }
  if (d.event !== 'infoDelivery') return;
  const info = d.info || {};
  const state = info.playerState;
  if (state === undefined) return;
  // Every event names the video it belongs to, so a trailer that has just
  // ended can be told apart from the one that was swapped out.
  const id = info.videoData?.video_id;
  if (id && want && id !== want) return;
  // The video is running: now the trailer can take the place of the artwork.
  if (state === 1) {
    clearTimeout(blink);
    stage?.classList.add('playing');
    return;
  }
  // The trailer ended: play it again, unless it never really started (a video
  // that dies at once would otherwise loop forever).
  if (state === 0 && want) { if (Date.now() - loadedAt > 2000) send(want); else stop(); }
}

function send(id) {
  loadedAt = Date.now();
  cmd('loadVideoById', [id, 0]);
  cmd('mute');
  cmd('playVideo');
}

// The embed only answers once the page has announced itself. The announcement
// is repeated until it does, because the embed may not be listening yet.
function announce() {
  clearTimeout(pingTimer);
  say({ event: 'listening', id: 1, channel: 'widget' });
  if (ready) return;
  if (pings++ < 30) pingTimer = setTimeout(announce, 250);
  else pings = 0; // the next hover starts a fresh attempt
}

function makeStage(from) {
  stage = document.createElement('div');
  stage.className = 'kp-preview';
  if (from) stage.style.setProperty('--kp-from', from);
  stage.style.setProperty('--kp-info-h', `${INFO_H}px`);
  inner = document.createElement('div');
  inner.className = 'kp-preview-inner';
  inner.setAttribute('aria-hidden', 'true');
  // The artwork rides in the window while the trailer loads, and the trailer
  // takes its place when it starts.
  still = document.createElement('img');
  still.className = 'kp-preview-still';
  still.alt = '';
  frame = document.createElement('iframe');
  frame.className = 'kp-preview-frame';
  frame.allow = 'autoplay; encrypted-media; picture-in-picture';
  frame.tabIndex = -1;
  frame.title = 'Preview';
  inner.append(still, frame);
  stage.appendChild(inner);

  // The strip under the trailer: the title, and what you can do with it.
  info = document.createElement('div');
  info.className = 'kp-preview-info';
  infoTitle = document.createElement('a');
  infoTitle.className = 'kp-info-title';
  infoTitle.href = '#';
  infoPlay = document.createElement('a');
  infoPlay.className = 'kp-act kp-play';
  infoPlay.href = '#';
  infoPlay.title = 'Watch';
  infoPlay.setAttribute('aria-label', 'Watch');
  infoPlay.innerHTML = icon('play');
  infoActions = document.createElement('div');
  infoActions.className = 'kp-info-actions';
  infoMeta = document.createElement('span');
  infoMeta.className = 'kp-info-meta';
  const row = document.createElement('div');
  row.className = 'kp-info-row';
  row.append(infoPlay, infoActions, infoMeta);
  info.append(infoTitle, row);
  stage.appendChild(info);

  document.body.appendChild(stage);
}

/**
 * Fill the strip with the card's own title, its line and its buttons.
 *
 * The buttons are copies: the card's + opens the library menu, and the copy
 * opens the same menu - the page watches for the click wherever it happens.
 */
function fillInfo(el) {
  const title = el.querySelector('.card-title');
  const meta = el.querySelector('.card-meta');
  const href = el.querySelector('.poster')?.getAttribute('href') || '';
  infoTitle.textContent = title?.textContent.trim() || '';
  infoTitle.href = href || '#';
  const id = (href.match(/\/(\d+)/) || [])[1] || '';
  infoPlay.href = id ? `/watch/${id}` : href || '#';

  // The line under the title: the score, and what the card says below it.
  infoMeta.textContent = '';
  const score = el.querySelector('.badge.score')?.textContent.trim();
  if (score) {
    const s = document.createElement('span');
    s.className = 'kp-score';
    s.innerHTML = icon('star');
    const b = document.createElement('b');
    b.textContent = score;
    s.appendChild(b);
    infoMeta.append(s, document.createTextNode(' · '));
  }
  infoMeta.append(document.createTextNode(meta?.textContent.trim() || ''));

  const quick = el.querySelector('.quick');
  const add = quick?.cloneNode(true);
  if (add) {
    // The copy keeps the attributes the page watches for: clicking it opens
    // the same library menu the card's own + opens.
    add.className = 'kp-act kp-add';
    infoActions.replaceChildren(add);
  } else if (id) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'kp-act kp-add';
    b.dataset.list = id;
    b.dataset.shelfOpen = id;
    b.setAttribute('aria-pressed', 'false');
    b.setAttribute('aria-label', 'Add to your library');
    b.title = 'Add to your library';
    b.innerHTML = icon('plus');
    infoActions.replaceChildren(b);
  } else infoActions.replaceChildren();

  // A Continue watching card can also be taken out of the rail. Its X is
  // under the trailer too, so it comes along.
  const x = el.querySelector('.card-x');
  if (x) {
    const c = x.cloneNode(true);
    c.className = 'kp-act kp-x';
    infoActions.append(c);
  }
}

/**
 * Put the trailer window over the card.
 *
 * Netflix pulls a title out of the row when you point at it: the artwork
 * grows into a bigger panel that reaches over its neighbours, and the video
 * plays in the place the artwork used to be. The window here is exactly as
 * tall as the thumbnail and 16:9 wide - a 2:3 poster turned sideways, so it
 * covers the artwork and spills over the cards on both sides.
 *
 * `glide` is for moving between two cards: the window slides across instead
 * of jumping. It is off while the page moves under the pointer, so the window
 * never lags behind a scroll.
 */
function geom(el) {
  const box = el.querySelector('.poster') || el;
  const r = box.getBoundingClientRect();
  if (!r.width || !r.height) return null;
  const h = Math.min(r.height, (innerWidth - 24) * 9 / 16);
  const w = h * 16 / 9;
  let left = r.left + r.width / 2 - w / 2;
  left = Math.max(12, Math.min(left, innerWidth - w - 12));
  // The video sits over the artwork and the strip of buttons hangs under it.
  // Near the bottom of the page the whole panel moves up, so the strip is
  // never half off the screen.
  let bottom = r.bottom;
  if (bottom + INFO_H > innerHeight - 12) bottom = innerHeight - 12 - INFO_H;
  let top = bottom - h;
  top = Math.max(12, Math.min(top, innerHeight - h - 12));
  // The window opens out of the thumbnail: it starts as wide as the artwork.
  return { left, top, w, h, from: String(Math.max(.3, Math.min(.72, r.width / w))) };
}

function place(el, glide = false) {
  const g = geom(el);
  if (!g) return false;
  const { left, top, w, h, from } = g;
  const key = `${Math.round(left)}px ${Math.round(top)}px ${Math.round(w)}px ${Math.round(h)}px`;
  if (key !== placed) {
    placed = key;
    stage.classList.toggle('glide', glide);
    // The slide is over quickly: after that the window follows the card
    // exactly, without lagging behind a scroll.
    if (glide) {
      clearTimeout(glideTimer);
      glideTimer = setTimeout(() => stage.classList.remove('glide'), 300);
    }
    stage.style.left = `${Math.round(left)}px`;
    stage.style.top = `${Math.round(top)}px`;
    stage.style.width = `${Math.round(w)}px`;
    stage.style.height = `${Math.round(h)}px`;
  }
  // The window opens out of the thumbnail: it starts as wide as the artwork.
  if (from !== fromSize) {
    fromSize = from;
    stage.style.setProperty('--kp-from', from);
  }
  return true;
}

// The card can move under a pointer that has not moved at all: rows arrive
// under the card, the page scrolls, the window changes. The box follows the
// card, so it is placed again on every frame while the preview is up.
let followRaf = 0;
function follow() {
  followRaf = 0;
  if (anchor && !anchor.isConnected) { stop(); return; } // the card went away
  if (anchor && stage) place(anchor);
  if (epRow && epPanel) placeEp(epRow);
  if (!anchor && !epRow) return;
  followRaf = requestAnimationFrame(follow);
}

/**
 * Move the window onto a card.
 *
 * The artwork of that card is what the window shows while its trailer loads.
 */
function show(el) {
  const g = geom(el);
  if (!g) return;
  // The start size is set before the window is put on the page, so the first
  // frame of the opening is already the width of the thumbnail.
  if (!stage) makeStage(g.from);
  const fresh = !stage.classList.contains('on');
  if (anchor && anchor !== el) anchor.classList.remove('kp-preview-on');
  anchor = el;
  place(el, !fresh);
  fillInfo(el);
  const art = el.querySelector('.poster img');
  if (art) still.src = art.currentSrc || art.src; else still.removeAttribute('src');
  // The trailer fades in over the artwork when it starts.
  stage.classList.remove('playing');
  el.classList.add('kp-preview-on');
  if (fresh) {
    void stage.offsetWidth; // let the window be drawn small before it opens
    stage.classList.add('on');
  }
}

/** Put the trailer of a card on the screen. */
function begin(el) {
  const id = el.dataset.trailer;
  if (!id || !previewsOn()) return;
  show(el);
  live = el;
  want = id;
  if (!frame.getAttribute('src')) frame.src = embed(id);
  if (ready) send(id); else { pings = 0; announce(); }
  if (!followRaf) followRaf = requestAnimationFrame(follow);
  clearTimeout(blink);
  // A video that never starts shows nothing - better an empty poster than a
  // black box sitting on the card.
  blink = setTimeout(() => { if (live === el) stop(); }, 6000);
}

function stop() {
  clearTimeout(wait);
  clearTimeout(blink);
  cancelAnimationFrame(followRaf);
  followRaf = 0;
  wait = 0;
  if (live) { live.classList.remove('kp-preview-on'); live = null; }
  if (anchor) { anchor.classList.remove('kp-preview-on'); anchor = null; }
  hover = null;
  want = null;
  stage?.classList.remove('on', 'playing', 'glide');
  if (ready) cmd('stopVideo');
  if (epRow) followRaf = requestAnimationFrame(follow); // the episode preview is still up
}

/* ---------- episode previews ---------- */

let epCtx = null;    // what the watch page says about the show on screen
let epPanel = null;  // the box that floats beside the episode list
let epVideo = null;
let epStill = null;
let epHls = null;
let epRow = null;
let epToken = 0;

/** The watch page hands over what an episode preview needs to resolve a stream. */
export function setEpisodeContext(ctx) { epCtx = ctx; }
export function clearEpisodeContext() { epCtx = null; stopEpisode(); }

function makeEpPanel() {
  if (epPanel) return;
  epPanel = document.createElement('div');
  epPanel.className = 'kp-preview-ep';
  epPanel.setAttribute('aria-hidden', 'true');
  epStill = document.createElement('img');
  epStill.className = 'kp-preview-still';
  epStill.alt = '';
  epVideo = document.createElement('video');
  epVideo.className = 'kp-preview-video';
  epVideo.muted = true;
  epVideo.playsInline = true;
  epVideo.autoplay = true;
  epVideo.addEventListener('playing', () => { if (epVideo) epVideo.hidden = false; });
  epPanel.append(epStill, epVideo);
  document.body.appendChild(epPanel);
}

/** Put the episode box beside the row, on the side with room for it. */
function placeEp(row) {
  const r = row.getBoundingClientRect();
  const w = 320, h = 180;
  let left = r.left - w - 14;
  if (left < 12) left = Math.min(r.right + 14, innerWidth - w - 12);
  let top = r.top + r.height / 2 - h / 2;
  top = Math.max(12, Math.min(top, innerHeight - h - 12));
  epPanel.style.left = `${Math.round(left)}px`;
  epPanel.style.top = `${Math.round(top)}px`;
  epPanel.style.width = `${w}px`;
  epPanel.style.height = `${h}px`;
}

async function startEpisode(row) {
  if (!epCtx) return;
  const n = Number(row.dataset.epPreview);
  if (!n) return;
  makeEpPanel();
  const still = row.dataset.epThumb;
  if (still) { epStill.src = still; epStill.hidden = false; } else epStill.hidden = true;
  epVideo.hidden = true;
  epPanel.classList.add('on');
  placeEp(row);
  epRow = row;
  if (!followRaf) followRaf = requestAnimationFrame(follow);
  const token = ++epToken;
  try {
    const r = await streamWatch({ anilistId: epCtx.anilistId, ep: n, type: epCtx.type(), source: epCtx.source() });
    if (token !== epToken || !epRow) return; // the pointer moved on
    const src = r.hlsProxyUrl || r.mp4ProxyUrl || r.streamUrl;
    if (!src) return;
    await ensureHls();
    if (token !== epToken || !epRow) return;
    epVideo.muted = true;
    if (r.playbackMode === 'mp4' || !window.Hls) {
      epVideo.src = src;
    } else {
      epHls = new Hls({ enableWorker: true, lowLatencyMode: false, maxBufferLength: 12, maxMaxBufferLength: 24, startLevel: 0 });
      epHls.loadSource(src);
      epHls.attachMedia(epVideo);
    }
    epVideo.play().catch(() => {});
  } catch {
    // A hover is not a place for an error message: the still stays and the
    // pointer moves on.
  }
}

function stopEpisode() {
  epToken++;
  if (epHls) { try { epHls.destroy(); } catch { /* already gone */ } epHls = null; }
  if (epVideo) { try { epVideo.pause(); epVideo.removeAttribute('src'); epVideo.load(); } catch { /* swapping */ } epVideo.hidden = true; }
  epPanel?.classList.remove('on');
  epRow = null;
  cancelAnimationFrame(followRaf);
  followRaf = 0;
  if (live || anchor) followRaf = requestAnimationFrame(follow); // the card preview is still up
}

/* ---------- the pointer ---------- */

function onOver(e) {
  if (e.pointerType !== 'mouse' || !previewsOn()) return;
  // The pointer is on the strip under the trailer: the preview stays up, so
  // the buttons can be reached.
  if (e.target.closest?.('.kp-preview')) return;
  over(e.target);
}

/**
 * Something is pointed at: the card under the pointer, or the card that has
 * the focus on a television. Both want the same thing - the trailer of that
 * card, after the pointer has rested on it for a moment.
 */
export function over(target) {
  const card = target.closest?.('[data-trailer]');
  const row = card ? null : target.closest?.('[data-ep-preview]');
  if (!card && !row) {
    // Ordinary content: only do something if a preview was up.
    if (live || hover || epRow) { stop(); stopEpisode(); }
    return;
  }
  if (card) {
    if (hover === card) return;
    stopEpisode();
    // Moving along a row: the window is already open, so it slides to the
    // new card instead of closing and opening again.
    if (stage?.classList.contains('on')) {
      hover = card;
      show(card);
      const id = card.dataset.trailer;
      if (!id) { stop(); return; }
      live = card;
      want = id;
      if (ready) send(id); else { pings = 0; announce(); }
      clearTimeout(blink);
      blink = setTimeout(() => { if (live === card) stop(); }, 6000);
      return;
    }
    stop();
    hover = card;
    wait = setTimeout(() => begin(card), DELAY);
    return;
  }
  if (!epCtx) return;
  if (hover === row) return;
  stop();
  stopEpisode();
  // The episode that is playing already has a preview: it is on screen.
  if (row.getAttribute('aria-current') === 'true') return;
  hover = row;
  wait = setTimeout(() => startEpisode(row), DELAY);
}

/** The card that has the focus on a television is pointed at. */
export function previewFocus(el) {
  if (!previewsOn()) return;
  over(el);
}

function onOut(e) {
  if (e.pointerType !== 'mouse') return;
  // The pointer left the artwork for the strip under it: the preview stays.
  if (e.relatedTarget?.closest?.('.kp-preview')) return;
  const el = e.target.closest?.('[data-trailer],[data-ep-preview]');
  if (!el || el !== hover) return;
  if (e.relatedTarget && el.contains(e.relatedTarget)) return; // still inside
  // Moving on to the next card: the pointerover that follows takes over, and
  // the window slides instead of closing.
  const next = e.relatedTarget?.closest?.('[data-trailer],[data-ep-preview]');
  if (next && next !== el) return;
  stop();
  stopEpisode();
}

/* ---------- wiring ---------- */

/** Stop whatever is playing - the list under the pointer was redrawn. */
export function stopPreviews() { stop(); stopEpisode(); }

let started = false;
export function initPreviews() {
  if (started) return;
  started = true;
  document.addEventListener('pointerover', onOver);
  document.addEventListener('pointerout', onOut);
  addEventListener('message', onMessage);
  // Another page is coming: nothing may keep playing over it.
  addEventListener('koma:route', () => stopPreviews());
}
