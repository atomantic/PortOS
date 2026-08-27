import { describe, expect, it } from 'vitest';
import {
  PERSISTENT_MIND_LIMITS,
  createDefaultPersistentMindState,
  nextPersistentMindWakeAt,
  normalizePersistentMindState,
  persistentMindBackoffMs,
  persistentMindTurnIsStale,
  requeuePersistentMindWake,
  takeNextPersistentMindWake,
} from './persistentMind.js';

const iso = (ms) => new Date(ms).toISOString();

describe('persistent mind state', () => {
  it('defaults to opt-in, stopped, and silent', () => {
    expect(createDefaultPersistentMindState()).toMatchObject({
      enabled: false,
      started: false,
      status: 'disabled',
      queuedMessages: [],
      selfWake: null,
      activeTurn: null,
    });
  });

  it('normalizes a partial legacy shape without treating missing state as enabled', () => {
    const state = normalizePersistentMindState({ started: true, queuedMessages: [{ id: 'm1', text: 'hello' }] });
    expect(state.enabled).toBe(false);
    expect(state.started).toBe(false);
    expect(state.status).toBe('disabled');
    expect(state.queuedMessages).toEqual([{ id: 'm1', text: 'hello', createdAt: iso(0) }]);
  });

  it('does not preserve a running status when the durable started flag is false', () => {
    const activeTurn = {
      id: 't1',
      wake: { kind: 'message', message: { id: 'm1', text: 'keep me', createdAt: iso(1) } },
      startedAt: iso(1), heartbeatAt: iso(1), providerId: null, model: null, effort: null,
    };
    const stopped = normalizePersistentMindState({ enabled: true, started: false, status: 'thinking', activeTurn });
    expect(stopped.status).toBe('idle');
    expect(stopped.activeTurn).toBeNull();
    expect(stopped.queuedMessages.map((message) => message.id)).toEqual(['m1']);
    expect(normalizePersistentMindState({ enabled: true, started: true, status: 'disabled' }).status).toBe('idle');
  });

  it('keeps FIFO user messages ahead of a due self-wake', () => {
    const base = {
      ...createDefaultPersistentMindState(), enabled: true, started: true, status: 'waiting',
      queuedMessages: [
        { id: 'm1', text: 'first', createdAt: iso(1) },
        { id: 'm2', text: 'second', createdAt: iso(2) },
      ],
      selfWake: { id: 'w1', kind: 'self', reason: 'idle', sourceTurnId: 't0', createdAt: iso(1), notBefore: iso(2) },
    };
    const first = takeNextPersistentMindWake(base, 10);
    const second = takeNextPersistentMindWake(first.state, 10);
    const third = takeNextPersistentMindWake(second.state, 10);
    expect(first.wake.message.id).toBe('m1');
    expect(second.wake.message.id).toBe('m2');
    expect(third.wake.id).toBe('w1');
  });

  it('does not consume work before the retry or self-wake deadline', () => {
    const state = {
      ...createDefaultPersistentMindState(), enabled: true, started: true,
      queuedMessages: [{ id: 'm1', text: 'wait', createdAt: iso(1) }],
      nextEligibleWakeAt: iso(1_000),
    };
    expect(takeNextPersistentMindWake(state, 500)).toMatchObject({ wake: null, dueAt: 1_000 });
    expect(nextPersistentMindWakeAt(state, 500)).toBe(1_000);
  });

  it('requeues an interrupted message once and never resurrects a completed id', () => {
    const wake = { kind: 'message', message: { id: 'm1', text: 'keep me', createdAt: iso(1) } };
    const once = requeuePersistentMindWake(createDefaultPersistentMindState(), wake);
    const twice = requeuePersistentMindWake(once, wake);
    const completed = requeuePersistentMindWake({ ...once, queuedMessages: [], recentMessageIds: ['m1'] }, wake);
    expect(twice.queuedMessages).toHaveLength(1);
    expect(completed.queuedMessages).toHaveLength(0);
  });

  it('caps exponential backoff and detects stale heartbeats at the boundary', () => {
    expect(persistentMindBackoffMs(1)).toBe(PERSISTENT_MIND_LIMITS.BACKOFF_BASE_MS);
    expect(persistentMindBackoffMs(99)).toBe(PERSISTENT_MIND_LIMITS.BACKOFF_MAX_MS);
    const state = {
      ...createDefaultPersistentMindState(), enabled: true, started: true, status: 'thinking',
      activeTurn: {
        id: 't1',
        wake: { kind: 'message', message: { id: 'm1', text: 'hello', createdAt: iso(1) } },
        startedAt: iso(1), heartbeatAt: iso(1), providerId: null, model: null, effort: null,
      },
    };
    expect(persistentMindTurnIsStale(state, 1 + PERSISTENT_MIND_LIMITS.WATCHDOG_STALE_MS - 1)).toBe(false);
    expect(persistentMindTurnIsStale(state, 1 + PERSISTENT_MIND_LIMITS.WATCHDOG_STALE_MS)).toBe(true);
  });
});
