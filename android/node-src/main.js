// Koma on Android: the starter that Node runs inside the app.
//
// One Node runtime hosts both servers, exactly as the desktop shell does with
// two processes: Koma's own server (what the WebView loads) and the AniVault
// streaming API (what Koma proxies to over the loopback).
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
process.chdir(root);

// The phone app and the television app can be installed side by side, and
// then they both want the same ports. The first free pair wins: the site
// takes one and the streaming API the next. The app is told which one the
// site got, so it loads the site this app actually started.
const free = port => new Promise(done => {
  const probe = createServer();
  probe.once('error', () => done(false));
  probe.once('listening', () => probe.close(() => done(true)));
  probe.listen(port, '127.0.0.1');
});

let site = 4180;
let api = 4181;
for (let i = 0; i < 20; i++) {
  if (await free(site) && await free(api)) break;
  site += 10;
  api += 10;
}

// The servers read their ports and the API key from the environment, so they
// are set before either module is imported.
process.env.PORT = String(site);
process.env.HOST = '127.0.0.1';
process.env.KOMA_ANIVAULT_URL = `http://127.0.0.1:${api}`;
try {
  // The app looks for this file to find the site.
  writeFileSync(join(root, '..', 'koma-site.port'), String(site));
} catch (err) {
  console.error('could not write the site port', err);
}
try {
  const env = readFileSync(join(root, 'anivault.env'), 'utf8');
  // Two names for the same key: Koma presents it (KOMA_ANIVAULT_KEY), and the
  // streaming API checks it (ANIVAULT_API_KEY - its dotenv looks for a .env
  // file, which the APK cannot carry, so the value is set here directly).
  process.env.KOMA_ANIVAULT_KEY = env.match(/^ANIVAULT_API_KEY=(.+)$/m)?.[1]?.trim() || '';
  process.env.ANIVAULT_API_KEY = process.env.KOMA_ANIVAULT_KEY;
  process.env.KOMA_DATA_DIR = join(root, '..', 'data');
  mkdirSync(process.env.KOMA_DATA_DIR, { recursive: true });
} catch { /* the key file ships with the app; a missing one fails loudly later */ }

// Koma first: the WebView is waiting for it.
await import('./koma/server.js');

// The streaming server reads PORT at import time, so it is changed here.
process.env.PORT = String(api);
await import('./anivault/dist/server.js');
