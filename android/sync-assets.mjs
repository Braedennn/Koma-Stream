// Assembles the Node project that ships inside the APK, and the asset copy
// lists the runtime reads at first launch.
//
//   node sync-assets.mjs
//
// Layout produced under app/src/main/assets/:
//   nodejs-project/
//     main.js, package.json, .env        <- from android/node-src + the key
//     koma/server.js, koma/server/**, koma/public/**   <- the site + its API
//     anivault/dist/**, anivault/node_modules/**       <- the streaming API
//   builtin_modules/                     <- already in place
//   dir.list, file.list                  <- one line per dir/file, nodejs-project relative
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const assets = join(here, 'app', 'src', 'main', 'assets');
const project = join(assets, 'nodejs-project');

// The last packaged build already carries a pruned production tree for
// AniVault; using it avoids a second npm install.
const packagedAnivault = join(repo, 'desktop', 'dist', 'Koma-win32-x64', 'resources', 'anivault');
const sourceAnivault = join(repo, 'Servers - DONT TOUCH', 'anivault-scraper');
const anivaultDist = existsSync(join(packagedAnivault, 'dist')) ? packagedAnivault : sourceAnivault;

console.log(`anivault from: ${anivaultDist === packagedAnivault ? 'the packaged build' : 'the source tree'}`);

rmSync(project, { recursive: true, force: true });
mkdirSync(project, { recursive: true });

// The starter and its package marker.
cpSync(join(here, 'node-src', 'main.js'), join(project, 'main.js'));
cpSync(join(here, 'node-src', 'package.json'), join(project, 'package.json'));

// The key travels as a plain file (aapt2 drops dotfiles from assets, so it
// cannot be called ".env") — the same key the desktop install carries.
const key = readFileSync(join(sourceAnivault, '.env'), 'utf8').match(/^ANIVAULT_API_KEY=(.+)$/m)?.[1]?.trim();
if (!key) { console.error('No ANIVAULT_API_KEY found in the anivault .env'); process.exit(1); }
writeFileSync(join(project, 'anivault.env'), `ANIVAULT_API_KEY=${key}\nNODE_ENV=production\n`);

// Koma: the server, the API, and the site it serves.
mkdirSync(join(project, 'koma'));
cpSync(join(repo, 'server.js'), join(project, 'koma', 'server.js'));
cpSync(join(repo, 'server'), join(project, 'koma', 'server'), { recursive: true });
cpSync(join(repo, 'public'), join(project, 'koma', 'public'), { recursive: true });

// Koma's OAuth applications are private build configuration, not source.
const oauthConfig = join(repo, '.data', 'auth', 'oauth.json');
if (existsSync(oauthConfig)) cpSync(oauthConfig, join(project, 'koma', 'auth.json'));

// The language filters need the catalogue data. The desktop app keeps it in
// .data, but Android has no AllAnime server of its own, so the latest known
// index and counts travel with the APK under ordinary (non-hidden) names.
const bundledData = join(project, 'koma', 'server', 'data');
mkdirSync(bundledData, { recursive: true });
for (const name of ['dubindex.json', 'audio.json']) {
  const source = join(repo, '.data', name);
  if (existsSync(source)) cpSync(source, join(bundledData, name));
}

// AniVault: compiled JS + its production dependencies.
cpSync(join(anivaultDist, 'dist'), join(project, 'anivault', 'dist'), { recursive: true });
writeFileSync(join(project, 'anivault', 'package.json'), '{"name":"anivault-api","type":"commonjs","private":true}');
cpSync(join(anivaultDist, 'node_modules'), join(project, 'anivault', 'node_modules'), { recursive: true });

// The runtime copies faster from two lists than by walking the asset tree.
const dirs = [], files = [];
const walk = (abs, rel) => {
  for (const name of readdirSync(abs, { withFileTypes: true })) {
    // aapt2's asset ignore rules, mirrored exactly: everything starting with
    // a dot goes, so do directories starting with an underscore — but a FILE
    // named "_stream_readable.js" inside a normal folder is kept, and Node
    // requires it. What the list names must be exactly what aapt2 keeps.
    if (name.name.startsWith('.')) continue;
    if (name.isDirectory() && name.name.startsWith('_')) continue;
    const a = join(abs, name.name), r = rel ? `${rel}/${name.name}` : name.name;
    name.isDirectory() ? (dirs.push(`nodejs-project/${r}`), walk(a, r)) : files.push(`nodejs-project/${r}`);
  }
};
walk(project, '');
dirs.sort(); files.sort();
writeFileSync(join(assets, 'dir.list'), dirs.map(d => `${d}\n`).join(''));
writeFileSync(join(assets, 'file.list'), files.map(f => `${f}\n`).join(''));

const size = p => { let n = 0; for (const f of files) { /* rough */ } return n; };
const total = files.length, dirCount = dirs.length;
const hash = createHash('sha256').update(readFileSync(join(assets, 'file.list'))).digest('hex').slice(0, 12);
console.log(`node project: ${dirCount} dirs, ${total} files (list hash ${hash})`);
