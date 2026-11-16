// Watch together: the host's playhead, shared with whoever joins the code.
//
// The host's server owns the room; this is the browser half. A host publishes
// what its player is doing, a viewer follows it. Each side keeps streaming
// through its own local server — only the playhead travels, so the host never
// carries anyone else's video.
import { $, $$, esc, toast } from './ui.js';
import { account } from './anilist.js';

const sleep = ms => new Promise(r => setTimeout(r, ms));

const S = {
  mode: 'none',        // 'none' | 'host' | 'guest'
  code: '', token: '', link: '', host: '', port: 0,
  id: '', v: 0,
  members: [], state: null, hostName: '',
  playhead: null,      // set by the watch page: what this player is doing
  remote: null,        // set by the watch page: how to follow someone else
};

const listeners = new Set();
const notify = () => { for (const fn of [...listeners]) fn(S); };

export const room = S;
export const isGuest = () => S.mode === 'guest';
export const isHost = () => S.mode === 'host';
export const subscribe = fn => { listeners.add(fn); return () => listeners.delete(fn); };

const myId = () => {
  let id = localStorage.getItem('koma.room.id');
  if (!id) { id = Math.random().toString(36).slice(2, 10); localStorage.setItem('koma.room.id', id); }
  return id;
};
const myName = () => account()?.name || 'Viewer';
const hostBase = () => `http://${S.host}:${S.port || 4000}`;

async function post(url, body) {
  const r = await fetch(url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || `The server answered with status ${r.status}.`);
  return d;
}

/* ---------- hosting ---------- */

/** Open a room on this machine and start publishing the playhead. */
export async function createSession() {
  if (S.mode === 'host') {
    // A new session replaces the old one — do not leave it standing.
    await post('/api/room/close', { code: S.code, token: S.token }).catch(() => {});
  }
  const d = await post('/api/room/create', { name: myName() });
  S.mode = 'host';
  S.code = d.code; S.token = d.token; S.link = d.url || '';
  S.host = ''; S.port = 0; S.v = 0;
  S.members = []; S.state = null; S.hostName = d.name || myName();
  notify();
  publish(); // tell the room right away where we are
  pollLoop();
  return d;
}

/** Tell the viewers where the playhead is. */
export function publish() {
  if (S.mode !== 'host' || !S.playhead) return;
  const state = S.playhead();
  if (!state) return;
  S.state = { ...state, at: Date.now() };
  post('/api/room/state', { code: S.code, token: S.token, state: S.state }).catch(() => {});
}

/* ---------- joining ---------- */

/**
 * Join a session by its code. Without an address, the code is looked for on
 * this network — the host's machine says where it is over the beacon.
 */
export async function joinSession({ code, host, port } = {}) {
  const clean = String(code || '').trim().toUpperCase();
  if (!clean) throw new Error('Enter the code the host gave you.');
  let where = { host, port: port || 4000 };
  if (!where.host) {
    const d = await fetch(`/api/room/discover?code=${encodeURIComponent(clean)}`).then(r => r.json()).catch(() => ({}));
    if (!d.found) throw new Error(`No session with the code ${clean} on this network.`);
    // The host may answer on more than one address; the first that answers
    // is the one we can reach.
    let joined = null;
    let lastErr = null;
    for (const h of [...new Set([d.host, ...(d.addrs || [])])].filter(Boolean)) {
      try {
        joined = await post(`http://${h}:${d.port || 4000}/api/room/join`, { code: clean, id: myId(), name: myName() });
        where = { host: h, port: d.port || 4000 };
        break;
      } catch (err) { lastErr = err; }
    }
    if (!joined) throw new Error(lastErr?.message || `No session with the code ${clean} on this network.`);
    S.mode = 'guest';
    S.code = clean; S.host = where.host; S.port = where.port;
    S.id = myId(); S.v = joined.v || 0;
    S.members = joined.members || []; S.state = joined.state || null; S.hostName = joined.host?.name || '';
    notify();
    applyRemote();
    pollLoop();
    return joined;
  }
  const d = await post(`http://${where.host}:${where.port}/api/room/join`, { code: clean, id: myId(), name: myName() });
  S.mode = 'guest';
  S.code = clean; S.host = where.host; S.port = where.port;
  S.id = myId(); S.v = d.v || 0;
  S.members = d.members || []; S.state = d.state || null; S.hostName = d.host?.name || '';
  notify();
  applyRemote();
  pollLoop();
  return d;
}

export async function leaveSession(reason) {
  if (S.mode === 'none') return;
  const mode = S.mode;
  const code = S.code, token = S.token, id = S.id, host = S.host, port = S.port;
  S.mode = 'none';
  try {
    if (mode === 'host') await post('/api/room/close', { code, token });
    else await post(`http://${host}:${port || 4000}/api/room/leave`, { code, id });
  } catch { /* the host's machine may already be gone */ }
  S.code = ''; S.token = ''; S.link = ''; S.state = null; S.members = []; S.v = 0;
  notify();
  if (reason) toast(reason);
}

/* ---------- the loop ---------- */

let polling = false;

