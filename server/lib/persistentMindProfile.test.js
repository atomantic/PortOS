import { describe, expect, it } from 'vitest';
import {
  createDefaultPersistentMindProfile,
  mergePersistentMindProfile,
  normalizePersistentMindProfile,
  persistentMindWakeIntervalMs,
  persistentMindProfileSchema,
} from './persistentMindProfile.js';

describe('persistent mind profile', () => {
  it('defaults to disabled text reasoning with no provider pin', () => {
    expect(createDefaultPersistentMindProfile()).toEqual({
      schemaVersion: 1,
      enabled: false,
      providerId: '',
      model: '',
      effort: '',
      thinkingInterface: 'text',
      wakeIntervalMinutes: 30,
    });
  });

  it('keeps an older config safe while normalizing invalid hand-edited fields', () => {
    expect(normalizePersistentMindProfile({ enabled: true, providerId: '  local  ', model: 42, effort: 'turbo' }))
      .toMatchObject({ enabled: true, providerId: 'local', model: '', effort: '', thinkingInterface: 'text', wakeIntervalMinutes: 30 });
    expect(normalizePersistentMindProfile({ wakeIntervalMinutes: 0 }).wakeIntervalMinutes).toBe(30);
    expect(persistentMindWakeIntervalMs({ wakeIntervalMinutes: 90 })).toBe(90 * 60_000);
  });

  it('clears model and effort when a provider changes without replacements', () => {
    const prior = { enabled: true, providerId: 'codex', model: 'gpt-5', effort: 'high', thinkingInterface: 'text' };
    expect(mergePersistentMindProfile(prior, { providerId: 'claude' }))
      .toMatchObject({ providerId: 'claude', model: '', effort: '' });
    expect(mergePersistentMindProfile(prior, { providerId: 'claude', model: 'sonnet', effort: 'medium' }))
      .toMatchObject({ providerId: 'claude', model: 'sonnet', effort: 'medium' });
  });

  it('uses the shared effort vocabulary and an explicit text interface at the API boundary', () => {
    expect(persistentMindProfileSchema.safeParse({ providerId: 'codex', model: 'gpt-5', effort: 'max', thinkingInterface: 'text' }).success).toBe(true);
    expect(persistentMindProfileSchema.safeParse({ effort: 'turbo' }).success).toBe(false);
    expect(persistentMindProfileSchema.safeParse({ thinkingInterface: 'tools' }).success).toBe(false);
    expect(persistentMindProfileSchema.safeParse({ wakeIntervalMinutes: 5 }).success).toBe(true);
    expect(persistentMindProfileSchema.safeParse({ wakeIntervalMinutes: 4 }).success).toBe(false);
    expect(persistentMindProfileSchema.safeParse({ wakeIntervalMinutes: 10_081 }).success).toBe(false);
  });
});
