import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';
import express from 'express';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { closeLoopbackServer, startLoopbackServer } from '../lib/testHelper.js';
import { remoteRequestHandler } from '../lib/requestOrigin.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { authGate, hostControlRouteGate } from '../services/authGate.js';
import { clearPassword, setPassword } from '../services/auth.js';
import { resolveAgentApiEnv } from '../services/agent/agentApiAuth.js';
import * as googleAuth from '../services/googleAuth.js';
import * as spotifyAuth from '../services/spotifyAuth.js';
import calendarRoutes from './calendar.js';
import spotifyRoutes from './spotify.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) => {
  const dataRoot = () => lazyTempDataRoot('portos-oauth-flows-');
  return makePathsProxy(await importOriginal(), {
    dataRoot,
    // dataPath closes over the original PATHS. Spotify uses it directly.
    overrides: { dataPath: (...parts) => join(dataRoot(), ...parts) },
  });
});

const { googleToken, spotifyToken } = vi.hoisted(() => ({ googleToken: vi.fn(), spotifyToken: vi.fn() }));
vi.mock('../lib/googleOAuthClient.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createGoogleOAuthClient: (options) => actual.createGoogleOAuthClient({ ...options, fetchImplementation: googleToken }),
  };
});
vi.mock('../lib/fetchWithTimeout.js', () => ({ fetchWithTimeout: spotifyToken }));
vi.mock('../services/calendarAccounts.js', () => ({}));
vi.mock('../services/calendarSync.js', () => ({}));
vi.mock('../services/calendarGoogleSync.js', () => ({}));
vi.mock('../services/dailyReview.js', () => ({}));
vi.mock('../services/calendarGoogleApiSync.js', () => ({}));
vi.mock('../services/googleOAuthAutoConfig.js', () => ({}));
vi.mock('../services/spotifySync.js', () => ({}));
vi.mock('../services/spotifyPlaylists.js', () => ({}));

