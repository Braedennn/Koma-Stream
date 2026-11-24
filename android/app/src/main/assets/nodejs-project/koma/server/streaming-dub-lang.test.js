import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

let upstream;
let streaming;
let port;
const calls = [];
const master = languages => `#EXTM3U\n${languages.map(([code, name]) => `#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",LANGUAGE="${code}",NAME="${name}",URI="${code}.m3u8"`).join('\n')}\n#EXT-X-STREAM-INF:BANDWIDTH=1200000,AUDIO="audio"\nvideo.m3u8\n`;

before(async () => {
  upstream = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/api/proxy/hls') {
      const ep = url.searchParams.get('ep');
      const server = url.searchParams.get('server');
      let text = master([['en', 'English'], ['fr', 'French']]);
      if (server === 'English') text = master([['en', 'English']]);
      if (server === 'Hindi') text = master([['en', 'English'], ['hi', 'Hindi']]);
      if (ep === '2' || ep === '6') text = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nvideo.m3u8\n';
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end(text);
      return;
    }
    if (url.pathname === '/api/watch') {
      const q = url.searchParams;
      const ep = q.get('ep');
      const source = q.get('source') || 'anikoto';
      const server = q.get('server') || (ep === '2' ? 'Unknown' : ep === '4' && source === 'desidub' ? 'Hindi' : ep === '6' || ep === '7' ? 'Dub (Hindi)' : 'English');
      calls.push({ ep, source, server, dubLang: q.get('dubLang') });
      if (ep === '3' || ep === '5' && server === 'English' || ep === '7') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ playbackMode: 'mp4', mp4ProxyUrl: `/api/proxy/video?ep=${ep}`, server, availableServers: ep === '5' ? ['English', 'Hindi'] : [] }));
        return;
      }
      const availableServers = ep === '2' ? ['Unknown'] : ep === '4' && source === 'desidub' ? ['Hindi'] : ep === '5' ? ['English', 'Hindi'] : ep === '6' ? ['Dub (Hindi)'] : ['English', 'French'];
      const actualServer = ep === '4' && source === 'desidub' ? 'Hindi' : server;
      const hlsProxyUrl = `http://127.0.0.1:${port}/api/proxy/hls?ep=${ep}&server=${actualServer}`;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ playbackMode: 'hls', hlsProxyUrl, server: actualServer, availableServers }));
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  port = upstream.address().port;
  process.env.KOMA_ANIVAULT_URL = `http://127.0.0.1:${port}`;
  process.env.KOMA_ANIVAULT_KEY = 'test-key';
  process.env.KOMA_SOURCE_SITES = 'catalogue|Test|127.0.0.1';
  streaming = await import(`./streaming.js?dub-lang-tests=${Date.now()}`);
});

after(async () => {
  await new Promise(resolve => upstream.close(resolve));
});

const request = { headers: {} };
const query = ep => new URLSearchParams({ ep: String(ep), type: 'dub', source: 'anikoto' });
const respond = () => ({
  status: 0,
  body: '',
  writeHead(status) { this.status = status; },
  end(body) { this.body = String(body || ''); },
});

test('a wrong-language playable mirror does not stop the later French mirror', async () => {
  calls.length = 0;
  const result = await streaming.watchOn({ source: 'anikoto', offset: 0 }, query(1), request, 'dub', Date.now() + 10000, 'fr');
  assert.equal(result.status, 200);
  assert.equal(result.data.server, 'French');
  assert.match(result.data.hlsProxyUrl, /[?&]lang=fr/);
  assert.deepEqual(calls.map(call => call.server), ['English', 'French']);
  assert.ok(calls.every(call => call.dubLang === null), 'Koma-only language is not forwarded to AniVault');
});

test('an undocumented single track cannot claim an explicit Hindi request', async () => {
  const result = await streaming.watchOn({ source: 'anikoto', offset: 0 }, query(2), request, 'dub', Date.now() + 10000, 'hi');
  assert.equal(result.status, 404);
  assert.equal(result.langMismatch, true);
  assert.match(result.data.error, /Hindi audio could not be verified/);
});

test('direct MP4 remains valid for English but not an unverifiable regional dub', async () => {
  const hindi = await streaming.watchOn({ source: 'anikoto', offset: 0 }, query(3), request, 'dub', Date.now() + 10000, 'hi');
  assert.equal(hindi.status, 404);
  assert.equal(hindi.langMismatch, true);
  const english = await streaming.watchOn({ source: 'anikoto', offset: 0 }, query(3), request, 'dub', Date.now() + 10000, 'en');
  assert.equal(english.status, 200);
  assert.equal(english.data.playbackMode, 'mp4');
});

