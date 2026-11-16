// Client glue for the local streaming servers: watch resolution, sub/dub
// badge painting, and the viewer's audio preference. Everything goes through
// Koma's own /api/stream and /api/audio routes (same-origin, key never leaves
// the server).
import { $$, icon } from './ui.js';

/* ---------- audio preference ---------- */
export const getAudioPref = () => { try { return localStorage.getItem('koma.audio') === 'dub' ? 'dub' : 'sub'; } catch { return 'sub'; } };
export const setAudioPref = t => { try { localStorage.setItem('koma.audio', t === 'dub' ? 'dub' : 'sub'); } catch { /* private mode */ } };

/* ---------- streaming API ---------- */
export async function streamStatus() {
  try { return (await fetch('/api/stream-status')).ok; } catch { return false; }
}

// Resolving a stream takes seconds upstream, so answers are shared for a
// minute: the watch page can start resolving before it has drawn, and the
// next episode is resolved ahead of time near the end of the current one.
//
// A minute is the most an answer can be kept: the link inside it is signed by
// the streaming host and dies ninety seconds after it was made. An answer
// kept longer would hand the player a link that no longer opens, and the
// viewer would wait for a refresh instead of watching.
const resolved = new Map(); // query -> { at, p }
const RESOLVE_TTL = 60e3;

// How long the browser waits for a stream to resolve.
//
// The server finishes inside its own budget and then says what stopped it,
// so the browser waits longer than that: a player that gives up while the
// server is still working shows "couldn't get a stream" and the reason never
// reaches the screen. The time that is left is also sent to the server, so it
// answers while the browser is still waiting.
export const RESOLVE_TIMEOUT = 150e3;

export function streamWatch({ anilistId, ep, type, source = 'anikoto', server, fresh = false, ms = RESOLVE_TIMEOUT }) {
  const p = new URLSearchParams({ source, anilistId: String(anilistId), ep: String(ep), type });
  if (server) p.set('server', server);
  const key = String(p);
  const hit = resolved.get(key);
  if (!fresh && hit && Date.now() - hit.at < RESOLVE_TTL) return hit.p;
  if (fresh) p.set('fresh', '1'); // tells Koma's server to skip its own short cache too
  const wait = Math.max(1000, Math.min(ms, RESOLVE_TIMEOUT));
  const req = fetch('/api/stream/watch?' + p, {
    signal: AbortSignal.timeout(wait),
    headers: { 'x-koma-deadline': String(wait) },
  }).then(async res => {
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(body.error || `The streaming server answered with status ${res.status}.`), { status: res.status });
    return body;
  }).catch(err => {
    // The browser gave up before the server did. The reason is then unknown,
    // so it says that - instead of pretending the episode is not there.
    if (err?.name === 'TimeoutError') throw Object.assign(new Error('The streaming server took too long to answer.'), { status: 504 });
    throw err;
  });
  resolved.set(key, { at: Date.now(), p: req });
  req.catch(() => { if (resolved.get(key)?.p === req) resolved.delete(key); });
  return req;
}

/* ---------- sub/dub mic badges on posters ---------- */
const painted = new Set();
let pollTimer;
let pollDelay = 4000;
let painting = false;

export function audioBadgeHTML({ sub, dub }) {
  if (sub && sub === dub) // sub and dub in equal supply: one chip says it once
    return `<span class="aud both" title="${sub} episode${sub === 1 ? '' : 's'} · sub &amp; dub">${icon('cc')}${icon('mic')}<b>${sub}</b></span>`;
  return `${sub ? `<span class="aud sub" title="${sub} episode${sub === 1 ? '' : 's'} with subtitles">${icon('cc')}<b>${sub}</b></span>` : ''}`
    + `${dub ? `<span class="aud dub" title="${dub} episode${dub === 1 ? '' : 's'} dubbed">${icon('mic')}<b>${dub}</b></span>` : ''}`;
}

/** Counts for one anime, for the watch page's audio buttons. Resolves null when unknown. */
export async function audioCounts(id) {
  try {
    const d = await (await fetch('/api/audio?ids=' + id)).json();
    return d.counts[id] || null;
  } catch { return null; }
}

function paint(scope) {
  if (painting) return; // a batch is already in flight; the poll will re-check
  const slots = $$('[data-audio-badge]', scope).filter(el => !painted.has(el.dataset.audioBadge) || !el.innerHTML);
  if (!slots.length) return;
  const ids = [...new Set(slots.map(el => el.dataset.audioBadge))];
  const fresh = ids.some(id => !painted.has(id));
  ids.forEach(id => painted.add(id));
  if (fresh) pollDelay = 4000; // new batch: reset the retry backoff
  painting = true;
  // The server answers for one batch of ids at a time: asking for every card
  // in one go would leave the ones past the first batch waiting forever, so
  // they are asked for in batches of their own.
  const chunks = [];
  for (let i = 0; i < ids.length; i += 60) chunks.push(ids.slice(i, i + 60));
  Promise.all(chunks.map(c => fetch('/api/audio?ids=' + c.join(',')).then(r => r.json())))
    .then(list => {
      const counts = {};
      let pending = 0;
      for (const d of list) {
        Object.assign(counts, d.counts || {});
        pending += d.pending || 0;
      }
      let stillPending = false;
      for (const el of slots) {
        const c = counts[el.dataset.audioBadge];
        if (c) el.innerHTML = audioBadgeHTML(c);
        else if (pending) { painted.delete(el.dataset.audioBadge); stillPending = true; }
      }
      if (stillPending && scope.isConnected && !document.hidden) {
        clearTimeout(pollTimer);
        pollDelay = Math.min((pollDelay || 4000) * 2, 30000);
        pollTimer = setTimeout(() => paint(scope), pollDelay);
      }
    })
    .catch(() => ids.forEach(id => painted.delete(id)))
    .finally(() => { painting = false; });
}

/**
 * Paint badges for every [data-audio-badge] slot under `scope`, including
 * nodes added later (browse infinite scroll, lazy rows). Call once per view.
 */
export function initAudioBadges(scope) {
  paint(scope);
  const io = new MutationObserver(() => {
    io.disconnect();
    requestAnimationFrame(() => { if (scope.isConnected) { paint(scope); io.observe(scope, { childList: true, subtree: true }); } });
  });
  io.observe(scope, { childList: true, subtree: true });
}
