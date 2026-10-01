import { describe, expect, it } from 'vitest';
import { musicVideoCompositionSchema } from './musicVideoValidation.js';
import { normalizeComposition } from '../services/musicVideo/composition.js';
import { musicVideoGradeFilter } from './musicVideoGrade.js';

// Serialization/validation boundary: no unbounded filter values from peers or PATCH.
describe('Music Video grade contract', () => {
  it('keeps legacy and explicit neutral manifests a true bypass and rejects invalid settings', () => {
    const sections = [{ sceneId: 'a', startSec: 0, endSec: 2 }];
    expect(normalizeComposition({ mode: 'composed' })).not.toHaveProperty('grade');
    expect(musicVideoGradeFilter(null, sections)).toBeNull();
    expect(musicVideoGradeFilter({ preset: 'neutral' }, sections)).toBeNull();
    for (const grade of [{ preset: 'injected-filter' }, { grain: 0.031 }, { grain: -1 }, { grain: Infinity }]) {
      expect(musicVideoCompositionSchema.safeParse({ grade }).success).toBe(false);
    }
    expect(normalizeComposition({ grade: { preset: 'unknown', grain: 100 } }).grade).toEqual({ preset: 'neutral', grain: 0.03, sections: [] });
    expect(musicVideoCompositionSchema.parse({ grade: { preset: 'teal-night', grain: 0.02 } }).grade.preset).toBe('teal-night');
  });
});
