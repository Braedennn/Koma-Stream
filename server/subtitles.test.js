import test, { afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  downloadSubtitles,
  loginSubtitles,
  readSubtitle,
  searchSubtitles,
  subtitlesTesting,
} from './subtitles.js';

const json = (value, options = {}) => new Response(JSON.stringify(value), {
  status: 200,
  ...options,
  headers: { 'content-type': 'application/json', ...(options.headers || {}) },
});
const file = (value, options = {}) => new Response(value, {
  status: 200,
  ...options,
  headers: { 'content-type': 'text/plain; charset=utf-8', ...(options.headers || {}) },
});
const downloadAnswer = (id = 123) => ({
  link: `https://cdn.example.test/download/${id}`,
  file_name: 'example.vtt',
  remaining: 19,
  requests: 1,
  reset_time_utc: '2026-11-23 00:00:00',
});
const postBody = { file_id: 123, sub_format: 'webvtt' };
const isDownloadPost = url => String(url) === 'https://api.opensubtitles.com/api/v1/download';

let directory;
let previousDataDir;

beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'koma-subtitles-'));
  previousDataDir = process.env.KOMA_DATA_DIR;
  process.env.KOMA_DATA_DIR = directory;
  subtitlesTesting.configure({ spacing: 0 });
});

afterEach(async () => {
  subtitlesTesting.reset();
  if (previousDataDir === undefined) delete process.env.KOMA_DATA_DIR;
  else process.env.KOMA_DATA_DIR = previousDataDir;
  await rm(directory, { recursive: true, force: true });
});

test('search maps sanitized results, forwards filters, and uses the five-minute cache', async () => {
  const calls = [];
  subtitlesTesting.configure({
    fetch: async (url, options) => {
      calls.push({ url: String(url), options });
      return json({
        total_pages: 4,
        total_count: 81,
        page: 2,
        data: [{
          id: 'raw-subtitle-id',
          attributes: {
            language: 'en',
            release: 'Show.S01E02.1080p',
            fps: 23.976,
            download_count: 42,
            ratings: 8.5,
            hearing_impaired: false,
            foreign_parts_only: true,
            from_trusted: true,
            url: 'https://upstream.example/private',
            feature_details: {
              title: 'A Show', year: 2025, season_number: 1, episode_number: 2,
            },
            files: [
              { file_id: 98765, file_name: 'show.srt' },
              { file_id: 'not-numeric', file_name: 'ignored.srt' },
            ],
          },
        }],
      });
    },
  });
  const args = {
    apiKey: 'secret-key', token: 'jwt-token', query: 'A Show', language: 'en',
    year: 2025, season: 1, episode: 2, type: 'episode', page: 2,
  };
  const first = await searchSubtitles(args);
  assert.deepEqual(first, {
    results: [{
      fileId: 98765,
      language: 'en',
      release: 'Show.S01E02.1080p',
      fileName: 'show.srt',
      fps: 23.976,
      downloadCount: 42,
      rating: 8.5,
      hearingImpaired: false,
      foreignPartsOnly: true,
      trusted: true,
      featureTitle: 'A Show',
      featureYear: 2025,
      season: 1,
      episode: 2,
    }],
    totalPages: 4,
    totalCount: 81,
    page: 2,
  });
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.origin + url.pathname, 'https://api.opensubtitles.com/api/v1/subtitles');
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    query: 'a show', languages: 'en', type: 'episode', page: '2',
    ai_translated: 'exclude', year: '2025', season_number: '1', episode_number: '2',
  });
  assert.deepEqual([...url.searchParams.keys()], [...url.searchParams.keys()].sort());
  assert.equal(url.searchParams.has('machine_translated'), false);
  assert.equal(calls[0].options.headers['User-Agent'], 'Koma v1.0.0');
  assert.equal(calls[0].options.headers['Api-Key'], 'secret-key');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer jwt-token');
  assert.equal(JSON.stringify(first).includes('upstream.example'), false);

  first.results[0].release = 'caller mutation';
  const second = await searchSubtitles(args);
  assert.equal(second.results[0].release, 'Show.S01E02.1080p');
  assert.equal(calls.length, 1);
});

test('login returns only the token and selected user fields', async () => {
  let request;
  subtitlesTesting.configure({
    fetch: async (url, options) => {
      request = { url: String(url), options };
      return json({
        token: 'new-jwt', base_url: 'https://ignored.example',
        user: {
          user_id: 7, level: 'User', vip: false, allowed_downloads: 20,
          downloads_count: 3, remaining_downloads: 17, private_field: 'omit',
        },
      });
    },
  });
  const answer = await loginSubtitles({ apiKey: 'key', username: 'viewer', password: 'password' });
  assert.equal(answer.token, 'new-jwt');
  assert.deepEqual(answer.user, {
    id: 7, username: '', level: 'User', vip: false,
    allowedDownloads: 20, downloadsCount: 3, remainingDownloads: 17,
  });
  assert.equal(request.url, 'https://api.opensubtitles.com/api/v1/login');
  assert.deepEqual(JSON.parse(request.options.body), { username: 'viewer', password: 'password' });
  assert.equal('private_field' in answer.user, false);
});

