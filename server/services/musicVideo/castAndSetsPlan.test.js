import { describe, it, expect } from 'vitest';
import { buildCastAndSetsImagePlan, castAndSetsReferences, castAndSetsSubjects, noteImageKeys } from './castAndSetsPlan.js';

const DIRECTION = {
  logline: 'Two teens ride all night.',
  protagonist: { name: 'Ada', face: 'sunburned', hair: 'frizzy perm' },
  looks: [{ name: 'TEE', description: 'lavender tee and cutoffs' }],
  sets: [{ id: 'street', name: 'Cul-de-sac', description: 'a curved street', lighting: 'golden hour' }],
  props: [
    { id: 'camera', name: "Ada's camera", owner: 'Ada', description: 'matte black plastic 35mm snapshot camera on a wrist strap' },
    { id: 'bmx', name: 'BMX', owner: 'Ada', description: 'chrome BMX with blue mag wheels' },
  ],
  songMap: [], tests: [],
};

describe('Cast & Sets neutral people sheets', () => {
  const direction = { ...DIRECTION,
    look: 'Kodak film grain, warm amber grade and hard rim light',
    protagonist: { ...DIRECTION.protagonist, forms: [{ id: 'age-7', label: 'Age 7', age: '7', look: 'Faded sepia film', era: '1965' }] },
    cast: [{ id: 'ben', name: 'Ben', face: 'wide-set brown eyes' }],
    looks: [...DIRECTION.looks, { name: 'Coat', description: 'a red wool coat' }],
    tests: [{ setId: 'street', formId: 'age-7', action: 'walking home', caption: 'memory' }], testsFixed: true,
  };
  const sheets = ['character', 'expressions', 'looks', 'form:age-7', 'cast:ben', 'face:ben'];

  it('isolates every people plate from scene lighting and grading while keeping scene and era looks', () => {
    const source = structuredClone(direction);
    const plan = buildCastAndSetsImagePlan({ scenes: [] }, direction);
    for (const key of sheets) {
      const prompt = plan[key].prompt;
      expect(prompt).toContain('Flat 18% neutral gray color field, uniform corner-to-corner');
      expect(prompt).toContain('not a physical room, backdrop, floor or wall');
      expect(prompt).toContain('zero cast, contact, floor or ambient-occlusion shadow');
      expect(prompt).toContain('zero light bleed outside the silhouette');
      expect(prompt).toContain('identical skin value and hue across front, rear and face panels');
      expect(prompt).toContain('no depth-of-field blur');
      expect(prompt).toContain('Render no text, no labels, no captions, no numbering anywhere in the image');
      expect(prompt).not.toMatch(/Look:|Light:|golden hour|Kodak|sepia|dark grey backdrop|typewriter captions/);
      expect(prompt).toContain('photorealistic, editorial photography');
    }
    for (const key of ['character', 'looks', 'form:age-7', 'cast:ben']) {
      expect(plan[key].prompt).toContain('FRONT views dead-on orthographic');
      expect(plan[key].prompt).toContain('weight even across both feet, regardless of how the figure stands in the reference');
    }
    for (const key of ['character', 'form:age-7', 'cast:ben']) {
      expect(plan[key].prompt).toContain('BACK view dead-on orthographic from directly behind');
      expect(plan[key].prompt).toContain('no glance back');
    }
    for (const key of sheets.filter((key) => key !== 'looks')) {
      expect(plan[key].prompt).toContain('FACE close-ups and FRONT face panels dead-on orthographic and level');
    }
    expect(plan.looks.prompt).toContain('Panel 1 from the left wears TEE: lavender tee and cutoffs');
    expect(plan.looks.prompt).toContain('Panel 2 from the left wears Coat: a red wool coat');
    expect(plan['set:street'].prompt).toContain('Lighting: golden hour');
    expect(plan['set:street'].prompt).toContain(`Look: ${direction.look}`);
    expect(plan['test:1'].prompt).toContain('Light: golden hour');
    expect(plan['test:1'].prompt).toContain('Look: Faded sepia film');
    expect(plan['test:1'].prompt).toContain('1965');
    expect(direction).toEqual(source);
  });

  it('retains known nonphotographic rendering media without carrying their scene grade onto people', () => {
    const look = 'Watercolor illustration and hand-drawn animation, warm amber grade, hard rim light';
    const plan = buildCastAndSetsImagePlan({ scenes: [] }, { ...direction, look });
    for (const key of sheets) {
      expect(plan[key].prompt).toContain('Rendering medium: Watercolor illustration, hand-drawn animation');
      expect(plan[key].prompt).not.toMatch(/photorealistic|Photographic|warm amber grade|hard rim light/);
    }
    expect(plan['set:street'].prompt).toContain(`Look: ${look}`);
    const animated = buildCastAndSetsImagePlan({ scenes: [] }, { ...direction, look: '3D animated, warm amber grade' });
    expect(animated.character.prompt).toContain('Rendering medium: 3D animated');
    expect(animated.character.prompt).not.toMatch(/photorealistic|warm amber grade/);
    const photographic = buildCastAndSetsImagePlan({ scenes: [] }, { ...direction, look: 'Editorial photography, not an anime or cartoon' });
    expect(photographic.character.prompt).toContain('photorealistic, editorial photography');
    expect(photographic.character.prompt).not.toContain('Rendering medium:');
    const excludedList = buildCastAndSetsImagePlan({ scenes: [] }, { ...direction, look: 'No anime, cartoon and pixel art; watercolor illustration, warm amber grade' });
    expect(excludedList.character.prompt).toContain('Rendering medium: watercolor illustration');
    expect(excludedList.character.prompt).not.toMatch(/anime|cartoon|pixel art|warm amber grade/);
    const memory = buildCastAndSetsImagePlan({ scenes: [] }, { ...direction,
      protagonist: { ...direction.protagonist, forms: [{ ...direction.protagonist.forms[0], look: 'oil painting, sepia grade' }] } });
    expect(memory.character.prompt).toContain('photorealistic, editorial photography');
    expect(memory['form:age-7'].prompt).toContain('Rendering medium: oil painting');
    expect(memory['form:age-7'].prompt).not.toMatch(/photorealistic|sepia grade/);
    expect(memory['test:1'].prompt).toContain('Look: oil painting, sepia grade');
    const inherited = buildCastAndSetsImagePlan({ scenes: [], concept: { style: 'acrylic painting, warm amber grade' } }, { ...direction, look: 'hard rim light' });
    expect(inherited.character.prompt).toContain('Rendering medium: acrylic painting');
    expect(inherited.character.prompt).not.toMatch(/photorealistic|warm amber grade|hard rim light/);
    const explicit = buildCastAndSetsImagePlan({ scenes: [] }, { ...direction, look: 'acrylic painting, warm amber grade' });
    expect(explicit.character.prompt).toContain('Rendering medium: acrylic painting');
    expect(explicit.character.prompt).not.toMatch(/photorealistic|warm amber grade/);
  });
});

