import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer } from 'node:http';

// Drive the owned OAuth client against a loopback token endpoint to catch
// regressions in refresh, credential merging, and the tokens event (#7372).

vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { calendar: '/test/calendar' },
  ensureDir: vi.fn(async () => {}),
  tryReadFile: vi.fn(),
  atomicWrite: vi.fn(async () => {}),
}));

vi.mock('../lib/fetchWithTimeout.js', () => ({ fetchWithTimeout: vi.fn(async () => ({ ok: true, status: 200 })) }));
vi.mock('../lib/secureAuthStore.js', () => ({
  ensureSecureDir: vi.fn(async () => {}),
  writeSecureJson: (...args) => atomicWriteMock(...args),
}));

import * as googleOAuthClient from '../lib/googleOAuthClient.js';
import { atomicWrite, tryReadFile } from '../lib/fileUtils.js';
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js';
import { clearAuth, getAuthenticatedClient, getAuthUrl, handleCallback, saveCredentials } from './googleAuth.js';

function atomicWriteMock(...args) { return atomicWrite(...args); }

const { createGoogleOAuthClient } = googleOAuthClient;

const CREDENTIALS = { clientId: 'test-client-id', clientSecret: 'test-secret', redirectUri: 'http://localhost:5555/cb' };
const REFRESHED = { access_token: 'refreshed-access', expires_in: 3600, scope: 'https://www.googleapis.com/auth/calendar', token_type: 'Bearer' };

let server;
let tokenUrl;
let requestBodies;
let tokenResponse;

/** Files googleAuth.js reads by path; anything else is absent. */
function stubFiles({ credentials = CREDENTIALS, tokens }) {
  tryReadFile.mockImplementation(async (file) => {
    if (file.endsWith('credentials.json')) return credentials ? JSON.stringify(credentials) : null;
    if (file.endsWith('tokens.json')) return tokens ? JSON.stringify(tokens) : null;
    return null;
  });
}

const expiredTokens = () => ({ access_token: 'stale-access', refresh_token: 'durable-refresh', expiry_date: Date.now() - 60_000, scope: 'https://www.googleapis.com/auth/calendar' });

/**
 * Redirect one client's token endpoint at the loopback server. Asserts the knob
 * still exists first: without it the refresh below would leave the machine for
 * Google's real endpoint, turning a contract break into a confusing network
 * failure. A major that renames it should fail HERE, saying so.
 */
function redirectTokenEndpoint(client) {
  expect(typeof client.endpoints?.oauth2TokenUrl).toBe('string');
  client.endpoints.oauth2TokenUrl = tokenUrl;
}

/** The write googleAuth.js makes for the tokens file, or undefined. */
const lastTokenWrite = () => atomicWrite.mock.calls.filter(([file]) => file.endsWith('tokens.json')).at(-1)?.[1];

beforeEach(async () => {
  requestBodies = [];
  tokenResponse = { status: 200, body: REFRESHED };
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    // A socket the client aborts mid-request would otherwise surface as an
    // unhandled 'error' and take the worker down rather than failing a test.
    req.on('error', () => {});
    res.on('error', () => {});
    req.on('end', () => {
      requestBodies.push(body);
      res.writeHead(tokenResponse.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(tokenResponse.body));
    });
  });
  server.on('clientError', (_err, socket) => socket.destroy());
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  tokenUrl = `http://127.0.0.1:${server.address().port}/token`;

  stubFiles({ tokens: null });
  await clearAuth();          // drop the module-level client cached by a prior test
  vi.clearAllMocks();
});

afterEach(async () => {
  // gaxios holds the refresh connection open; close() alone would wait on it.
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  vi.restoreAllMocks();
});

describe('googleAuth OAuth2 client contract', () => {
  it('exports a constructible OAuth client', () => {
    expect(typeof createGoogleOAuthClient).toBe('function');
    const client = createGoogleOAuthClient(CREDENTIALS);
    expect(client.credentials).toEqual({});
  });

  it('generates a consent URL carrying the offline/consent/state options getAuthUrl passes', () => {
    const client = createGoogleOAuthClient(CREDENTIALS);
    const url = client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: ['https://www.googleapis.com/auth/calendar'],
      state: 'messages',
    });
    expect(url).toContain('access_type=offline');
    expect(url).toContain('prompt=consent');
    // The callback is shared by Calendar and Messages; the state is what routes
    // the user back to the tab they started from.
    expect(url).toContain('state=messages');
  });

  it('returns null until both credentials and an access token exist', async () => {
    stubFiles({ credentials: null, tokens: expiredTokens() });
    expect(await getAuthenticatedClient()).toBeNull();

    stubFiles({ tokens: null });
    await clearAuth();
    expect(await getAuthenticatedClient()).toBeNull();
  });
});

