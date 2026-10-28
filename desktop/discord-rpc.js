// Discord Rich Presence over Discord's local IPC pipe.
// The wire format is tiny — [opcode u32][length u32][JSON] over a Windows named
// pipe — so this needs no native module and the packaged app ships without
// extra dependencies.
const net = require('node:net');
const { EventEmitter } = require('node:events');

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };
// Discord (each flavour) listens on 10 pipes per install, numbered 0…9.
const PREFIXES = ['\\\\.\\pipe\\discord-ipc-', '\\\\.\\pipe\\discord-canary-ipc-', '\\\\.\\pipe\\discord-ptb-ipc-'];
const PIPES_EACH = 10;
const HANDSHAKE_TIMEOUT = 6000;          // ms to wait for Discord to answer our handshake
const CONNECT_TIMEOUT = 1500;            // ms per pipe before moving on
const HELLO_FALLBACK = 30000;           // ms heartbeat if Discord never sends HELLO
const RETRY_MIN = 5000;
const RETRY_MAX = 60000;

/** Discord's activity fields are length-limited; trim before they go out. */
const clip = (v, max) => String(v ?? '').slice(0, max);

/** Asset keys take either an uploaded asset name (≤128 chars) or a plain https URL,
 *  which Discord downloads itself — URLs have no length limit and must not pass
 *  through the clip, or long cover URLs get truncated and never resolve. */
const imgKey = v => (/^https?:\/\//.test(String(v ?? '')) ? String(v) : clip(v, 128));

class DiscordRpc extends EventEmitter {
  constructor({ clientId, pipePrefixes = PREFIXES, pipes = PIPES_EACH } = {}) {
    super();
    this.clientId = String(clientId || '').trim();
    // Flat pipe order: all of the stable install's pipes, then Canary's, then PTB's.
    this.targets = pipePrefixes.flatMap(p => Array.from({ length: pipes }, (_, i) => `${p}${i}`));
    this.socket = null;
    this.buf = Buffer.alloc(0);
    this.ready = false;
    this.stopped = false;
    this.heartbeat = HELLO_FALLBACK;
    this.beatTimer = null;
    this.hsTimer = null;
    this.retry = 0;
    this.retryTimer = null;
    this.lastError = '';
    this.activity = null;               // last activity we were asked to show
  }

  get connected() { return this.ready; }

  /** Open the pipe and shake hands. Safe to call twice. */
  connect() {
    this.stopped = false;
    if (!this.clientId || this.socket) return;
    this.openPipe(0);
  }

  /** Close the pipe and stop retrying. */
  close() {
    this.stopped = true;
    this.clearTimers();
    this.dropSocket();
    this.ready = false;
  }

  /** Show an activity (or null to clear it). Safe before the pipe is ready:
   *  the activity is remembered and sent as soon as Discord says READY. */
  setActivity(activity) {
    this.activity = activity || null;
    if (!this.ready) return;
    this.sendActivity(this.activity);
  }

  clearTimers() {
    if (this.beatTimer) { clearInterval(this.beatTimer); this.beatTimer = null; }
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
  }

  dropSocket() {
    const s = this.socket;
    if (this.hsTimer) { clearTimeout(this.hsTimer); this.hsTimer = null; }
    this.socket = null;
    if (!s) return;
    try { s.destroy(); } catch { /* already gone */ }
  }

  openPipe(index) {
    if (this.stopped || this.socket) return;
    if (index >= this.targets.length) { this.scheduleRetry(); return; }
    const path = this.targets[index];
    const socket = net.createConnection({ path, allowHalfOpen: false });
    let settled = false;

    const giveUp = () => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* already gone */ }
      this.openPipe(index + 1);
    };
    socket.setTimeout(CONNECT_TIMEOUT, giveUp);
    socket.once('error', giveUp);
    socket.once('connect', () => {
      if (settled) return;
      settled = true;
      socket.setTimeout(0);
      socket.removeListener('error', giveUp);
      this.socket = socket;
      this.buf = Buffer.alloc(0);
      this.ready = false;
      this.retry = 0;
      // A pipe that accepts but never answers must not sit here forever.
      this.hsTimer = setTimeout(() => {
        if (this.socket && !this.ready) this.onGone('no handshake reply');
      }, HANDSHAKE_TIMEOUT);
      socket.on('data', chunk => this.onData(chunk));
      socket.on('error', err => this.onGone(err.message));
      socket.on('close', () => this.onGone(''));
      this.send(OP.HANDSHAKE, { v: 1, client_id: this.clientId });
    });
  }

  onGone(reason) {
    if (!this.socket) return;
    this.dropSocket();
    this.ready = false;
    if (this.beatTimer) { clearInterval(this.beatTimer); this.beatTimer = null; }
    if (reason) this.lastError = reason;
    this.emit('disconnected', reason);
    if (!this.stopped) this.scheduleRetry();
  }

  scheduleRetry() {
    if (this.stopped || this.retryTimer) return;
    const wait = Math.min(RETRY_MAX, RETRY_MIN * 2 ** this.retry);
    this.retry++;
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.openPipe(0); }, wait);
  }

  onData(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    for (;;) {
      if (this.buf.length < 8) return;
      const op = this.buf.readUInt32LE(0);
      const len = this.buf.readUInt32LE(4);
      if (len > 1 << 20) { this.onGone('bad frame length'); return; } // 1 MiB is way past any Discord frame
      if (this.buf.length < 8 + len) return;
      const payload = this.buf.subarray(8, 8 + len);
      this.buf = this.buf.subarray(8 + len);
      this.onFrame(op, payload);
    }
  }

  onFrame(op, payload) {
    if (op === OP.CLOSE) {
      let code = 0, message = '';
      try { const j = JSON.parse(payload.toString('utf8')); code = j.code; message = j.message; } catch { /* not json */ }
      this.lastError = message || `Discord closed the connection (code ${code})`;
      this.emit('error', this.lastError);
      this.onGone('');
      return;
    }
    if (op === OP.PING) { this.send(OP.PONG, payload); return; } // Discord asks, we answer
    if (op === OP.PONG) return;

    let msg;
    try { msg = JSON.parse(payload.toString('utf8')); } catch { return; }
    const evt = msg?.evt;
    const data = msg?.data;

    if (evt === 'HELLO') {
      const interval = Number(data?.heartbeat_interval);
      this.heartbeat = Number.isFinite(interval) && interval > 0 ? interval : HELLO_FALLBACK;
      this.startHeartbeat();
      return;
    }
    if (evt === 'READY') {
      if (this.hsTimer) { clearTimeout(this.hsTimer); this.hsTimer = null; }
      this.ready = true;
      this.lastError = '';
      this.emit('ready', data);
      if (this.activity) this.sendActivity(this.activity); // show what the page asked for
      return;
    }
    if (evt === 'PING') { this.send(OP.FRAME, { cmd: 'DISPATCH', evt: 'PONG', nonce: msg.nonce }); return; }
    if (evt === 'PONG') return;
    if (evt === 'ERROR') {
      this.lastError = String(data?.message || 'Discord rejected the request');
      this.emit('error', this.lastError);
      return;
    }
    if (msg?.cmd === 'SET_ACTIVITY' && evt === 'SET_ACTIVITY') this.emit('activity', data);
  }

  startHeartbeat() {
    if (this.beatTimer) clearInterval(this.beatTimer);
    this.beatTimer = setInterval(() => {
      if (!this.socket) return;
      // Both forms are part of the protocol: the frame-level PING and the
      // dispatch PING. Sending one keeps the connection alive on every
      // Discord build we have seen.
      this.send(OP.PING, Buffer.alloc(0));
      this.send(OP.FRAME, { cmd: 'DISPATCH', evt: 'PING' });
    }, this.heartbeat);
  }

  sendActivity(activity) {
    const payload = {
      cmd: 'SET_ACTIVITY',
      args: { pid: process.pid, activity },
      nonce: `${Date.now()}`,
    };
    this.send(OP.FRAME, payload);
  }

  send(op, data) {
    if (!this.socket || this.socket.destroyed) return;
    const body = Buffer.isBuffer(data) ? data : Buffer.from(JSON.stringify(data), 'utf8');
    const head = Buffer.alloc(8);
    head.writeUInt32LE(op, 0);
    head.writeUInt32LE(body.length, 4);
    try { this.socket.write(Buffer.concat([head, body])); }
    catch (err) { this.onGone(err.message); }
  }
}

