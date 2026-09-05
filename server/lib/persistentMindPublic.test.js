import { describe, expect, it } from 'vitest';
import { createDefaultPersistentMindState, normalizePersistentMindState } from './persistentMind.js';
import { publicPersistentMindState } from './persistentMindPublic.js';

const selection = {
  id: 'deep-think',
  label: 'Deep think',
  providerId: 'example-provider',
  model: 'example-model',
  effort: 'high',
};

const stateWithActiveTemporaryTurn = (overrides = {}) => normalizePersistentMindState({
  ...createDefaultPersistentMindState(),
  enabled: true,
  started: true,
  status: 'thinking',
  activeTurn: {
    id: 'turn-9',
    startedAt: '2026-09-01T00:00:00.000Z',
    heartbeatAt: '2026-09-01T00:00:05.000Z',
    providerId: 'example-provider',
    model: 'example-model',
    effort: 'high',
    wake: {
      kind: 'message',
      message: {
        id: 'message-9',
        text: 'Think harder about this one.',
        thinkingPresetId: 'deep-think',
        thinkingPreset: selection,
        createdAt: '2026-09-01T00:00:00.000Z',
      },
    },
  },
  ...overrides,
});

describe('public persistent mind state', () => {
  it('projects the scheduled wake without exposing queued message content', () => {
    const nextWakeAt = new Date(Date.now() + 15 * 60_000).toISOString();
    const projected = publicPersistentMindState({
      ...createDefaultPersistentMindState(),
      enabled: true,
      started: true,
      status: 'waiting',
      queuedMessages: [],
      selfWake: {
        id: 'wake-1',
        kind: 'self',
        reason: 'scheduled reflection',
        sourceTurnId: 'turn-1',
        createdAt: new Date().toISOString(),
        notBefore: nextWakeAt,
      },
    });

    expect(projected.nextWakeAt).toBe(nextWakeAt);
    expect(projected).not.toHaveProperty('selfWake');
    expect(projected).not.toHaveProperty('queuedMessages');
  });

  it('reports the route a temporary session is actually running on, not the home profile', () => {
    const projected = publicPersistentMindState(stateWithActiveTemporaryTurn());

    expect(projected.activeRoute).toEqual({
      providerId: 'example-provider',
      model: 'example-model',
      effort: 'high',
    });
    expect(projected.activeThinkingSession).toEqual({
      presetId: 'deep-think',
      label: 'Deep think',
      providerId: 'example-provider',
      model: 'example-model',
      effort: 'high',
      resolvable: true,
    });
    // The message body itself must never ride the status payload.
    expect(JSON.stringify(projected)).not.toContain('Think harder');
  });

  it('marks a session whose stored selection no longer validates as unresolvable', () => {
    // `sanitizeMessage` keeps a selected-but-unvalidatable message as a durable
    // record with a null selection, which is exactly the revoked-mid-flight case
    // the resolver refuses. The page must say so instead of rendering a route.
    const state = normalizePersistentMindState({
      ...createDefaultPersistentMindState(),
      enabled: true,
      started: true,
      status: 'thinking',
      activeTurn: {
        id: 'turn-10',
        startedAt: '2026-09-01T00:00:00.000Z',
        heartbeatAt: '2026-09-01T00:00:05.000Z',
        providerId: 'example-provider',
        model: 'example-model',
        effort: 'high',
        wake: {
          kind: 'message',
          message: {
            id: 'message-10',
            text: 'Selection was revoked.',
            thinkingPresetId: 'deep-think',
            thinkingPreset: { ...selection, effort: 'not-a-level' },
            createdAt: '2026-09-01T00:00:00.000Z',
          },
        },
      },
    });

    const projected = publicPersistentMindState(state);

    expect(projected.activeThinkingSession).toMatchObject({
      presetId: 'deep-think',
      resolvable: false,
      providerId: null,
      model: null,
    });
  });

  it('leaves the temporary-session fields null for an ordinary wake', () => {
    const projected = publicPersistentMindState({
      ...createDefaultPersistentMindState(),
      enabled: true,
      started: true,
      status: 'waiting',
    });

    expect(projected.activeRoute).toBeNull();
    expect(projected.activeThinkingSession).toBeNull();
    expect(projected.queuedTemporaryMessageCount).toBe(0);
  });

  it('counts only the queued messages that carry a borrowed route', () => {
    const state = normalizePersistentMindState({
      ...createDefaultPersistentMindState(),
      enabled: true,
      started: true,
      status: 'waiting',
      queuedMessages: [
        { id: 'ordinary', text: 'no preset', createdAt: '2026-09-01T00:00:00.000Z' },
        {
          id: 'borrowed',
          text: 'with preset',
          thinkingPresetId: 'deep-think',
          thinkingPreset: selection,
          createdAt: '2026-09-01T00:00:01.000Z',
        },
      ],
    });

    const projected = publicPersistentMindState(state);

    expect(projected.queuedMessageCount).toBe(2);
    expect(projected.queuedTemporaryMessageCount).toBe(1);
  });
});
