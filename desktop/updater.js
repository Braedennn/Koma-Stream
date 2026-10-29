// Self-updating for packaged builds: sweep old installers, stream a new release's
// installer down in the background, and then ASK — the installer only ever runs when
// the user clicks "Update now" in the app. Knows nothing about Electron: test and
// caller feed the paths and hooks in, so the whole flow can be driven in a test.
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { Readable } = require('node:stream');

/** 1.0.10 > 1.0.9, 1.1 > 1.0.9 — dotted numeric compare, missing parts count as 0. */
function newerVersion(a, b) {
  const pa = String(a).split('.').map(Number), pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d > 0;
  }
  return false;
}

/** Delete our leftover installers and partial downloads. Files the installer is running
 *  from are locked and simply survive for a later session's sweep. */
function sweep(dir) {
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!/^(Koma-Setup.*\.exe|Koma-Setup.*\.part)$/i.test(f)) continue;
      try { fs.unlinkSync(path.join(dir, f)); } catch { /* still running or being copied */ }
    }
  } catch { /* dir missing: nothing to sweep */ }
}

/** Stream the installer to dir as Koma-Setup.exe.part, reporting 0-100 progress, then
 *  rename it into place. Resolves with the path it can be run from, rejects with the
 *  network/disk error otherwise. */
async function download(url, { dir, log, onPct = () => {} }) {
  fs.mkdirSync(dir, { recursive: true });
  const part = path.join(dir, 'Koma-Setup.exe.part');
  const dest = path.join(dir, 'Koma-Setup.exe');
  const dropPart = () => { try { fs.unlinkSync(part); } catch { /* fine */ } };
  try {
    const r = await fetch(url, { headers: { 'User-Agent': 'Koma-Desktop' } });
    if (!r.ok) throw new Error(`download failed: HTTP ${r.status}`);
    const total = Number(r.headers.get('content-length')) || 0;
    const source = Readable.fromWeb(r.body); // undici hands back a web stream; plain .on('data') needs a Node stream
    await new Promise((res, rej) => {
      const out = fs.createWriteStream(part);
      let got = 0, last = -1;
      source.on('data', chunk => {
        got += chunk.length;
        if (total) {
          const pct = Math.floor(got / total * 100);
          if (pct > last) { last = pct; onPct(pct); }
        }
        out.write(chunk);
      });
      source.on('end', () => out.end());
      source.on('error', rej);
      out.on('error', rej);
      out.on('finish', res);
    });
    // A previous installer still held the dest would make the rename bounce; retry a bit.
    let placed = false;
    for (let i = 0; i < 5 && !placed; i++) {
      try { fs.renameSync(part, dest); placed = true; }
      catch { await new Promise(r => setTimeout(r, 500)); }
    }
    if (!placed) {
      log('rename kept bouncing — using the part file as the installer');
      dropAll(dest); // best effort: the part IS a complete file, so just run it there
      return part;
    }
    log(`downloaded ${Math.round(fs.statSync(dest).size / 1048576)} MB`);
    return dest;
  } catch (err) {
    dropPart();
    throw err;
  }
}

const dropAll = p => { try { fs.unlinkSync(p); } catch { /* fine */ } };

/** Hand over: open the installer and leave the stage AT ONCE. The installer
 *  overwrites the very files this app is running from, so anything still open when
 *  it starts copying is what makes an update die halfway. Deliberately dumb and
 *  separate from download: nothing here runs until the user's explicit "Update now"
 *  click. */
function install(exePath, { quitAfter, spawnImpl, log = () => {} }) {
  log('opening the installer…');
  const sp = spawnImpl || ((cmd, args, opts) => cp.spawn(cmd, args, opts));
  sp(exePath, [], { detached: true, stdio: 'ignore' }).unref();
  if (quitAfter) setImmediate(quitAfter); // the app goes now — not in a couple of seconds
  return exePath;
}

module.exports = { newerVersion, sweep, download, install };
