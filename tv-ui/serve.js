// Serves the study's screen over http, the way Koma's own app serves its site.
// A file:// page cannot load video from an http address — Chromium's URL safety
// check refuses it — so the study is a local site of its own, exactly like the
// desktop app it is standing in for.
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json',
};

function createRendererServer(root) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (request, response) => {
      const url = new URL(request.url, 'http://localhost');
      const asked = decodeURIComponent(url.pathname);
      /* Koma's own proxy serves the episode, but a page may only load video
         from its own origin: this relays that stream, and rewrites a playlist
         so its segments come back here too. The streaming servers are still
         Koma's — nothing about the episode itself is re-implemented. */
      if (asked.startsWith('/media/')) {
        try { return await relay(request, response, url); }
        catch (error) { response.writeHead(502, { 'Content-Type': 'text/plain' }).end(String(error?.message || error)); return; }
      }
      const file = path.join(root, asked === '/' ? 'index.html' : asked);
      if (!file.startsWith(root)) { response.writeHead(403).end('Forbidden'); return; }
      fs.readFile(file, (error, body) => {
        if (error) { response.writeHead(404).end('Not found'); return; }
        response.writeHead(200, {
          'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
          'Cache-Control': 'no-store',
        });
        response.end(body);
      });
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      url: `http://127.0.0.1:${server.address().port}/`,
    }));
  });
}

const isPlaylist = text => /^#EXTM3U|^#EXT-X/.test(text.trim());

async function relay(request, response, url) {
  const target = url.searchParams.get('url');
  if (!target) { response.writeHead(400).end('No stream given.'); return; }
  const upstream = await fetch(target, {
    headers: {
      ...(request.headers.range ? { Range: request.headers.range } : {}),
      Accept: '*/*',
      'User-Agent': 'Mozilla/5.0',
      Referer: url.searchParams.get('ref') || '',
    },
    redirect: 'follow',
  });
  const type = upstream.headers.get('content-type') || '';
  const body = await upstream.arrayBuffer();
  const text = Buffer.from(body).toString('utf8');
  if (type.includes('mpegurl') || type.includes('x-mpegurl') || isPlaylist(text)) {
    // Every address inside a playlist comes back here, so the next request
    // lands on this origin as well.
    const mine = `http://127.0.0.1:${response.socket.localPort}`;
    const rewritten = text.replace(/(https?:\/\/[^\s"']+|\/api\/proxy\/[^\s"']+)/g, match =>
      `${mine}/media/stream?url=${encodeURIComponent(match.startsWith('/') ? new URL(match, target).href : match)}&ref=${encodeURIComponent(url.searchParams.get('ref') || '')}`);
    response.writeHead(upstream.status, {
      'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
    });
    response.end(rewritten);
    return;
  }
  response.writeHead(upstream.status, {
    'Content-Type': type || 'video/mp2t',
    'Content-Length': String(body.byteLength),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
  });
  response.end(Buffer.from(body));
}

module.exports = { createRendererServer };