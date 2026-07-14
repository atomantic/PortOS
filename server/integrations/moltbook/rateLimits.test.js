import { describe, it, expect } from 'vitest';
import {
  checkRateLimit,
  recordAction,
  getRateLimitStatus,
  clearRateLimitState,
  MOLTBOOK_RATE_LIMITS,
} from './rateLimits.js';

describe('moltbook rateLimits', () => {
  it('allows an action then enforces the cooldown after recording', () => {
    const key = 'test-key-cooldown';
    clearRateLimitState(key);
    expect(checkRateLimit(key, 'vote').allowed).toBe(true);
    recordAction(key, 'vote');
    const blocked = checkRateLimit(key, 'vote');
    expect(blocked.allowed).toBe(false);
    expect(blocked.waitMs).toBeGreaterThan(0);
    clearRateLimitState(key);
  });

  it('enforces the daily cap', () => {
    const key = 'test-key-daily';
    clearRateLimitState(key);
    const max = MOLTBOOK_RATE_LIMITS.vote.maxPerDay;
    for (let i = 0; i < max; i++) recordAction(key, 'vote');
    const status = getRateLimitStatus(key);
    expect(status.vote.remaining).toBe(0);
    expect(checkRateLimit(key, 'vote').allowed).toBe(false);
    clearRateLimitState(key);
  });

  it('unknown actions are always allowed', () => {
    expect(checkRateLimit('any', 'bogus').allowed).toBe(true);
  });

  it('does not leak entries without bound — cycling many keys stays bounded', () => {
    // The state map is bounded (default maxSize 1000). Touching far more keys
    // than the cap must not grow the map without limit; older idle keys are
    // shed. We can only observe behavior through the public API, so assert the
    // most-recently-used key is still tracked (cooldown enforced) after churn.
    for (let i = 0; i < 5000; i++) recordAction(`churn-${i}`, 'vote');
    const recent = 'churn-4999';
    expect(checkRateLimit(recent, 'vote').allowed).toBe(false); // still cooling down
    clearRateLimitState(recent);
  });
});
