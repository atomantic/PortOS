import { describe, it, expect } from 'vitest';
import {
  CODEX_ACCOUNT_STATUS,
  CODEX_ERROR_CODES,
  codexRateLimitsExhausted,
  deriveCodexAccountStatus,
  isCodexAuthError,
  isCodexSubscriptionProvider,
  normalizeCodexAccount,
  normalizeCodexLoginStart,
  normalizeCodexRateLimits,
  redactCodexMessage,
  redactCodexPayload,
} from './codexAccount.js';

describe('isCodexSubscriptionProvider', () => {
  it('claims CLI and TUI providers whose command is the codex binary, whatever the id', () => {
    expect(isCodexSubscriptionProvider({ id: 'codex', type: 'cli', command: 'codex' })).toBe(true);
    expect(isCodexSubscriptionProvider({ id: 'codex-tui', type: 'tui', command: 'codex' })).toBe(true);
    // A renamed clone still runs the same binary against the same sign-in.
    expect(isCodexSubscriptionProvider({ id: 'codex-review', type: 'cli', command: '/opt/bin/codex' })).toBe(true);
  });

  it('does not claim an API provider or another vendor CLI', () => {
    // An OpenAI API record authenticates with its own stored key — a
    // subscription sign-in is not its question.
    expect(isCodexSubscriptionProvider({ id: 'openai', type: 'api', endpoint: 'https://api.example.com/v1' })).toBe(false);
    expect(isCodexSubscriptionProvider({ id: 'claude-code', type: 'cli', command: 'claude' })).toBe(false);
    expect(isCodexSubscriptionProvider({ id: 'codex', type: 'cli' })).toBe(false);
  });
});

describe('redactCodexPayload', () => {
  it('replaces every credential-shaped key at any depth, keeping the rest readable', () => {
    const redacted = redactCodexPayload({
      account: { type: 'chatgpt', planType: 'pro' },
      chatgptAuthTokens: { accessToken: 'secret-value', refresh_token: 'secret-value' },
      nested: [{ apiKey: 'secret-value', label: 'kept' }],
    });

    expect(redacted.account).toEqual({ type: 'chatgpt', planType: 'pro' });
    expect(redacted.chatgptAuthTokens).toBe('[redacted]');
    expect(redacted.nested[0]).toEqual({ apiKey: '[redacted]', label: 'kept' });
    expect(JSON.stringify(redacted)).not.toContain('secret-value');
  });

  it('bounds recursion and string length so one payload cannot flood a log line', () => {
    let deep = { leaf: 'x' };
    for (let i = 0; i < 10; i += 1) deep = { deep };

    expect(JSON.stringify(redactCodexPayload(deep))).toContain('[redacted]');
    expect(redactCodexPayload('y'.repeat(500))).toHaveLength(201);
  });
});

describe('normalizeCodexAccount', () => {
  it('returns null for a successful read that found no account — the only signed-out input', () => {
    expect(normalizeCodexAccount({ account: null })).toBeNull();
    expect(normalizeCodexAccount(null)).toBeNull();
  });

  it('keeps only the auth method, plan, and managed-credential flag', () => {
    expect(normalizeCodexAccount({
      account: { type: 'chatgpt', planType: 'pro', usesCodexManagedCredentials: true, accessToken: 'secret-value' },
    })).toEqual({ authMethod: 'chatgpt', planType: 'pro', usesCodexManagedCredentials: true });
  });

  it('accepts a bare record, since an install may run a newer or older Codex', () => {
    expect(normalizeCodexAccount({ type: 'apiKey' }))
      .toEqual({ authMethod: 'apiKey', planType: null, usesCodexManagedCredentials: false });
  });

  it('throws rather than inventing a signed-out verdict from a shape it cannot read', () => {
    expect(() => normalizeCodexAccount({ account: { planType: 'pro' } })).toThrow(/auth method/);
    expect(() => normalizeCodexAccount('nope')).toThrow();
  });
});

