// Watch together: one host, one playhead, several viewers.
//
// The host's server owns the room. It holds the playhead (what is playing,
// where, paused or not) and the roster. Viewers poll for it and apply it to
// their own player — each side keeps streaming through its own local server,
// so the host never carries anyone else's video.
//
// Rooms are found by a short code. On the same network the host's server
// broadcasts that code over UDP, so a viewer who types it finds the host
// without having to be told an address; a join link carries the address for
// the cases where UDP does not get through.
import dgram from 'node:dgram';
import http from 'node:http';
import { networkInterfaces } from 'node:os';

const PORT = Number(process.env.PORT) || 4000;
const BEACON_PORT = Number(process.env.KOMA_BEACON_PORT) || 41234;
const BEACON_GROUP = '239.255.42.99';
const CODE_TTL = 30 * 60e3;   // a room nobody has touched for half an hour is gone
const MEMBER_TTL = 90e3;      // a viewer that stopped polling has left
const POLL_WAIT = 20e3;       // how long a state poll waits for a change
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0, no I/1

/* ---------- rooms ---------- */

const rooms = new Map();   // code -> room
const found = new Map();   // code -> { host, port, name, at } (heard over the beacon)

const rand = n => {
  let s = '';
  for (let i = 0; i < n; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
};

const newCode = () => {
  let code;
  do { code = rand(6); } while (rooms.has(code));
  return code;
};

/* ---------- the addresses other people can reach ---------- */

// Virtual adapters, VPN taps and carrier-grade NAT addresses are not the
// network your friends are on: a session invite has to carry the address of
// the Wi-Fi or the cable, not the address of a virtual machine.
const VIRTUAL = /tailscale|zerotier|virtualbox|vmware|vethernet|hyper-v|loopback|wsl|docker|vpn|openvpn|wireguard|wintun/i;
const VIRTUAL_MAC = /^(0a:00:27|00:0c:29|00:50:56|00:1c:42|00:15:5d|00:16:3e|02:00:00)/i;
const isPrivate = ip => /^10\./.test(ip)
  || /^192\.168\./.test(ip)
  || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);

/** Every address this machine has on a network people can actually reach us on. */
export function lanAddresses() {
  const out = [];
  for (const [name, list] of Object.entries(networkInterfaces())) {
    if (VIRTUAL.test(name)) continue;
    for (const ni of list || []) {
      if (ni.family !== 'IPv4' || ni.internal) continue;
      if (ni.mac && VIRTUAL_MAC.test(ni.mac)) continue;
      if (!isPrivate(ni.address)) continue;
      out.push(ni.address);
    }
  }
  if (out.length) return out;
  // Nothing private: fall back to anything that isn't loopback.
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) return [ni.address];
    }
  }
  return ['127.0.0.1'];
}

/** This machine's address on the local network — what a viewer has to reach. */
export function lanAddress() {
  return lanAddresses()[0];
}

/** The subnet's broadcast address, for the beacons that routers pass on. */
function subnetBroadcast(ip) {
  const p = ip.split('.');
  if (p.length !== 4) return '255.255.255.255';
  return `${p[0]}.${p[1]}.${p[2]}.255`;
}

export function joinUrl(code) {
  return `http://${lanAddress()}:${PORT}/join/${code}`;
}

