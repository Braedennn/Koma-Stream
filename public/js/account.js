// Account sign-in shared by AniList and MyAnimeList.
//
// The provider applications belong to Koma. A user only chooses a provider and
// approves access to their own account; no client ID or secret is ever shown
// to, or typed by, the person using the app.
import * as anilist from './anilist.js';
import * as myanimelist from './myanimelist.js';

const ACTIVE_KEY = 'koma.account.provider';
const PENDING_KEY = 'koma.oauth.pending';
const PROVIDERS = { anilist, myanimelist };

let pending = null;
let configPromise = null;
let activeName = '';

function storedProvider() {
  let name = '';
  try { name = localStorage.getItem(ACTIVE_KEY) || ''; } catch { /* private mode */ }
  if (PROVIDERS[name]) return name;
  // Existing AniList sessions predate the provider key. Keep that session
  // active instead of making an upgrade look like a sign-out.
  if (anilist.account()) return 'anilist';
  if (myanimelist.account()) return 'myanimelist';
  return '';
}

function applyActive(name) {
  activeName = PROVIDERS[name] ? name : '';
  anilist.setActive(activeName === 'anilist');
  myanimelist.setActive(activeName === 'myanimelist');
}

applyActive(storedProvider());
addEventListener('storage', event => {
  if (event.key === ACTIVE_KEY) applyActive(storedProvider());
});

const provider = () => PROVIDERS[activeName] || null;

export const activeProvider = () => provider()?.provider || '';
export const activeProviderLabel = () => provider()?.providerLabel || '';
export const account = () => provider()?.account() || null;
export const profileUrl = user => provider()?.profileUrl(user) || '';
export const syncPending = () => provider()?.syncPending() || 0;

export function signOut() {
  const current = provider();
  if (current) current.signOut();
  try { localStorage.removeItem(ACTIVE_KEY); } catch { /* private mode */ }
  applyActive('');
  dispatchEvent(new CustomEvent('koma:account'));
}

export function syncNow() {
  return provider()?.syncNow() || Promise.resolve(false);
}

export function initAutoSync() {
  for (const item of Object.values(PROVIDERS)) item.initAutoSync();
}

function config() {
  configPromise ||= fetch('/api/auth/config', { headers: { Accept: 'application/json' } })
    .then(async response => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || `The sign-in configuration could not be loaded (${response.status}).`);
      return data;
    })
    .catch(error => {
      configPromise = null;
      throw error;
    });
  return configPromise;
}

function randomToken(bytes = 32) {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  let text = '';
  for (const value of raw) text += String.fromCharCode(value);
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function savePending(value) {
  pending = value;
  try { sessionStorage.setItem(PENDING_KEY, JSON.stringify(value)); } catch { /* private mode */ }
}

function loadPending() {
  if (pending) return pending;
  try { pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) || 'null'); } catch { pending = null; }
  return pending;
}

function clearPending() {
  pending = null;
  try { sessionStorage.removeItem(PENDING_KEY); } catch { /* private mode */ }
}

const inApp = () => !!window.koma || !!window.KomaAndroid;

/** Starts the provider's own sign-in page. The app shell brings the callback back in. */
export async function startLogin(name) {
  const item = PROVIDERS[name];
  if (!item) throw new Error('That account provider is not available.');
  if (!inApp()) throw new Error('Open Koma on this device to connect your account.');
  const settings = await config();
  const selected = settings?.[name];
  if (!selected?.configured || !selected.clientId) {
    throw new Error(`${item.providerLabel} sign-in is not configured in this build yet.`);
  }

  const state = randomToken(24);
  const verifier = name === 'myanimelist' ? randomToken(64) : '';
  savePending({
    provider: name,
    state,
    verifier,
    redirectUri: selected.redirectUri,
    flow: selected.flow,
    createdAt: Date.now(),
  });

  const url = new URL(name === 'myanimelist'
    ? 'https://myanimelist.net/v1/oauth2/authorize'
    : 'https://anilist.co/api/v2/oauth/authorize');
  url.searchParams.set('client_id', selected.clientId);
  url.searchParams.set('redirect_uri', selected.redirectUri);
  url.searchParams.set('state', state);
  if (selected.flow === 'token') {
    url.searchParams.set('response_type', 'token');
  } else {
    url.searchParams.set('response_type', 'code');
    if (verifier) {
      url.searchParams.set('code_challenge', verifier);
      url.searchParams.set('code_challenge_method', 'plain');
    }
  }
  location.assign(url.toString());
}

/** Finishes the callback, exchanges its code when needed, and loads the user. */
export async function finishLogin(name) {
  const item = PROVIDERS[name];
  if (!item) throw new Error('That account provider is not available.');
  const saved = loadPending();
  if (!saved || saved.provider !== name || Date.now() - Number(saved.createdAt || 0) > 15 * 60e3) {
    clearPending();
    throw new Error('This sign-in request expired. Please try again.');
  }

  const query = new URLSearchParams(location.search);
  const hash = new URLSearchParams(location.hash.replace(/^#/, ''));
  // Check the transaction before reading an error. An unsolicited callback must
  // not be able to clear a valid sign-in that is still in progress.
  const returnedState = query.get('state') || hash.get('state');
  if (!returnedState || returnedState !== saved.state) {
    clearPending();
    throw new Error('The sign-in response did not match this Koma session.');
  }
  const error = query.get('error') || hash.get('error');
  if (error) {
    clearPending();
    throw new Error(query.get('error_description') || hash.get('error_description') || error);
  }

  let session;
  if (saved.flow === 'token') {
    const accessToken = hash.get('access_token');
    if (!accessToken) throw new Error(`${item.providerLabel} did not send a sign-in token back.`);
    session = { accessToken, expiresIn: Number(hash.get('expires_in')) || 365 * 86400 };
  } else {
    const code = query.get('code');
    if (!code) throw new Error(`${item.providerLabel} did not send an authorization code back.`);
    const response = await fetch(`/api/auth/${name}/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ code, redirectUri: saved.redirectUri, codeVerifier: saved.verifier }),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'The sign-in code could not be exchanged.');
    session = data;
  }

  item.setSession(session);
  let user;
  try {
    user = await item.loadUser();
  } catch (error) {
    item.signOut();
    clearPending();
    throw error;
  }

  // Switching providers keeps the other session in storage, but only the
  // selected provider is allowed to synchronize with the local library.
  applyActive(name);
  try { localStorage.setItem(ACTIVE_KEY, name); } catch { /* private mode */ }
  clearPending();
  dispatchEvent(new CustomEvent('koma:account'));

  let syncError = '';
  try {
    await item.syncNow();
  } catch (error) {
    syncError = error?.message || 'The first synchronization did not finish.';
    dispatchEvent(new CustomEvent('koma:sync-error', { detail: syncError }));
  }
  return { user, syncError };
}
