import { join } from 'path';
import { PATHS, tryReadFile } from '../lib/fileUtils.js';
import { ensureSecureDir, writeSecureJson } from '../lib/secureAuthStore.js';
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js';
import { ServerError } from '../lib/errorHandler.js';
import { createGoogleOAuthClient } from '../lib/googleOAuthClient.js';
import { createOAuthStateStore, INVALID_OAUTH_STATE_MESSAGE } from '../lib/oauthState.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { PORTS } from '../lib/ports.js';

const AUTH_DIR = join(PATHS.calendar, 'google-auth');
const CREDENTIALS_FILE = join(AUTH_DIR, 'credentials.json');
const TOKENS_FILE = join(AUTH_DIR, 'tokens.json');
const SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/gmail.modify'
];
export const GOOGLE_API_TIMEOUT_MS = 30_000;
export const OAUTH_REDIRECT_URI = `http://${process.env.PUBLIC_HOST || 'localhost'}:${process.env.PORT || PORTS.API}/api/calendar/google/oauth/callback`;

let oAuth2Client = null;
// Token refreshes, client loads, and disconnects share this generation and write tail.
let authGeneration = 0;
let activeClears = 0;
const queueTokenWrite = createFileWriteQueue();
const oauthState = createOAuthStateStore();

async function ensureAuthDir() {
  await ensureSecureDir(AUTH_DIR);
}

export async function getCredentials() {
  await ensureAuthDir();
  const raw = await tryReadFile(CREDENTIALS_FILE);
  if (!raw) return null;
  return JSON.parse(raw);
}

export async function saveCredentials({ clientId, clientSecret }) {
  authGeneration++;
  oAuth2Client = null;
  const credentials = { clientId, clientSecret, redirectUri: OAUTH_REDIRECT_URI };
  await queueTokenWrite(async () => {
    await ensureAuthDir();
    await writeSecureJson(CREDENTIALS_FILE, credentials);
    // Re-bump after serializing so any overlapping exchange or reader is invalidated.
    authGeneration++;
    oAuth2Client = null;
  });
  console.log('📅 Google OAuth credentials saved');
  return { hasCredentials: true, redirectUri: credentials.redirectUri };
}

export async function getTokens() {
  await ensureAuthDir();
  const raw = await tryReadFile(TOKENS_FILE);
  if (!raw) return null;
  return JSON.parse(raw);
}

async function persistRefreshedTokens(newTokens, generation) {
  await queueTokenWrite(async () => {
    if (generation !== authGeneration || activeClears > 0) return;
    await ensureAuthDir();
    const existing = (await getTokens()) || {};
    if (generation !== authGeneration || activeClears > 0) return;
    await writeSecureJson(TOKENS_FILE, { ...existing, ...newTokens });
  });
  if (generation !== authGeneration || activeClears > 0) return;
  console.log('📅 Google OAuth tokens refreshed');
}

function attachTokenPersistence(client, generation) {
  client.on('tokens', (newTokens) => {
    persistRefreshedTokens(newTokens, generation)
      .catch((err) => console.error(`❌ Failed to persist refreshed Google OAuth tokens: ${err.message}`));
  });
}

const REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const REVOKE_TIMEOUT_MS = 5_000;

// Best-effort: disconnecting must succeed locally even when Google is unreachable.
async function revokeToken(token) {
  if (!token) return;
  const res = await fetchWithTimeout(REVOKE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ token }).toString(),
  }, REVOKE_TIMEOUT_MS).catch((err) => ({ ok: false, status: err?.name || 'error' }));
  console.log(res.ok
    ? '📅 Google OAuth token revoked upstream'
    : `⚠️ Google OAuth token revocation not accepted (${res.status}); clearing local copy anyway`);
}

export async function clearAuth() {
  authGeneration++;
  oAuth2Client = null;
  activeClears++;
  let tokenToRevoke = null;
  try {
    await queueTokenWrite(async () => {
      await ensureAuthDir();
      const tokens = await getTokens().catch(() => null);
      tokenToRevoke = tokens?.refresh_token || tokens?.access_token || null;
      await writeSecureJson(TOKENS_FILE, {});
      // Re-bump after clearing disk so no reader that raced before the lock can survive.
      authGeneration++;
      oAuth2Client = null;
    });
  } finally {
    activeClears--;
  }
  await revokeToken(tokenToRevoke);
  console.log('📅 Google OAuth tokens cleared');
}

