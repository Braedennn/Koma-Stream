import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = 'https://api.opensubtitles.com/api/v1';
const USER_AGENT = 'Koma v1.0.0';
const SEARCH_TTL = 5 * 60e3;
const SEARCH_CAP = 100;
const MAX_JSON = 2 * 1024 * 1024;
const MAX_SUBTITLE = 5 * 1024 * 1024;
const MAX_REDIRECTS = 3;

const searchCache = new Map();
const searchInFlight = new Map();
const downloadInFlight = new Map();
const requestQueues = new Map();
const lastRequest = new Map();

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const defaults = () => ({ fetch: globalThis.fetch, storage: null, now: Date.now, sleep, spacing: 350 });
let runtime = defaults();

function failure(message, status, extra = null) {
  return Object.assign(new Error(message), { status }, extra || {});
}

function text(value, name, max, { optional = false } = {}) {
  if (value == null && optional) return '';
  if (typeof value !== 'string') throw failure(`${name} must be text.`, 400);
  const out = value.trim();
  if ((!optional && !out) || out.length > max) throw failure(`${name} must contain 1-${max} characters.`, 400);
  return out;
}

function integer(value, name, min, max, zero = false) {
  if (typeof value === 'boolean' || value == null || value === '') throw failure(`${name} must be a whole number.`, 400);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || (zero && n === 0 ? false : n < min) || n > max) {
    throw failure(`${name} is outside its allowed range.`, 400);
  }
  return n;
}

function apiKeyOf(value) {
  const key = value || process.env.KOMA_OPENSUBTITLES_API_KEY;
  if (!key) throw failure('Add your OpenSubtitles API key in Settings first.', 401);
  return text(key, 'apiKey', 512);
}

function tokenOf(value) {
  const token = text(value || '', 'token', 8192, { optional: true });
  if (/[\r\n]/.test(token)) throw failure('token contains invalid characters.', 400);
  return token;
}

function languageOf(value, multiple = false) {
  const language = text(value, 'language', multiple ? 120 : 40).toLowerCase();
  const parts = language.split(',');
  if ((!multiple && parts.length !== 1) || parts.length > 10
    || parts.some(code => !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/.test(code))) {
    throw failure('language must be an ISO language code.', 400);
  }
  return parts.join(',');
}

function fileIdOf(value) {
  if (typeof value === 'string' && !/^\d+$/.test(value)) return null;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? String(id) : null;
}

function requiredFileId(value) {
  const id = fileIdOf(value);
  if (!id) throw failure('fileId must be a positive numeric id.', 400);
  return id;
}

function cacheDirectory() {
  const root = process.env.KOMA_DATA_DIR?.trim();
  return root ? path.join(path.resolve(root), 'subtitles') : fileURLToPath(new URL('../.data/subtitles/', import.meta.url));
}

