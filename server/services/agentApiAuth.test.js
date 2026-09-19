/**
 * The loopback credential agents spend on this install's own API.
 *
 * The failure this exists to prevent is silent in both directions: hand out no
 * token on a password-protected install and every canned agent `curl` is a
 * `401` the agent reads as a broken endpoint; hand one out to a public-content
 * stage and contributor-controlled text is running with a credential to the
 * whole API. Both are asserted here, along with the reuse contract — a parallel
 * dispatch must not write one session record per agent — and the revocation
 * path, since a stale token fails exactly like having none.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

const authEvents = new EventEmitter();
const isAuthEnabled = vi.fn();
const createSession = vi.fn();
const verifySession = vi.fn();

vi.mock('./auth.js', () => ({
  authEvents,
  isAuthEnabled: (...args) => isAuthEnabled(...args),
  createSession: (...args) => createSession(...args),
  verifySession: (...args) => verifySession(...args),
}));

const { resolveAgentApiEnv, __testing } = await import('./agentApiAuth.js');

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
const session = (token) => ({ token, expiresAt: Date.now() + THIRTY_DAYS_MS });

describe('resolveAgentApiEnv', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __testing.reset();
    isAuthEnabled.mockResolvedValue(true);
    verifySession.mockResolvedValue(true);
    createSession.mockImplementation(async () => session('tok-1'));
  });

  it('mints a session token for the agent when the install has an instance password', async () => {
    await expect(resolveAgentApiEnv()).resolves.toEqual({ PORTOS_API_TOKEN: 'tok-1' });
  });

  it('hands out no token when no instance password is set — the gate lets the call through anyway', async () => {
    isAuthEnabled.mockResolvedValue(false);

    await expect(resolveAgentApiEnv()).resolves.toEqual({});
    expect(createSession).not.toHaveBeenCalled();
  });

  it('never gives a public-content stage a credential to this install', async () => {
    await expect(resolveAgentApiEnv({ safetyProfile: 'public-review' })).resolves.toEqual({});
    await expect(resolveAgentApiEnv({ safetyProfile: 'public-review-actions' })).resolves.toEqual({});
    expect(createSession).not.toHaveBeenCalled();
  });

  it('reuses one token across spawns, including a concurrent burst', async () => {
    const [first, second] = await Promise.all([resolveAgentApiEnv(), resolveAgentApiEnv()]);
    const third = await resolveAgentApiEnv();

    expect(first).toEqual({ PORTOS_API_TOKEN: 'tok-1' });
    expect(second).toEqual({ PORTOS_API_TOKEN: 'tok-1' });
    expect(third).toEqual({ PORTOS_API_TOKEN: 'tok-1' });
    expect(createSession).toHaveBeenCalledTimes(1);
  });

  it('re-mints after a password rotation drops every session', async () => {
    await resolveAgentApiEnv();
    createSession.mockImplementation(async () => session('tok-2'));
    authEvents.emit('sessions:revoked-all');

    await expect(resolveAgentApiEnv()).resolves.toEqual({ PORTOS_API_TOKEN: 'tok-2' });
    expect(createSession).toHaveBeenCalledTimes(2);
  });

  it('re-mints when the session store no longer knows the cached token', async () => {
    await resolveAgentApiEnv();
    verifySession.mockResolvedValue(false);
    createSession.mockImplementation(async () => session('tok-3'));

    await expect(resolveAgentApiEnv()).resolves.toEqual({ PORTOS_API_TOKEN: 'tok-3' });
  });

  it('re-mints a token that would expire inside a long agent run', async () => {
    createSession.mockImplementationOnce(async () => ({ token: 'tok-expiring', expiresAt: Date.now() + 60_000 }));
    await resolveAgentApiEnv();
    createSession.mockImplementation(async () => session('tok-fresh'));

    await expect(resolveAgentApiEnv()).resolves.toEqual({ PORTOS_API_TOKEN: 'tok-fresh' });
  });

  it('spawns without a token when minting fails', async () => {
    createSession.mockRejectedValue(new Error('settings.json is unreadable'));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(resolveAgentApiEnv()).resolves.toEqual({});
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });
});