test('an unverifiable MP4 mirror does not stop a later Hindi HLS mirror', async () => {
  calls.length = 0;
  const result = await streaming.watchOn({ source: 'anikoto', offset: 0 }, query(5), request, 'dub', Date.now() + 10000, 'hi');
  assert.equal(result.status, 200);
  assert.equal(result.data.playbackMode, 'hls');
  assert.equal(result.data.server, 'Hindi');
  assert.match(result.data.hlsProxyUrl, /[?&]lang=hi/);
  assert.deepEqual(calls.map(call => call.server), ['English', 'Hindi']);
});

test('an explicitly Hindi-labelled source can verify a muxed HLS track or direct MP4', async () => {
  const hls = await streaming.watchOn({ source: 'desidub', offset: 0 }, query(6), request, 'dub', Date.now() + 10000, 'hi');
  assert.equal(hls.status, 200);
  assert.equal(hls.data.playbackMode, 'hls');
  assert.doesNotMatch(hls.data.hlsProxyUrl, /[?&]lang=/, 'a verified muxed playlist needs no narrowing parameter');
  const mp4 = await streaming.watchOn({ source: 'desidub', offset: 0 }, query(7), request, 'dub', Date.now() + 10000, 'hi');
  assert.equal(mp4.status, 200);
  assert.equal(mp4.data.playbackMode, 'mp4');
});

test('full resolution forces old regional links to English and shares their cache', async () => {
  calls.length = 0;
  const hindiRes = respond();
  await streaming.proxyJson({ method: 'GET', headers: { 'x-koma-deadline': '10000' } }, hindiRes, '/watch', '?ep=4&type=dub&source=anikoto&dubLang=hi');
  assert.equal(hindiRes.status, 200);
  assert.equal(JSON.parse(hindiRes.body).server, 'English');
  assert.match(JSON.parse(hindiRes.body).hlsProxyUrl, /[?&]lang=en/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].source, 'anikoto');

  const frenchRes = respond();
  await streaming.proxyJson({ method: 'GET', headers: { 'x-koma-deadline': '10000' } }, frenchRes, '/watch', '?ep=4&type=dub&source=anikoto&dubLang=fr');
  assert.equal(frenchRes.status, 200);
  assert.equal(frenchRes.body, hindiRes.body, 'regional aliases reuse the canonical English cache entry');
  assert.equal(calls.length, 1);
});

test('an obsolete DesiDub source deep link falls back to the English source path', async () => {
  calls.length = 0;
  const response = respond();
  await streaming.proxyJson({ method: 'GET', headers: { 'x-koma-deadline': '10000' } }, response, '/watch', '?ep=4&type=dub&source=desidub&dubLang=hi&fresh=1');
  assert.equal(response.status, 200);
  assert.equal(JSON.parse(response.body).server, 'English');
  assert.ok(calls.length > 0);
  assert.ok(calls.every(call => call.source !== 'desidub'));
});

test('the media proxy serves the narrowed French master from its cache', async () => {
  const resolved = await streaming.watchOn({ source: 'anikoto', offset: 0 }, query(1), request, 'dub', Date.now() + 10000, 'fr');
  assert.equal(resolved.status, 200);
  const url = new URL(resolved.data.hlsProxyUrl, 'http://koma.test');
  const response = respond();
  await streaming.proxyMedia(request, response, url.pathname, url.search);
  assert.equal(response.status, 200);
  assert.match(response.body, /NAME="French"[^\n]*DEFAULT=YES,AUTOSELECT=YES/);
  assert.doesNotMatch(response.body, /NAME="English"/);
  assert.match(response.body, /video\.m3u8/);
});

test('the media proxy refuses a missing strict language instead of serving English', async () => {
  const resolved = await streaming.watchOn({ source: 'anikoto', offset: 0 }, query(1), request, 'dub', Date.now() + 10000, 'fr');
  assert.equal(resolved.status, 200);
  const response = respond();
  await streaming.proxyMedia(request, response, '/api/proxy/hls', '?ep=1&server=French&lang=hi');
  assert.equal(response.status, 404);
  assert.match(response.body, /no audio in the language/);
});

test('metadata-free English and Japanese playlists keep playing through the proxy', async () => {
  for (const [type, lang] of [['dub', 'en'], ['sub', 'ja']]) {
    const q = new URLSearchParams({ ep: '2', type, source: 'anikoto' });
    const resolved = await streaming.watchOn({ source: 'anikoto', offset: 0 }, q, request, type, Date.now() + 10000, lang);
    assert.equal(resolved.status, 200);
    const url = new URL(resolved.data.hlsProxyUrl, 'http://koma.test');
    const response = respond();
    await streaming.proxyMedia(request, response, url.pathname, url.search);
    assert.equal(response.status, 200);
    assert.match(response.body, /video\.m3u8/);
  }
});
