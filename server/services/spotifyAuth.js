/**
 * Spotify OAuth (#2152) — authorization-code flow with refresh tokens for the
 * machine-local Spotify listening-history ingestion (see spotifySync.js).
 *
 * Design constraints (docs/plans/2026-07-04-human-activity-tracking.md):
 *
 * - **Zero new dependencies.** Spotify has no first-party Node SDK we need — the
 *   token exchange is two `fetch` POSTs to `accounts.spotify.com`, so we own the
 *   ~40 lines rather than pull a library (per the dependency policy). Node ≥18
 *   `fetch` is built in.
 * - **Confidential client.** The user creates their own Spotify developer app and
 *   pastes the client id/secret (stored under `data/spotify/`, mirroring
 *   `data/calendar/google-auth/`). We authenticate the token endpoint with HTTP
 *   Basic (`client_secret_basic`) — no PKCE needed for a server-side secret.
 * - **Machine-local.** Credentials + tokens live in `data/spotify/` JSON files,
 *   never federated. Derived `media.listen` events land in the machine-local
 *   `human_activity_events` table.
 * - **No cold-bootstrap side effects.** Nothing here runs at module load; the
 *   first token exchange only happens when the user completes the OAuth flow.
 *
 * The pure helpers (`isTokenExpired`, `withExpiry`, `getRedirectUri`) are exported
 * and unit-tested without any network or filesystem access.
 */
import { dataPath, ensureDir, atomicWrite, tryReadFile } from '../lib/fileUtils.js';
import { ServerError } from '../lib/errorHandler.js';

const AUTH_DIR = dataPath('spotify');
const CREDENTIALS_FILE = dataPath('spotify', 'credentials.json');
const TOKENS_FILE = dataPath('spotify', 'tokens.json');

// Only the read-recently-played scope is required for history ingestion.
// (`user-read-playback-state` would enable a future live "now playing" — out of
// scope here, so we keep the grant minimal.)
export const SPOTIFY_SCOPES = ['user-read-recently-played'];

const ACCOUNTS_BASE = 'https://accounts.spotify.com';

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests — no network, no filesystem).
// ---------------------------------------------------------------------------

/**
 * The redirect URI registered in the user's Spotify developer app. Mirrors
 * googleAuth's env-driven constant so it stays stable across the auth-url and
 * callback round-trip. Surfaced in the auth status so the user can copy the
 * exact string into the Spotify dashboard (it must match byte-for-byte).
 */
export function getRedirectUri() {
  if (process.env.SPOTIFY_REDIRECT_URI) return process.env.SPOTIFY_REDIRECT_URI;
  const host = process.env.PUBLIC_HOST || 'localhost';
  const port = process.env.PORT || 5555;
  return `http://${host}:${port}/api/spotify/oauth/callback`;
}

/**
 * Stamp an absolute `expires_at` (epoch ms) onto a raw Spotify token response so
 * `isTokenExpired` can decide when to refresh. `expires_in` is seconds-from-now.
 */
export function withExpiry(tokens, now = Date.now()) {
  const expiresIn = Number(tokens?.expires_in);
  return {
    ...tokens,
    expires_at: Number.isFinite(expiresIn) ? now + expiresIn * 1000 : null,
  };
}

/**
 * True when the access token is missing or within `skewMs` of its expiry (so a
 * caller refreshes proactively). An unknown `expires_at` counts as expired — we
 * refresh rather than gamble on a stale token. `null`/absent token ⇒ expired.
 */
export function isTokenExpired(tokens, now = Date.now(), skewMs = 60000) {
  if (!tokens?.access_token) return true;
  if (!Number.isFinite(tokens?.expires_at)) return true;
  return now >= tokens.expires_at - skewMs;
}

// ---------------------------------------------------------------------------
// Credentials + tokens (machine-local files under data/spotify/).
// ---------------------------------------------------------------------------

async function ensureAuthDir() {
  await ensureDir(AUTH_DIR);
}

