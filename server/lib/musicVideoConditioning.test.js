import { musicVideoFrameModelInput } from './musicVideoShotPrompt.js';
import { shotSheetCast } from './musicVideoShotSheet.js';
import { musicVideoConceptSchema } from './musicVideoValidation.js';
import { describe, it, expect } from 'vitest';
import { musicVideoCastGuideReferences, musicVideoCatalogPickPlans, musicVideoReferenceChoices, musicVideoClipConditioningReferences, musicVideoClipReferenceCapacity, musicVideoConditioningReferences, musicVideoFrameReferenceFiles, musicVideoReferenceCapacity } from './musicVideoConditioning.js';
import { getFalVideoModel } from './falVideoModels.js';

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

it('uses the selected video model\'s real extra-image capacity', () => {
  expect(musicVideoClipReferenceCapacity('grok')).toBe(7);
  expect(musicVideoClipReferenceCapacity('local', { maxReferenceImages: 9, maxReferenceTotal: 5 })).toBe(4);
  expect(musicVideoClipReferenceCapacity('local', { id: 'ltx25' })).toBe(0);
  expect(musicVideoClipReferenceCapacity('fal', getFalVideoModel('minimax/h3-max/reference-to-video'))).toBe(9);
  expect(musicVideoClipReferenceCapacity('fal', getFalVideoModel('bytedance/seedance-2.5/reference-to-video'))).toBe(16);
  expect(musicVideoClipReferenceCapacity('fal', getFalVideoModel('fal-ai/minimax/hailuo-02/standard/image-to-video'))).toBe(0);
  expect(musicVideoClipReferenceCapacity('runway')).toBe(0);
});