describe('normalizeCodexRateLimits', () => {
  it('reports a fetched-but-empty window as an object, not as a failed fetch', () => {
    // The sentinel that matters: `null` is reserved for "could not read".
    expect(normalizeCodexRateLimits({ rateLimits: {} })).toEqual({ primary: null, secondary: null, credits: null });
  });

  it('normalizes the usage windows and drops anything not a number', () => {
    expect(normalizeCodexRateLimits({
      rateLimits: {
        primary: { usedPercent: 42.5, windowDurationMins: 300, resetsAt: '2026-09-01T00:00:00Z', limitName: 'weekly' },
        secondary: { usedPercent: 'lots' },
        credits: { hasCredits: true, unlimited: false, balance: 12 },
      },
    })).toEqual({
      primary: { usedPercent: 42.5, windowDurationMins: 300, resetsAt: '2026-09-01T00:00:00Z', limitName: 'weekly' },
      secondary: null,
      credits: { hasCredits: true, unlimited: false },
    });
  });

  it('throws on a non-object response so the caller keeps the null sentinel', () => {
    expect(() => normalizeCodexRateLimits(undefined)).toThrow();
    expect(() => normalizeCodexRateLimits('nope')).toThrow();
  });
});

describe('codexRateLimitsExhausted', () => {
  it('is false for an unread quota and true only for a window at or past 100%', () => {
    expect(codexRateLimitsExhausted(null)).toBe(false);
    expect(codexRateLimitsExhausted({ primary: { usedPercent: 99.9 }, secondary: null })).toBe(false);
    expect(codexRateLimitsExhausted({ primary: null, secondary: { usedPercent: 100 } })).toBe(true);
  });
});

describe('normalizeCodexLoginStart', () => {
  it('returns the browser URL and nothing else', () => {
    expect(normalizeCodexLoginStart({
      loginId: 'login-1',
      authUrl: 'https://auth.example.com/x',
      chatgptAuthTokens: { accessToken: 'secret-value' },
    })).toEqual({ loginId: 'login-1', authUrl: 'https://auth.example.com/x', verificationUrl: null, userCode: null });
  });

  it('accepts the device-code shape', () => {
    expect(normalizeCodexLoginStart({ loginId: 'login-2', verificationUrl: 'https://auth.example.com/device', userCode: 'ABCD-EFGH' }))
      .toEqual({ loginId: 'login-2', authUrl: null, verificationUrl: 'https://auth.example.com/device', userCode: 'ABCD-EFGH' });
  });

  it('refuses a URL it could never cancel or correlate', () => {
    expect(() => normalizeCodexLoginStart({ authUrl: 'https://auth.example.com/x' })).toThrow(/loginId/);
    expect(() => normalizeCodexLoginStart({ loginId: 'login-3' })).toThrow(/sign-in URL/);
  });

  it('refuses a non-HTTPS browser handoff', () => {
    expect(() => normalizeCodexLoginStart({ loginId: 'login-4', authUrl: 'javascript:alert(1)' })).toThrow(/sign-in URL/);
    expect(() => normalizeCodexLoginStart({ loginId: 'login-5', verificationUrl: 'http://auth.example.com/device' })).toThrow(/sign-in URL/);
  });
});