describe('googleAuth token refresh', () => {
  it('refreshes an expired access token and persists it without losing the refresh token', async () => {
    stubFiles({ tokens: expiredTokens() });
    const client = await getAuthenticatedClient();
    redirectTokenEndpoint(client);

    const { token } = await client.getAccessToken();

    expect(token).toBe(REFRESHED.access_token);
    expect(client.credentials.access_token).toBe(REFRESHED.access_token);
    // The refresh response carries no refresh token of its own; the client
    // re-attaches the one it was seeded with. Losing it would strand the
    // install on a silent re-authorization prompt.
    expect(client.credentials.refresh_token).toBe('durable-refresh');
    expect(client.credentials.expiry_date).toBeGreaterThan(Date.now());
    expect(requestBodies).toHaveLength(1);
    expect(requestBodies[0]).toContain('grant_type=refresh_token');
    expect(requestBodies[0]).toContain('refresh_token=durable-refresh');

    await vi.waitFor(() => expect(lastTokenWrite()).toMatchObject({
      access_token: REFRESHED.access_token,
      refresh_token: 'durable-refresh',
    }));
  });

  it('keeps the stored refresh token when the refresh payload omits it', async () => {
    stubFiles({ tokens: expiredTokens() });
    const client = await getAuthenticatedClient();

    // A token endpoint is not obliged to echo the refresh token back, and the
    // client only re-attaches it as a convenience. Persistence must merge over
    // what is already on disk rather than trust the payload to be complete —
    // writing the bare payload would strand the install on a re-auth prompt at
    // the next expiry.
    client.emit('tokens', { access_token: 'rotated-access', expiry_date: Date.now() + 3_600_000 });

    await vi.waitFor(() => expect(lastTokenWrite()).toMatchObject({
      access_token: 'rotated-access',
      refresh_token: 'durable-refresh',
    }));
  });

  it('does not restore refreshed tokens when disconnect overlaps an in-flight token write', async () => {
    let storedTokens = expiredTokens();
    tryReadFile.mockImplementation(async (file) => {
      if (file.endsWith('credentials.json')) return JSON.stringify(CREDENTIALS);
      if (file.endsWith('tokens.json')) return storedTokens ? JSON.stringify(storedTokens) : null;
      return null;
    });
    const client = await getAuthenticatedClient();
    const writeStarted = Promise.withResolvers();
    const releaseWrite = Promise.withResolvers();
    atomicWrite.mockImplementation(async (file, value) => {
      if (!file.endsWith('tokens.json')) return;
      writeStarted.resolve();
      await releaseWrite.promise;
      storedTokens = value;
    });

    client.emit('tokens', { access_token: 'late-refresh', expiry_date: Date.now() + 3_600_000 });
    await writeStarted.promise;

    const clearing = clearAuth();
    releaseWrite.resolve();
    await clearing;

    expect(storedTokens).toEqual({});
    expect(lastTokenWrite()).toEqual({});
  });

  it('serializes concurrent refresh merges against the latest stored tokens', async () => {
    let storedTokens = expiredTokens();
    tryReadFile.mockImplementation(async (file) => {
      if (file.endsWith('credentials.json')) return JSON.stringify(CREDENTIALS);
      if (file.endsWith('tokens.json')) return JSON.stringify(storedTokens);
      return null;
    });
    const client = await getAuthenticatedClient();
    const writeStarted = Promise.withResolvers();
    const releaseWrite = Promise.withResolvers();
    let firstWrite = true;
    atomicWrite.mockImplementation(async (file, value) => {
      if (!file.endsWith('tokens.json')) return;
      if (firstWrite) {
        firstWrite = false;
        writeStarted.resolve();
        await releaseWrite.promise;
      }
      storedTokens = value;
    });

    client.emit('tokens', { access_token: 'rotated-access' });
    await writeStarted.promise;
    client.emit('tokens', { expiry_date: 1_900_000_000_000 });
    releaseWrite.resolve();

    await vi.waitFor(() => expect(lastTokenWrite()).toMatchObject({
      access_token: 'rotated-access',
      expiry_date: 1_900_000_000_000,
      refresh_token: 'durable-refresh',
    }));
  });

  it('rejects and persists nothing when the token endpoint refuses the refresh', async () => {
    stubFiles({ tokens: expiredTokens() });
    tokenResponse = { status: 400, body: { error: 'invalid_grant', error_description: 'Token has been revoked.' } };
    const client = await getAuthenticatedClient();
    redirectTokenEndpoint(client);

    // A revoked refresh token must surface as a rejection the caller can report,
    // never as a silent success that overwrites good tokens with an error body.
    await expect(client.getAccessToken()).rejects.toThrow();
    expect(lastTokenWrite()).toBeUndefined();
    expect(client.credentials.refresh_token).toBe('durable-refresh');
  });

  it('serves an unexpired token from the client without re-hitting the token endpoint', async () => {
    stubFiles({ tokens: { access_token: 'live-access', refresh_token: 'durable-refresh', expiry_date: Date.now() + 3_600_000 } });
    const client = await getAuthenticatedClient();
    redirectTokenEndpoint(client);

    const { token } = await client.getAccessToken();

    expect(token).toBe('live-access');
    expect(requestBodies).toHaveLength(0);
  });
});

