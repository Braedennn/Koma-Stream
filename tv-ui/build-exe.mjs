// Packs the study into a Windows folder with its own .exe.
//   node build-exe.mjs
// It borrows the packager already installed for the desktop app, so this needs
// no second Electron on disk.
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const packagerEntry = path.join(here, '..', 'desktop', 'node_modules', '@electron', 'packager', 'dist', 'index.js');
const module = await import(pathToFileURL(packagerEntry).href);
const packager = module.default || module.packager;

const out = path.join(here, 'dist');
const result = await packager({
  dir: here,
  out,
  platform: 'win32',
  arch: 'x64',
  name: 'KomaTV',
  appVersion: '1.0.0',
  buildVersion: '1.0.0',
  overwrite: true,
  prune: true,
  // Only the shell and the screen: no dependencies, no tools, no notes.
  ignore: /(^|\/)(node_modules|dist|tools|\.git|\.gitignore|README\.md|build-exe\.mjs|.*\.log)(\/|$)/,
});

const [app] = result;
console.log(`built: ${app}`);
for (const file of ['KomaTV.exe', 'resources/app.asar']) {
  const full = path.join(app, file);
  if (!existsSync(full)) throw new Error(`Missing from the package: ${file}`);
  console.log(`  ${file}  ${statSync(full).size} bytes`);
}
// The packager puts the app in an archive; open it to be sure the screen went in.
const asar = await import(pathToFileURL(path.join(here, '..', 'desktop', 'node_modules', '@electron', 'asar', 'lib', 'asar.js')).href);
const files = (await asar.listPackage(path.join(app, 'resources', 'app.asar'))).map(name => name.replace(/\\/g, '/'));
for (const entry of ['/main.js', '/bridge.js', '/preload.js', '/renderer/index.html', '/renderer/css/tv.css', '/renderer/js/app.js', '/renderer/sample.json', '/package.json']) {
  if (!files.includes(entry)) throw new Error(`Missing from the archive: ${entry}`);
}
console.log(`  app.asar holds ${files.length} entries, including the screen`);
if (files.some(name => name.includes('node_modules'))) throw new Error('The archive should not hold dependencies');