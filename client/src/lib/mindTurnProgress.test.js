import { describe, expect, it } from 'vitest';
import { describeMindTurnProgress, mindTurnStage } from './mindTurnProgress.js';

const thinkingState = (overrides = {}) => ({
  enabled: true,
  started: true,
  status: 'thinking',
  activeTurnId: 'turn-1',
  pauseReason: null,
  usageLimited: false,
  nextEligibleWakeAt: null,
  ...overrides,
});

const runtimeFor = (inference = {}) => ({
  observedAt: '2026-09-01T00:02:40.000Z',
  inference: {
    active: true,
    turnId: 'turn-1',
    startedAt: '2026-09-01T00:00:00.000Z',
    heartbeatAt: '2026-09-01T00:02:35.000Z',
    elapsedMs: 160_000,
    heartbeatAgeMs: 5_000,
    heartbeatStale: false,
    providerId: 'example-provider',
    model: 'example-model',
    residency: { status: 'loaded', backend: 'ollama', loaded: true },
    ...inference,
  },
});

describe('describeMindTurnProgress', () => {
  it('reports elapsed time, heartbeat freshness, and residency while a turn runs', () => {
    const progress = describeMindTurnProgress({ state: thinkingState(), runtime: runtimeFor() });

    expect(progress.phase).toBe('thinking');
    expect(progress.busy).toBe(true);
    expect(progress.detail).toBe('2m 40s · heartbeat 5s ago · model loaded');
  });

  it('names each local residency state so a cold load never reads as a hang', () => {
    const detailFor = (status) => describeMindTurnProgress({
      state: thinkingState(),
      runtime: runtimeFor({ residency: { status, backend: 'ollama', loaded: status === 'loaded' } }),
    }).detail;

    expect(detailFor('not-loaded')).toContain('loading model');
    expect(detailFor('unknown')).toContain('local runtime unreachable');
    // Nothing local to report — a clause here would imply otherwise.
    expect(detailFor('provider-managed')).toBe('2m 40s · heartbeat 5s ago');
  });

  it('separates a stale heartbeat from ordinary thinking', () => {
    const fresh = describeMindTurnProgress({ state: thinkingState(), runtime: runtimeFor() });
    const stale = describeMindTurnProgress({
      state: thinkingState(),
      runtime: runtimeFor({ heartbeatAgeMs: 190_000, heartbeatStale: true }),
    });

    expect(fresh.phase).toBe('thinking');
    expect(stale.phase).toBe('stalled');
    expect(stale.busy).toBe(true);
    expect(stale.detail).toContain('no heartbeat for 3m 10s');
  });

  it('ignores freshness from a snapshot describing a different turn', () => {
    const progress = describeMindTurnProgress({
      state: thinkingState(),
      // The previous turn's snapshot: dating THIS turn with it would report a
      // just-started turn as long-running and stalled.
      runtime: runtimeFor({ turnId: 'turn-0', heartbeatAgeMs: 900_000, heartbeatStale: true }),
    });

    expect(progress.phase).toBe('thinking');
    expect(progress.detail).toBeNull();
  });

  it('keeps a just-started turn distinct from one reporting no measurement at all', () => {
    const justStarted = describeMindTurnProgress({
      state: thinkingState(),
      runtime: runtimeFor({ elapsedMs: 0, heartbeatAgeMs: 0 }),
    });
    const unreported = describeMindTurnProgress({
      state: thinkingState(),
      runtime: runtimeFor({ elapsedMs: null, heartbeatAgeMs: null }),
    });

    expect(justStarted.detail).toBe('0s · heartbeat 0s ago · model loaded');
    expect(unreported.detail).toBe('model loaded');
  });

  it('takes the quota retry time from the probe schedule, which is the only thing that sets it', () => {
    // A usage-limit autopause clears nextEligibleWakeAt (no backoff gate), so a
    // projection that only read that field would never show a retry time for the
    // exact case this feature exists for.
    const quotaState = {
      status: 'paused',
      started: true,
      activeTurnId: null,
      usageLimited: true,
      pauseReason: 'Provider usage limit reached',
      nextEligibleWakeAt: null,
    };
    const progress = describeMindTurnProgress({
      state: quotaState,
      runtime: { usageLimitRetryAt: '2026-09-01T00:30:00.000Z' },
    });

    expect(progress.phase).toBe('blocked');
    expect(progress.busy).toBe(false);
    expect(progress.reason).toBe('Provider usage limit reached');
    expect(progress.retryAt).toBe('2026-09-01T00:30:00.000Z');
    // No probe scheduled yet: say nothing rather than invent a time.
    expect(describeMindTurnProgress({ state: quotaState, runtime: null }).retryAt).toBeNull();
  });

  it('treats a degraded wake as blocked so a failing provider is not read as working', () => {
    const progress = describeMindTurnProgress({
      state: { status: 'degraded', started: true, activeTurnId: null, usageLimited: false, pauseReason: 'Provider unavailable or wake failed', nextEligibleWakeAt: '2026-09-01T00:05:00.000Z' },
    });

    expect(progress.phase).toBe('blocked');
    // Falls back to the backoff gate, which a degraded wake (unlike a quota
    // autopause) really does set.
    expect(progress.retryAt).toBe('2026-09-01T00:05:00.000Z');
  });

  it('leaves a user pause and an ordinary wait idle', () => {
    expect(describeMindTurnProgress({ state: { status: 'paused', usageLimited: false } }).phase).toBe('idle');
    expect(describeMindTurnProgress({ state: { status: 'waiting', started: true } }).phase).toBe('idle');
    expect(describeMindTurnProgress({}).phase).toBe('idle');
  });
});

describe('mindTurnStage', () => {
  const events = [
    { eventId: 'a', kind: 'mind.wake', turnId: 'turn-1', sequence: 1 },
    { eventId: 'b', kind: 'mind.model.request', turnId: 'turn-1', sequence: 2 },
    { eventId: 'c', kind: 'mind.capability.request', turnId: 'turn-1', sequence: 4 },
    { eventId: 'd', kind: 'mind.model.result', turnId: 'turn-1', sequence: 3 },
    { eventId: 'e', kind: 'mind.model.request', turnId: 'turn-0', sequence: 9 },
  ];

  it('reads the newest stage for the claimed turn by sequence, not array order', () => {
    expect(mindTurnStage({ activeTurnId: 'turn-1' }, events)).toBe('Running a granted action');
  });

  it('ignores events belonging to another turn', () => {
    expect(mindTurnStage({ activeTurnId: 'turn-2' }, events)).toBeNull();
  });

  it('returns null when no turn is claimed or no events are loaded', () => {
    expect(mindTurnStage({ activeTurnId: null }, events)).toBeNull();
    expect(mindTurnStage({ activeTurnId: 'turn-1' }, null)).toBeNull();
  });
});
