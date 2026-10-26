import { describe, expect, it } from 'vitest';
import { greyboxSceneSchema } from './greyboxScene.js';
import { GREYBOX_STARTERS } from './greyboxStarters.js';

describe('greybox starters', () => {
  it('ships distinct, compact scenes that the save endpoint accepts, with usable shot ids', () => {
    expect(GREYBOX_STARTERS).toHaveLength(3);
    expect(new Set(GREYBOX_STARTERS.map(({ id }) => id)).size).toBe(GREYBOX_STARTERS.length);
    for (const { scene } of GREYBOX_STARTERS) {
      const parsed = greyboxSceneSchema.parse(scene);
      expect(parsed).toEqual(scene);
      expect(parsed.parts.length).toBeLessThan(40);
      expect(parsed.shots.length).toBeGreaterThan(0);
      for (const key of ['parts', 'zones', 'landmarks', 'anchors', 'shots']) {
        expect(new Set(parsed[key].map(({ id }) => id)).size).toBe(parsed[key].length);
      }
    }
  });
});