/** Shape an activity the way Discord expects, trimming every field to its limit. */
function buildActivity({ details, state, image, largeImage, largeText, smallImage, smallText, startTimestamp, endTimestamp, buttons }) {
  const activity = {
    details: clip(details, 128),
    state: clip(state, 128),
    timestamps: {},
  };
  if (startTimestamp) activity.timestamps.start = Math.floor(startTimestamp / 1000);
  if (endTimestamp) activity.timestamps.end = Math.floor(endTimestamp / 1000);
  if (!Object.keys(activity.timestamps).length) delete activity.timestamps;

  const assets = {};
  if (largeImage) assets.large_image = imgKey(largeImage);
  if (largeText) assets.large_text = clip(largeText, 128);
  if (smallImage) assets.small_image = imgKey(smallImage);
  if (smallText) assets.small_text = clip(smallText, 128);
  if (Object.keys(assets).length) activity.assets = assets;

  if (buttons) {
    const bs = buttons
      .filter(b => b?.label && /^https?:\/\/./.test(b?.url))
      .slice(0, 2)
      .map(b => ({ label: clip(b.label, 32), url: clip(b.url, 512) }));
    if (bs.length) activity.buttons = bs;
  }

  if (image) activity.image = imgKey(image); // small_image alias used by some builds
  if (!activity.details && !activity.state) return null;
  return activity;
}

module.exports = { DiscordRpc, buildActivity };