describe('musicVideoConditioningReferences with Casting guides', () => {
  // Uniquely catches selecting the second long guide sending the first one's image.
  it('resolves distinct long guide picks and preserves existing short guide ids', () => {
    const prefix = 'a'.repeat(130);
    const media = { [CAST_ID]: [guide(`${prefix}-one.png`, 7), guide(`${prefix}-two.png`, 7), guide('short.png', 7)] };
    const scene = { characterVariant: { ingredientId: CAST_ID, age: 7 } };
    const refs = musicVideoCastGuideReferences(project([]), scene, media);
    expect(new Set(refs.map(ref => ref.id)).size).toBe(3);
    expect(refs.every(ref => ref.id.length <= 128)).toBe(true);
    expect(refs.find(ref => ref.imageId === 'short.png').id).toBe('mvr-guide-short.png');
    for (const ref of refs) {
      expect(ids(musicVideoConditioningReferences(project([]), { ...scene, frameReferenceIds: [ref.id] }, media))).toEqual([ref.imageId]);
    }
  });

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
    expect(ids(musicVideoConditioningReferences(project(authored), { characterVariant: { ingredientId: CAST_ID } }, five)))
      .toEqual(['g1.png', 'g2.png', 'g3.png', 'g4.png', 'g5.png', 'lead.png', 'set.png']);
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

  it('keeps distinct explicit choices that use the same image', () => {
    const references = [{ id: 'first', imageId: 'same.png' }, { id: 'second', imageId: 'same.png' }];
    expect(musicVideoConditioningReferences(project(references), { frameReferenceIds: ['first', 'second'] }).map((ref) => ref.id))
      .toEqual(['first', 'second']);
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

  it('prioritizes each person and face sheet on a close-up, retaining the set when it fits', () => {
    const withFaces = { ...checkedIn, visualSpec: { references: [...references,
      { id: 'mvr-cs-expressions', imageId: 'lead-face.png', role: 'character' },
      { id: 'mvr-cs-face-kevin', imageId: 'kevin-face.png', role: 'character' }] } };
    expect(ids(musicVideoConditioningReferences(withFaces, scene({ sectionIndex: 0, framePrompt: 'Arm\'s-length selfie: Kevin and her cheek to cheek' }))))
      .toEqual(['lead-sheet.png', 'lead-face.png', 'kevin-sheet.png', 'kevin-face.png', 'hill.png']);
    expect(ids(musicVideoConditioningReferences(withFaces, scene({ sectionIndex: 0, framePrompt: 'Close-up of Kevin' }), null, null, { limit: 4 })))
      .toEqual(['lead-sheet.png', 'lead-face.png', 'kevin-sheet.png', 'kevin-face.png']);
    expect(ids(musicVideoConditioningReferences(withFaces, scene({ sectionIndex: 0, framePrompt: 'Close-up of her laughing' }))))
      .toEqual(['lead-sheet.png', 'lead-face.png', 'hill.png']);
    expect(ids(musicVideoConditioningReferences(withFaces, scene({ sectionIndex: 0, framePrompt: 'Close up of her laughing' }))))
      .toEqual(['lead-sheet.png', 'lead-face.png', 'hill.png']);
    expect(ids(musicVideoConditioningReferences(withFaces, scene({ sectionIndex: 0, framePrompt: 'At arm’s length, Kevin and her' }))))
      .toEqual(['lead-sheet.png', 'lead-face.png', 'kevin-sheet.png', 'kevin-face.png', 'hill.png']);
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

describe('musicVideoConditioningReferences with research photos (#14822)', () => {
  const research = (n) => ({ id: `mvr-research-r${n}`, imageId: `research-${n}.png`, subject: 'Example Breed', pageUrl: 'https://example.com/photo' });
  // Uniquely catches researched subject photos losing their lead to the automatic set, or escaping the renderer cap.
  it('leads with the shot\'s research photos as subject references, within the renderer\'s cap', () => {
    const scene = { researchReferences: [research(1), research(2), research(3)] };
    const refs = musicVideoConditioningReferences(project(authored), scene, null, null, { limit: 4 });
    expect(ids(refs)).toEqual(['research-1.png', 'research-2.png', 'research-3.png', 'lead.png']);
    expect(refs[0]).toMatchObject({ role: 'subject', label: 'Example Breed', research: true });
    expect(ids(musicVideoConditioningReferences(project(authored), { ...scene, frameReferenceIds: ['set', 'mvr-research-r2'] }))).toEqual(['set.png', 'research-2.png']);
    // On Auto a clip also keeps the subject photos, beside the identities.
    expect(ids(musicVideoClipConditioningReferences(project(authored), scene))).toEqual(['research-1.png', 'research-2.png', 'research-3.png', 'lead.png']);
  });
});

describe('catalog-linked check-in conditioning', () => {
  const catalogProject = () => ({
    visualSpec: { references: [
      { id: 'mvr-cs-character', imageId: 'old-sheet.png', role: 'character', condition: true },
      { id: 'renamed-sheet', imageId: 'old-set.png', role: 'set', condition: true },
      { id: 'palette', imageId: 'palette.png', role: 'mood', condition: true },
    ] },
    castAndSets: {
      source: 'catalog', status: 'approved',
      images: { character: { imageId: 'old-sheet.png' }, 'set:room': { imageId: 'old-set.png' } },
      overflowFaceReferences: [{ id: 'mvr-cs-face-lead', imageId: 'old-face.png', role: 'character' }],
      catalogCheckin: { approved: true, basis: 'live-basis', problems: [], items: [
        { subjectId: 'lead', ingredientId: CAST_ID, formId: 'adult', kind: 'character', name: 'Lead', images: ['current-lead.png'] },
        { subjectId: 'room', ingredientId: 'cat-loc-room', kind: 'location', name: 'Room', images: ['current-room.png'] },
      ] },
    },
  });

  // Uniquely catches a moved pick vanishing from renders when the catalog later stops offering its image.
  it('reports a catalog pick the check-in stopped offering, but not while the check-in itself is unresolved', () => {
    const p = catalogProject();
    const id = musicVideoReferenceChoices(p).find((ref) => ref.imageId === 'current-lead.png').id;
    const scene = { sceneId: 's1', frameReferenceIds: [id] };
    expect(musicVideoCatalogPickPlans(p, [scene])).toEqual([]);
    p.castAndSets.catalogCheckin.items[0].images = ['newer-lead.png'];
    expect(musicVideoCatalogPickPlans(p, [scene])[0].unmappedFrame).toEqual([{ id, label: 'a removed catalog image' }]);
    p.castAndSets.catalogCheckin.problems = [{ subjectId: 'lead', code: 'CATALOG_UNAVAILABLE', message: 'Try again' }];
    expect(musicVideoCatalogPickPlans(p, [scene])).toEqual([]);
  });

  it('conditions from current catalog media without copying or modifying historical sheets', () => {
    const p = catalogProject();
    const before = structuredClone(p);
    expect(ids(musicVideoConditioningReferences(p, { prompt: 'Lead in the Room' }))).toEqual(['current-lead.png', 'current-room.png', 'palette.png']);
    expect(p).toEqual(before);
    p.castAndSets.catalogCheckin.items[0].images = ['updated-lead.png'];
    expect(ids(musicVideoConditioningReferences(p, { prompt: 'Lead in the Room' }))[0]).toBe('updated-lead.png');
    expect(ids(musicVideoClipConditioningReferences(p, { prompt: 'Lead in the Room' }))).toEqual(['updated-lead.png']);
  });

  it('drops stale explicit picks and aliases while retaining live picks and panel art', () => {
    const p = catalogProject();
    const scene = { panelId: 'p1', panelArt: 'panel.png', frameReferenceIds: [
      'mvr-cs-character', 'renamed-sheet', 'mvr-cs-face-lead', musicVideoReferenceChoices(p)[0].id, 'mvr-panel-p1',
    ], researchReferences: [{ id: 'aliased-old', imageId: 'old-sheet.png', subject: 'Lead' }] };
    scene.frameReferenceIds.push('aliased-old');
    const before = structuredClone(scene);
    expect(ids(musicVideoConditioningReferences(p, scene))).toEqual(['current-lead.png', 'panel.png']);
    expect(ids(musicVideoClipConditioningReferences(p, { ...scene, clipReferenceIds: scene.frameReferenceIds })))
      .toEqual(['current-lead.png']);
    expect(scene).toEqual(before);
    expect(ids(musicVideoConditioningReferences(p, { panelId: 'p1', panelArt: 'panel.png', prompt: 'Lead in the Room' })))
      .toEqual(['current-lead.png', 'current-room.png', 'palette.png', 'panel.png']);
  });

  it('allows a historical sheet promoted into the approved catalog while excluding its old IDs and unpromoted history', () => {
    const p = catalogProject();
    p.castAndSets.images.character.history = ['promoted.png', 'obsolete-edit.png'];
    p.castAndSets.catalogCheckin.items[0].images = ['old-sheet.png', 'promoted.png'];
    p.visualSpec.references.push({ id: 'old-edit-alias', imageId: 'obsolete-edit.png', condition: true });
    expect(ids(musicVideoConditioningReferences(p, { prompt: 'Lead in the Room' }))).toEqual(['old-sheet.png', 'current-room.png', 'promoted.png', 'palette.png']);
    expect(ids(musicVideoConditioningReferences(p, { frameReferenceIds: ['mvr-cs-character', 'old-edit-alias', musicVideoReferenceChoices(p)[0].id] })))
      .toEqual(['old-sheet.png']);
  });

  it('keeps explicit media choices stable through catalog reordering, insertion and removal', () => {
    const p = catalogProject();
    const item = p.castAndSets.catalogCheckin.items[0];
    const prefix = 'shared-prefix-'.repeat(20);
    item.subjectId = 'long-subject-'.repeat(20);
    item.images = [`${prefix}a.png`, `${prefix}b.png`];
    const choices = musicVideoReferenceChoices(p);
    const selected = [choices[1].id, choices[0].id];
    expect(new Set(selected).size).toBe(2);
    expect(selected.every(id => id.length <= 128)).toBe(true);
    const scene = { frameReferenceIds: selected };
    item.images = ['inserted.png', `${prefix}b.png`, `${prefix}a.png`];
    expect(ids(musicVideoConditioningReferences(p, scene))).toEqual([`${prefix}b.png`, `${prefix}a.png`]);
    item.images = ['replacement.png', `${prefix}a.png`];
    expect(ids(musicVideoConditioningReferences(p, scene))).toEqual([`${prefix}a.png`]);
    expect(scene.frameReferenceIds).toEqual(selected);
  });

  it('gives each catalog subject a distinct image before extra views consume the renderer cap', () => {
    const p = catalogProject();
    p.castAndSets.catalogCheckin.items[0].images = ['lead.png', 'lead.png', 'lead-side.png', 'lead-back.png'];
    p.castAndSets.catalogCheckin.items.splice(1, 0, { subjectId: 'guest', kind: 'character', name: 'Guest', images: ['lead.png', 'guest.png', 'guest-side.png'] });
    p.castAndSets.catalogCheckin.items[2].images = ['room.png', 'room-side.png'];
    expect(ids(musicVideoConditioningReferences(p, { prompt: 'Lead and Guest in the Room' }, null, null, { limit: 3 }))).toEqual(['lead.png', 'guest.png', 'room.png']);
    expect(ids(musicVideoConditioningReferences(p, { prompt: 'Lead and Guest in the Room' }, null, null, { limit: 6 })))
      .toEqual(['lead.png', 'guest.png', 'room.png', 'lead-side.png', 'guest-side.png', 'room-side.png']);
  });

  it('selects the named actor and room rather than unrelated actors, even beyond the renderer cap', () => {
    const p = catalogProject();
    p.castAndSets.catalogCheckin.items.unshift(...['Alice', 'Clara', 'David', 'Elena', 'Felix'].map(name => ({
      subjectId: name, ingredientId: `cast-${name}`, kind: 'character', name, images: [1, 2, 3, 4].map(n => `${name}-${n}.png`),
    })));
    const lead = p.castAndSets.catalogCheckin.items.find(item => item.subjectId === 'lead');
    lead.name = 'Bob';
    const scene = { description: 'Bob alone in the Room' };
    expect(ids(musicVideoConditioningReferences(p, scene, null, null, { limit: 4 })))
      .toEqual(['current-lead.png', 'current-room.png', 'palette.png']);
    expect(ids(musicVideoConditioningReferences(p, scene, null, null, { limit: 1 }))).toEqual(['current-lead.png']);
    expect(ids(musicVideoConditioningReferences(p, { prompt: 'An abstract shot' }))).toEqual(['palette.png']);
  });

  it('honors structured cast and set selectors without substituting other subjects when selected items are missing', () => {
    const p = catalogProject();
    p.castAndSets.catalogCheckin.items.push({ subjectId: 'camera', kind: 'object', name: "Lead's camera", images: ['camera.png'] });
    expect(ids(musicVideoConditioningReferences(p, { characterVariant: { ingredientId: CAST_ID }, setReference: { subjectId: 'room' } })))
      .toEqual(['current-lead.png', 'current-room.png', 'palette.png']);
    expect(ids(musicVideoConditioningReferences(p, { characterVariant: { ingredientId: 'missing' }, setReference: { subjectId: 'missing' } })))
      .toEqual(['palette.png']);
    expect(ids(musicVideoConditioningReferences(p, { shotSheet: { characters: ['Lead'], location: 'Room', action: 'Raise the camera' } })))
      .toEqual(['current-lead.png', 'current-room.png', 'camera.png', 'palette.png']);
    expect(ids(musicVideoConditioningReferences(p, { shotSheet: { characters: ['Missing'], location: 'Missing' } }))).toEqual(['palette.png']);
    p.castAndSets.direction = { sets: [{ id: 'legacy-room', setReference: { subjectId: 'room' } }], songMap: [{ section: 0, setId: 'legacy-room' }] };
    expect(ids(musicVideoConditioningReferences(p, { sectionIndex: 0 }))).toEqual(['current-room.png', 'palette.png']);
    expect(musicVideoConditioningReferences(p, { frameReferenceIds: ['removed-choice'], prompt: 'Lead in the Room' })).toEqual([]);
  });

  it('keeps an explicit catalog form exact despite matching names, shot-sheet cast and canonical guides', () => {
    const p = catalogProject();
    const lead = p.castAndSets.catalogCheckin.items[0];
    lead.formId = null;
    p.castAndSets.catalogCheckin.items.push({ ...lead, subjectId: 'lead-child', formId: 'child', images: ['child-look.png'] },
      { ...lead, subjectId: 'lead-older', formId: 'older', images: ['older-look.png'] });
    const scene = { characterVariant: { ingredientId: CAST_ID, formId: 'child' }, framePrompt: 'Lead alone', shotSheet: { characters: ['Lead'] } };
    const media = { [CAST_ID]: [guide('canonical-guide.png', 30), guide('older-guide.png', 70,
      { library: { guide: true, variant: { formId: 'older' } } })] };
    expect(ids(musicVideoConditioningReferences(p, scene, media))).toEqual(['child-look.png', 'palette.png']);
    expect(ids(musicVideoConditioningReferences(p, { ...scene, characterVariant: { ingredientId: CAST_ID, formId: null } }, media)))
      .toEqual(['canonical-guide.png', 'current-lead.png', 'palette.png']);
    p.castAndSets.catalogCheckin.items = p.castAndSets.catalogCheckin.items.filter(item => item.formId !== 'child');
    expect(ids(musicVideoConditioningReferences(p, scene, media))).toEqual(['palette.png']);
    media[CAST_ID].push(guide('child-guide.png', 7, { library: { guide: true, variant: { formId: 'child' } } }));
    expect(ids(musicVideoConditioningReferences(p, scene, media))).toEqual(['child-guide.png', 'palette.png']);
  });

  it('does not resurrect legacy sheets while catalog resolution or approval is pending', () => {
    for (const checkin of [undefined, { approved: false, items: [], problems: [] },
      { approved: true, items: [{ subjectId: 'lead', kind: 'character', images: ['current-lead.png'] }], problems: ['Missing catalog item'] }]) {
      const p = catalogProject();
      p.castAndSets.catalogCheckin = checkin;
      expect(ids(musicVideoConditioningReferences(p, { prompt: 'Lead in the Room' }))).toEqual(['palette.png']);
      expect(musicVideoConditioningReferences(p, { frameReferenceIds: ['mvr-cs-character', 'renamed-sheet'] })).toEqual([]);
    }
  });
});

// Pins the public render inputs together: switching an alternate must switch both text and pixels.
it('uses only the active alternate in the frame bible, references and shot-sheet picker', () => {
  const subjects = [
    { id: 'one', kind: 'character', name: 'Q', description: 'Silver coat', ingredientId: 'cast-one' },
    { id: 'two', kind: 'character', name: 'Q', description: 'Copper dress', ingredientId: 'cast-two' },
  ];
  const p = { concept: { subjects }, visualSpec: { references: [] }, castAndSets: {
    source: 'catalog', catalogCheckin: { approved: true, problems: [], items: subjects.map(subject => ({
      subjectId: subject.id, ingredientId: subject.ingredientId, name: subject.name, kind: subject.kind, images: [`${subject.id}.png`],
    })) },
  } };
  const scene = { framePrompt: 'Q stands by the window' };
  const assertChoice = (image, present, absent) => {
    const references = musicVideoConditioningReferences(p, scene);
    expect(ids(references)).toEqual([image]);
    const input = musicVideoFrameModelInput(p, scene, { references });
    expect(input.prompt).toContain(present);
    expect(input.prompt).not.toContain(absent);
    expect(shotSheetCast(p)).toEqual(['Q']);
  };
  assertChoice('one.png', 'Silver coat', 'Copper dress');
  p.concept = musicVideoConceptSchema.parse({ subjects: subjects.map(subject => ({ ...subject, active: subject.id === 'two' })) });
  assertChoice('two.png', 'Copper dress', 'Silver coat');
  expect(ids(musicVideoConditioningReferences(p, { shotSheet: { characters: ['Q'] } }))).toEqual(['two.png']);
  expect(musicVideoConditioningReferences(p, { framePrompt: 'q stands by the window' })).toEqual([]);
  const oldPick = musicVideoReferenceChoices({ ...p, concept: { subjects } })[0].id;
  expect(musicVideoConditioningReferences(p, { ...scene, frameReferenceIds: [oldPick] })).toEqual([]);
});

it('matches short cast names as exact whole words and keeps short role words out of conditioning', () => {
  const p = { castAndSets: { status: 'approved', direction: { cast: [{ id: 'guest', name: 'Q', role: 'DJ' }] } }, visualSpec: { references: [
    { id: 'mvr-cs-character', imageId: 'lead.png' },
    { id: 'mvr-cs-cast-guest', imageId: 'guest.png' },
    { id: 'authored', role: 'character', label: 'Xi — portrait', imageId: 'authored.png' },
  ] } };
  expect(ids(musicVideoConditioningReferences(p, { prompt: 'Q meets Xi' }))).toEqual(['lead.png', 'guest.png', 'authored.png']);
  expect(ids(musicVideoConditioningReferences(p, { prompt: 'q meets xi at a DJ booth with Qwerty' }))).toEqual(['lead.png']);
});

it('drops inactive generated cast sheets and catalog-image aliases from new renders', () => {
  const p = { concept: { subjects: [
    { id: 'cs-protagonist', kind: 'character', role: 'protagonist', name: 'Q', active: false },
    { id: 'cs-cast-guest', kind: 'character', name: 'Q', active: true },
  ] }, castAndSets: { status: 'approved', direction: { cast: [{ id: 'guest', name: 'Q' }] },
    catalogCheckin: { items: [{ subjectId: 'cs-protagonist', images: ['old.png'] }] },
  }, visualSpec: { references: [
    { id: 'mvr-cs-character', imageId: 'old.png', condition: true },
    { id: 'old-alias', imageId: 'old.png', condition: true },
    { id: 'mvr-cs-cast-guest', imageId: 'new.png', condition: true },
  ] } };
  expect(ids(musicVideoConditioningReferences(p, { prompt: 'Q walks' }))).toEqual(['new.png']);
  p.concept.subjects = p.concept.subjects.map(subject => ({ ...subject, active: !subject.active }));
  expect(ids(musicVideoConditioningReferences(p, { prompt: 'Q walks' }))).toEqual(['old.png']);
});