const diskStorage = {
  async read(id) {
    try {
      return await readFile(path.join(cacheDirectory(), `${id}.vtt`));
    } catch (err) {
      if (err?.code === 'ENOENT') return null;
      throw err;
    }
  },
  async write(id, data) {
    const directory = cacheDirectory();
    await mkdir(directory, { recursive: true });
    const temporary = path.join(directory, `.${id}.${process.pid}.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, data, { flag: 'wx' });
      await rename(temporary, path.join(directory, `${id}.vtt`));
    } finally {
      await unlink(temporary).catch(() => {});
    }
  },
};

const store = () => runtime.storage || diskStorage;

export async function readSubtitle(fileId) {
  const id = fileIdOf(fileId);
  if (!id) return null;
  try {
    const data = await store().read(id);
    if (data == null) return null;
    return Buffer.isBuffer(data) ? data : Buffer.from(data);
  } catch {
    return null;
  }
}

function header(response, name) {
  return response?.headers?.get?.(name) || '';
}

async function paced(apiKey) {
  if (!runtime.spacing) return;
  const previous = requestQueues.get(apiKey) || Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    const wait = runtime.spacing - (runtime.now() - (lastRequest.get(apiKey) || 0));
    if (wait > 0) await runtime.sleep(wait);
    lastRequest.set(apiKey, runtime.now());
  });
  requestQueues.set(apiKey, current);
  try {
    await current;
  } finally {
    if (requestQueues.get(apiKey) === current) requestQueues.delete(apiKey);
  }
}

async function limitedBody(response, maximum) {
  const declared = Number(header(response, 'content-length'));
  if (Number.isFinite(declared) && declared > maximum) throw failure('OpenSubtitles returned an oversized response.', 502);
  const chunks = [];
  let size = 0;
  const append = chunk => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maximum) throw failure('OpenSubtitles returned an oversized response.', 502);
    chunks.push(buffer);
  };
  if (response.body?.[Symbol.asyncIterator]) {
    for await (const chunk of response.body) append(chunk);
  } else if (response.arrayBuffer) {
    append(await response.arrayBuffer());
  } else {
    append(await response.text());
  }
  return Buffer.concat(chunks, size);
}

async function fetchBytes(url, options, { apiKey = '', timeout = 15000, maximum = MAX_JSON, networkMessage } = {}) {
  if (apiKey) await paced(apiKey);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  timer.unref?.();
  try {
    const response = await runtime.fetch(url, { ...options, signal: controller.signal });
    const body = await limitedBody(response, maximum);
    return { response, body };
  } catch (err) {
    if (err?.status) throw err;
    throw failure(networkMessage || 'OpenSubtitles could not be reached.', 503);
  } finally {
    clearTimeout(timer);
  }
}

function cleanNumber(value, { integer: whole = false, min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(value);
  if (!Number.isFinite(n) || (whole && !Number.isSafeInteger(n)) || n < min || n > max) return null;
  return n;
}

function cleanText(value, maximum = 500) {
  return typeof value === 'string' ? value.trim().slice(0, maximum) : '';
}

function resetAtOf(data, response) {
  const stated = cleanText(data?.reset_time_utc || data?.reset_at, 100);
  if (stated) return stated;
  const epoch = Number(header(response, 'x-ratelimit-reset') || header(response, 'ratelimit-reset'));
  if (!Number.isFinite(epoch) || epoch <= 0) return null;
  const date = new Date(epoch < 1e12 ? epoch * 1000 : epoch);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function retryAfterOf(data, response) {
  const raw = header(response, 'retry-after');
  let seconds = Number(raw || data?.retry_after);
  if (raw && !Number.isFinite(seconds)) {
    const date = Date.parse(raw);
    seconds = Number.isFinite(date) ? Math.max(0, Math.ceil((date - runtime.now()) / 1000)) : 0;
  }
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) : 0;
}

function quotaOf(data, response) {
  return {
    remaining: cleanNumber(data?.remaining, { integer: true }),
    resetAt: resetAtOf(data, response),
    requests: cleanNumber(data?.requests, { integer: true }),
  };
}

function upstreamFailure(response, data, operation = 'request') {
  const status = Number(response?.status) || 502;
  const message = `${cleanText(data?.message || data?.error, 1000)} ${cleanText(data?.errors?.[0]?.message, 500)}`;
  const resetAt = resetAtOf(data, response);
  if (status === 429 || /quota|rate.?limit|too many requests|download limit/i.test(message)) {
    throw failure('OpenSubtitles quota or rate limit reached.', 429, {
      retryAfter: retryAfterOf(data, response), resetAt,
    });
  }
  if (status === 401 || status === 403 || (operation === 'login' && [400, 406].includes(status))
    || /invalid api.?key|unauthori[sz]ed|authentication failed/i.test(message)) {
    throw failure('OpenSubtitles authentication failed.', 401);
  }
  if (status === 404 || /not found/i.test(message)) throw failure('The subtitle was not found.', 404);
  if (status === 400 || status === 406 || status === 422) throw failure('OpenSubtitles rejected the request.', 400);
  throw failure(`OpenSubtitles returned status ${status}.`, 502);
}

async function apiJson(apiKey, token, route, { method = 'GET', body, operation = 'request' } = {}) {
  const { response, body: bytes } = await fetchBytes(`${BASE}${route}`, {
    method,
    redirect: 'manual',
    headers: {
      Accept: 'application/json',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      'User-Agent': USER_AGENT,
      'Api-Key': apiKey,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }, { apiKey });
  let data = null;
  try { data = JSON.parse(bytes.toString('utf8')); } catch { /* handled below */ }
  const status = Number(response.status) || 200;
  if (!(response.ok ?? (status >= 200 && status < 300)) || status < 200 || status >= 300) {
    upstreamFailure(response, data, operation);
  }
  if (!data || typeof data !== 'object') throw failure('OpenSubtitles returned invalid JSON.', 502);
  return { data, response };
}

function searchResult(row) {
  const attributes = row?.attributes;
  if (!attributes || typeof attributes !== 'object') return [];
  const details = attributes.feature_details || {};
  const files = Array.isArray(attributes.files) ? attributes.files : [];
  return files.flatMap(file => {
    const fileId = fileIdOf(file?.file_id);
    if (!fileId) return [];
    return [{
      fileId: Number(fileId),
      language: cleanText(attributes.language, 40),
      release: cleanText(attributes.release),
      fileName: cleanText(file.file_name),
      fps: cleanNumber(attributes.fps, { max: 1000 }),
      downloadCount: cleanNumber(attributes.download_count, { integer: true }),
      rating: cleanNumber(attributes.ratings, { max: 10 }),
      hearingImpaired: attributes.hearing_impaired === true,
      foreignPartsOnly: attributes.foreign_parts_only === true,
      trusted: attributes.from_trusted === true,
      featureTitle: cleanText(details.title || details.movie_name, 300),
      featureYear: cleanNumber(details.year, { integer: true, min: 0, max: 9999 }),
      season: cleanNumber(details.season_number, { integer: true, min: 0, max: 10000 }),
      episode: cleanNumber(details.episode_number, { integer: true, min: 0, max: 100000 }),
    }];
  });
}

function copySearch(value) {
  return { ...value, results: value.results.map(result => ({ ...result })) };
}

async function performSearch(options) {
  // OpenSubtitles redirects every search to one canonical URL. Sending that
  // form directly avoids a 301: sorted names, lowercase values, no default
  // page, and no redundant machine_translated=exclude (already the default).
  const query = new URLSearchParams({
    query: options.query.toLowerCase(),
    languages: options.language.toLowerCase(),
    type: options.type,
    ai_translated: 'exclude',
  });
  if (options.page > 1) query.set('page', String(options.page));
  if (options.year) query.set('year', String(options.year));
  if (options.season) query.set('season_number', String(options.season));
  if (options.episode) query.set('episode_number', String(options.episode));
  query.sort();
  const { data } = await apiJson(options.apiKey, options.token, `/subtitles?${query}`);
  if (!Array.isArray(data.data)) throw failure('OpenSubtitles returned an invalid search response.', 502);
  return {
    results: data.data.flatMap(searchResult),
    totalPages: cleanNumber(data.total_pages, { integer: true }) ?? 0,
    totalCount: cleanNumber(data.total_count, { integer: true }) ?? 0,
    page: cleanNumber(data.page, { integer: true, min: 1 }) ?? options.page,
  };
}

export async function searchSubtitles({ apiKey, token = '', query, language = 'en', year = 0, season = 0, episode = 0, type = 'episode', page = 1 } = {}) {
  const options = {
    apiKey: apiKeyOf(apiKey), token: tokenOf(token), query: text(query, 'query', 200),
    language: languageOf(language, true), year: integer(year, 'year', 1878, 2100, true),
    season: integer(season, 'season', 1, 100, true), episode: integer(episode, 'episode', 1, 10000, true),
    type: String(type).toLowerCase(), page: integer(page, 'page', 1, 1000),
  };
  if (!['movie', 'episode'].includes(options.type)) throw failure('type must be movie or episode.', 400);
  const key = JSON.stringify(options);
  const hit = searchCache.get(key);
  if (hit && runtime.now() - hit.at < SEARCH_TTL) return copySearch(hit.value);
  if (hit) searchCache.delete(key);
  if (searchInFlight.has(key)) return copySearch(await searchInFlight.get(key));
  const pending = performSearch(options).then(value => {
    searchCache.set(key, { at: runtime.now(), value });
    while (searchCache.size > SEARCH_CAP) searchCache.delete(searchCache.keys().next().value);
    return value;
  });
  searchInFlight.set(key, pending);
  try {
    return copySearch(await pending);
  } finally {
    if (searchInFlight.get(key) === pending) searchInFlight.delete(key);
  }
}

export async function loginSubtitles({ apiKey, username, password } = {}) {
  const key = apiKeyOf(apiKey);
  const userName = text(username, 'username', 200);
  if (typeof password !== 'string' || !password.length || password.length > 512) {
    throw failure('password must contain 1-512 characters.', 400);
  }
  const { data } = await apiJson(key, '', '/login', {
    method: 'POST', operation: 'login', body: { username: userName, password },
  });
  const token = cleanText(data.token, 8192);
  if (!token) throw failure('OpenSubtitles returned an invalid login response.', 502);
  const user = data.user && typeof data.user === 'object' ? data.user : {};
  return {
    token,
    user: {
      id: cleanNumber(user.user_id, { integer: true, min: 1 }),
      username: cleanText(user.username, 200),
      level: cleanText(user.level, 100),
      vip: user.vip === true,
      allowedDownloads: cleanNumber(user.allowed_downloads, { integer: true }),
      downloadsCount: cleanNumber(user.downloads_count, { integer: true }),
      remainingDownloads: cleanNumber(user.remaining_downloads, { integer: true }),
    },
  };
}

function languageName(code) {
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code;
  } catch {
    return code;
  }
}

function trackOf(id, code, releaseName) {
  return {
    id: `opensubtitles:${id}`, lang: languageName(code), code,
    url: `/api/subtitles/file/${id}`, source: 'opensubtitles', releaseName,
  };
}

function httpsUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) throw failure('OpenSubtitles returned an invalid download link.', 502);
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error();
    return url;
  } catch {
    throw failure('OpenSubtitles returned an invalid download link.', 502);
  }
}

async function fetchSubtitle(link) {
  let url = httpsUrl(link);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const { response, body } = await fetchBytes(url, {
      method: 'GET', redirect: 'manual',
      headers: { 'User-Agent': USER_AGENT, Accept: 'text/vtt,text/plain;q=0.9,*/*;q=0.1' },
    }, { timeout: 20000, maximum: MAX_SUBTITLE, networkMessage: 'The subtitle file could not be reached.' });
    const status = Number(response.status) || 200;
    if ([301, 302, 303, 307, 308].includes(status)) {
      if (redirects === MAX_REDIRECTS || !header(response, 'location')) throw failure('The subtitle download redirected too often.', 502);
      try {
        url = httpsUrl(new URL(header(response, 'location'), url).href);
      } catch (err) {
        if (err?.status) throw err;
        throw failure('OpenSubtitles returned an invalid redirect.', 502);
      }
      continue;
    }
    if (!(response.ok ?? (status >= 200 && status < 300)) || status < 200 || status >= 300) {
      upstreamFailure(response, null, 'download');
    }
    return { body, contentType: header(response, 'content-type') };
  }
  throw failure('The subtitle download redirected too often.', 502);
}

const TIME = '(\\d{1,3}):([0-5]\\d):([0-5]\\d)[,.](\\d{1,3})';
const TIMING = new RegExp(`^\\s*${TIME}\\s+-->\\s+${TIME}(?:\\s+.*)?$`);
function timestamp(match, offset) {
  return `${match[offset].padStart(2, '0')}:${match[offset + 1]}:${match[offset + 2]}.${match[offset + 3].padEnd(3, '0')}`;
}

function srtToVtt(input) {
  const lines = input.split('\n');
  const out = ['WEBVTT', ''];
  let cues = 0;
  for (let i = 0; i < lines.length;) {
    while (i < lines.length && !lines[i].trim()) i++;
    if (i >= lines.length) break;
    if (/^\s*\d+\s*$/.test(lines[i]) && TIMING.test(lines[i + 1] || '')) i++;
    const timing = lines[i].match(TIMING);
    if (!timing) return null;
    out.push(`${timestamp(timing, 1)} --> ${timestamp(timing, 5)}`);
    i++;
    while (i < lines.length && lines[i].trim()) out.push(lines[i++]);
    out.push('');
    cues++;
  }
  return cues ? out.join('\n') : null;
}

function asVtt(bytes, contentType) {
  let source = bytes.toString('utf8');
  if (source.charCodeAt(0) === 0xfeff) source = source.slice(1);
  const beginning = source.trimStart().slice(0, 500).toLowerCase();
  if (/\x00/.test(source) || /text\/html|application\/xhtml/i.test(contentType)
    || /^(?:<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]|<script[\s>])/.test(beginning)) {
    throw failure('OpenSubtitles returned HTML or binary data instead of subtitles.', 502);
  }
  source = source.replace(/\r\n?/g, '\n');
  let output;
  if (/^WEBVTT(?:[\t ][^\n]*)?(?:\n|$)/.test(source)) output = source;
  else output = srtToVtt(source);
  if (!output) throw failure('OpenSubtitles returned an unsupported subtitle format.', 502);
  if (!output.endsWith('\n')) output += '\n';
  const result = Buffer.from(output, 'utf8');
  if (result.length > MAX_SUBTITLE) throw failure('The converted subtitle is too large.', 502);
  return result;
}

const emptyQuota = () => ({ remaining: null, resetAt: null, requests: null });

async function populateDownload(apiKey, token, id) {
  const cached = await readSubtitle(id);
  if (cached) return emptyQuota();
  const { data, response } = await apiJson(apiKey, token, '/download', {
    method: 'POST', operation: 'download', body: { file_id: Number(id), sub_format: 'webvtt' },
  });
  if (!data.link) upstreamFailure(response, data, 'download');
  const file = await fetchSubtitle(data.link);
  const vtt = asVtt(file.body, file.contentType);
  try {
    await store().write(id, vtt);
  } catch {
    throw failure('The subtitle cache could not be written.', 503);
  }
  return quotaOf(data, response);
}

export async function downloadSubtitles({ apiKey, token = '', fileId, language = 'en', releaseName = '' } = {}) {
  const key = apiKeyOf(apiKey);
  const jwt = tokenOf(token);
  const id = requiredFileId(fileId);
  const code = languageOf(language);
  const release = text(releaseName, 'releaseName', 500, { optional: true });
  if (await readSubtitle(id)) return { track: trackOf(id, code, release), quota: emptyQuota() };
  const coalesceKey = `${key}\0${id}`;
  let pending = downloadInFlight.get(coalesceKey);
  if (!pending) {
    pending = populateDownload(key, jwt, id);
    downloadInFlight.set(coalesceKey, pending);
    pending.then(
      () => { if (downloadInFlight.get(coalesceKey) === pending) downloadInFlight.delete(coalesceKey); },
      () => { if (downloadInFlight.get(coalesceKey) === pending) downloadInFlight.delete(coalesceKey); },
    );
  }
  const quota = await pending;
  return { track: trackOf(id, code, release), quota };
}

// Kept in one object so production callers only need the four functions above.
export const subtitlesTesting = Object.freeze({
  configure(options = {}) {
    if (options.fetch !== undefined && typeof options.fetch !== 'function') throw new TypeError('fetch must be a function');
    if (options.storage !== undefined && options.storage !== null
      && (typeof options.storage.read !== 'function' || typeof options.storage.write !== 'function')) {
      throw new TypeError('storage must provide read and write functions');
    }
    runtime = {
      ...runtime,
      ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
      ...(options.storage !== undefined ? { storage: options.storage } : {}),
      ...(options.now ? { now: options.now } : {}),
      ...(options.sleep ? { sleep: options.sleep } : {}),
      ...(options.spacing !== undefined ? { spacing: Math.max(0, Number(options.spacing) || 0) } : {}),
    };
  },
  reset() {
    searchCache.clear();
    searchInFlight.clear();
    downloadInFlight.clear();
    requestQueues.clear();
    lastRequest.clear();
    runtime = defaults();
  },
});