function createRoom(name) {
  const code = newCode();
  const room = {
    code,
    host: { token: rand(24), name: name || 'Host', at: Date.now() },
    state: null,
    v: 1,
    members: new Map(),   // id -> { id, name, joinedAt, seen }
    waiters: new Set(),   // long polls waiting for a newer version
    touched: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

function roomOf(code) {
  const room = rooms.get(String(code || '').toUpperCase());
  if (!room) return null;
  if (Date.now() - room.touched > CODE_TTL) { closeRoom(room); return null; }
  room.touched = Date.now();
  sweepMembers(room);
  return room;
}

/** A viewer that stopped polling has left: drop it from the roster. */
function sweepMembers(room) {
  const now = Date.now();
  for (const [id, m] of room.members) {
    if (now - (m.seen || m.joinedAt) > MEMBER_TTL) room.members.delete(id);
  }
}

function closeRoom(room) {
  for (const w of room.waiters) { try { w(null); } catch { /* gone */ } }
  room.waiters.clear();
  rooms.delete(room.code);
  if (!rooms.size) closeLanDoor(); // nobody is watching any more: shut the door
}

function publicRoom(room) {
  return {
    v: room.v,
    code: room.code,
    host: { name: room.host.name },
    state: room.state,
    members: [...room.members.values()].map(m => ({ id: m.id, name: m.name, joinedAt: m.joinedAt })),
  };
}

/* ---------- the LAN beacon ---------- */

let sock = null;

/**
 * The host says "there is a session with this code" every couple of seconds,
 * so a viewer who starts later still finds it.
 *
 * It goes out three ways: as multicast (which most networks pass, and which
 * comes back to this machine so a single-box test works), as a subnet
 * broadcast (for networks that drop multicast) and as the limited broadcast
 * (last resort). Each network this machine is on gets its own multicast
 * interface, so the packet leaves through the Wi-Fi and not through a virtual
 * adapter.
 */
function beaconSocket() {
  if (sock) return sock;
  sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
  sock.on('message', (msg, rinfo) => {
    try {
      const d = JSON.parse(msg.toString());
      if (d?.k !== 'koma-room') return;
      const list = Array.isArray(d.rooms) ? d.rooms : (d.code ? [{ code: d.code, name: d.name }] : []);
      for (const r of list) {
        if (!r?.code) continue;
        // The sender says which addresses it answers on. That is better than
        // the address the packet came from: a packet can leave through one
        // network and be heard on another, and the address the door is on is
        // the one a viewer must use.
        found.set(String(r.code).toUpperCase(), {
          host: d.addr || rinfo.address,
          addrs: Array.isArray(d.addrs) ? d.addrs : [],
          port: d.port || PORT, name: r.name || '', at: Date.now(),
        });
      }
    } catch { /* not ours */ }
  });
  sock.on('error', err => { console.warn(`room: beacon socket (${err.message})`); sock = null; });
  try {
    sock.bind(BEACON_PORT, () => {
      try { sock.setBroadcast(true); } catch { /* no broadcast */ }
      try { sock.addMembership(BEACON_GROUP); sock.setMulticastLoopback(true); } catch { /* no multicast */ }
    });
  } catch (err) {
    console.warn(`room: cannot listen for sessions (${err.message})`);
    sock = null;
  }
  return sock;
}

setInterval(() => {
  const s = sock;
  if (!s || !rooms.size) return;
  const payload = Buffer.from(JSON.stringify({
    k: 'koma-room', port: PORT,
    addr: lanAddress(), addrs: lanAddresses(),
    rooms: [...rooms.values()].map(r => ({ code: r.code, name: r.host.name })),
  }));
  const warn = err => { if (err) console.warn(`room: beacon (${err.message})`); };
  for (const ip of lanAddresses()) {
    // Multicast, out through this network — this is what a viewer on the
    // Wi-Fi hears.
    try { s.setMulticastInterface(ip); } catch { /* keep the default */ }
    s.send(payload, BEACON_PORT, BEACON_GROUP, warn);
    // And once without a pinned interface, so this machine hears its own
    // sessions even when the packet would leave through another network.
    try { s.setMulticastInterface('0.0.0.0'); } catch { /* keep the default */ }
    s.send(payload, BEACON_PORT, BEACON_GROUP, warn);
    // The subnet's own broadcast, for networks that drop multicast.
    s.send(payload, BEACON_PORT, subnetBroadcast(ip), warn);
  }
  // And the limited broadcast, for the odd network that wants it.
  s.send(payload, BEACON_PORT, '255.255.255.255', warn);
}, 2000).unref?.();

/** Wait a moment for a beacon to say where this code lives. */
function waitForBeacon(code, ms = 4000) {
  const key = String(code || '').toUpperCase();
  const hit = found.get(key);
  if (hit && Date.now() - hit.at < 15000) return Promise.resolve(hit);
  return new Promise(resolve => {
    const started = Date.now();
    const timer = setInterval(() => {
      const h = found.get(key);
      if (h && Date.now() - h.at < 15000) { clearInterval(timer); resolve(h); return; }
      if (Date.now() - started > ms) { clearInterval(timer); resolve(null); }
    }, 150);
  });
}

/* ---------- the network door ---------- */
//
// Koma's own server listens on the loopback: nobody on the network can open
// the app's pages. A session needs a way in, so while a session is open a
// second door opens on the network address — and only for the session: the
// room's API and the invite page. When the session ends, the door closes and
// the machine is private again.

let lanHandler = null;
let lanServers = [];

/** The handler that answers on the network door (set by the server). */
export function setLanHandler(fn) { lanHandler = fn; }

/** Open the door on every address other people can reach us on. */
export function openLanDoor(port = PORT) {
  if (lanServers.length || !lanHandler) return;
  for (const addr of lanAddresses()) {
    if (addr === '127.0.0.1') continue;
    const s = http.createServer((req, res) => lanHandler(req, res));
    s.on('error', err => console.warn(`room: the network door on ${addr} (${err.message})`));
    s.listen(port, addr, () => console.log(`Watch together: friends can join at http://${addr}:${port}`));
    lanServers.push(s);
  }
}

/** Close the door again: the session is over, the machine is private. */
export function closeLanDoor() {
  for (const s of lanServers) { try { s.close(); } catch { /* already gone */ } }
  lanServers = [];
}

export function lanDoorOpen() {
  return lanServers.length > 0;
}

/* ---------- the endpoints ---------- */

function json(res, status, body) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(buf);
}

function readBody(req) {
  return new Promise(resolve => {
    let raw = '';
    req.on('data', c => {
      raw += c;
      if (raw.length > 64 * 1024) { req.destroy(); resolve({}); }
    });
    req.on('end', () => { try { resolve(JSON.parse(raw || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

/** Create a room, join one, publish the playhead, or read it. */
export async function handleRoom(req, res, path, url, { lan = false } = {}) {
  const action = path.slice('/api/room/'.length);
  const body = req.method === 'POST' ? await readBody(req) : {};
  const code = String(body.code || url.searchParams.get('code') || '').toUpperCase();

  if (action === 'create') {
    const room = createRoom(body.name);
    beaconSocket();
    openLanDoor(PORT);
    return json(res, 200, { code: room.code, token: room.host.token, name: room.host.name, url: joinUrl(room.code), port: PORT });
  }

  if (action === 'join') {
    const room = roomOf(code);
    if (!room) return json(res, 404, { error: 'No session with that code.', found: false });
    const id = String(body.id || rand(8));
    const member = room.members.get(id) || { id, name: body.name || 'Viewer', joinedAt: Date.now() };
    if (body.name) member.name = body.name;
    member.seen = Date.now();
    room.members.set(id, member);
    room.touched = Date.now();
    return json(res, 200, publicRoom(room));
  }

  if (action === 'leave') {
    const room = roomOf(code);
    if (room) room.members.delete(String(body.id || ''));
    return json(res, 200, { ok: true });
  }

  if (action === 'state' && req.method === 'POST') {
    const room = roomOf(code);
    if (!room) return json(res, 404, { error: 'No session with that code.' });
    if (body.token !== room.host.token) return json(res, 403, { error: 'Only the host publishes the playhead.' });
    room.state = body.state || null;
    room.v++;
    room.touched = Date.now();
    for (const w of [...room.waiters]) w(room);
    room.waiters.clear();
    return json(res, 200, { ok: true, v: room.v });
  }

  if (action === 'state') {
    const room = roomOf(code);
    if (!room) return json(res, 404, { error: 'No session with that code.', found: false });
    const since = Number(url.searchParams.get('since')) || 0;
    const id = String(url.searchParams.get('id') || '');
    if (id) { const m = room.members.get(id); if (m) m.seen = Date.now(); }
    if (room.v > since) return json(res, 200, publicRoom(room));
    // Nothing new yet: hold the answer until the host moves on.
    await new Promise(resolve => {
      const timer = setTimeout(() => { room.waiters.delete(wait); resolve(); }, POLL_WAIT);
      const wait = room => { clearTimeout(timer); resolve(room); };
      room.waiters.add(wait);
    });
    if (!rooms.has(room.code)) return json(res, 404, { error: 'The session ended.', found: false });
    return json(res, 200, publicRoom(room));
  }

  if (action === 'discover') {
    // The session may be right here: the same machine runs the host's server.
    const local = rooms.get(code);
    if (local) {
      return json(res, 200, { found: true, code, host: lanAddress(), port: PORT, addrs: lanAddresses(), name: local.host.name, here: true });
    }
    const hit = await waitForBeacon(code);
    if (!hit) return json(res, 200, { found: false, code });
    return json(res, 200, { found: true, code, host: hit.host, port: hit.port, addrs: hit.addrs || [], name: hit.name });
  }

  if (action === 'close') {
    const room = roomOf(code);
    if (!room) return json(res, 200, { ok: true });
    if (body.token !== room.host.token) return json(res, 403, { error: 'Only the host ends the session.' });
    closeRoom(room);
    return json(res, 200, { ok: true });
  }

  if (action === 'rooms') {
    // The list of live sessions is for this machine only: on the network the
    // code is the secret, and a list would hand it over.
    if (lan) return json(res, 404, { error: 'No such room endpoint.' });
    return json(res, 200, { rooms: [...rooms.values()].map(r => ({ code: r.code, name: r.host.name, members: r.members.size })) });
  }

  return json(res, 404, { error: 'No such room endpoint.' });
}

export function roomInfo() {
  return { rooms: rooms.size, beacon: BEACON_PORT, lan: lanAddress(), addresses: lanAddresses() };
}
