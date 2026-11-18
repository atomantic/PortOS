import { describe, expect, it } from 'vitest';
import {
  createDefaultPersistentMindThinkingPresets,
  findPersistentMindThinkingPreset,
  mergePersistentMindThinkingPresets,
  normalizePersistentMindThinkingPresets,
  PERSISTENT_MIND_THINKING_PRESET_LIMITS,
  persistentMindThinkingPresetsSchema,
  persistentMindThinkingSelectionSchema,
} from './persistentMindThinkingPresets.js';

const preset = (overrides = {}) => ({
  id: 'deep',
  label: 'Deep pass',
  providerId: 'example-provider',
  model: 'example-model',
  effort: 'max',
  ...overrides,
});

describe('persistent mind thinking presets', () => {
  it('ships no presets, so an upgraded install keeps exactly its pinned default route', () => {
    expect(createDefaultPersistentMindThinkingPresets()).toEqual({ schemaVersion: 1, presets: [] });
    expect(normalizePersistentMindThinkingPresets(undefined)).toEqual({ schemaVersion: 1, presets: [] });
    expect(normalizePersistentMindThinkingPresets({ presets: 'not-a-list' })).toEqual({ schemaVersion: 1, presets: [] });
  });

  it('drops half-pinned entries rather than storing a route that has to be guessed', () => {
    const { presets } = normalizePersistentMindThinkingPresets({
      presets: [
        preset(),
        preset({ id: 'no-model', model: '' }),
        preset({ id: 'no-provider', providerId: '   ' }),
        preset({ id: '../escape' }),
        preset({ id: '' }),
      ],
    });
    expect(presets.map((entry) => entry.id)).toEqual(['deep']);
  });

  it('never turns an unusable effort into a pin, and names an unlabeled preset by its route', () => {
    const { presets } = normalizePersistentMindThinkingPresets({
      presets: [preset({ effort: 'turbo' }), preset({ id: 'plain', label: '  ', effort: undefined })],
    });
    expect(presets).toHaveLength(1);
    expect(presets[0]).toMatchObject({ label: 'example-provider / example-model', effort: '' });
    const longRoute = normalizePersistentMindThinkingPresets({
      presets: [preset({ providerId: 'p'.repeat(100), model: 'm'.repeat(200), label: '' })],
    }).presets[0];
    expect(persistentMindThinkingSelectionSchema.safeParse(longRoute).success).toBe(true);
    const legacy = normalizePersistentMindThinkingPresets({
      presets: [preset({ id: 'i'.repeat(70), label: 'n'.repeat(100) })],
    }).presets[0];
    expect(legacy).toEqual(preset({ id: 'i'.repeat(64), label: 'n'.repeat(80) }));
  });

  it('keeps the first of a duplicated id and caps the stored list', () => {
    const { presets } = normalizePersistentMindThinkingPresets({
      presets: [
        preset({ model: 'first-model' }),
        preset({ model: 'second-model' }),
        ...Array.from({ length: 40 }, (_, index) => preset({ id: `extra-${index}` })),
      ],
    });
    expect(presets[0].model).toBe('first-model');
    expect(presets).toHaveLength(PERSISTENT_MIND_THINKING_PRESET_LIMITS.MAX_PRESETS);
  });

  it('replaces the whole list on a list patch so a delete cannot be resurrected by a merge', () => {
    const stored = { presets: [preset(), preset({ id: 'fast', model: 'fast-model' })] };
    expect(mergePersistentMindThinkingPresets(stored, { presets: [preset()] }).presets.map((p) => p.id))
      .toEqual(['deep']);
    expect(mergePersistentMindThinkingPresets(stored, { presets: [] }).presets).toEqual([]);
    // An unrelated settings PATCH must not clear presets the user saved.
    expect(mergePersistentMindThinkingPresets(stored, {}).presets.map((p) => p.id)).toEqual(['deep', 'fast']);
  });

  it('looks up only an exact saved id', () => {
    const stored = { presets: [preset()] };
    expect(findPersistentMindThinkingPreset(stored, 'deep')).toMatchObject({ providerId: 'example-provider' });
    expect(findPersistentMindThinkingPreset(stored, ' deep ')).toMatchObject({ id: 'deep' });
    expect(findPersistentMindThinkingPreset(stored, 'removed')).toBeNull();
    expect(findPersistentMindThinkingPreset(stored, '')).toBeNull();
    expect(findPersistentMindThinkingPreset(stored, null)).toBeNull();
  });

  it('rejects an unusable preset at the API boundary instead of silently normalizing it away', () => {
    expect(persistentMindThinkingPresetsSchema.safeParse({ presets: [preset()] }).success).toBe(true);
    expect(persistentMindThinkingPresetsSchema.safeParse({ presets: [preset({ effort: '' })] }).success).toBe(true);
    expect(persistentMindThinkingPresetsSchema.safeParse({ presets: [preset({ effort: 'turbo' })] }).success).toBe(false);
    expect(persistentMindThinkingPresetsSchema.safeParse({ presets: [preset({ model: '' })] }).success).toBe(false);
    expect(persistentMindThinkingPresetsSchema.safeParse({ presets: [preset({ id: 'has space' })] }).success).toBe(false);
    expect(persistentMindThinkingPresetsSchema.safeParse({ presets: [preset()], extra: true }).success).toBe(false);
    expect(persistentMindThinkingPresetsSchema.safeParse({
      presets: Array.from({ length: PERSISTENT_MIND_THINKING_PRESET_LIMITS.MAX_PRESETS + 1 }, (_, i) => preset({ id: `p${i}` })),
    }).success).toBe(false);
  });
});
