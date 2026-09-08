import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/db.js', () => ({
  ensureSchema: vi.fn().mockResolvedValue(undefined),
  query: vi.fn(),
  withTransaction: vi.fn(),
}));
vi.mock('./settings.js', () => ({ getSettings: vi.fn() }));
// The realtime transport is a live long-lived socket; the status card only
// reads its snapshot, so the module is stubbed at that one function.
vi.mock('./beeperSocket.js', () => ({
  getBeeperRealtimeState: vi.fn(() => ({
    state: 'down', lastEventAt: null, lastPingAt: null, reconnectAttempts: 0, appState: null, appStateActionable: false, authRejected: false,
  })),
}));
// `beeperCredentials.js` runs FOR REAL here (against the mocked `query` and
// `vaultCrypto` below) — the #11-decision-8 guard this suite exists to prove
// ("an unreadable vault throws rather than reporting not-configured") lives
// inside that module, and mocking the module away (as this file used to) means
// the guard is never actually exercised.
vi.mock('../lib/vaultCrypto.js', () => ({
  ensureVaultKey: vi.fn().mockResolvedValue({ generated: false }),
  encryptValue: vi.fn(),
  decryptValue: vi.fn(),
}));
vi.mock('./beeperClient.js', async () => {
  const actual = await vi.importActual('./beeperClient.js');
  return { ...actual, probeBeeperInfo: vi.fn(), getInfo: vi.fn() };
});

import { query } from '../lib/db.js';
import { getSettings } from './settings.js';
import { decryptValue } from '../lib/vaultCrypto.js';
import { getBeeperRealtimeState } from './beeperSocket.js';
import {
  probeBeeperInfo, getInfo, BeeperApiError, __setLastBeeperSuccessAtForTests,
} from './beeperClient.js';
import { getBeeperStatus, checkBeeperConnection, listBeeperAccounts } from './beeperStatus.js';
import { getBeeperSweepProgress, updateBeeperSweepProgress, __resetBeeperSweepProgressForTests } from './beeperSweepProgress.js';

const DOWN_REALTIME_STATE = {
  state: 'down', lastEventAt: null, lastPingAt: null, reconnectAttempts: 0, appState: null, appStateActionable: false, authRejected: false,
};

// A placeholder that is obviously not a real credential (root AGENTS.md).
const TOKEN = 'example-beeper-token';
const CIPHERTEXT = 'v1:aXY=:dGFn:Y3Q=';

// `beeperCredentials.js` runs two different queries against the same mocked
// `query()` (the credential row, the account roster) — route each to its own
// fixture by sniffing the SQL text, the way a real Postgres client cannot.
function mockDb({ credentialRow = null, accountsRows = [], accountsError = null } = {}) {
  vi.mocked(query).mockImplementation(async (sql) => {
    const text = String(sql);
    if (text.includes('FROM beeper_credentials')) {
      return { rows: credentialRow ? [credentialRow] : [] };
    }
    if (text.includes('FROM beeper_accounts')) {
      if (accountsError) throw accountsError;
      return { rows: accountsRows };
    }
    return { rows: [] };
  });
}

const noCredential = (opts = {}) => mockDb({ credentialRow: null, ...opts });

const credential = ({
  tokenExpiresAt = null, tokenSource = 'oauth', scopes = '', ...opts
} = {}) => {
  vi.mocked(decryptValue).mockReturnValue(TOKEN);
  return mockDb({
    credentialRow: {
      token_enc: CIPHERTEXT, token_expires_at: tokenExpiresAt, scopes, source: tokenSource, client_id: '',
    },
    ...opts,
  });
};

const unreadableCredential = (opts = {}) => {
  vi.mocked(decryptValue).mockImplementation(() => { throw new Error('Malformed vault ciphertext'); });
  return mockDb({
    credentialRow: {
      token_enc: 'corrupt', token_expires_at: null, scopes: '', source: 'oauth', client_id: '',
    },
    ...opts,
  });
};

describe('listBeeperAccounts', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns the mirrored account roster', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [{ accountId: 'acc1', network: 'whatsapp', displayName: 'Example', status: 'connected', bridgeId: 'b1', lastSeenAt: null }] });
    const accounts = await listBeeperAccounts();
    expect(accounts).toEqual([{ accountId: 'acc1', network: 'whatsapp', displayName: 'Example', status: 'connected', bridgeId: 'b1', lastSeenAt: null }]);
  });

  it('returns an empty array (a trustworthy "no accounts yet") rather than throwing on an unexpected result shape', async () => {
    vi.mocked(query).mockResolvedValue({});
    expect(await listBeeperAccounts()).toEqual([]);
  });
});

