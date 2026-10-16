import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';

const fixture = vi.hoisted(() => ({ files: new Map(), account: { id: '11111111-1111-4111-8111-111111111111', type: 'gmail', enabled: true } }));
vi.mock('../lib/fileUtils.js', async importOriginal => ({
  ...await importOriginal(),
  PATHS: { calendar: '/mock/calendar', messages: '/mock/messages' },
  ensureDir: async () => {},
  tryReadFile: async path => fixture.files.get(path) ?? null,
  atomicWrite: async (path, data) => { fixture.files.set(path, JSON.stringify(data)); }
}));
vi.mock('./messageAccounts.js', () => ({
  getAccount: async () => fixture.account,
  updateSyncStatus: async () => {},
  updateSendAsAliases: async () => {},
  markSentIngested: async () => {}
}));
vi.mock('./userTimezone.js', () => ({ getUserTimezone: async () => 'UTC' }));
vi.mock('./humanActivity.js', () => ({
  messageActivityCandidates: () => [],
  newlyLearnedAliases: () => []
}));

import { clearAuth, getAuthenticatedClient, GOOGLE_API_TIMEOUT_MS } from './googleAuth.js';
import { syncAccount } from './messageSync.js';
import { sendGmail } from './messageGmailSync.js';

const json = body => new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
const tokensPath = join('/mock/calendar', 'google-auth', 'tokens.json');
let ownedPromises;

beforeEach(async () => {
  ownedPromises = [];
  fixture.files.clear();
  await clearAuth();
  fixture.files.set(join('/mock/calendar', 'google-auth', 'credentials.json'), JSON.stringify({ clientId: 'example-client', clientSecret: 'example-secret' }));
  fixture.files.set(tokensPath, JSON.stringify({ access_token: 'expired-access', refresh_token: 'durable-refresh', expiry_date: 1 }));
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  if (vi.isFakeTimers()) await vi.runAllTimersAsync();
  await Promise.allSettled(ownedPromises);
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Google OAuth deadline through message workflows', () => {
  // Regression: API timeouts cannot release the account lock when auth hangs
  // before dispatch. Exercise the real OAuth2/Gaxios timeout and retry machinery.
  it('bounds a stalled token refresh, releases the sync lock, and recovers with persisted credentials', async () => {
    const client = await getAuthenticatedClient();
    expect(client.transporter.defaults.timeout).toBe(30_000);
    client.endpoints.oauth2TokenUrl = 'https://oauth.example.com/token';
    vi.useFakeTimers();
    // Native AbortSignal.timeout uses internal timers. Bridge only its clock so
    // the real Gaxios transport still creates and handles each deadline signal.
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new DOMException('Token request deadline exceeded', 'TimeoutError')), ms);
      return controller.signal;
    });
    let stall = true;
    let tokenAttempts = 0;
    const tokenStarted = Promise.withResolvers();
    const apiRequests = [];
    client.transporter.defaults.fetchImplementation = async (url, init) => {
      if (String(url) === client.endpoints.oauth2TokenUrl) {
        tokenAttempts++;
        tokenStarted.resolve(init.signal);
        if (stall) return new Promise((_resolve, reject) => {
          const abort = () => reject(init.signal.reason);
          if (init.signal.aborted) abort();
          else init.signal.addEventListener('abort', abort, { once: true });
        });
        return json({ access_token: 'refreshed-access', expires_in: 3600, token_type: 'Bearer' });
      }
      apiRequests.push({ url: String(url), init });
      if (String(url).includes('/settings/sendAs')) return json({ sendAs: [] });
      if (String(url).includes('/messages')) return json({ messages: [] });
      throw new Error('Unexpected example transport request');
    };

    // The direct SDK error distinguishes a deadline from revoked credentials.
    const refreshError = client.getAccessToken().catch(error => error);
    ownedPromises.push(refreshError);
    const firstTokenSignal = await tokenStarted.promise;
    const syncStarted = Promise.withResolvers();
    const sync = syncAccount(fixture.account.id, { emit: event => {
      if (event === 'messages:sync:started') syncStarted.resolve();
    } });
    ownedPromises.push(sync);
    await syncStarted.promise;
    const send = sendGmail(fixture.account, { id: 'example-draft', to: ['alice@example.com'] });
    ownedPromises.push(send);
    expect(await syncAccount(fixture.account.id)).toMatchObject({ status: 409 });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(firstTokenSignal.aborted).toBe(false);
    expect(tokenAttempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(firstTokenSignal.aborted).toBe(true);
    expect(firstTokenSignal.reason.name).toBe('TimeoutError');
    // Alias lookup is opportunistic: after its refresh fails, the message
    // listing makes its own bounded refresh attempt before sync reports failure.
    await vi.advanceTimersByTimeAsync(GOOGLE_API_TIMEOUT_MS * 5 + 4_000);
    expect(await refreshError).toMatchObject({ code: 'TimeoutError' });
    expect(await sync).toMatchObject({ status: 502, error: expect.stringContaining('deadline exceeded') });
    expect(await send).toMatchObject({ success: false, code: 'GMAIL_AUTH_FAILED' });
    expect(apiRequests).toHaveLength(0);
    expect(tokenAttempts).toBe(6);
    expect(JSON.parse(fixture.files.get(tokensPath)).access_token).toBe('expired-access');

    stall = false;
    expect(await syncAccount(fixture.account.id)).toMatchObject({ status: 'success' });
    expect(JSON.parse(fixture.files.get(tokensPath))).toMatchObject({ access_token: 'refreshed-access', refresh_token: 'durable-refresh' });
    expect(apiRequests.length).toBeGreaterThan(0);

    // A request's explicit deadline and retry policy still override defaults.
    const overridden = [];
    client.transporter.defaults.adapter = async (options, dispatch) => {
      overridden.push({ timeout: options.timeout, retry: options.retry });
      return dispatch(options);
    };
    await client.request({ url: 'https://gmail.example.com/messages', timeout: 10_000, retry: false });
    expect(overridden).toEqual([{ timeout: 10_000, retry: false }]);
  });
});