describe('Cast & Sets prop sheet', () => {
  it('preserves the signature while keeping carried objects on the prop sheet', () => {
    const signature = 'matte black plastic 35mm snapshot camera on a wrist strap';
    const direction = { ...DIRECTION,
      protagonist: { ...DIRECTION.protagonist, signature,
        forms: [{ id: 'age-7', label: 'Age 7', age: '7', wardrobe: 'a plaid dress and a silver watch' }] },
      cast: [{ id: 'ben', name: 'Ben', wardrobe: 'a denim jacket and a gold ring' }],
    };
    for (const props of [direction.props, []]) {
      const plan = buildCastAndSetsImagePlan({ scenes: [] }, { ...direction, props });
      for (const key of ['character', 'looks', 'form:age-7', 'cast:ben']) {
        expect(plan[key].prompt).toContain('Hands empty and relaxed, holding no device or carried object');
        expect(plan[key].prompt).toContain('Carried props are drawn on the prop sheet');
      }
      for (const key of ['character', 'looks']) {
        expect(plan[key].prompt).toContain(signature);
        expect(plan[key].prompt).toContain('keep physical and worn details; carried objects belong on the prop sheet');
      }
      expect(plan.character.prompt).toContain('lavender tee and cutoffs');
      expect(plan['form:age-7'].prompt).toContain('a plaid dress and a silver watch');
      expect(plan['cast:ben'].prompt).toContain('a denim jacket and a gold ring');
      if (props.length) expect(plan.props.prompt).toContain(signature);
    }
    // The plan chooses fields for each sheet; it never edits the director's source text.
    expect(direction.protagonist.signature).toBe(signature);
  });

  it('keeps a physical signature in the character and wardrobe prompts without a prop sheet', () => {
    const signature = 'a silver eyebrow scar and a red scarf';
    const direction = { ...DIRECTION, protagonist: { ...DIRECTION.protagonist, signature }, props: [] };
    const plan = buildCastAndSetsImagePlan({ scenes: [] }, direction);
    expect(plan.character.prompt).toContain(signature);
    expect(plan.looks.prompt).toContain(signature);
  });

  it('plans one prop sheet naming every prop exactly, and none without props', () => {
    const plan = buildCastAndSetsImagePlan({ scenes: [] }, DIRECTION);
    expect(plan.props).toMatchObject({ kind: 'props', deps: [], refKeys: [] });
    expect(plan.props.prompt).toContain("ADA'S CAMERA (Ada): matte black plastic 35mm snapshot camera on a wrist strap");
    expect(plan.props.prompt).toContain('BMX (Ada): chrome BMX with blue mag wheels');
    expect(plan.props.prompt).toMatch(/no brand names, logos or text/);
    expect(noteImageKeys('prop', plan)).toEqual(['props']);
    expect(buildCastAndSetsImagePlan({ scenes: [] }, { ...DIRECTION, props: [] }).props).toBeUndefined();
  });

  it('publishes the sheet as an unconditioned prop reference and each prop as an object subject', () => {
    const stage = { direction: DIRECTION, images: { character: { imageId: 'lead.png' }, props: { imageId: 'props.png' } } };
    const props = castAndSetsReferences({ visualSpec: { references: [] } }, stage).find((ref) => ref.id === 'mvr-cs-props');
    expect(props).toMatchObject({ imageId: 'props.png', role: 'prop', label: 'Props', condition: false });
    expect(props.note).toContain("Ada's camera: matte black plastic 35mm snapshot camera");
    const objects = castAndSetsSubjects({ concept: { subjects: [] } }, stage).filter((s) => s.kind === 'object');
    expect(objects.map((s) => s.name)).toEqual(["Ada's camera", 'BMX']);
  });
});

