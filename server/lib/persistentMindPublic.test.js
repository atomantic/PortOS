import { describe, expect, it } from 'vitest';
import { createDefaultPersistentMindState } from './persistentMind.js';
import { publicPersistentMindState } from './persistentMindPublic.js';

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
});
