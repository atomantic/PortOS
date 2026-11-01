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
  it('leads with age-compatible guides, then fills from the project references', () => {
    const scene = { characterVariant: { ingredientId: CAST_ID, age: 7 } };
    const refs = musicVideoConditioningReferences(project(authored), scene, castMedia);
    expect(ids(refs)).toEqual(['child.png', 'lead.png', 'set.png']);
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

  // Uniquely catches a guide the image route would reject (400) taking a slot a sendable guide should fill.
  it('skips guides a frame render cannot name, letting the next candidate take the slot', () => {
    const media = { [CAST_ID]: [guide('child.gif', 7), guide('nested/child.png', 7), guide('child.png', 7)] };
    expect(ids(musicVideoConditioningReferences(project(authored), { characterVariant: { ingredientId: CAST_ID, age: 7 } }, media)))
      .toEqual(['child.png', 'lead.png', 'set.png']);
  });

  // Uniquely catches unsendable flagged guides letting non-guide images condition the shot.
  it('uses the automatic set when every flagged guide is unsendable, never the non-guide images', () => {
    const media = { [CAST_ID]: [guide('hero.avif', 7), { mediaKey: 'stale.png', kind: 'reference', library: { variant: { age: 7 } } }] };
    expect(ids(musicVideoConditioningReferences(project(authored), { characterVariant: { ingredientId: CAST_ID, age: 7 } }, media)))
      .toEqual(['lead.png', 'set.png']);
    const unflagged = { [CAST_ID]: [{ mediaKey: 'face.png', kind: 'portrait', library: {} }] };
    expect(ids(musicVideoConditioningReferences(project(authored), { characterVariant: { ingredientId: CAST_ID } }, unflagged))[0]).toBe('face.png');
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

  // Uniquely catches a fitted shot's storyboard panel losing its slot to identities, or an explicit pick ignoring it.
  it('keeps a slot for a fitted shot\'s storyboard panel art, after the identities', () => {
    const scene = { characterVariant: { ingredientId: CAST_ID, age: 7 }, panelId: 'panel-1', panelArt: 'panel.png' };
    const refs = musicVideoConditioningReferences(project(authored), scene, castMedia);
    expect(ids(refs)).toEqual(['child.png', 'lead.png', 'set.png', 'panel.png']);
    expect(refs[3]).toMatchObject({ id: 'mvr-panel-panel-1', label: 'Storyboard panel' });
    expect(ids(musicVideoConditioningReferences(project(authored), { ...scene, frameReferenceIds: ['set'] }))).toEqual(['set.png']);
    expect(ids(musicVideoConditioningReferences(project(authored), { ...scene, frameReferenceIds: ['mvr-panel-panel-1'] }))).toEqual(['panel.png']);
    expect(ids(musicVideoConditioningReferences(project(authored), { panelId: 'panel-1', panelArt: 'sketch.gif' }))).toEqual(['lead.png', 'set.png']);
  });
});

describe('musicVideoConditioningReferences with an approved Cast & Sets check-in', () => {
  const references = [
    { id: 'mvr-cs-character', imageId: 'lead-sheet.png', condition: true },
    { id: 'mvr-cs-set-street', imageId: 'street.png', condition: true },
    { id: 'mvr-cs-set-mall', imageId: 'mall.png', condition: true },
    { id: 'mvr-cs-set-lot', imageId: 'lot.png', condition: true },
    { id: 'mvr-cs-set-hill', imageId: 'hill.png', condition: false },
    { id: 'mvr-cs-cast-kevin', imageId: 'kevin-sheet.png', condition: false },
  ];
  const checkedIn = {
    visualSpec: { references },
    castAndSets: { status: 'approved', direction: { cast: [{ id: 'kevin', name: 'Kevin', role: 'boyfriend' }], songMap: [{ section: 0, setId: 'hill' }] } },
  };
  const scene = (extra) => ({ framePrompt: 'Kevin rides beside her, both laughing', ...extra });

  it('sends the shot\'s own set and the cast it names', () => {
    expect(ids(musicVideoConditioningReferences(checkedIn, scene({ sectionIndex: 0 })))).toEqual(['lead-sheet.png', 'hill.png', 'kevin-sheet.png']);
  });

  it('adds the prop sheet to a shot that shows a prop, never to one that only names its owner', () => {
    const withProps = {
      visualSpec: { references: [...references, { id: 'mvr-cs-props', imageId: 'props.png', role: 'prop', condition: false }] },
      castAndSets: { ...checkedIn.castAndSets, direction: { ...checkedIn.castAndSets.direction, props: [{ id: 'camera', name: "Kevin's camera", description: 'black 35mm compact' }] } },
    };
    expect(ids(musicVideoConditioningReferences(withProps, scene({ sectionIndex: 0, framePrompt: 'Kevin rides beside her, raising his camera' }))))
      .toEqual(['lead-sheet.png', 'hill.png', 'kevin-sheet.png', 'props.png']);
    expect(ids(musicVideoConditioningReferences(withProps, scene({ sectionIndex: 0 })))).toEqual(['lead-sheet.png', 'hill.png', 'kevin-sheet.png']);
  });

  it('trades the set plate for each person face sheet on a close-up', () => {
    const withFaces = { ...checkedIn, visualSpec: { references: [...references,
      { id: 'mvr-cs-expressions', imageId: 'lead-face.png', role: 'character' },
      { id: 'mvr-cs-face-kevin', imageId: 'kevin-face.png', role: 'character' }] } };
    expect(ids(musicVideoConditioningReferences(withFaces, scene({ sectionIndex: 0, framePrompt: 'Arm\'s-length selfie: Kevin and her cheek to cheek' }))))
      .toEqual(['lead-sheet.png', 'lead-face.png', 'kevin-sheet.png', 'kevin-face.png']);
    expect(ids(musicVideoConditioningReferences(withFaces, scene({ sectionIndex: 0, framePrompt: 'Close-up of her laughing' }))))
      .toEqual(['lead-sheet.png', 'lead-face.png', 'hill.png']);
    expect(ids(musicVideoConditioningReferences(withFaces, scene({ sectionIndex: 0 })))).toEqual(['lead-sheet.png', 'hill.png', 'kevin-sheet.png']);
  });

  // Uniquely catches a shot whose song section was cleared (a replaced song) dropping the
  // cast sheets it names for the capped authored set, so a co-lead is drawn from text alone.
  it('keeps the named cast when the shot has no song section, filling spare slots with the authored set', () => {
    expect(ids(musicVideoConditioningReferences(checkedIn, scene({ sectionIndex: null }))))
      .toEqual(['lead-sheet.png', 'kevin-sheet.png', 'street.png', 'mall.png']);
    expect(ids(musicVideoConditioningReferences(checkedIn, { framePrompt: 'An empty street at dawn' })))
      .toEqual(['lead-sheet.png', 'street.png', 'mall.png', 'lot.png']);
  });
});