/** Read the room until it ends. The server holds the answer until it changes. */
async function pollLoop() {
  if (polling) return; // one reader per session
  polling = true;
  try {
    while (S.mode !== 'none') {
      const code = S.code;
      const url = S.mode === 'host'
        ? `/api/room/state?code=${code}&since=${S.v}`
        : `${hostBase()}/api/room/state?code=${code}&since=${S.v}&id=${S.id}`;
      try {
        const r = await fetch(url);
        if (r.status === 404) {
          if (S.code !== code) continue; // the session changed under us: read the new one
          const was = S.mode;
          S.mode = 'none'; S.code = ''; S.state = null; S.members = [];
          notify();
          if (was === 'guest') toast('The session ended.');
          break;
        }
        const d = await r.json();
        S.v = d.v || S.v;
        S.members = d.members || [];
        S.hostName = d.host?.name || S.hostName;
        if (d.state) S.state = d.state;
        notify();
        if (S.mode === 'guest') applyRemote();
      } catch {
        await sleep(2000); // the host's machine is out of reach — keep trying
        continue;
      }
      await sleep(400);
    }
  } finally {
    polling = false;
  }
}

/** Follow the host: on their player if there is one, otherwise go where they are. */
function applyRemote() {
  const s = S.state;
  if (!s) return;
  if (S.remote) { S.remote(s); return; }
  if (!s.animeId) return;
  const url = roomUrl(s);
  // Already on the host's page: that page picks the state up when it is
  // ready. Navigating again would throw the page away and start it over.
  if (location.pathname === url.split('?')[0]) return;
  dispatchEvent(new CustomEvent('koma:room-goto', { detail: url }));
}

/** Wait until the host says where they are (or the wait runs out). */
export function waitForState(ms = 5000) {
  if (S.state?.animeId) return Promise.resolve(S.state);
  return new Promise(resolve => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (S.state?.animeId || Date.now() - started > ms) { clearInterval(timer); resolve(S.state); }
    }, 150);
  });
}

export const roomUrl = s => `/watch/${s.animeId}?ep=${s.ep}${s.type === 'dub' ? '&type=dub' : ''}`;

/* ---------- the watch page's side ---------- */

/**
 * Hand the room the watch page's player. `playhead` says what we are doing,
 * `remote` applies what the host is doing.
 */
export function initRoom({ playhead, remote }) {
  S.playhead = playhead;
  S.remote = remote;
  return () => { if (S.playhead === playhead) { S.playhead = null; S.remote = null; } };
}

// While the host is playing, the playhead is republished every couple of
// seconds: that is what keeps a viewer's clock from drifting.
setInterval(() => {
  if (S.mode === 'host' && S.playhead?.()?.playing) publish();
}, 2000);

/* ---------- the dialog ---------- */

let dlg = null;
let tab = 'host';

function paint() {
  if (!dlg) return;
  for (const p of $$('[data-room-pane]', dlg)) p.hidden = p.dataset.roomPane !== tab;
  for (const b of $$('[data-room-tab]', dlg)) b.setAttribute('aria-selected', String(b.dataset.roomTab === tab));

  const hostLive = $('[data-room-live="host"]', dlg);
  const joinLive = $('[data-room-live="join"]', dlg);
  if (hostLive) hostLive.hidden = S.mode !== 'host';
  if (joinLive) joinLive.hidden = S.mode !== 'guest';
  const createBtn = $('[data-room-create]', dlg);
  const joinBtn = $('[data-room-join]', dlg);
  if (createBtn) createBtn.hidden = S.mode === 'host';
  if (joinBtn) joinBtn.hidden = S.mode === 'guest';

  for (const el of $$('[data-room-code]', dlg)) el.textContent = S.code || '------';
  for (const el of $$('[data-room-link]', dlg)) el.textContent = S.mode === 'host' ? (S.link || '') : '';

  const n = S.members.length;
  for (const el of $$('[data-room-members-label]', dlg)) {
    el.textContent = S.mode === 'host'
      ? (n ? `${n} ${n === 1 ? 'person is' : 'people are'} watching` : 'Nobody has joined yet')
      : (S.hostName ? `Following ${S.hostName}` : 'Following the host');
  }
  for (const el of $$('[data-room-members]', dlg)) {
    el.innerHTML = S.members.map(m => `<li><b>${esc(m.name)}</b></li>`).join('');
    el.hidden = !S.members.length;
  }
}

export function openRoomDialog() {
  dlg = dlg || $('#room');
  if (!dlg) return;
  tab = S.mode === 'guest' ? 'join' : 'host';
  paint();
  dlg.showModal();
}

/** Wire the dialog once, at startup. */
export function initRoomUI() {
  dlg = $('#room');
  if (!dlg) return;
  dlg.addEventListener('click', async e => {
    if (e.target.closest('[data-room-close]')) { dlg.close(); return; }
    const t = e.target.closest('[data-room-tab]');
    if (t) { tab = t.dataset.roomTab; paint(); return; }

    if (e.target.closest('[data-room-create]')) {
      try { await createSession(); paint(); }
      catch (err) { toast(err.message); }
      return;
    }
    if (e.target.closest('[data-room-join]')) {
      const input = $('[data-room-input]', dlg);
      const err = $('[data-room-err]', dlg);
      try {
        await joinSession({ code: input.value });
        paint();
      } catch (ex) {
        if (err) { err.textContent = ex.message; err.hidden = false; }
      }
      return;
    }
    if (e.target.closest('[data-room-copy]')) {
      const link = S.link || `${location.origin}/join/${S.code}`;
      navigator.clipboard?.writeText(link).then(() => toast('Invite copied')).catch(() => toast(link));
      return;
    }
    if (e.target.closest('[data-room-end]')) { await leaveSession('Session ended'); paint(); return; }
    if (e.target.closest('[data-room-leave]')) { await leaveSession('You left the session'); paint(); return; }
  });
  dlg.addEventListener('close', () => { const input = $('[data-room-input]', dlg); if (input) input.value = ''; });
  subscribe(paint);
}
