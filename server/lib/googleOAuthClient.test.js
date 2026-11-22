import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGoogleOAuthClient } from './googleOAuthClient.js';

const json = (status, body) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});

function client(fetchImplementation, extra = {}) {
  return createGoogleOAuthClient({
    clientId: 'example-client',
    clientSecret: 'example-secret',
    redirectUri: 'http://127.0.0.1/callback',
    fetchImplementation,
    ...extra,
  });
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('createGoogleOAuthClient', () => {
  it('builds a consent URL with the offline access options', () => {
    const auth = client(async () => json(200, {}));
    const url = new URL(auth.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: ['https://www.googleapis.com/auth/calendar', 'https://www.googleapis.com/auth/gmail.modify'],
      state: 'messages',
    }));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('example-client');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1/callback');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('state')).toBe('messages');
    expect(url.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/gmail.modify');
  });

  it('exchanges a code, converts expires_in, and emits the tokens', async () => {
    const bodies = [];
    const auth = client(async (_url, init) => {
      bodies.push(Object.fromEntries(init.body));
      return json(200, { access_token: 'fresh', refresh_token: 'durable', expires_in: 3600, token_type: 'Bearer' });
    });
    const seen = [];
    auth.on('tokens', (tokens) => seen.push({ ...tokens }));
    const { tokens } = await auth.getToken('auth-code');
    expect(tokens.access_token).toBe('fresh');
    expect(tokens.refresh_token).toBe('durable');
    expect(tokens.expires_in).toBeUndefined();
    expect(tokens.expiry_date).toBeGreaterThan(Date.now());
    expect(bodies[0]).toMatchObject({ grant_type: 'authorization_code', code: 'auth-code', redirect_uri: 'http://127.0.0.1/callback' });
    expect(seen[0].access_token).toBe('fresh');
    expect(seen[0].expires_in).toBeUndefined();
  });

  it('refreshes once for concurrent callers and keeps the stored refresh token', async () => {
    let calls = 0;
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const auth = client(async () => {
      calls += 1;
      await gate;
      return json(200, { access_token: 'refreshed', expires_in: 3600 });
    });
    auth.setCredentials({ access_token: 'stale', refresh_token: 'durable-refresh', expiry_date: 1 });
    const first = auth.getAccessToken();
    const second = auth.getAccessToken();
    await vi.waitFor(() => expect(calls).toBe(1));
    release();
    await expect(first).resolves.toEqual({ token: 'refreshed' });
    await expect(second).resolves.toEqual({ token: 'refreshed' });
    expect(calls).toBe(1);
    expect(auth.credentials.refresh_token).toBe('durable-refresh');
    expect(auth.credentials.expiry_date).toBeGreaterThan(Date.now());
  });

  it('leaves credentials unchanged when the token endpoint refuses the refresh', async () => {
    const auth = client(async () => json(400, { error: 'invalid_grant', error_description: 'revoked' }));
    auth.setCredentials({ access_token: 'stale', refresh_token: 'durable-refresh', expiry_date: 1 });
    await expect(auth.getAccessToken()).rejects.toThrow('invalid_grant');
    expect(auth.credentials).toMatchObject({ access_token: 'stale', refresh_token: 'durable-refresh' });
  });

  it('reports TimeoutError without replacing a live refresh token', async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('The operation was aborted due to timeout', 'TimeoutError')), ms);
      return controller.signal;
    });
    const auth = client((_url, init) => new Promise((_resolve, reject) => {
      const abort = () => reject(init.signal.reason);
      if (init.signal.aborted) abort();
      else init.signal.addEventListener('abort', abort, { once: true });
    }), { timeoutMs: 30_000 });
    auth.setCredentials({ access_token: 'stale', refresh_token: 'durable-refresh', expiry_date: 1 });
    const pending = auth.getAccessToken().then((value) => ({ value }), (error) => error);
    await vi.runAllTimersAsync();
    const error = await pending;
    expect(error.code).toBe('TimeoutError');
    expect(auth.credentials.refresh_token).toBe('durable-refresh');
    expect(auth.credentials.access_token).toBe('stale');
  });

  it('retries an idempotent GET and never resubmits POST', async () => {
    vi.useFakeTimers();
    const calls = [];
    const auth = client(async (url, init) => {
      calls.push([init.method, String(url)]);
      return json(503, { error: { code: 503, message: 'unavailable' } });
    });
    auth.setCredentials({ access_token: 'example-token', expiry_date: Date.now() + 3_600_000 });
    const get = auth.request({ url: 'https://www.googleapis.com/calendar/v3/users/me/calendarList', method: 'GET', retry: true })
      .then((value) => value, (error) => error);
    const post = auth.request({ url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', method: 'POST', data: { raw: 'example' }, retry: true })
      .then((value) => value, (error) => error);
    const once = auth.request({ url: 'https://www.googleapis.com/calendar/v3/users/me/calendarList', method: 'GET', retry: false })
      .then((value) => value, (error) => error);
    await vi.runAllTimersAsync();
    const [getError, postError, onceError] = await Promise.all([get, post, once]);
    expect(getError).toMatchObject({ code: 503, message: 'unavailable', response: { status: 503 } });
    expect(postError.response.status).toBe(503);
    expect(onceError.response.status).toBe(503);
    expect(calls.filter(([method]) => method === 'GET')).toHaveLength(5);
    expect(calls.filter(([method, url]) => method === 'POST' && url.includes('/messages/send'))).toHaveLength(1);
  });

  it('refreshes a token that has no expiry after one 401 and replays the request once', async () => {
    const calls = [];
    const auth = client(async (url) => {
      calls.push(String(url));
      if (String(url).includes('oauth2.googleapis.com')) return json(200, { access_token: 'refreshed', expires_in: 3600 });
      if (calls.filter((item) => item.includes('calendar')).length === 1) return json(401, { error: { code: 401, message: 'expired' } });
      return json(200, { id: 'example-event' });
    });
    auth.setCredentials({ access_token: 'stale', refresh_token: 'durable-refresh' });
    await expect(auth.request({ url: 'https://www.googleapis.com/calendar/v3/users/me/calendarList', retry: false }))
      .resolves.toMatchObject({ data: { id: 'example-event' } });
    expect(calls.filter((url) => url.includes('oauth2.googleapis.com'))).toHaveLength(1);
    expect(calls.filter((url) => url.includes('calendar'))).toHaveLength(2);
    expect(auth.credentials.access_token).toBe('refreshed');
    expect(auth.credentials.refresh_token).toBe('durable-refresh');
  });
});