describe('Cast & Sets face sheets', () => {
  const WITH_CAST = { ...DIRECTION, cast: [{ id: 'ben', name: 'Ben', role: 'boyfriend', face: 'long narrow face, ears that stick out', hair: 'shaggy middle part' }] };

  it('opens every face sheet with the head angles and gives each cast member one built on their cast sheet', () => {
    const plan = buildCastAndSetsImagePlan({ scenes: [] }, WITH_CAST);
    expect(plan.expressions.label).toBe('Face sheet');
    for (const key of ['expressions', 'face:ben']) {
      expect(plan[key].refTemplates).toEqual(['music-video-face-angles.png']);
      expect(plan[key].prompt).toContain('Reference image 1 is ONLY an angle/layout guide');
      expect(plan[key].prompt).toContain('LEFT faces image-left; RIGHT faces image-right');
      expect(plan[key].prompt).toContain('Never copy the template');
    }
    expect(plan.expressions.prompt).toContain('FRONT, 3/4 LEFT, PROFILE LEFT, 3/4 RIGHT, PROFILE RIGHT');
    expect(plan['face:ben']).toMatchObject({ kind: 'face', deps: ['cast:ben'], refKeys: ['cast:ben'], label: 'Ben face sheet' });
    expect(plan['face:ben'].prompt).toContain('FRONT, 3/4 LEFT, PROFILE LEFT');
    expect(plan['face:ben'].prompt).toContain('nothing held in the hands');
    // The labeled angle guide must not contradict the sheet's "no text" (#14795).
    for (const key of ['expressions', 'face:ben']) {
      expect(plan[key].prompt).toContain('no text');
      expect(plan[key].prompt).toContain('Never copy the template\'s drawing style, grey skin, arrows or text labels');
    }
    expect(noteImageKeys('ben face sheet', plan)).toEqual(['face:ben']);
  });

  it('publishes each face sheet as an unconditioned reference with the face and hair note', () => {
    const stage = { direction: { ...WITH_CAST, protagonist: { ...DIRECTION.protagonist, face: 'sunburned' } }, images: { character: { imageId: 'lead.png' }, expressions: { imageId: 'lead-face.png' }, 'cast:ben': { imageId: 'ben.png' }, 'face:ben': { imageId: 'ben-face.png' } } };
    const refs = castAndSetsReferences({ visualSpec: { references: [] } }, stage);
    expect(refs.find((ref) => ref.id === 'mvr-cs-face-ben')).toMatchObject({ imageId: 'ben-face.png', role: 'character', label: 'Ben — face sheet', condition: false, note: 'long narrow face, ears that stick out; shaggy middle part' });
    expect(refs.find((ref) => ref.id === 'mvr-cs-expressions')).toMatchObject({ label: 'Ada — face sheet', note: 'sunburned; frizzy perm' });
  });

  // A full reference list must not lose existing prop, wardrobe or protagonist sheets to the new cast faces.
  it('preserves existing reference types when cast face sheets exceed the list capacity', () => {
    const authored = Array.from({ length: 19 }, (_, i) => ({ id: `authored-${i}`, imageId: `authored-${i}.png`, condition: false }));
    const stage = { direction: WITH_CAST, images: {
      character: { imageId: 'lead.png' }, 'cast:ben': { imageId: 'ben.png' }, 'face:ben': { imageId: 'ben-face.png' },
      props: { imageId: 'props.png' }, looks: { imageId: 'looks.png' }, expressions: { imageId: 'lead-face.png' },
    } };
    const refs = castAndSetsReferences({ visualSpec: { references: authored } }, stage);
    expect(refs).toHaveLength(24);
    expect(refs.map((ref) => ref.id)).toEqual(expect.arrayContaining(['mvr-cs-props', 'mvr-cs-looks', 'mvr-cs-expressions']));
    expect(refs.map((ref) => ref.id)).not.toContain('mvr-cs-face-ben');
  });
});

