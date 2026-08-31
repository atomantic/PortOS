import { describe, it, expect, afterEach, vi } from 'vitest';

const mocks = {
  ensureDir: vi.fn(async () => {}),
  atomicWrite: vi.fn(async () => {}),
  tryReadFile: vi.fn(async () => null),
  fetchWithTimeout: vi.fn(),
  getSelfHost: vi.fn(),
  getHttpsEnabledAtBoot: vi.fn(),
};

vi.mock('../lib/fileUtils.js', () => ({
  dataPath: (...parts) => `/tmp/${parts.join('/')}`,
  ensureDir: (...args) => mocks.ensureDir(...args),
  atomicWrite: (...args) => mocks.atomicWrite(...args),
  tryReadFile: (...args) => mocks.tryReadFile(...args),
}));

vi.mock('../lib/fetchWithTimeout.js', () => ({
  fetchWithTimeout: (...args) => mocks.fetchWithTimeout(...args),
}));

vi.mock('../lib/peerSelfHost.js', () => ({
  getSelfHost: (...args) => mocks.getSelfHost(...args),
}));

vi.mock('../lib/httpsState.js', () => ({
  getHttpsEnabledAtBoot: (...args) => mocks.getHttpsEnabledAtBoot(...args),
}));

import { isTokenExpired, withExpiry, getRedirectUri, getAuthStatus, getAccessToken, handleCallback, SPOTIFY_SCOPES } from './spotifyAuth.js';

describe('spotifyAuth pure helpers', () => {
  describe('withExpiry', () => {
    it('stamps an absolute expires_at from expires_in seconds', () => {
      const now = 1_700_000_000_000;
      const tokens = withExpiry({ access_token: 'a', expires_in: 3600 }, now);
      expect(tokens.expires_at).toBe(now + 3600 * 1000);
      expect(tokens.access_token).toBe('a');
    });

    it('sets expires_at to null when expires_in is absent/non-numeric', () => {
      expect(withExpiry({ access_token: 'a' }).expires_at).toBeNull();
      expect(withExpiry({ access_token: 'a', expires_in: 'nope' }).expires_at).toBeNull();
    });
  });

  describe('isTokenExpired', () => {
    const now = 1_700_000_000_000;

    it('is false for a token comfortably before expiry', () => {
      expect(isTokenExpired({ access_token: 'a', expires_at: now + 600_000 }, now)).toBe(false);
    });

    it('is true within the refresh skew window', () => {
      expect(isTokenExpired({ access_token: 'a', expires_at: now + 30_000 }, now, 60_000)).toBe(true);
    });

    it('is true past expiry', () => {
      expect(isTokenExpired({ access_token: 'a', expires_at: now - 1 }, now)).toBe(true);
    });

    it('treats a missing access_token or expires_at as expired', () => {
      expect(isTokenExpired({ expires_at: now + 600_000 }, now)).toBe(true);
      expect(isTokenExpired({ access_token: 'a' }, now)).toBe(true);
      expect(isTokenExpired(null, now)).toBe(true);
    });
  });

  describe('getRedirectUri', () => {
    const savedEnv = { ...process.env };
    afterEach(() => {
      process.env = { ...savedEnv };
      mocks.getSelfHost.mockReset().mockReturnValue(null);
      mocks.getHttpsEnabledAtBoot.mockReset().mockReturnValue({ value: false });
    });

    it('honors an explicit SPOTIFY_REDIRECT_URI override', () => {
      process.env.SPOTIFY_REDIRECT_URI = 'https://example.test/api/spotify/oauth/callback';
      expect(getRedirectUri()).toBe('https://example.test/api/spotify/oauth/callback');
    });

    it('uses a request origin when the caller supplies the public URL', () => {
      delete process.env.SPOTIFY_REDIRECT_URI;
      delete process.env.PUBLIC_HOST;
      process.env.PORT = '5555';

      expect(getRedirectUri({ origin: 'https://host-example.ts.net:5555/' }))
        .toBe('https://host-example.ts.net:5555/api/spotify/oauth/callback');
    });

    it('builds the callback path from PUBLIC_HOST/PORT otherwise', () => {
      delete process.env.SPOTIFY_REDIRECT_URI;
      process.env.PUBLIC_HOST = 'myhost';
      process.env.PORT = '5555';
      expect(getRedirectUri()).toBe('http://myhost:5555/api/spotify/oauth/callback');
    });

    it('uses the active Tailscale host and HTTPS state when no override is configured', () => {
      delete process.env.SPOTIFY_REDIRECT_URI;
      delete process.env.PUBLIC_HOST;
      process.env.PORT = '5555';
      mocks.getSelfHost.mockReturnValue('host-example.ts.net');
      mocks.getHttpsEnabledAtBoot.mockReturnValue({ value: true });

      expect(getRedirectUri()).toBe('https://host-example.ts.net:5555/api/spotify/oauth/callback');
    });

    it('uses HTTP for an auto-detected host when HTTPS is disabled', () => {
      delete process.env.SPOTIFY_REDIRECT_URI;
      delete process.env.PUBLIC_HOST;
      process.env.PORT = '5555';
      mocks.getSelfHost.mockReturnValue('host-example.ts.net');
      mocks.getHttpsEnabledAtBoot.mockReturnValue({ value: false });

      expect(getRedirectUri()).toBe('http://host-example.ts.net:5555/api/spotify/oauth/callback');
    });

    it('falls back to localhost when no host is auto-detected', () => {
      delete process.env.SPOTIFY_REDIRECT_URI;
      delete process.env.PUBLIC_HOST;
      process.env.PORT = '5555';
      mocks.getSelfHost.mockReturnValue(null);

      expect(getRedirectUri()).toBe('http://localhost:5555/api/spotify/oauth/callback');
    });

    it('falls back to localhost when certificate metadata has an invalid hostname', () => {
      delete process.env.SPOTIFY_REDIRECT_URI;
      delete process.env.PUBLIC_HOST;
      process.env.PORT = '5555';
      mocks.getSelfHost.mockReturnValue('undefined.example-tailnet.ts.net');

      expect(getRedirectUri()).toBe('http://localhost:5555/api/spotify/oauth/callback');
    });

    it('surfaces the derived URI in auth status', async () => {
      delete process.env.SPOTIFY_REDIRECT_URI;
      delete process.env.PUBLIC_HOST;
      process.env.PORT = '5555';
      mocks.getSelfHost.mockReturnValue('host-example.ts.net');
      mocks.getHttpsEnabledAtBoot.mockReturnValue({ value: true });

      await expect(getAuthStatus()).resolves.toMatchObject({
        redirectUri: 'https://host-example.ts.net:5555/api/spotify/oauth/callback',
      });
    });
  });
});