// The owned client is a Node-fetch leaf (#17250). It stays out of the boot
// package closure that used to pay for google-auth-library (#16558).
function createOAuth2Client(credentials) {
  return createGoogleOAuthClient({
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    redirectUri: credentials.redirectUri || OAUTH_REDIRECT_URI,
    // Token exchange/refresh uses its own transport, before an API request's
    // deadline applies. Keep the transport's retries and per-request overrides.
    timeoutMs: GOOGLE_API_TIMEOUT_MS,
  });
}

export async function getAuthUrl(returnTo = 'calendar') {
  const credentials = await getCredentials();
  if (!credentials) throw new ServerError('No Google OAuth credentials configured', { status: 400 });

  const client = createOAuth2Client(credentials);
  const url = client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state: oauthState.issue({ returnTo: returnTo === 'messages' ? 'messages' : 'calendar' }),
  });
  return { url };
}

async function exchangeAuthorizationCode(code) {
  const generation = authGeneration;
  const credentials = await getCredentials();
  if (!credentials) throw new ServerError('No credentials configured', { status: 400 });

  const client = createOAuth2Client(credentials);
  const { tokens } = await client.getToken(code);
  let saved = false;
  await queueTokenWrite(async () => {
    if (generation !== authGeneration || activeClears > 0) return;
    await ensureAuthDir();
    await writeSecureJson(TOKENS_FILE, tokens);
    // Re-check after the write: clearAuth() or saveCredentials() may have started
    // while writeSecureJson was in flight. When saveCredentials() superseded the
    // exchange without a queued clearAuth(), clear the mismatched-client tokens
    // rather than leaving them paired with the new credentials.
    if (generation !== authGeneration || activeClears > 0) {
      if (activeClears === 0) await writeSecureJson(TOKENS_FILE, {});
      return;
    }
    client.setCredentials(tokens);
    attachTokenPersistence(client, generation);
    oAuth2Client = client;
    saved = true;
  });
  if (!saved) throw new Error('Google OAuth credentials changed during authorization');

  console.log('📅 Google OAuth callback processed, tokens stored');
}

export async function handleCallback({ code, state, error }) {
  const pending = oauthState.consume(state);
  if (!pending) return { error: INVALID_OAUTH_STATE_MESSAGE };
  const { returnTo } = pending;
  if (error || !code) return { returnTo, error: error || 'Missing authorization code' };

  return exchangeAuthorizationCode(code).then(() => ({ returnTo, success: true }))
    .catch((err) => {
      console.error(`❌ Google OAuth callback failed: ${err.message}`);
      return { returnTo, error: err.message || 'Google OAuth callback failed' };
    });
}

export async function getAuthenticatedClient() {
  if (activeClears > 0) return null;
  const generation = authGeneration;
  const credentials = await getCredentials();
  if (!credentials?.clientId) return null;

  const tokens = await getTokens();
  if (!tokens?.access_token) return null;
  if (generation !== authGeneration || activeClears > 0) return null;

  if (!oAuth2Client) {
    const client = createOAuth2Client(credentials);
    client.setCredentials(tokens);

    attachTokenPersistence(client, generation);
    oAuth2Client = client;
  }

  return oAuth2Client;
}

export function needsScopeUpgrade(tokens) {
  if (!tokens?.scope) return true;
  const scopes = tokens.scope.split(' ');
  // Check all required scopes are present
  return !SCOPES.every(s => scopes.includes(s));
}

export async function getAuthStatus() {
  const credentials = await getCredentials();
  const tokens = await getTokens();
  return {
    hasCredentials: !!credentials?.clientId,
    hasTokens: !!tokens?.access_token,
    expiryDate: tokens?.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
    needsScopeUpgrade: needsScopeUpgrade(tokens)
  };
}