describe('Cast & Sets set plates', () => {
  it('keeps a set description that uses "their" for objects, and asks for separate, upright furniture', () => {
    const sets = [{ id: 'food-court', name: 'Food court', lighting: 'hard flash',
      description: 'The dead mall food court: molded chairs around round tables, shuttered counters with their menu boards blank; a photo booth against a pillar' }];
    const prompt = buildCastAndSetsImagePlan({ scenes: [] }, { ...DIRECTION, sets })['set:food-court'].prompt;
    expect(prompt).toContain('shuttered counters with their menu boards blank');
    expect(prompt).toMatch(/furniture stands upright on its own legs, nothing stacked, interlocked or piled/);
    expect(prompt).toContain('Keep new details consistent with the described place and its era');
  });

  it('preserves an intentionally unusual set while asking for coherent additions', () => {
    const description = 'A car is parked at a boarded-up abandoned house.';
    const sets = [{ id: 'house', name: 'House', description }];
    const prompt = buildCastAndSetsImagePlan({ scenes: [] }, { ...DIRECTION, sets })['set:house'].prompt;
    expect(prompt).toContain(description);
    expect(prompt).toContain('preserve explicitly requested or intentionally unusual details');
  });

  it('still drops a sentence that pictures people in an empty plate', () => {
    const sets = [{ id: 'lot', name: 'Lot', lighting: 'dusk', description: 'An empty dirt lot. The couple ride across it.' }];
    const prompt = buildCastAndSetsImagePlan({ scenes: [] }, { ...DIRECTION, sets })['set:lot'].prompt;
    expect(prompt).toContain('An empty dirt lot.');
    expect(prompt).not.toContain('couple');
  });
});

describe('Cast & Sets test frames', () => {
  const tests = [{ setId: 'street', look: 'TEE', action: 'Ada coasts past on her bike', caption: 'hands off' }];

  it('lets an in-set action use a signature prop without a sheet-only instruction', () => {
    const direction = { ...DIRECTION,
      protagonist: { ...DIRECTION.protagonist, signature: 'a black snapshot camera' },
      tests: [{ setId: 'street', look: 'TEE', action: 'Ada holds the camera up to her eye', caption: 'the shutter clicks' }],
    };
    const plan = buildCastAndSetsImagePlan({ scenes: [] }, direction);
    expect(plan['test:1'].prompt).toContain('Ada holds the camera up to her eye');
    expect(plan['test:1'].prompt).not.toContain('carried objects belong on the prop sheet');
    const prior = buildCastAndSetsImagePlan({ scenes: [] }, { ...direction, protagonist: { ...direction.protagonist, signature: '' } });
    expect(plan['test:1'].prompt).toBe(prior['test:1'].prompt);
    expect(plan.character.prompt).toContain('signature: a black snapshot camera');
    expect(plan.character.prompt).toContain('carried objects belong on the prop sheet');
  });

  it('lights the person by the plate so they never read as pasted in', () => {
    const plan = buildCastAndSetsImagePlan({ scenes: [] }, { ...DIRECTION, look: 'Glossy anamorphic cinema', tests });
    expect(plan['test:1'].prompt).toContain('People are lit only by the light already in the place');
  });

  it('allows badly lit people when the look is amateur snapshots or home video', () => {
    const plan = buildCastAndSetsImagePlan({ scenes: [] }, { ...DIRECTION, look: 'Faded consumer snapshots, harsh pop-up flash, VHS-C chroma bleed', tests });
    expect(plan['test:1'].prompt).toContain('Authentic amateur snapshot lighting');
    expect(plan['test:1'].prompt).toContain('often underexposed, unevenly lit or half in shadow');
  });

  it('judges the light on the look the frame uses, so an era set with a polished look overrides an amateur project look', () => {
    const sets = [{ ...DIRECTION.sets[0], era: '2026', look: 'Polished digital cinema, crisp and clean' }];
    const plan = buildCastAndSetsImagePlan({ scenes: [] }, { ...DIRECTION, sets, look: 'Faded VHS home video', tests });
    expect(plan['test:1'].prompt).toContain('People are lit only by the light already in the place');
    expect(plan['test:1'].prompt).not.toContain('Authentic amateur snapshot lighting');
  });
});