describe('deriveCodexAccountStatus', () => {
  const ACCOUNT = { authMethod: 'chatgpt', planType: 'pro', usesCodexManagedCredentials: false };

  it('never collapses an unprobed runtime or an unanswered read into signed-out', () => {
    expect(deriveCodexAccountStatus({ runtimeInstalled: null, accountFetched: false }))
      .toBe(CODEX_ACCOUNT_STATUS.unknown);
    expect(deriveCodexAccountStatus({ runtimeInstalled: true, accountFetched: false }))
      .toBe(CODEX_ACCOUNT_STATUS.unknown);
    expect(deriveCodexAccountStatus({ runtimeInstalled: false }))
      .toBe(CODEX_ACCOUNT_STATUS.runtimeMissing);
  });

  it('says signed-out only when a read actually reported no account', () => {
    expect(deriveCodexAccountStatus({ runtimeInstalled: true, accountFetched: true, account: null }))
      .toBe(CODEX_ACCOUNT_STATUS.signedOut);
  });

  it('prefers login-pending over signed-out and unknown while a flow is live', () => {
    expect(deriveCodexAccountStatus({ runtimeInstalled: true, accountFetched: true, account: null, loginPending: true }))
      .toBe(CODEX_ACCOUNT_STATUS.loginPending);
    expect(deriveCodexAccountStatus({ runtimeInstalled: true, accountFetched: false, loginPending: true }))
      .toBe(CODEX_ACCOUNT_STATUS.loginPending);
  });

  it('reports reauth-required for a revoked sign-in and unknown for any other failure', () => {
    expect(deriveCodexAccountStatus({ runtimeInstalled: true, error: { code: CODEX_ERROR_CODES.authRevoked } }))
      .toBe(CODEX_ACCOUNT_STATUS.reauthRequired);
    expect(deriveCodexAccountStatus({ runtimeInstalled: true, error: { code: CODEX_ERROR_CODES.timeout }, loginPending: true }))
      .toBe(CODEX_ACCOUNT_STATUS.unknown);
  });

  it('is ready on an unread quota, and quota-exhausted only on a read one', () => {
    // An unread usage window must not take a working subscription off the page.
    expect(deriveCodexAccountStatus({ runtimeInstalled: true, accountFetched: true, account: ACCOUNT, rateLimits: null }))
      .toBe(CODEX_ACCOUNT_STATUS.ready);
    expect(deriveCodexAccountStatus({
      runtimeInstalled: true, accountFetched: true, account: ACCOUNT, rateLimits: { primary: { usedPercent: 100 } },
    })).toBe(CODEX_ACCOUNT_STATUS.quotaExhausted);
  });
});

describe('isCodexAuthError', () => {
  it('recognizes the revoked/expired shapes and nothing else', () => {
    expect(isCodexAuthError({ message: 'request failed with status 401' })).toBe(true);
    expect(isCodexAuthError({ message: 'token expired' })).toBe(true);
    expect(isCodexAuthError({ message: 'connection refused' })).toBe(false);
    expect(isCodexAuthError(null)).toBe(false);
  });
});

describe('redactCodexMessage', () => {
  it('masks a credential-shaped value under any label or scheme', () => {
    // These messages are logged AND returned to the browser by the `/codex/*`
    // routes, and the payload redactor keys on FIELD NAMES a free-text message
    // does not have.
    for (const [message, secret] of [
      ['access_token=sk-live-ABCDEFGH1234 expired', 'sk-live-ABCDEFGH1234'],
      ['refresh_token: eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 rejected', 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'],
      ['Authorization: Bearer abcdefghijklmnopqrst', 'abcdefghijklmnopqrst'],
      // Not just Bearer/Basic — a scheme PortOS has never seen must not slip past.
      ['Authorization: Token eyJhbGciOiJIUzI1NiJ9abcd', 'eyJhbGciOiJIUzI1NiJ9abcd'],
    ]) {
      const masked = redactCodexMessage(message);
      expect(masked).not.toContain(secret);
      expect(masked).toContain('[redacted]');
    }
  });

  it('leaves an ordinary message alone', () => {
    // A redactor that mangles prose makes every error harder to act on, so the
    // value has to look like a credential — not merely follow a scary word.
    for (const message of [
      'The secret: sauce',
      'The secret is safe',
      'GET /v1/secrets:read failed',
      'Codex app-server did not answer account/read within 15s.',
    ]) {
      expect(redactCodexMessage(message)).toBe(message);
    }
  });

  it('reports nothing to say as null, not an empty string', () => {
    expect(redactCodexMessage('')).toBeNull();
    expect(redactCodexMessage(null)).toBeNull();
    expect(redactCodexMessage(42)).toBeNull();
  });
});
