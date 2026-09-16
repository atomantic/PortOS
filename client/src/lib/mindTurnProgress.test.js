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
    expect(progress.elapsedMs).toBe(160_000);
    expect(progress.detail).toBe('2m 40s · heartbeat 5s ago · model loaded');
  });

  it('renders a cold local model as loading rather than as a silent hang', () => {
    const progress = describeMindTurnProgress({
      state: thinkingState(),
      runtime: runtimeFor({ residency: { status: 'not-loaded', backend: 'ollama', loaded: false } }),
    });

    expect(progress.residency).toBe('loading model');
    expect(progress.detail).toContain('loading model');
  });

  it('names an unreachable local runtime instead of implying healthy inference', () => {
    const progress = describeMindTurnProgress({
      state: thinkingState(),
      runtime: runtimeFor({ residency: { status: 'unknown', backend: 'lmstudio', loaded: null } }),
    });

    expect(progress.residency).toBe('local runtime unreachable');
  });

  it('says nothing about residency for a provider-managed route', () => {
    const progress = describeMindTurnProgress({
      state: thinkingState(),
      runtime: runtimeFor({ residency: { status: 'provider-managed', backend: null, loaded: null } }),
    });

    expect(progress.residency).toBeNull();
    expect(progress.detail).toBe('2m 40s · heartbeat 5s ago');
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
    expect(progress.elapsedMs).toBeNull();
    expect(progress.heartbeatAgeMs).toBeNull();
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

  it('reports a quota autopause as blocked with a retry time, not as a user pause', () => {
    const progress = describeMindTurnProgress({
      state: {
        status: 'paused',
        started: true,
        activeTurnId: null,
        usageLimited: true,
        pauseReason: 'Provider usage limit reached',
        nextEligibleWakeAt: '2026-09-01T00:30:00.000Z',
      },
      runtime: null,
    });

    expect(progress.phase).toBe('blocked');
    expect(progress.busy).toBe(false);
    expect(progress.reason).toBe('Provider usage limit reached');
    expect(progress.retryAt).toBe('2026-09-01T00:30:00.000Z');
    expect(progress.detail).toBe('retrying automatically');
  });

  it('treats a degraded wake as blocked so a failing provider is not read as working', () => {
    const progress = describeMindTurnProgress({
      state: { status: 'degraded', started: true, activeTurnId: null, usageLimited: false, pauseReason: 'Provider unavailable or wake failed', nextEligibleWakeAt: '2026-09-01T00:05:00.000Z' },
    });

    expect(progress.phase).toBe('blocked');
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
