import { describe, it, expect } from 'vitest';
import { musicVideoConditioningReferences, MUSIC_VIDEO_MAX_CONDITIONING_REFERENCES } from './musicVideoConditioning.js';

const CAST_ID = 'cat-chr-example';
const guide = (mediaKey, age, extra = {}) => ({ mediaKey, kind: 'reference', createdAt: '2026-01-01T00:00:00.000Z', library: { variant: { age }, guide: true }, ...extra });

const project = (references) => ({
  concept: { subjects: [{ id: 'mvc-1', kind: 'character', name: 'Example Lead', ingredientId: CAST_ID }] },
  visualSpec: { references },
});
const authored = [
  { id: 'lead', imageId: 'lead.png', role: 'character', condition: true },
  { id: 'set', imageId: 'set.png', role: 'set', condition: true },
  { id: 'off', imageId: 'off.png', role: 'prop', condition: false },
];
const castMedia = { [CAST_ID]: [guide('adult.png', 27), guide('child.png', 7), guide('teen.png', 17)] };
const ids = (refs) => refs.map((ref) => ref.imageId);

describe('musicVideoConditioningReferences with Casting guides', () => {
  it('leads with the guide closest to the scene age, then fills from the project references', () => {
    const scene = { characterVariant: { ingredientId: CAST_ID, age: 7 } };
    const refs = musicVideoConditioningReferences(project(authored), scene, castMedia);
    expect(ids(refs)).toEqual(['child.png', 'teen.png', 'adult.png', 'lead.png']);
    expect(refs[0]).toMatchObject({ role: 'character', castGuide: true, label: 'Example Lead · age 7' });
    expect(ids(musicVideoConditioningReferences(project(authored), { characterVariant: { ingredientId: CAST_ID, age: 27 } }, castMedia))[0])
      .toBe('adult.png');
  });

  it('keeps the cap and drops a project reference that repeats a guide image', () => {
    const many = { [CAST_ID]: [guide('a.png', 7), guide('lead.png', 8)] };
    const refs = musicVideoConditioningReferences(project(authored), { characterVariant: { ingredientId: CAST_ID, age: 7 } }, many);
    expect(ids(refs)).toEqual(['a.png', 'lead.png', 'set.png']);
    const five = { [CAST_ID]: [1, 2, 3, 4, 5].map((n) => guide(`g${n}.png`, 7, { library: { variant: { age: 7 } } }))};
    expect(musicVideoConditioningReferences(project(authored), { characterVariant: { ingredientId: CAST_ID } }, five))
      .toHaveLength(MUSIC_VIDEO_MAX_CONDITIONING_REFERENCES);
  });

  it('is unchanged without a variant or before the cast media loads', () => {
    const today = ids(musicVideoConditioningReferences(project(authored), {}));
    expect(today).toEqual(['lead.png', 'set.png']);
    expect(ids(musicVideoConditioningReferences(project(authored), {}, castMedia))).toEqual(today);
    expect(ids(musicVideoConditioningReferences(project(authored), { characterVariant: { ingredientId: CAST_ID, age: 7 } }, null))).toEqual(today);
  });

  it('lets explicit frame references win, resolving a kept guide id', () => {
    const scene = { characterVariant: { ingredientId: CAST_ID, age: 7 }, frameReferenceIds: ['set', 'mvr-guide-child.png'] };
    expect(ids(musicVideoConditioningReferences(project(authored), scene, castMedia))).toEqual(['set.png', 'child.png']);
    expect(ids(musicVideoConditioningReferences(project(authored), scene))).toEqual(['set.png']);
  });
});
