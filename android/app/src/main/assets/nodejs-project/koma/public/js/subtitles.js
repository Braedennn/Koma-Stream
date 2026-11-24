// OpenSubtitles search and optional account sign-in. Credentials belong to the
// viewer; Koma's loopback server forwards them without exposing upstream links.
import { $, $$, esc, toast } from './ui.js';

const KEY = 'koma.opensubtitles';
let credentials = (() => {
  try { return { apiKey: '', token: '', user: null, username: '', ...JSON.parse(localStorage.getItem(KEY) || '{}') }; }
  catch { return { apiKey: '', token: '', user: null, username: '' }; }
})();
let searchDialog = null;
let activePlayer = null;
let results = [];
let generation = 0;
let builtInKey = false;
let defaultNote = '';

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(credentials)); } catch { /* private mode */ }
  dispatchEvent(new CustomEvent('koma:opensubtitles'));
}

function headers(withToken = true) {
  const h = { Accept: 'application/json' };
  if (credentials.apiKey) h['x-opensubtitles-key'] = credentials.apiKey;
  if (withToken && credentials.token) h['x-opensubtitles-token'] = credentials.token;
  return h;
}

async function request(path, { method = 'GET', body, token = true } = {}) {
  let response;
  try {
    response = await fetch(path, {
      method,
      headers: { ...headers(token), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error('Koma could not reach its local subtitle service.');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `OpenSubtitles answered with status ${response.status}.`);
    error.status = response.status;
    error.resetAt = data.resetAt || '';
    throw error;
  }
  return data;
}

function paintAccount() {
  const apiKey = $('[data-os-api-key]');
  if (apiKey && apiKey.value !== credentials.apiKey) apiKey.value = credentials.apiKey;
  if (apiKey) apiKey.placeholder = builtInKey ? 'Built into this TV app' : 'Your OpenSubtitles API key';
  const note = $('[data-os-note]');
  if (note) {
    if (!defaultNote) defaultNote = note.textContent;
    note.textContent = builtInKey
      ? 'Koma TV includes its OpenSubtitles application key, so you do not need to enter one. Sign in optionally with your own OpenSubtitles account to use its download allowance, or add a personal API key to override the built-in one.'
      : defaultNote;
  }
  const username = $('[data-os-username]');
  if (username && !username.value) username.value = credentials.username || '';
  const status = $('[data-os-status]');
  if (status) {
    status.textContent = credentials.token
      ? `Connected${credentials.username ? ` as ${credentials.username}` : ''}${credentials.user?.level ? ` · ${credentials.user.level}` : ''}`
      : credentials.apiKey ? 'API key saved · anonymous downloads'
        : builtInKey ? 'Koma TV API key ready · anonymous downloads' : 'Add your API key to search';
  }
  const login = $('[data-os-login]');
  const logout = $('[data-os-logout]');
  if (login) login.hidden = Boolean(credentials.token);
  if (logout) logout.hidden = !credentials.token;
}

async function login(button) {
  const apiKey = $('[data-os-api-key]')?.value.trim() || '';
  const username = $('[data-os-username]')?.value.trim() || '';
  const password = $('[data-os-password]')?.value || '';
  if ((!apiKey && !builtInKey) || !username || !password) {
    toast(builtInKey ? 'Enter your OpenSubtitles username and password first' : 'Enter your API key, username and password first');
    return;
  }
  credentials.apiKey = apiKey;
  button.disabled = true;
  try {
    const data = await request('/api/subtitles/login', { method: 'POST', body: { username, password }, token: false });
    credentials = { apiKey, token: data.token, user: data.user || null, username };
    const passwordInput = $('[data-os-password]');
    if (passwordInput) passwordInput.value = '';
    save();
    toast('OpenSubtitles connected');
  } catch (error) {
    toast(error.message);
  } finally {
    button.disabled = false;
    paintAccount();
  }
}

function renderResults(message = '') {
  const box = $('[data-os-results]', searchDialog);
  if (!box) return;
  if (message) {
    box.innerHTML = `<p class="subtitle-empty">${esc(message)}</p>`;
    return;
  }
  box.innerHTML = results.map(result => {
    const facts = [
      result.language,
      result.fps ? `${result.fps} fps` : '',
      result.downloadCount ? `${result.downloadCount.toLocaleString()} downloads` : '',
      result.rating ? `${Number(result.rating).toFixed(1)}/10` : '',
      result.trusted ? 'Trusted' : '',
      result.hearingImpaired ? 'Hearing impaired' : '',
      result.foreignPartsOnly ? 'Foreign parts only' : '',
    ].filter(Boolean).join(' · ');
    return `<article class="subtitle-result"><div><b>${esc(result.release || result.fileName || `Subtitle ${result.fileId}`)}</b><small>${esc(facts)}</small></div><button class="btn btn-ghost btn-sm" type="button" data-os-add="${result.fileId}">Add</button></article>`;
  }).join('');
}

async function search(button) {
  const seq = ++generation;
  const query = $('[data-os-query]', searchDialog)?.value.trim() || '';
  if (!query) {
    renderResults('Enter a title to search.');
    return;
  }
  const params = new URLSearchParams({
    query,
    language: $('[data-os-language]', searchDialog)?.value.trim() || 'en',
    type: $('[data-os-type]', searchDialog)?.value || 'episode',
    season: $('[data-os-season]', searchDialog)?.value || '0',
    episode: $('[data-os-episode]', searchDialog)?.value || '0',
    year: $('[data-os-year]', searchDialog)?.value || '0',
  });
  button.disabled = true;
  button.textContent = 'Searching…';
  renderResults('Searching OpenSubtitles…');
  try {
    const data = await request(`/api/subtitles/search?${params}`);
    if (seq !== generation) return;
    results = Array.isArray(data.results) ? data.results : [];
    if (!results.length) {
      renderResults('No matching releases. Try another title language, leave Season empty, or correct the episode number.');
      return;
    }
    renderResults();
  } catch (error) {
    if (seq !== generation) return;
    results = [];
    const suffix = error.resetAt ? ` Quota resets ${error.resetAt}.` : '';
    renderResults(`${error.message}${suffix}`);
  } finally {
    if (seq === generation) {
      button.disabled = false;
      button.textContent = 'Search';
    }
  }
}

async function add(button) {
  const result = results.find(item => String(item.fileId) === button.dataset.osAdd);
  if (!result || !activePlayer) return;
  button.disabled = true;
  button.textContent = 'Adding…';
  try {
    const data = await request('/api/subtitles/download', {
      method: 'POST',
      body: { fileId: result.fileId, language: result.language, releaseName: result.release || result.fileName || '' },
    });
    if (!activePlayer.addSubtitleTrack(data.track)) throw new Error('The player could not attach this subtitle release.');
    searchDialog.close();
    const left = Number(data.quota?.remaining);
    toast(`Subtitles added${Number.isFinite(left) ? ` · ${left} OpenSubtitles downloads left` : ''}`);
  } catch (error) {
    toast(error.message);
    button.disabled = false;
    button.textContent = 'Add';
  }
}

export function openSubtitleSearch(player, media = {}) {
  if (!searchDialog || !player) return;
  activePlayer = player;
  generation++;
  results = [];
  $('[data-os-query]', searchDialog).value = media.title || '';
  $('[data-os-language]', searchDialog).value = media.language || 'en';
  $('[data-os-type]', searchDialog).value = media.type === 'movie' ? 'movie' : 'episode';
  $('[data-os-season]', searchDialog).value = Number(media.season) > 0 ? String(media.season) : '';
  $('[data-os-episode]', searchDialog).value = Number(media.episode) > 0 ? String(media.episode) : '';
  $('[data-os-year]', searchDialog).value = Number(media.year) > 0 ? String(media.year) : '';
  $('[data-os-season]', searchDialog).disabled = media.type === 'movie';
  $('[data-os-episode]', searchDialog).disabled = media.type === 'movie';
  renderResults('Search when you are ready. Season is optional because anime numbering does not always match OpenSubtitles.');
  if (!searchDialog.open) searchDialog.showModal();
}

export function initSubtitles() {
  searchDialog = $('#subtitle-search');
  if (!searchDialog) return;
  paintAccount();
  request('/api/subtitles/status', { token: false }).then(status => {
    builtInKey = Boolean(status.builtIn);
    paintAccount();
  }).catch(() => { /* the ordinary personal-key flow remains available */ });
  $('[data-os-api-key]')?.addEventListener('change', event => {
    const value = event.target.value.trim();
    if (value === credentials.apiKey) return;
    credentials = { apiKey: value, token: '', user: null, username: $('[data-os-username]')?.value.trim() || '' };
    save();
    paintAccount();
  });
  $('[data-os-login]')?.addEventListener('click', event => login(event.currentTarget));
  $('[data-os-logout]')?.addEventListener('click', () => {
    credentials.token = '';
    credentials.user = null;
    save();
    paintAccount();
    toast(builtInKey ? 'OpenSubtitles signed out; the built-in TV key remains available' : 'OpenSubtitles signed out; your API key is still saved');
  });
  searchDialog.querySelector('[data-close]')?.addEventListener('click', () => searchDialog.close());
  searchDialog.addEventListener('click', event => { if (event.target === searchDialog) searchDialog.close(); });
  $('[data-os-search]', searchDialog)?.addEventListener('click', event => search(event.currentTarget));
  $('[data-os-query]', searchDialog)?.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); $('[data-os-search]', searchDialog)?.click(); }
  });
  $('[data-os-type]', searchDialog)?.addEventListener('change', event => {
    const movie = event.target.value === 'movie';
    $('[data-os-season]', searchDialog).disabled = movie;
    $('[data-os-episode]', searchDialog).disabled = movie;
  });
  $('[data-os-results]', searchDialog)?.addEventListener('click', event => {
    const button = event.target.closest('[data-os-add]');
    if (button) add(button);
  });
  searchDialog.addEventListener('close', () => { generation++; activePlayer = null; results = []; });
  addEventListener('koma:opensubtitles', paintAccount);
}
