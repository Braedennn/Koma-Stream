// OAuth configuration and code exchange for the two list providers.
//
// The provider credentials belong to Koma, not to the person signing in. They
// are read from a private file (or environment variables) and the secret is
// never sent to the browser. The browser only receives the public client ID it
// needs to build the provider's authorization URL.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// MyAnimeList validates the redirect URI before authentication and accepts
// the loopback URI registered by the application. Android bridges this same
// localhost callback back into its app; the desktop app already serves it.
const REDIRECTS = {
  anilist: 'http://localhost:4000/auth/anilist',
  myanimelist: 'http://localhost:4000/auth/myanimelist',
};

const configFiles = [
  // Packaged desktop app: resources/app-site/auth.json.
  fileURLToPath(new URL('../auth.json', import.meta.url)),
  // Source checkout: .data/auth/oauth.json.
  fileURLToPath(new URL('../.data/auth/oauth.json', import.meta.url)),
];

let fileConfig = {};
for (const file of configFiles) {
  if (!existsSync(file)) continue;
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    if (parsed && typeof parsed === 'object') fileConfig = parsed;
  } catch (error) {
    console.error(`[auth] could not read ${file}: ${error.message}`);
  }
}

const value = (provider, name) => {
  const envName = provider === 'myanimelist' ? 'KOMA_MAL' : 'KOMA_ANILIST';
  const suffix = name === 'clientId' ? 'CLIENT_ID' : name === 'clientSecret' ? 'CLIENT_SECRET' : name.toUpperCase();
  const fromEnv = process.env[`${envName}_${suffix}`];
  if (fromEnv != null && fromEnv.trim()) return fromEnv.trim();
  const section = fileConfig?.[provider];
  const raw = section && typeof section === 'object' ? section[name] : '';
  return typeof raw === 'string' ? raw.trim() : '';
};

const providers = {
  anilist: {
    clientId: value('anilist', 'clientId'),
    clientSecret: value('anilist', 'clientSecret'),
    redirectUri: REDIRECTS.anilist,
  },
  myanimelist: {
    clientId: value('myanimelist', 'clientId'),
    clientSecret: value('myanimelist', 'clientSecret'),
    redirectUri: REDIRECTS.myanimelist,
  },
};

export function publicConfig() {
  return {
    anilist: {
      clientId: providers.anilist.clientId,
      configured: !!providers.anilist.clientId,
      // Without a secret the browser receives the token directly. With one,
      // the local Koma server exchanges the short-lived code instead.
      flow: providers.anilist.clientSecret ? 'code' : 'token',
      redirectUri: providers.anilist.redirectUri,
    },
    myanimelist: {
      clientId: providers.myanimelist.clientId,
      configured: !!providers.myanimelist.clientId,
      flow: 'code',
      redirectUri: providers.myanimelist.redirectUri,
    },
  };
}

class AuthError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

async function postForm(url, fields, headers = {}) {
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        ...headers,
      },
      body: new URLSearchParams(fields),
      signal: AbortSignal.timeout(20000),
    });
  } catch (error) {
    throw new AuthError(`The sign-in service could not be reached (${error.cause?.code || error.name}).`, 503);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    const detail = data.error_description || data.message || data.error || `HTTP ${response.status}`;
    throw new AuthError(`The sign-in service refused the request: ${detail}.`, 502);
  }
  return data;
}

function requireProvider(name) {
  const provider = providers[name];
  if (!provider) throw new AuthError('Unknown sign-in provider.', 400);
  if (!provider.clientId) throw new AuthError('This sign-in provider is not configured.', 503);
  return provider;
}

export async function exchangeAniList(body) {
  const provider = requireProvider('anilist');
  if (!provider.clientSecret) {
    throw new AuthError('AniList code exchange needs the Koma client secret.', 503);
  }
  const code = String(body?.code || '').trim();
  if (!code) throw new AuthError('AniList did not send an authorization code.', 400);
  if (String(body?.redirectUri || '') !== provider.redirectUri) {
    throw new AuthError('The AniList redirect URI did not match.', 400);
  }
  const data = await postForm('https://anilist.co/api/v2/oauth/token', {
    grant_type: 'authorization_code',
    client_id: provider.clientId,
    client_secret: provider.clientSecret,
    redirect_uri: provider.redirectUri,
    code,
  });
  if (!data.access_token) throw new AuthError('AniList did not return an access token.', 502);
  return {
    accessToken: data.access_token,
    refreshToken: '',
    expiresIn: Number(data.expires_in) || 365 * 86400,
  };
}

export async function exchangeMyAnimeList(body) {
  const provider = requireProvider('myanimelist');
  const code = String(body?.code || '').trim();
  const verifier = String(body?.codeVerifier || '').trim();
  if (!code) throw new AuthError('MyAnimeList did not send an authorization code.', 400);
  if (verifier.length < 43 || verifier.length > 128) {
    throw new AuthError('The MyAnimeList PKCE verifier is invalid.', 400);
  }
  if (String(body?.redirectUri || '') !== provider.redirectUri) {
    throw new AuthError('The MyAnimeList redirect URI did not match.', 400);
  }
  const basic = Buffer.from(`${provider.clientId}:${provider.clientSecret}`).toString('base64');
  const data = await postForm('https://myanimelist.net/v1/oauth2/token', {
    grant_type: 'authorization_code',
    client_id: provider.clientId,
    redirect_uri: provider.redirectUri,
    code,
    code_verifier: verifier,
  }, { Authorization: `Basic ${basic}` });
  if (!data.access_token) throw new AuthError('MyAnimeList did not return an access token.', 502);
  return {
    accessToken: data.access_token,
    refreshToken: String(data.refresh_token || ''),
    expiresIn: Number(data.expires_in) || 3600,
  };
}

export async function refreshMyAnimeList(body) {
  const provider = requireProvider('myanimelist');
  const refreshToken = String(body?.refreshToken || '').trim();
  if (!refreshToken) throw new AuthError('The MyAnimeList refresh token is missing.', 400);
  const basic = Buffer.from(`${provider.clientId}:${provider.clientSecret}`).toString('base64');
  const data = await postForm('https://myanimelist.net/v1/oauth2/token', {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  }, { Authorization: `Basic ${basic}` });
  if (!data.access_token) throw new AuthError('MyAnimeList did not return a new access token.', 502);
  return {
    accessToken: data.access_token,
    refreshToken: String(data.refresh_token || refreshToken),
    expiresIn: Number(data.expires_in) || 3600,
  };
}
