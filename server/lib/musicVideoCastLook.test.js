import { describe, expect, it } from 'vitest';
import { castInputsFromReferences, castLookForTake } from './musicVideoCastLook.js';
import { musicVideoTakeInputSchema } from './musicVideoValidation.js';

const guide = (mediaKey, age) => ({ mediaKey, kind: 'reference', library: { variant: { age }, guide: true } });
const sceneFor = (ingredientId, age) => ({ sceneId: 's1', characterVariant: { ingredientId, age } });
const projectFor = (references = []) => ({
  concept: { subjects: [{ ingredientId: 'cat-lead', name: 'Example Lead' }, { ingredientId: 'cat-other', name: 'Example Other' }] },
  visualSpec: { references },
});

describe('music video cast look (#14154)', () => {
  // Uniquely catches recording the whole available set, or a greybox/panel image, instead of the guides and sheets a frame was sent.
  it('snapshots only the cast guides and Cast & Sets sheets among the references that were sent', () => {
    const scene = sceneFor('cat-lead', 7);
    const references = [
      { id: 'mvr-guide-child.png', imageId: 'child.png', castGuide: true },
      { id: 'mvr-cs-character', imageId: 'sheet.png' },
      { id: 'mvr-cs-set-harbor', imageId: 'harbor.png' },
      { id: 'mvr-panel-art', imageId: 'panel.png', panelArt: true },
      { id: 'greybox', imageId: 'layout.png', greybox: true },
    ];
    expect(castInputsFromReferences(scene, references)).toEqual({
      ingredientId: 'cat-lead',
      guides: ['child.png'],
      sheets: [{ id: 'mvr-cs-character', imageId: 'sheet.png' }, { id: 'mvr-cs-set-harbor', imageId: 'harbor.png' }],
    });
    expect(castInputsFromReferences({ sceneId: 's1' }, [])).toEqual({ ingredientId: null, guides: [], sheets: [] });
  });

  it('accepts that snapshot on a take, including an empty one, and refuses a path', () => {
    const castInputs = { ingredientId: 'cat-lead', guides: ['child.png'], sheets: [{ id: 'mvr-cs-character', imageId: 'sheet.png' }] };
    expect(musicVideoTakeInputSchema.safeParse({ kind: 'image', assetId: 'frame.png', source: 'generated', castInputs, replaceSelection: true }).success).toBe(true);
    expect(musicVideoTakeInputSchema.safeParse({ kind: 'image', assetId: 'frame.png', castInputs: { ingredientId: null, guides: [], sheets: [] } }).success).toBe(true);
    expect(musicVideoTakeInputSchema.safeParse({ kind: 'image', assetId: 'frame.png', castInputs: { ingredientId: null, guides: ['../child.png'], sheets: [] } }).success).toBe(false);
  });

  // Larger renderers can send more than eight sheets; the last one must still mark a take stale.
  it('records and checks every sheet a larger renderer received', () => {
    const references = Array.from({ length: 10 }, (_, i) => ({ id: `mvr-cs-cast-${i}`, imageId: `cast-${i}.png` }));
    const castInputs = castInputsFromReferences(null, references);
    expect(castInputs.sheets).toHaveLength(10);
    expect(musicVideoTakeInputSchema.safeParse({ kind: 'image', assetId: 'frame.png', castInputs }).success).toBe(true);
    const project = projectFor(references.map((ref, i) => i === 9 ? { ...ref, imageId: 'changed.png' } : ref));
    expect(castLookForTake(project, {}, { castInputs }).status).toBe('older');
  });

  // Uniquely catches a guide or sheet change marking another cast member, a take with no snapshot, or an empty snapshot.
  it('marks a frame older only when a guide or sheet it used has changed', () => {
    const lead = sceneFor('cat-lead', 7);
    const other = sceneFor('cat-other', 30);
    const project = projectFor([{ id: 'mvr-cs-character', imageId: 'sheet-new.png' }]);
    const castMedia = { 'cat-lead': [guide('face-new.png', 7)], 'cat-other': [guide('other.png', 30)] };
    const older = { ingredientId: 'cat-lead', guides: ['face-old.png'], sheets: [{ id: 'mvr-cs-character', imageId: 'sheet-old.png' }] };
    const guidesOnly = { ingredientId: 'cat-lead', guides: ['face-old.png'], sheets: [] };
    expect(castLookForTake(project, lead, { castInputs: older }, castMedia).status).toBe('older');
    expect(castLookForTake(project, lead, { castInputs: guidesOnly }, castMedia).status).toBe('older');
    expect(castLookForTake(project, lead, { castInputs: older }, {}).status).toBe('older');
    expect(castLookForTake(project, other, {
      castInputs: { ingredientId: 'cat-other', guides: ['other.png'], sheets: [] },
    }, castMedia).status).toBe('current');
    expect(castLookForTake(project, lead, { castInputs: { ingredientId: 'cat-lead', guides: ['face-new.png'], sheets: [] } }, castMedia).status).toBe('current');
    expect(castLookForTake(project, lead, { castInputs: { ingredientId: 'cat-lead', guides: [], sheets: [] } }, null).status).toBe('current');
    expect(castLookForTake(project, lead, { kind: 'image' }, castMedia).status).toBe('unknown');
    expect(castLookForTake(project, lead, { castInputs: guidesOnly }, {}).status).toBe('unknown');
    expect(castLookForTake(project, lead, { castInputs: guidesOnly }, { 'cat-lead': null }).status).toBe('unknown');
  });
});
