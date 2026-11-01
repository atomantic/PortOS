import { describe, it, expect } from 'vitest';
import { musicVideoConditioningReferences, musicVideoFrameReferenceFiles, MUSIC_VIDEO_MAX_CONDITIONING_REFERENCES, musicVideoReferenceCapacity } from './musicVideoConditioning.js';

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
    // A renderer's capacity caps the list; without one it keeps every pick in priority order.
    expect(musicVideoConditioningReferences(project(authored), { characterVariant: { ingredientId: CAST_ID } }, five, null, { limit: 4 }))
      .toHaveLength(4);
    expect(musicVideoConditioningReferences(project(authored), { characterVariant: { ingredientId: CAST_ID } }, five).length).toBeGreaterThan(4);
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

  it('retains automatic panel art at both the request and renderer limits while preserving explicit order', () => {
    const references = Array.from({ length: 16 }, (_, i) => ({ id: `r${i}`, imageId: `${i}.png`, condition: true }));
    const scene = { panelArt: 'panel.png' };
    const auto = musicVideoConditioningReferences(project(references), scene);
    expect(musicVideoFrameReferenceFiles('frame.png', auto, 16, { reservePanel: true })).toEqual(['frame.png', ...references.slice(0, 14).map((ref) => ref.imageId), 'panel.png']);
    expect(ids(musicVideoConditioningReferences(project(references), scene, null, null, { limit: 3 }))).toEqual(['0.png', '1.png', 'panel.png']);
    expect(ids(musicVideoConditioningReferences(project(references), { ...scene, frameReferenceIds: ['r0', 'r1', 'r2', 'mvr-panel-art'] }, null, null, { limit: 3 }))).toEqual(['0.png', '1.png', '2.png']);
    expect(musicVideoConditioningReferences(project(references), scene, null, null, { limit: 0 })).toEqual([]);
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
    expect(ids(musicVideoConditioningReferences(withFaces, scene({ sectionIndex: 0, framePrompt: 'Close up of her laughing' }))))
      .toEqual(['lead-sheet.png', 'lead-face.png', 'hill.png']);
    expect(ids(musicVideoConditioningReferences(withFaces, scene({ sectionIndex: 0, framePrompt: 'At arm’s length, Kevin and her' }))))
      .toEqual(['lead-sheet.png', 'lead-face.png', 'kevin-sheet.png', 'kevin-face.png']);
    expect(ids(musicVideoConditioningReferences(withFaces, scene({ sectionIndex: 0 })))).toEqual(['lead-sheet.png', 'hill.png', 'kevin-sheet.png']);
  });

  // Only sheets omitted at approval may be restored as virtual references.
  it('honors removal of a published face sheet and hides overflow outside an approved stage', () => {
    const face = { id: 'mvr-cs-face-kevin', imageId: 'kevin-face.png', role: 'character' };
    const shot = scene({ framePrompt: 'Close-up of Kevin' });
    const approved = { ...checkedIn, castAndSets: { ...checkedIn.castAndSets, images: { 'face:kevin': { imageId: face.imageId } }, overflowFaceReferences: [] } };
    expect(ids(musicVideoConditioningReferences(approved, shot))).not.toContain(face.imageId);
    const overflow = { ...approved, castAndSets: { ...approved.castAndSets, overflowFaceReferences: [face] } };
    expect(ids(musicVideoConditioningReferences(overflow, shot))).toContain(face.imageId);
    expect(ids(musicVideoConditioningReferences({ ...overflow, castAndSets: { ...overflow.castAndSets, status: 'review' } }, shot))).not.toContain(face.imageId);
    // A full list may have omitted the supporting cast sheet as well as its face sheet.
    const noCastSheet = { ...overflow, visualSpec: { references: references.filter((ref) => ref.id !== 'mvr-cs-cast-kevin') } };
    expect(ids(musicVideoConditioningReferences(noCastSheet, shot)).slice(0, 2)).toEqual(['lead-sheet.png', 'kevin-face.png']);
  });

  // Uniquely catches a shot whose song section was cleared (a replaced song) dropping the
  // cast sheets it names for the capped authored set, so a co-lead is drawn from text alone.
  it('keeps the named cast when the shot has no song section, filling spare slots with the authored set', () => {
    expect(ids(musicVideoConditioningReferences(checkedIn, scene({ sectionIndex: null }), null, null, { limit: 4 })))
      .toEqual(['lead-sheet.png', 'kevin-sheet.png', 'street.png', 'mall.png']);
    expect(ids(musicVideoConditioningReferences(checkedIn, { framePrompt: 'An empty street at dawn' }, null, null, { limit: 4 })))
      .toEqual(['lead-sheet.png', 'street.png', 'mall.png', 'lot.png']);
  });
});

describe('musicVideoReferenceCapacity', () => {
  it('follows the image renderer, not a fixed four', () => {
    expect(musicVideoReferenceCapacity('codex')).toBe(5);
    expect(musicVideoReferenceCapacity('grok')).toBe(16);
    expect(musicVideoReferenceCapacity('local', { localModel: { pipelineClass: 'QwenImage21Pipeline' } })).toBe(10);
    expect(musicVideoReferenceCapacity('local', { localModel: { runner: 'flux3' } })).toBe(10);
    expect(musicVideoReferenceCapacity('local', { localModel: { runner: 'flux2' } })).toBe(4);
    expect(musicVideoReferenceCapacity('local', { localModel: { runner: 'mflux' } })).toBe(0);
  });
});
