// Checks the study's own relay against Koma's proxy, the way the player does.
//   node tools/relay-check.mjs
import { createRendererServer } from '../serve.js';

const KOMA = process.argv[2] || 'http://127.0.0.1:4242';
const site = await createRendererServer(new URL('../renderer/', import.meta.url).pathname);

const answer = await fetch(`${KOMA}/api/stream/watch?source=anikoto&anilistId=21&ep=1&type=sub`, {
  headers: { 'x-koma-deadline': '140000' },
});
const data = await answer.json();
const koma = new URL(data.hlsProxyUrl, KOMA);
const via = `${site.url}media/stream?url=${encodeURIComponent(koma.href)}&ref=${encodeURIComponent(koma.searchParams.get('ref') || '')}`;

const master = await fetch(via);
const text = await master.text();
console.log('relay master:', master.status, master.headers.get('content-type'), `${text.length} bytes`);
console.log(text.split('\n').slice(0, 4).join('\n'));

const first = text.split('\n').find(line => line.startsWith('http') || line.startsWith('/'));
const target = first.startsWith('http') ? first : `${site.url.replace(/\/$/, '')}${first}`;
const variant = await fetch(target);
const body = await variant.text();
console.log('relay variant:', variant.status, variant.headers.get('content-type'), `${body.length} bytes`);
console.log(body.split('\n').slice(0, 4).join('\n'));

const segment = body.split('\n').find(line => line.startsWith('http') || line.startsWith('/'));
const segTarget = segment.startsWith('http') ? segment : `${site.url.replace(/\/$/, '')}${segment}`;
const bytes = await fetch(segTarget, { headers: { Range: 'bytes=0-1023' } });
console.log('relay segment:', bytes.status, bytes.headers.get('content-type'), bytes.headers.get('content-length'));
site.server.close();