describe('getBeeperStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __setLastBeeperSuccessAtForTests(null);
    vi.mocked(getSettings).mockResolvedValue({});
    // `clearAllMocks()` resets call history, not a mock's return value —
    // reset this explicitly so the ping-recency test below can't leak its
    // override into a later test that assumes the default "never pinged" state.
    vi.mocked(getBeeperRealtimeState).mockReturnValue(DOWN_REALTIME_STATE);
    __resetBeeperSweepProgressForTests();
  });

  it('reports reachable:null (never false) and skips the probe entirely when no token is configured', async () => {
    noCredential();

    const status = await getBeeperStatus();

    expect(status.tokenConfigured).toBe(false);
    expect(status.reachable).toBeNull();
    expect(status.probeState).toBe('unknown');
    expect(status.tokenScopes).toEqual([]);
    expect(probeBeeperInfo).not.toHaveBeenCalled();
  });

  it('probes and reports reachable:true with account roster and app version when a token is configured and reachable', async () => {
    vi.mocked(getSettings).mockResolvedValue({ beeper: { baseUrl: 'http://127.0.0.1:23373' } });
    credential({ tokenSource: 'pasted', accountsRows: [{ accountId: 'acc1' }] });
    vi.mocked(probeBeeperInfo).mockResolvedValue({
      reachable: true, info: { app: { name: 'Beeper', version: '4.3.73' } }, error: null, timedOut: false, latencyMs: 8,
    });

    const status = await getBeeperStatus();

    expect(status.tokenConfigured).toBe(true);
    expect(status.reachable).toBe(true);
    expect(status.probeState).toBe('ok');
    expect(status.appVersion).toBe('4.3.73');
    expect(status.accounts).toEqual([{ accountId: 'acc1' }]);
    expect(status.accountsError).toBeNull();
    expect(probeBeeperInfo).toHaveBeenCalledWith({ baseUrl: 'http://127.0.0.1:23373' });
    // The transport snapshot the settings card's liveness dot renders from (#33).
    expect(status.realtime).toEqual(DOWN_REALTIME_STATE);
  });

  it('reports reachable:false with lastProbeError when a token is configured but unreachable', async () => {
    credential();
    vi.mocked(probeBeeperInfo).mockResolvedValue({
      reachable: false, info: null, error: 'connection refused', timedOut: false, latencyMs: 4,
    });

    const status = await getBeeperStatus();

    expect(status.reachable).toBe(false);
    expect(status.probeState).toBe('unreachable');
    expect(status.lastProbeError).toBe('connection refused');
  });

  // Fork issue #61, decision 7: a probe timeout with a recent successful
  // Beeper call is `slow`, not `unreachable` — `reachable` stays true.
  it('reports probeState:slow (reachable stays true) when a probe times out shortly after a real API success', async () => {
    credential();
    __setLastBeeperSuccessAtForTests(Date.now() - 5_000);
    vi.mocked(probeBeeperInfo).mockResolvedValue({
      reachable: false, info: null, error: 'Beeper request failed: aborted', timedOut: true, latencyMs: 3000,
    });

    const status = await getBeeperStatus();

    expect(status.reachable).toBe(true);
    expect(status.probeState).toBe('slow');
    expect(status.probeLatencyMs).toBe(3000);
  });

  it('reports probeState:slow when the realtime socket pinged recently, even with no recent API call', async () => {
    vi.mocked(getBeeperRealtimeState).mockReturnValue({
      ...DOWN_REALTIME_STATE, state: 'connected', lastPingAt: new Date(Date.now() - 10_000).toISOString(),
    });
    credential();
    vi.mocked(probeBeeperInfo).mockResolvedValue({
      reachable: false, info: null, error: 'timed out', timedOut: true, latencyMs: 3000,
    });

    const status = await getBeeperStatus();

    expect(status.reachable).toBe(true);
    expect(status.probeState).toBe('slow');
  });

  // A timeout with NO recent activity, and any non-timeout failure regardless
  // of recent activity, both stay `unreachable` — a genuinely closed Beeper
  // Desktop must still reach the unreachable card promptly.
  it('reports probeState:unreachable for a timeout with no recent Beeper activity', async () => {
    credential();
    vi.mocked(probeBeeperInfo).mockResolvedValue({
      reachable: false, info: null, error: 'timed out', timedOut: true, latencyMs: 3000,
    });

    const status = await getBeeperStatus();

    expect(status.reachable).toBe(false);
    expect(status.probeState).toBe('unreachable');
  });

  it('reports probeState:unreachable for a fast connection refusal even with a recent success', async () => {
    credential();
    __setLastBeeperSuccessAtForTests(Date.now() - 1_000);
    vi.mocked(probeBeeperInfo).mockResolvedValue({
      reachable: false, info: null, error: 'connection refused', timedOut: false, latencyMs: 3,
    });

    const status = await getBeeperStatus();

    expect(status.reachable).toBe(false);
    expect(status.probeState).toBe('unreachable');
  });

  // The bug this whole suite exists for: the credential layer used to be
  // checked only for a ROW's presence (`resolveBeeperTokenMeta`, which never
  // decrypts), so a vault whose ciphertext cannot be decrypted — the vault key
  // rotated or corrupted, the row otherwise intact — read as a perfectly
  // healthy, connected install instead of the documented "could not read
  // status" branch. Run against the REAL credentials layer (mocked only at
  // `query`/`vaultCrypto`), not a mock of `resolveBeeperTokenMeta` itself.
  it('propagates an unreadable vault rather than reporting tokenConfigured:true/reachable:true', async () => {
    unreadableCredential();

    await expect(getBeeperStatus()).rejects.toThrow(/vault ciphertext/);
    // The whole point: it never gets far enough to report a healthy probe.
    expect(probeBeeperInfo).not.toHaveBeenCalled();
  });

  // A failed accounts read must not collapse into "no accounts mirrored yet"
  // — that is `listBeeperAccounts`' own honest empty result, and a DB hiccup
  // reading it is a different, unknown state.
  it('reports a failed accounts read as unknown (accounts:null), distinct from a successful read of zero accounts', async () => {
    credential({ accountsError: new Error('db unavailable') });
    vi.mocked(probeBeeperInfo).mockResolvedValue({
      reachable: true, info: {}, error: null, timedOut: false, latencyMs: 5,
    });

    const failed = await getBeeperStatus();
    expect(failed.accounts).toBeNull();
    expect(failed.accountsError).toBe('db unavailable');

    credential({ accountsRows: [] });
    vi.mocked(probeBeeperInfo).mockResolvedValue({
      reachable: true, info: {}, error: null, timedOut: false, latencyMs: 5,
    });
    const empty = await getBeeperStatus();
    expect(empty.accounts).toEqual([]);
    expect(empty.accountsError).toBeNull();
  });

  it('warns when the stored token expiry is within 7 days', async () => {
    const soon = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toISOString();
    credential({ tokenExpiresAt: soon });
    vi.mocked(probeBeeperInfo).mockResolvedValue({
      reachable: true, info: {}, error: null, timedOut: false, latencyMs: 5,
    });

    const status = await getBeeperStatus();
    expect(status.tokenExpiringSoon).toBe(true);
  });

  it('does not warn when the stored token expiry is far away', async () => {
    const far = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000).toISOString();
    credential({ tokenExpiresAt: far });
    vi.mocked(probeBeeperInfo).mockResolvedValue({
      reachable: true, info: {}, error: null, timedOut: false, latencyMs: 5,
    });

    const status = await getBeeperStatus();
    expect(status.tokenExpiringSoon).toBe(false);
  });

  it('surfaces how the credential was obtained, and never anything else about it', async () => {
    credential({ tokenSource: 'pasted' });
    vi.mocked(probeBeeperInfo).mockResolvedValue({
      reachable: true, info: {}, error: null, timedOut: false, latencyMs: 5,
    });

    const status = await getBeeperStatus();
    expect(status.tokenSource).toBe('pasted');
    expect(Object.keys(status)).not.toContain('token');
  });

  // Fork issue #78: the credential row's `scopes` column reaches the status
  // payload as `tokenScopes`, the same array shape `beeperCredentials.js`
  // already parses it into — so a read-only grant is visible before a send
  // fails, and the raw token value never rides along with it.
  it('surfaces the granted OAuth scopes as an array, and never the token value', async () => {
    credential({ tokenSource: 'oauth', scopes: 'read write' });
    vi.mocked(probeBeeperInfo).mockResolvedValue({
      reachable: true, info: {}, error: null, timedOut: false, latencyMs: 5,
    });

    const status = await getBeeperStatus();
    expect(status.tokenScopes).toEqual(['read', 'write']);
    expect(JSON.stringify(status)).not.toContain(TOKEN);
  });

  // A pasted token (#11 decision 3) never carries scopes back from Beeper's
  // own paste UI — `beeperOAuth.js` stores `scopes: []` for that path — so the
  // status payload must report an honest empty array, never `null` or a
  // fabricated grant.
  it('reports an empty tokenScopes array for a pasted token', async () => {
    credential({ tokenSource: 'pasted', scopes: '' });
    vi.mocked(probeBeeperInfo).mockResolvedValue({
      reachable: true, info: {}, error: null, timedOut: false, latencyMs: 5,
    });

    const status = await getBeeperStatus();
    expect(status.tokenScopes).toEqual([]);
  });

  // There is no refresh grant, so an expired token is its own actionable
  // RE-CONNECT state, distinct from "expiring soon" and from any API failure.
  it('reports tokenExpired for a lapsed token, distinctly from tokenExpiringSoon', async () => {
    credential({ tokenExpiresAt: new Date(Date.now() - 60_000).toISOString() });
    vi.mocked(probeBeeperInfo).mockResolvedValue({
      reachable: true, info: {}, error: null, timedOut: false, latencyMs: 5,
    });

    const status = await getBeeperStatus();
    expect(status.tokenExpired).toBe(true);
    expect(status.tokenExpiringSoon).toBe(true);
  });

  it('leaves both expiry flags false for a no-expiry pasted token', async () => {
    credential({ tokenExpiresAt: null, tokenSource: 'pasted' });
    vi.mocked(probeBeeperInfo).mockResolvedValue({
      reachable: true, info: {}, error: null, timedOut: false, latencyMs: 5,
    });

    const status = await getBeeperStatus();
    expect(status.tokenExpired).toBe(false);
    expect(status.tokenExpiringSoon).toBe(false);
    expect(status.tokenExpiresAt).toBeNull();
  });

  // Sweep visibility (#80) — this fails on the old code, which had no `sweep`
  // key on the status payload at all.
  describe('sweep state', () => {
    it('reports an idle shape when no sweep has ever run', async () => {
      noCredential();

      const status = await getBeeperStatus();

      expect(status.sweep).toEqual({
        running: false, startedAt: null, finishedAt: null, reason: null,
        accountsDone: 0, accountsTotal: null, chats: 0, messages: 0,
      });
    });

    it('reports a running shape mid-sweep', async () => {
      noCredential();
      updateBeeperSweepProgress({
        running: true, startedAt: '2026-09-05T10:00:00.000Z', finishedAt: null, reason: 'scheduler',
        accountsDone: 2, accountsTotal: 9, chats: 40, messages: 812,
      });

      const status = await getBeeperStatus();

      expect(status.sweep).toMatchObject({
        running: true, accountsDone: 2, accountsTotal: 9, chats: 40, messages: 812,
      });
    });

    it('reports the last completed pass once a sweep has finished, not zeroed counts', async () => {
      noCredential();
      updateBeeperSweepProgress({
        running: false, startedAt: '2026-09-05T10:00:00.000Z', finishedAt: '2026-09-05T10:04:12.000Z',
        reason: 'manual', accountsDone: 9, accountsTotal: 9, chats: 210, messages: 4032,
      });

      const status = await getBeeperStatus();

      expect(status.sweep).toMatchObject({
        running: false, finishedAt: '2026-09-05T10:04:12.000Z', accountsDone: 9, accountsTotal: 9, chats: 210, messages: 4032,
      });
    });
  });
});

describe('checkBeeperConnection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getSettings).mockResolvedValue({});
  });

  it('throws a typed NOT_CONFIGURED BeeperApiError when no token is configured', async () => {
    noCredential();
    await expect(checkBeeperConnection()).rejects.toMatchObject({ code: 'NOT_CONFIGURED' });
    expect(getInfo).not.toHaveBeenCalled();
  });

  it('propagates a NETWORK_ERROR from a live probe', async () => {
    credential();
    vi.mocked(getInfo).mockRejectedValue(new BeeperApiError('Beeper request failed', { status: 0, code: 'NETWORK_ERROR', retryable: false }));
    await expect(checkBeeperConnection()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('throws MALFORMED_RESPONSE on an unexpected /v1/info shape', async () => {
    credential();
    vi.mocked(getInfo).mockResolvedValue({ unexpected: true });
    await expect(checkBeeperConnection()).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' });
  });

  it('resolves reachable:true on a well-shaped live probe', async () => {
    credential();
    vi.mocked(getInfo).mockResolvedValue({ app: { name: 'Beeper' }, server: { status: 'running' } });
    await expect(checkBeeperConnection()).resolves.toMatchObject({ reachable: true });
  });
});
