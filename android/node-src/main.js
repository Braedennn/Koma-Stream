// Koma on Android: the starter that Node runs inside the app.
//
// Koma's site and API are served by the native Rust executable. Node remains
// only for the separate AniVault streaming API, which Koma reaches over the
// loopback.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
process.chdir(root);

// The phone app and the television app can be installed side by side, and
// then they both want a streaming port. The first free one wins.
const free = port => new Promise(done => {
  const probe = createServer();
  probe.once('error', () => done(false));
  probe.once('listening', () => probe.close(() => done(true)));
  probe.listen(port, '127.0.0.1');
});

let api = 0;
for (let i = 0; i < 20; i++) {
  const candidate = 4181 + i * 10;
  if (await free(candidate)) {
    api = candidate;
    break;
  }
}
if (!api) throw new Error('no free AniVault port at or above 4181');

process.env.PORT = String(api);
process.env.HOST = '127.0.0.1';
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

// Only the streaming sidecar runs under Node. The native Koma server is a
// separate process started by the Android app.
await import('./anivault/dist/server.js');

try {
  // The app reads this file to tell the native server where AniVault lives.
  writeFileSync(join(root, '..', 'koma-anivault.port'), String(api));
} catch (err) {
  console.error('could not write the anivault port', err);
}