const crossSite = { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document' };
const providers = [
  {
    name: 'Google',
    start: '/api/calendar/google/auth/url?returnTo=messages',
    callback: '/api/calendar/google/oauth/callback',
    success: '/messages/config',
    fallback: '/calendar/config',
    service: googleAuth,
    tokenEndpoint: googleToken,
  },
  {
    name: 'Spotify',
    start: '/api/spotify/auth/url',
    callback: '/api/spotify/oauth/callback',
    success: '/brain/spotify?oauthConnected=1',
    fallback: '/brain/spotify',
    service: spotifyAuth,
    tokenEndpoint: spotifyToken,
  },
];

let localServer;
let remoteServer;

beforeAll(async () => {
  const app = express();
  app.use(authGate, hostControlRouteGate);
  app.use('/api/calendar', calendarRoutes);
  app.use('/api/spotify', spotifyRoutes);
  app.use(errorMiddleware);
  localServer = await startLoopbackServer(app);
  remoteServer = await startLoopbackServer(remoteRequestHandler(app));

  for (const { service } of providers) {
    await service.saveCredentials({ clientId: 'example-client', clientSecret: 'example-secret' });
  }
});

afterAll(async () => {
  await Promise.all([localServer, remoteServer].filter(Boolean).map(closeLoopbackServer));
  cleanupTempDataRoots();
});

beforeEach(() => {
  vi.stubEnv('SPOTIFY_REDIRECT_URI', undefined);
  for (const { tokenEndpoint } of providers) {
    tokenEndpoint.mockReset().mockImplementation(async () => Response.json({
      access_token: 'example-access', refresh_token: 'example-refresh', expires_in: 3600,
    }));
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function call(server, path, { headers, method = 'GET' } = {}) {
  return fetch(`http://127.0.0.1:${server.address().port}${path}`, { headers, method, redirect: 'manual' });
}

async function authorize(server, path, headers) {
  const response = await call(server, path, { method: 'POST', headers });
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const { url } = await response.json();
  const params = new URL(url).searchParams;
  expect(params.get('state')).toMatch(/^[A-Za-z0-9_-]{32}$/);
  return params;
}

async function expectOAuthError(server, path, destination, headers = crossSite) {
  const response = await call(server, path, { headers });
  expect(response.status).toBe(302);
  const target = new URL(response.headers.get('location'), 'http://example.test');
  expect(target.pathname).toBe(destination);
  expect(target.searchParams.get('oauthError')).toMatch(/OAuth state/);
}

describe.each(providers)('$name OAuth', ({ start, callback, success, fallback, service, tokenEndpoint }) => {
  it('refuses old GET initiation, remote password-free initiation and originless cross-site POSTs', async () => {
    expect((await call(localServer, start)).status).toBe(404);
    expect((await call(remoteServer, start, { method: 'POST' })).status).toBe(403);
    expect((await call(localServer, start, { method: 'POST', headers: crossSite })).status).toBe(403);
  });

  it('rejects missing, unknown, malformed and expired state before exchange', async () => {
    const tokensBefore = await service.getTokens();
    const params = await authorize(localServer, start);
    const state = params.get('state');
    expect((await authorize(localServer, start)).get('state')).not.toBe(state);

    for (const query of [
      'code=example-code',
      `code=example-code&state=${'x'.repeat(32)}`,
      `code=example-code&state=${state}&state=${state}`,
    ]) {
      await expectOAuthError(localServer, `${callback}?${query}`, fallback);
    }
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 10 * 60 * 1000);
    await expectOAuthError(localServer, `${callback}?code=example-code&state=${state}`, fallback);

    expect(tokenEndpoint).not.toHaveBeenCalled();
    expect(await service.getTokens()).toEqual(tokensBefore);
  });

  it('completes an authorization started locally and rejects a replay', async () => {
    const params = await authorize(localServer, start);
    const path = `${callback}?code=example-code&state=${params.get('state')}&returnTo=calendar`;
    const response = await call(localServer, path, {
      headers: { ...crossSite, 'X-Forwarded-Host': 'different.example.test', 'X-Forwarded-Proto': 'https' },
    });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(success);
    const [, options] = tokenEndpoint.mock.calls[0];
    expect(new URLSearchParams(options.body).get('redirect_uri')).toBe(params.get('redirect_uri'));
    expect(await service.getTokens()).toMatchObject({ access_token: 'example-access' });

    await expectOAuthError(localServer, path, fallback);
    expect(tokenEndpoint).toHaveBeenCalledTimes(1);
  });

  it('accepts a provider denial once and preserves the verified destination', async () => {
    const { pathname } = new URL(success, 'http://example.test');
    const params = await authorize(localServer, start);
    const path = `${callback}?error=access_denied&state=${params.get('state')}`;
    const response = await call(localServer, path, { headers: crossSite });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(`${pathname}?oauthError=access_denied`);
    await expectOAuthError(localServer, path, fallback);
    expect(tokenEndpoint).not.toHaveBeenCalled();
  });
});

it('preserves authenticated operator and delegated agent initiation and authentic browser callbacks', async () => {
  const newPassword = 'example-test-password';
  const { token } = await setPassword({ newPassword });
  try {
    const human = { Cookie: `portos_auth=${token}` };
    const { PORTOS_API_TOKEN } = await resolveAgentApiEnv();
    expect(PORTOS_API_TOKEN).toBeTruthy();
    const agent = { Authorization: `Bearer ${PORTOS_API_TOKEN}` };
    for (const { start, callback, success, fallback, tokenEndpoint } of providers) {
      expect((await call(remoteServer, start, { method: 'POST' })).status).toBe(401);
      expect((await call(remoteServer, start, { method: 'POST', headers: { ...human, ...crossSite } })).status).toBe(403);
      await authorize(remoteServer, start, human);
      const params = await authorize(remoteServer, start, agent);
      const headers = { ...human, ...crossSite };
      await expectOAuthError(remoteServer, `${callback}?code=example-code`, fallback, headers);
      expect(tokenEndpoint).not.toHaveBeenCalled();
      const response = await call(remoteServer, `${callback}?code=example-code&state=${params.get('state')}`, { headers });
      expect(response.status).toBe(302);
      expect(response.headers.get('location')).toBe(success);
      expect(tokenEndpoint).toHaveBeenCalledTimes(1);
    }
  } finally {
    await clearPassword({ currentPassword: newPassword });
  }
});
