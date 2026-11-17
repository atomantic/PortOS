import { describe, expect, it } from 'vitest';
import { musicVideoShotReferenceChecks } from './shotReferenceCheck.js';
import { musicVideoLinkedReferenceId } from '../../lib/musicVideo/musicVideoConditioning.js';

// A comparison sheet is one image filed on both characters' records (`sheet:comparison`), with each
// record also holding its own half (`sheet:comparison-solo`). These pin that the shared sheet covers both.
const SHARED = 'pair-sheet.png';
const subjects = [
  { id: 'lead', ingredientId: 'chr-lead', name: 'Lead', kind: 'character' },
  { id: 'guest', ingredientId: 'chr-guest', name: 'Guest', kind: 'character' },
  { id: 'third', ingredientId: 'chr-third', name: 'Third', kind: 'character' },
];
const media = {
  'chr-lead': [
    { kind: 'portrait', mediaKey: 'lead.png' },
    { kind: 'reference', role: 'sheet:comparison', mediaKey: SHARED, library: { comparedWith: 'chr-guest' } },
    { kind: 'reference', role: 'sheet:comparison-solo', mediaKey: 'lead-half.png', library: { derivedFrom: { mediaKey: SHARED } } },
  ],
  'chr-guest': [
    { kind: 'portrait', mediaKey: 'guest.png' },
    { kind: 'reference', role: 'sheet:comparison', mediaKey: SHARED },
    { kind: 'reference', role: 'sheet:comparison-solo', mediaKey: 'guest-half.png', library: { derivedFrom: { mediaKey: SHARED } } },
  ],
  'chr-third': [{ kind: 'portrait', mediaKey: 'third.png' }],
};
const pick = musicVideoLinkedReferenceId;

function projectWith(scenes, conceptSubjects = subjects) {
  const items = conceptSubjects.map(subject => ({ subjectId: subject.id, ingredientId: subject.ingredientId, kind: subject.kind,
    name: subject.name, images: [], pickableImages: [], retiredImages: [] }));
  return { concept: { subjects: conceptSubjects }, castAndSets: { source: 'catalog', catalogCheckin: { items, problems: [] } },
    scenes: scenes.map(([sceneId, characters, frameReferenceIds]) => ({ sceneId, takes: [], shotSheet: { characters }, frameReferenceIds })) };
}
const codes = async (project) => (await musicVideoShotReferenceChecks(project, media)).map(row => [row.sceneId, row.code, row.message]);

describe('shot reference check with a shared comparison sheet', () => {
  it('counts the shared sheet for both characters of a two-person shot, in either record order', async () => {
    const scenes = [['pair', ['Lead', 'Guest'], [pick(SHARED)]]];
    expect(await codes(projectWith(scenes))).toEqual([]);
    // The guest's record is read first: the sheet's id is the same, and it still covers the lead.
    expect(await codes(projectWith(scenes, [subjects[1], subjects[0], subjects[2]]))).toEqual([]);
  });

  it('still reports a third listed character the sheet does not show', async () => {
    const rows = await codes(projectWith([['trio', ['Lead', 'Guest', 'Third'], [pick(SHARED)]]]));
    expect(rows.map(([, code, message]) => [code, message])).toEqual([
      ['missing-character', 'Shot 1: Add a character reference for Third to the start frame.'],
    ]);
  });

  it('does not flag a one-person shot as carrying an extra character for picking the shared sheet', async () => {
    expect(await codes(projectWith([['solo', ['Lead'], [pick(SHARED)]]]))).toEqual([]);
  });

  it('counts a solo half only for its own character', async () => {
    const rows = await codes(projectWith([
      ['half', ['Lead', 'Guest'], [pick('lead-half.png')]],
      ['wrong-half', ['Lead'], [pick('guest-half.png')]],
    ]));
    expect(rows.map(([sceneId, code]) => [sceneId, code])).toEqual([
      ['half', 'missing-character'], ['wrong-half', 'missing-character'], ['wrong-half', 'extra-character'],
    ]);
    expect(rows[0][2]).toContain('for Guest');
  });

  it('does not let the shared sheet stand in for an inactive alternate', async () => {
    // The guest is set aside for an alternate with the same name, on another record without the sheet.
    const alternate = { id: 'guest-alt', ingredientId: 'chr-guest-alt', name: 'Guest', kind: 'character', active: true };
    const cast = [subjects[0], { ...subjects[1], active: false }, alternate];
    const withAlternate = { ...media, 'chr-guest-alt': [{ kind: 'portrait', mediaKey: 'guest-alt.png' }] };
    const rows = await musicVideoShotReferenceChecks(projectWith([['pair', ['Lead', 'Guest'], [pick(SHARED)]]], cast), withAlternate);
    expect(rows.map(row => [row.code, row.message])).toEqual([
      ['missing-character', 'Shot 1: Add a character reference for Guest to the start frame.'],
    ]);
    expect(rows[0].patch).toEqual({ frameReferenceIds: [pick(SHARED), pick('guest-alt.png')] });
  });
});
