// Assembles the Android assets and native server binaries that ship inside the
// APK.
//
//   node sync-assets.mjs
//
// Layout produced under app/src/main/:
//   assets/
//     nodejs-project/
//       main.js, package.json, anivault.env  <- the Node streaming sidecar
//       anivault/dist/**, anivault/node_modules/**
//     koma-site/
//       public/**                              <- the site the Rust server serves
//       server/data/**                         <- the language catalogue data
//     dir.list, file.list                      <- nodejs-project-relative copy lists
//   jniLibs/<abi>/libkoma_server.so            <- the native Rust server
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..');
const assets = join(here, 'app', 'src', 'main', 'assets');
const project = join(assets, 'nodejs-project');
const komaSite = join(assets, 'koma-site');
const jniLibs = join(here, 'app', 'src', 'main', 'jniLibs');

// The last packaged build already carries a pruned production tree for
// AniVault; using it avoids a second npm install.
const packagedAnivault = join(repo, 'desktop', 'dist', 'Koma-win32-x64', 'resources', 'anivault');
const sourceAnivault = join(repo, 'Servers - DONT TOUCH', 'anivault-scraper');
const anivaultDist = existsSync(join(packagedAnivault, 'dist')) ? packagedAnivault : sourceAnivault;

// Cargo's standard Android target triples map onto the APK's ABI names.
const rustTargets = {
  'arm64-v8a': 'aarch64-linux-android',
  'armeabi-v7a': 'armv7-linux-androideabi',
  'x86_64': 'x86_64-linux-android',
};
const cargoTarget = process.env.CARGO_TARGET_DIR;
const explicitRustTarget = process.env.KOMA_RUST_TARGET_DIR;
const resolveRustTarget = value => value
  ? (isAbsolute(value) ? value : join(repo, value))
  : null;
const rustTarget = resolveRustTarget(explicitRustTarget)
  || resolveRustTarget(cargoTarget)
  || join(repo, 'rust-backend', 'target');
const rustBinaries = Object.entries(rustTargets).map(([abi, triple]) => {
  const releaseDir = join(rustTarget, triple, 'release');
  const candidates = [
    join(releaseDir, 'libkoma_server.so'),
    join(releaseDir, 'libkoma_server'),
    join(releaseDir, 'koma-server'),
  ];
  return {
    abi,
    source: candidates.find(candidate => existsSync(candidate)),
    candidates,
  };
});

console.log(`anivault from: ${anivaultDist === packagedAnivault ? 'the packaged build' : 'the source tree'}`);

const missingRust = rustBinaries.filter(binary => !binary.source);
if (missingRust.length) {
  console.error('Missing Rust Android binaries:');
  for (const binary of missingRust) {
    console.error(`  ${binary.abi}: ${binary.candidates.join(' or ')}`);
  }
  console.error(`Build the release binaries under ${rustTarget} before syncing assets.`);
  process.exit(1);
}

// Replace the generated trees, but leave the existing JNI runtime libraries in
// place: this directory also carries libnode.so for the AniVault sidecar.
rmSync(project, { recursive: true, force: true });
rmSync(komaSite, { recursive: true, force: true });
mkdirSync(project, { recursive: true });

// The Node starter and its package marker.
cpSync(join(here, 'node-src', 'main.js'), join(project, 'main.js'));
cpSync(join(here, 'node-src', 'package.json'), join(project, 'package.json'));

// The key travels as a plain file (aapt2 drops dotfiles from assets, so it
// cannot be called ".env") — the same key the desktop install carries.
const key = readFileSync(join(sourceAnivault, '.env'), 'utf8').match(/^ANIVAULT_API_KEY=(.+)$/m)?.[1]?.trim();
if (!key) { console.error('No ANIVAULT_API_KEY found in the anivault .env'); process.exit(1); }
writeFileSync(join(project, 'anivault.env'), `ANIVAULT_API_KEY=${key}\nNODE_ENV=production\n`);

// The native server gets the static site and the language catalogue data. It
// receives their app-storage paths through KOMA_PUBLIC_DIR and KOMA_DATA_DIR.
mkdirSync(join(komaSite, 'server', 'data'), { recursive: true });
cpSync(join(repo, 'public'), join(komaSite, 'public'), { recursive: true });
const sourceData = join(repo, 'server', 'data');
if (existsSync(sourceData)) {
  cpSync(sourceData, join(komaSite, 'server', 'data'), { recursive: true });
}

// The desktop app keeps the current catalogue in .data. Android has no
// AllAnime server of its own, so the latest known index and counts travel
// with the APK under ordinary (non-hidden) names.
for (const name of ['dubindex.json', 'audio.json']) {
  const source = join(repo, '.data', name);
  if (existsSync(source)) cpSync(source, join(komaSite, 'server', 'data', name));
}

// AniVault: compiled JS + its production dependencies. It is the only server
// still hosted by Node; Koma itself runs in the packaged Rust executable.
cpSync(join(anivaultDist, 'dist'), join(project, 'anivault', 'dist'), { recursive: true });
writeFileSync(join(project, 'anivault', 'package.json'), '{"name":"anivault-api","type":"commonjs","private":true}');
cpSync(join(anivaultDist, 'node_modules'), join(project, 'anivault', 'node_modules'), { recursive: true });

// The Rust server is copied into the ABI-specific native library directories.
// Android extracts these libraries and the app executes the selected one from
// ApplicationInfo.nativeLibraryDir.
for (const binary of rustBinaries) {
  const destination = join(jniLibs, binary.abi, 'libkoma_server.so');
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(binary.source, destination);
}

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

const total = files.length, dirCount = dirs.length;
const hash = createHash('sha256').update(readFileSync(join(assets, 'file.list'))).digest('hex').slice(0, 12);
console.log(`node sidecar: ${dirCount} dirs, ${total} files (list hash ${hash})`);
console.log(`rust server: ${rustBinaries.map(binary => binary.abi).join(', ')}`);