export async function getCredentials() {
  await ensureAuthDir();
  const raw = await tryReadFile(CREDENTIALS_FILE);
  if (!raw) return null;
  return JSON.parse(raw);
}

export async function saveCredentials({ clientId, clientSecret }) {
  await ensureAuthDir();
  const credentials = { clientId, clientSecret, redirectUri: getRedirectUri() };
  await atomicWrite(CREDENTIALS_FILE, credentials);
  console.log('🎧 Spotify OAuth credentials saved');
  return { hasCredentials: true, redirectUri: credentials.redirectUri };
}

export async function getTokens() {
  await ensureAuthDir();
  const raw = await tryReadFile(TOKENS_FILE);
  if (!raw) return null;
  return JSON.parse(raw);
}

async function saveTokens(tokens) {
  await ensureAuthDir();
  await atomicWrite(TOKENS_FILE, tokens);
}

export async function clearAuth() {
  await ensureAuthDir();
  await atomicWrite(TOKENS_FILE, {});
  console.log('🎧 Spotify OAuth tokens cleared');
  return { cleared: true };
}

// ---------------------------------------------------------------------------
// OAuth flow (side-effecting — network via fetch).
// ---------------------------------------------------------------------------

// Exchange with the Spotify token endpoint. `.json()` failures are caught inline
// (a non-JSON error body must not mask the real HTTP status).
async function requestToken(params) {
  const credentials = await getCredentials();
  if (!credentials?.clientId) {
    throw new ServerError('No Spotify OAuth credentials configured', { status: 400 });
  }
  const basic = Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString('base64');
  const res = await fetch(`${ACCOUNTS_BASE}/api/token`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params).toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ServerError(
      `Spotify token request failed: ${json.error_description || json.error || res.status}`,
      { status: 400 },
    );
  }
  return json;
}

export async function getAuthUrl() {
  const credentials = await getCredentials();
  if (!credentials?.clientId) {
    throw new ServerError('No Spotify OAuth credentials configured', { status: 400 });
  }
  const params = new URLSearchParams({
    client_id: credentials.clientId,
    response_type: 'code',
    redirect_uri: getRedirectUri(),
    scope: SPOTIFY_SCOPES.join(' '),
    show_dialog: 'false',
  });
  return { url: `${ACCOUNTS_BASE}/authorize?${params.toString()}` };
}

export async function handleCallback(code) {
  const tokens = await requestToken({
    grant_type: 'authorization_code',
    code,
    redirect_uri: getRedirectUri(),
  });
  await saveTokens(withExpiry(tokens));
  console.log('🎧 Spotify OAuth callback processed, tokens stored');
  return { success: true };
}

/**
 * Return a valid access token, refreshing via the stored refresh token when the
 * current one is expired/near-expiry. Returns `null` when the user hasn't
 * connected (no tokens) or the grant is unrecoverable (no refresh token) — the
 * caller surfaces a "connect in Settings" prompt rather than throwing.
 *
 * Spotify may OMIT `refresh_token` from a refresh response (it stays valid), so
 * the existing refresh token is preserved when the response doesn't carry one.
 */
export async function getAccessToken() {
  const tokens = await getTokens();
  if (!tokens?.access_token && !tokens?.refresh_token) return null;
  if (!isTokenExpired(tokens)) return tokens.access_token;
  if (!tokens?.refresh_token) return null;

  const refreshed = await requestToken({
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token,
  });
  const merged = withExpiry({ ...tokens, ...refreshed });
  if (!refreshed.refresh_token) merged.refresh_token = tokens.refresh_token;
  await saveTokens(merged);
  console.log('🎧 Spotify OAuth access token refreshed');
  return merged.access_token;
}

export async function getAuthStatus() {
  const credentials = await getCredentials();
  const tokens = await getTokens();
  return {
    hasCredentials: !!credentials?.clientId,
    hasTokens: !!(tokens?.access_token || tokens?.refresh_token),
    expiresAt: Number.isFinite(tokens?.expires_at) ? new Date(tokens.expires_at).toISOString() : null,
    scope: tokens?.scope || null,
    redirectUri: getRedirectUri(),
  };
}
