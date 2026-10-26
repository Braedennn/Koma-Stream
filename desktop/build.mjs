// Builds dist/Koma-win32-x64/Koma.exe (run build-app.bat, or `node build.mjs`).
// Everything Koma needs is bundled inside the app: the site, the compiled
// AniVault server with its production dependencies, and the AllAnime server
// with its own portable Python. The result runs on a PC with no Node, npm or
// Python installed, and no console windows ever open.
import { packager } from '@electron/packager';
import { execSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const here = import.meta.dirname;
const site = path.resolve(here, '..');
const anivault = path.join(site, 'Servers - DONT TOUCH', 'anivault-scraper');
const allanime = path.join(site, 'Servers - DONT TOUCH', 'allanime-api');
const stage = path.join(here, 'build', 'bundle');
const embedded = path.join(here, 'build', 'embedded');
const PY_EMBED_URL = 'https://www.python.org/ftp/python/3.13.3/python-3.13.3-embed-amd64.zip';
const GET_PIP_URL = 'https://bootstrap.pypa.io/get-pip.py';

const sh = (cmd, cwd = here) => { console.log(`  > ${cmd}`); execSync(cmd, { cwd, stdio: 'inherit' }); };
const download = async (url, file) => {
  console.log(`  downloading ${url}`);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Couldn't download ${url} (${r.status})`);
  fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
};

/* ---------- portable Python (cached in build/embedded once) ---------- */
async function preparePython() {
  const py = path.join(embedded, 'py');
  if (fs.existsSync(path.join(py, 'python.exe')) && fs.existsSync(path.join(py, 'Lib', 'site-packages', 'fastapi'))) return py;
  fs.rmSync(py, { recursive: true, force: true });
  fs.mkdirSync(embedded, { recursive: true });
  const zip = path.join(embedded, 'python-embed.zip');
  await download(PY_EMBED_URL, zip);
  fs.mkdirSync(py, { recursive: true });
  if (spawnSync('tar', ['-xf', zip, '-C', py], { stdio: 'inherit' }).status) throw new Error('tar failed to extract the embedded Python');
  // Enable site-packages (pip installs there), then bootstrap pip and the deps.
  const pth = fs.readdirSync(py).find(f => f.endsWith('._pth'));
  fs.writeFileSync(path.join(py, pth), fs.readFileSync(path.join(py, pth), 'utf8').replace(/^#import site/m, 'import site'));
  const getPip = path.join(embedded, 'get-pip.py');
  await download(GET_PIP_URL, getPip);
  sh(`"${path.join(py, 'python.exe')}" "${getPip}" --no-warn-script-location`);
  sh(`"${path.join(py, 'python.exe')}" -m pip install --no-warn-script-location -r "${path.join(allanime, 'requirements.txt')}"`);
  return py;
}

/* ---------- staging ---------- */
function copy(from, to) { fs.cpSync(from, to, { recursive: true }); }

async function main() {
  console.log('[1/5] Compiling the streaming server (AniVault)...');
  sh('npm run build', anivault);
  if (!fs.existsSync(path.join(anivault, 'dist', 'server.js'))) throw new Error('AniVault build produced no dist/server.js');

  console.log('[2/5] Preparing the portable Python (AllAnime)...');
  const py = await preparePython();

  console.log('[3/5] Staging the bundle...');
  fs.rmSync(stage, { recursive: true, force: true });
  // The site
  const sSite = path.join(stage, 'app-site');
  fs.mkdirSync(sSite, { recursive: true });
  copy(path.join(site, 'server.js'), path.join(sSite, 'server.js'));
  copy(path.join(site, 'package.json'), path.join(sSite, 'package.json'));
  copy(path.join(site, 'server'), path.join(sSite, 'server'));
  copy(path.join(site, 'public'), path.join(sSite, 'public'));
  // AniVault: compiled output + config + production-only dependencies
  const sAni = path.join(stage, 'anivault');
  fs.mkdirSync(sAni, { recursive: true });
  copy(path.join(anivault, 'dist'), path.join(sAni, 'dist'));
  copy(path.join(anivault, 'package.json'), path.join(sAni, 'package.json'));
  copy(path.join(anivault, '.env'), path.join(sAni, '.env'));
  copy(path.join(anivault, 'package-lock.json'), path.join(sAni, 'package-lock.json'));
  // AllAnime: the app + its portable Python
  const sAll = path.join(stage, 'allanime');
  fs.mkdirSync(sAll, { recursive: true });
  copy(path.join(allanime, 'main.py'), path.join(sAll, 'main.py'));
  copy(py, path.join(sAll, 'py'));

  console.log('[4/5] Installing AniVault\'s production dependencies...');
  sh('npm ci --omit=dev --no-audit --no-fund', sAni);

  console.log('[5/5] Packaging Koma.exe...');
  const [out] = await packager({
    dir: here, name: 'Koma', platform: process.env.KOMA_PLATFORM || 'win32', arch: 'x64',
    icon: path.join(here, 'build', 'icon.ico'),
    out: path.join(here, 'dist'), overwrite: true, asar: true,
    extraResource: [sSite, sAni, sAll],
    appCopyright: 'TotallyNoire',
    win32metadata: { CompanyName: 'TotallyNoire', FileDescription: 'Koma', ProductName: 'Koma', InternalName: 'Koma', OriginalFilename: 'Koma.exe' },
    ignore: [/^\/dist(\/|$)/, /^\/build\//, /^\/node_modules\//, /^\/koma-home\.txt$/, /^\/build\.mjs$/, /\.svg$/, /\.(bat|ps1|nsi)$/],
  });
  const resources = path.join(out, 'resources');
  for (const part of ['app-site/server.js', 'anivault/dist/server.js', 'allanime/main.py', 'allanime/py/python.exe']) {
    if (!fs.existsSync(path.join(resources, part))) throw new Error(`Bundling failed: ${part} is missing from the package`);
  }
  console.log(`Built: ${out}`);
}

await main();