describe('googleAuth callback', () => {
  it('stores the exchanged tokens and leaves the client authorized', async () => {
    stubFiles({ tokens: null });
    const exchange = vi.fn().mockResolvedValue({ tokens: { access_token: 'fresh-access', refresh_token: 'fresh-refresh', expiry_date: Date.now() + 3_600_000 } });
    const realCreate = createGoogleOAuthClient;
    vi.spyOn(googleOAuthClient, 'createGoogleOAuthClient').mockImplementation((options) => {
      const client = realCreate(options);
      client.getToken = exchange;
      return client;
    });

    const { url } = await getAuthUrl('messages');
    const state = new URL(url).searchParams.get('state');
    const result = await handleCallback({ code: 'auth-code', state });

    expect(result).toEqual({ success: true, returnTo: 'messages' });
    expect(exchange).toHaveBeenCalledWith('auth-code');
    expect(lastTokenWrite()).toMatchObject({ access_token: 'fresh-access', refresh_token: 'fresh-refresh' });

    stubFiles({ tokens: { access_token: 'fresh-access', refresh_token: 'fresh-refresh', expiry_date: Date.now() + 3_600_000 } });
    expect((await getAuthenticatedClient()).credentials.access_token).toBe('fresh-access');
  });

  it('keeps the verified return target on exchange failure and consumes the nonce', async () => {
    const exchange = vi.fn().mockRejectedValue(new Error('invalid_grant'));
    vi.spyOn(googleOAuthClient, 'createGoogleOAuthClient').mockImplementation((options) => ({
      ...createGoogleOAuthClient(options),
      getToken: exchange,
    }));
    const state = new URL((await getAuthUrl('messages')).url).searchParams.get('state');

    await expect(handleCallback({ code: 'bad-code', state })).resolves.toEqual({
      returnTo: 'messages', error: 'invalid_grant',
    });
    await expect(handleCallback({ code: 'bad-code', state })).resolves.toEqual({ error: expect.stringMatching(/OAuth state/) });
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(lastTokenWrite()).toBeUndefined();
  });
});

describe('googleAuth credentials and disconnect', () => {
  it('saveCredentials never returns the client secret', async () => {
    const result = await saveCredentials({ clientId: 'cid', clientSecret: 'shh' });
    expect(result).toEqual({ hasCredentials: true, redirectUri: expect.any(String) });
    expect(JSON.stringify(result)).not.toContain('shh');
  });

  it('clearAuth revokes the refresh token upstream before clearing local tokens', async () => {
    stubFiles({ tokens: { access_token: 'a', refresh_token: 'durable-refresh' } });
    await clearAuth();
    const [url, options, timeout] = fetchWithTimeout.mock.calls[0];
    expect(url).toBe('https://oauth2.googleapis.com/revoke');
    expect(options.method).toBe('POST');
    expect(options.body).toBe('token=durable-refresh');
    expect(timeout).toBeGreaterThan(0);
    expect(lastTokenWrite()).toEqual({});
  });

  it('clearAuth still clears locally when revocation fails', async () => {
    stubFiles({ tokens: { access_token: 'only-access' } });
    fetchWithTimeout.mockRejectedValueOnce(new Error('offline'));
    await clearAuth();
    expect(fetchWithTimeout.mock.calls[0][1].body).toBe('token=only-access');
    expect(lastTokenWrite()).toEqual({});
  });

  it('clearAuth skips revocation when no token is stored', async () => {
    stubFiles({ tokens: null });
    await clearAuth();
    expect(fetchWithTimeout).not.toHaveBeenCalled();
  });

  it('clearAuth propagates a local token write failure', async () => {
    stubFiles({ tokens: { access_token: 'only-access' } });
    atomicWrite.mockRejectedValueOnce(new Error('disk write failed'));

    await expect(clearAuth()).rejects.toThrow('disk write failed');
  });
});
