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