test('download converts BOM/CRLF SRT with comma and dot timestamps to cached WebVTT', async () => {
  const calls = [];
  subtitlesTesting.configure({
    fetch: async (url, options) => {
      calls.push({ url: String(url), options });
      if (calls.length === 1) return json(downloadAnswer());
      return file('\uFEFF1\r\n0:00:01,0 --> 00:00:03.500\r\nHello\r\nworld\r\n\r\n2\r\n00:01:02.25 --> 00:01:04,000\r\nSecond\r\n');
    },
  });
  const answer = await downloadSubtitles({ apiKey: 'key', token: 'jwt', fileId: 123, releaseName: 'Release' });
  assert.deepEqual(answer, {
    track: {
      id: 'opensubtitles:123', lang: 'English', code: 'en',
      url: '/api/subtitles/file/123', source: 'opensubtitles', releaseName: 'Release',
    },
    quota: { remaining: 19, resetAt: '2026-11-23 00:00:00', requests: 1 },
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(JSON.parse(calls[0].options.body), postBody);
  assert.equal(calls[0].options.headers['Api-Key'], 'key');
  assert.equal(calls[1].options.headers['Api-Key'], undefined);
  assert.equal(calls[1].options.headers.Authorization, undefined);
  assert.equal(JSON.stringify(answer).includes('cdn.example.test'), false);
  const expected = 'WEBVTT\n\n00:00:01.000 --> 00:00:03.500\nHello\nworld\n\n00:01:02.250 --> 00:01:04.000\nSecond\n';
  assert.equal((await readSubtitle(123)).toString('utf8'), expected);
  assert.equal(await readFile(path.join(directory, 'subtitles', '123.vtt'), 'utf8'), expected);
});

test('HTML download responses are rejected and never cached', async () => {
  subtitlesTesting.configure({
    fetch: async url => isDownloadPost(url)
      ? json(downloadAnswer(456))
      : file('<!doctype html><html><body>Not a subtitle</body></html>', { headers: { 'content-type': 'text/html' } }),
  });
  await assert.rejects(
    downloadSubtitles({ apiKey: 'key', fileId: 456 }),
    err => err.status === 502 && !String(err.message).includes('cdn.example.test'),
  );
  assert.equal(await readSubtitle(456), null);
});

test('an existing cached VTT avoids both upstream calls and quota use', async () => {
  let calls = 0;
  subtitlesTesting.configure({
    fetch: async url => {
      calls++;
      return isDownloadPost(url)
        ? json(downloadAnswer(789))
        : file('WEBVTT\r\n\r\n00:00:01.000 --> 00:00:02.000\r\nCached\r\n');
    },
  });
  const args = { apiKey: 'key', fileId: 789, releaseName: 'Cached release' };
  const first = await downloadSubtitles(args);
  assert.equal(first.quota.remaining, 19);
  const second = await downloadSubtitles(args);
  assert.deepEqual(second.track, first.track);
  assert.deepEqual(second.quota, { remaining: null, resetAt: null, requests: null });
  assert.equal(calls, 2);
});

test('concurrent downloads for the same API key and file are coalesced', async () => {
  let openGate;
  let markStarted;
  const gate = new Promise(resolve => { openGate = resolve; });
  const started = new Promise(resolve => { markStarted = resolve; });
  const calls = [];
  const cache = new Map();
  subtitlesTesting.configure({
    storage: {
      read: async id => cache.get(id) || null,
      write: async (id, data) => { cache.set(id, Buffer.from(data)); },
    },
    fetch: async url => {
      calls.push(String(url));
      if (isDownloadPost(url)) return json(downloadAnswer(321));
      markStarted();
      await gate;
      return file('1\n00:00:01,000 --> 00:00:02,000\nShared\n');
    },
  });
  const one = downloadSubtitles({ apiKey: 'key', fileId: 321, releaseName: 'One' });
  const two = downloadSubtitles({ apiKey: 'key', fileId: '321', releaseName: 'Two' });
  await started;
  assert.equal(calls.filter(isDownloadPost).length, 1);
  assert.equal(calls.filter(url => url.startsWith('https://cdn.example.test')).length, 1);
  openGate();
  const [first, second] = await Promise.all([one, two]);
  assert.equal(first.track.releaseName, 'One');
  assert.equal(second.track.releaseName, 'Two');
  assert.equal(calls.length, 2);
  assert.match((await readSubtitle(321)).toString(), /^WEBVTT/);
});

test('readSubtitle accepts only numeric ids, reads cache only, and returns null for misses', async () => {
  let network = false;
  subtitlesTesting.configure({ fetch: async () => { network = true; throw new Error('network forbidden'); } });
  await mkdir(path.join(directory, 'subtitles'), { recursive: true });
  await writeFile(path.join(directory, 'subtitles', '42.vtt'), 'WEBVTT\n');
  assert.deepEqual(await readSubtitle(42), Buffer.from('WEBVTT\n'));
  assert.deepEqual(await readSubtitle('00042'), Buffer.from('WEBVTT\n'));
  assert.equal(await readSubtitle(43), null);
  for (const id of ['../42', '42.vtt', '1e2', '1.5', '-1', '0', '', null, {}, 9007199254740992]) {
    assert.equal(await readSubtitle(id), null, `invalid id: ${String(id)}`);
  }
  assert.equal(network, false);
});

test('validation and quota failures expose meaningful sanitized errors', async () => {
  let calls = 0;
  subtitlesTesting.configure({
    fetch: async () => {
      calls++;
      return json({ message: 'Download quota exceeded', reset_time_utc: '2026-11-23 00:00:00' }, {
        status: 406, headers: { 'retry-after': '120' },
      });
    },
  });
  await assert.rejects(searchSubtitles({ apiKey: 'key', query: '', page: 0 }), err => err.status === 400);
  assert.equal(calls, 0);
  await assert.rejects(downloadSubtitles({ apiKey: 'key', fileId: 999 }), err => (
    err.status === 429 && err.retryAfter === 120 && err.resetAt === '2026-11-23 00:00:00'
  ));
});
