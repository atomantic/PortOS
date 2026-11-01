import { describe, it, expect } from 'vitest';
import { buildCastAndSetsImagePlan, castAndSetsReferences, castAndSetsSubjects, noteImageKeys } from './castAndSetsPlan.js';

const DIRECTION = {
  logline: 'Two teens ride all night.',
  protagonist: { name: 'Renee', face: 'sunburned', hair: 'frizzy perm' },
  looks: [{ name: 'TEE', description: 'lavender tee and cutoffs' }],
  sets: [{ id: 'street', name: 'Cul-de-sac', description: 'a curved street', lighting: 'golden hour' }],
  props: [
    { id: 'camera', name: "Renee's camera", owner: 'Renee', description: 'matte black plastic 35mm snapshot camera on a wrist strap' },
    { id: 'bmx', name: 'BMX', owner: 'Renee', description: 'chrome BMX with blue mag wheels' },
  ],
  songMap: [], tests: [],
};

describe('Cast & Sets prop sheet', () => {
  it('plans one prop sheet naming every prop exactly, and none without props', () => {
    const plan = buildCastAndSetsImagePlan({ scenes: [] }, DIRECTION);
    expect(plan.props).toMatchObject({ kind: 'props', deps: [], refKeys: [] });
    expect(plan.props.prompt).toContain("RENEE'S CAMERA (Renee): matte black plastic 35mm snapshot camera on a wrist strap");
    expect(plan.props.prompt).toContain('BMX (Renee): chrome BMX with blue mag wheels');
    expect(plan.props.prompt).toMatch(/no brand names, logos or text/);
    expect(noteImageKeys('prop', plan)).toEqual(['props']);
    expect(buildCastAndSetsImagePlan({ scenes: [] }, { ...DIRECTION, props: [] }).props).toBeUndefined();
  });

  it('publishes the sheet as an unconditioned prop reference and each prop as an object subject', () => {
    const stage = { direction: DIRECTION, images: { character: { imageId: 'lead.png' }, props: { imageId: 'props.png' } } };
    const props = castAndSetsReferences({ visualSpec: { references: [] } }, stage).find((ref) => ref.id === 'mvr-cs-props');
    expect(props).toMatchObject({ imageId: 'props.png', role: 'prop', label: 'Props', condition: false });
    expect(props.note).toContain("Renee's camera: matte black plastic 35mm snapshot camera");
    const objects = castAndSetsSubjects({ concept: { subjects: [] } }, stage).filter((s) => s.kind === 'object');
    expect(objects.map((s) => s.name)).toEqual(["Renee's camera", 'BMX']);
  });
});

describe('Cast & Sets face sheets', () => {
  const WITH_CAST = { ...DIRECTION, cast: [{ id: 'kevin', name: 'Kevin', role: 'boyfriend', face: 'long narrow face, ears that stick out', hair: 'shaggy middle part' }] };

  it('opens every face sheet with the head angles and gives each cast member one built on their cast sheet', () => {
    const plan = buildCastAndSetsImagePlan({ scenes: [] }, WITH_CAST);
    expect(plan.expressions.label).toBe('Face sheet');
    expect(plan.expressions.prompt).toContain('FRONT, 3/4 LEFT, PROFILE LEFT, 3/4 RIGHT, PROFILE RIGHT');
    expect(plan['face:kevin']).toMatchObject({ kind: 'face', deps: ['cast:kevin'], refKeys: ['cast:kevin'], label: 'Kevin face sheet' });
    expect(plan['face:kevin'].prompt).toContain('FRONT, 3/4 LEFT, PROFILE LEFT');
    expect(plan['face:kevin'].prompt).toContain('nothing held in the hands');
    expect(noteImageKeys('kevin face sheet', plan)).toEqual(['face:kevin']);
  });

  it('publishes each face sheet as an unconditioned reference with the face and hair note', () => {
    const stage = { direction: { ...WITH_CAST, protagonist: { ...DIRECTION.protagonist, face: 'sunburned' } }, images: { character: { imageId: 'lead.png' }, expressions: { imageId: 'lead-face.png' }, 'cast:kevin': { imageId: 'kevin.png' }, 'face:kevin': { imageId: 'kevin-face.png' } } };
    const refs = castAndSetsReferences({ visualSpec: { references: [] } }, stage);
    expect(refs.find((ref) => ref.id === 'mvr-cs-face-kevin')).toMatchObject({ imageId: 'kevin-face.png', role: 'character', label: 'Kevin — face sheet', condition: false, note: 'long narrow face, ears that stick out; shaggy middle part' });
    expect(refs.find((ref) => ref.id === 'mvr-cs-expressions')).toMatchObject({ label: 'Renee — face sheet', note: 'sunburned; frizzy perm' });
  });
});