describe('getAccessToken', () => {
  afterEach(() => {
    mocks.ensureDir.mockClear();
    mocks.atomicWrite.mockClear();
    mocks.tryReadFile.mockReset().mockResolvedValue(null);
    mocks.fetchWithTimeout.mockReset();
  });

  const expiredTokens = JSON.stringify({ access_token: 'old', refresh_token: 'r1', expires_at: 1 });
  const credentials = JSON.stringify({ clientId: 'cid', clientSecret: 'secret' });

  // tryReadFile is called per file (tokens.json then credentials.json inside
  // requestToken); route by the requested path.
  const routeReads = () => mocks.tryReadFile.mockImplementation(async (path) => {
    if (String(path).endsWith('tokens.json')) return expiredTokens;
    if (String(path).endsWith('credentials.json')) return credentials;
    return null;
  });

  it('passes a finite timeout to fetchWithTimeout on refresh', async () => {
    routeReads();
    mocks.fetchWithTimeout.mockResolvedValue({
      ok: true,
      json: async () => ({ access_token: 'fresh', expires_in: 3600 }),
    });

    await getAccessToken();

    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(1);
    const timeoutArg = mocks.fetchWithTimeout.mock.calls[0][2];
    expect(Number.isFinite(timeoutArg)).toBe(true);
    expect(timeoutArg).toBeGreaterThan(0);
  });

  it('single-flights concurrent refreshes into one token request', async () => {
    routeReads();
    let resolveFetch;
    mocks.fetchWithTimeout.mockReturnValue(new Promise((res) => { resolveFetch = res; }));

    const p1 = getAccessToken();
    const p2 = getAccessToken();
    // Wait until the shared refresh has actually issued its single fetch before
    // releasing it (both callers await getTokens/getCredentials first).
    while (mocks.fetchWithTimeout.mock.calls.length === 0) {
      await new Promise((r) => setTimeout(r, 0));
    }
    resolveFetch({ ok: true, json: async () => ({ access_token: 'fresh', expires_in: 3600 }) });

    const [t1, t2] = await Promise.all([p1, p2]);
    expect(t1).toBe('fresh');
    expect(t2).toBe('fresh');
    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(1);
  });

  it('clears the single-flight guard so a later refresh can run again', async () => {
    routeReads();
    mocks.fetchWithTimeout
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'fresh', expires_in: 3600 }) });

    await expect(getAccessToken()).rejects.toThrow();
    // Guard released in finally → the next call issues a fresh request.
    await expect(getAccessToken()).resolves.toBe('fresh');
    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(2);
  });
});

describe('handleCallback', () => {
  it('requests playlist scopes for the expanded Brain integration', () => {
    expect(SPOTIFY_SCOPES).toEqual([
      'user-read-recently-played',
      'playlist-read-private',
      'playlist-read-collaborative',
    ]);
  });

  it('single-flights and replays a successful callback without reusing the code', async () => {
    mocks.tryReadFile.mockImplementation(async (path) => (
      String(path).endsWith('credentials.json')
        ? JSON.stringify({ clientId: 'cid', clientSecret: 'secret' })
        : null
    ));
    let resolveFetch;
    mocks.fetchWithTimeout.mockReturnValue(new Promise((resolve) => { resolveFetch = resolve; }));

    const first = handleCallback('one-time-code');
    const second = handleCallback('one-time-code');
    while (mocks.fetchWithTimeout.mock.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    resolveFetch({ ok: true, json: async () => ({ access_token: 'fresh', refresh_token: 'refresh', expires_in: 3600 }) });

    await expect(Promise.all([first, second])).resolves.toEqual([{ success: true }, { success: true, duplicate: true }]);
    await expect(handleCallback('one-time-code')).resolves.toMatchObject({ success: true, duplicate: true });
    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(1);
  });
});
