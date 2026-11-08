import { describe, it, expect, vi } from 'vitest';
import { loadMusicVideoGreybox, withMusicVideoGreyboxInput } from './greyboxReferences.js';
import { musicVideoFrameModelInput, musicVideoShotModelInput } from '../../lib/musicVideoShotPrompt.js';
import { musicVideoSceneCreateSchema } from '../../lib/musicVideoValidation.js';
import { buildProjectRecord, addScene, replaceScenes, splitScene } from './projectsLogic.js';
import { buildCastAndSetsImagePlan } from './castAndSetsPlan.js';
import { musicVideoConditioningReferences } from '../../lib/musicVideoConditioning.js';

const setReference = { subjectId: 'set-rink', greyboxShotId: 'wide' };
const scene = { sceneId: 's1', prompt: 'The singer waves', framePrompt: 'A wide shot', startSec: 0, endSec: 8, setReference };
const subject = { id: 'set-rink', kind: 'place', name: 'Example Rink', ingredientId: 'cat-rink' };
const project = { concept: { subjects: [subject] }, scenes: [scene] };
const ingredient = { id: 'cat-rink', type: 'place', payload: { greybox: {
  anchors: [{ id: 'rail', label: 'Singer' }],
  shots: [{ id: 'wide', label: 'Wide camera', figures: [{ anchorId: 'rail', pose: 'waving' }] }],
} } };
const media = [{ mediaKey: 'layout.png', kind: 'reference', role: 'greybox-shot:wide' }];
const deps = () => ({ catalog: { getIngredient: vi.fn(async () => structuredClone(ingredient)), listMediaForIngredient: vi.fn(async () => structuredClone(media)) }, resolveImage: vi.fn(() => '/example/layout.png') });

describe('music video greybox selection', () => {
  // Uniquely catches a clip from a start frame sending the set plate as an extra, unpicked reference.
  it('adds no plate to a clip that animates its start frame', async () => {
    const request = { prompt: 'The singer waves', sourceImageFile: 'start.png', musicVideo: { projectId: 'p', sceneId: 's1' } };
    await expect(withMusicVideoGreyboxInput(request, project)).resolves.toBe(request);
  });

  it('resolves the selected camera and records figure additions in both sent prompts without editing authored fields', async () => {
    const greybox = await loadMusicVideoGreybox(project, scene, deps());
    expect(greybox.reference).toMatchObject({ imageId: 'layout.png', role: 'set' });
    for (const compose of [musicVideoFrameModelInput, musicVideoShotModelInput]) {
      const input = compose(project, scene, { greybox });
      expect(input.prompt).toContain('Singer stands at the "rail" mark, waving');
      expect(input.promptAdditions).toContainEqual({ id: 'greybox-figure-0', label: 'Greybox figure 1', text: 'Singer stands at the "rail" mark, waving' });
    }
    expect(scene.framePrompt).toBe('A wide shot');
    expect(scene.prompt).toBe('The singer waves');
  });

  it('refuses removed cameras, detached captures and missing bytes instead of using a different plate', async () => {
    const d = deps();
    await expect(loadMusicVideoGreybox(project, { ...scene, setReference: { ...setReference, greyboxShotId: 'removed' } }, d)).rejects.toMatchObject({ code: 'MUSIC_VIDEO_GREYBOX_UNAVAILABLE' });
    d.catalog.listMediaForIngredient.mockResolvedValue([{ ...media[0], role: 'reference' }]);
    await expect(loadMusicVideoGreybox(project, scene, d)).rejects.toThrow(/no capture/);
    d.catalog.listMediaForIngredient.mockResolvedValue(media);
    d.resolveImage.mockReturnValue(null);
    await expect(loadMusicVideoGreybox(project, scene, d)).rejects.toThrow(/file is missing/);
    expect(await loadMusicVideoGreybox(project, { ...scene, setReference: null }, d)).toBeNull();
  });

  it('sends the camera photo plate in place of the flat capture and the generic section set plate', async () => {
    const d = deps();
    d.catalog.getIngredient.mockResolvedValue({ ...ingredient, payload: { greybox: { ...ingredient.payload.greybox, shots: [{ ...ingredient.payload.greybox.shots[0], plate: 'wall-photo.png' }] } } });
    d.catalog.listMediaForIngredient.mockResolvedValue([...media, { mediaKey: 'wall-photo.png', kind: 'reference', role: null }]);
    const greybox = await loadMusicVideoGreybox(project, scene, d);
    expect(greybox.reference).toMatchObject({ imageId: 'wall-photo.png', role: 'set', plate: true });
    const withPlate = { ...project, scenes: [{ ...scene, frameReferenceIds: ['mvr-cs-set-rink', 'mvr-cast'] }],
      visualSpec: { references: [{ id: 'mvr-cs-set-rink', imageId: 'generic.png', role: 'set' }, { id: 'mvr-cast', imageId: 'cast.png', role: 'character' }] } };
    expect(musicVideoConditioningReferences(withPlate, withPlate.scenes[0], null, greybox).map((r) => r.imageId)).toEqual(['wall-photo.png', 'layout.png', 'cast.png']);
    // A plate no longer attached to the place falls back to the capture.
    d.catalog.listMediaForIngredient.mockResolvedValue(media);
    expect((await loadMusicVideoGreybox(project, scene, d)).reference).toMatchObject({ imageId: 'layout.png' });
  });

  // Uniquely catches a plate hiding where the camera's figures stand, or a shot unable to turn the layout off.
  it('sends the flat figure capture after the photo plate as a layout-only reference unless the shot turns it off', async () => {
    const d = deps();
    d.catalog.getIngredient.mockResolvedValue({ ...ingredient, payload: { greybox: { ...ingredient.payload.greybox, shots: [{ ...ingredient.payload.greybox.shots[0], plate: 'wall-photo.png' }] } } });
    d.catalog.listMediaForIngredient.mockResolvedValue([...media, { mediaKey: 'wall-photo.png', kind: 'reference', role: null }]);
    d.resolveImage.mockImplementation((file) => `/example/${file}`);
    const greybox = await loadMusicVideoGreybox(project, scene, d);
    expect(greybox).toMatchObject({ blockingAvailable: true, blockingPath: '/example/layout.png', blocking: { imageId: 'layout.png', role: 'blocking', blocking: true } });
    const refs = musicVideoConditioningReferences({ ...project, visualSpec: { references: [{ id: 'mvr-cast', imageId: 'cast.png', role: 'character' }] }, scenes: [{ ...scene, frameReferenceIds: ['mvr-cast'] }] },
      { ...scene, frameReferenceIds: ['mvr-cast'] }, null, greybox);
    expect(refs.map((r) => r.imageId)).toEqual(['wall-photo.png', 'layout.png', 'cast.png']);
    const input = musicVideoFrameModelInput(project, scene, { greybox, references: refs });
    expect(input.prompt).toContain('Reference image 2 is the layout only');
    expect(input.promptAdditions.find((a) => a.id === 'reference-map').text).toContain('which way they face');
    // A two-slot renderer keeps both greybox images ahead of the cast.
    expect(musicVideoConditioningReferences(project, scene, null, greybox, { limit: 2 }).map((r) => r.imageId)).toEqual(['wall-photo.png', 'layout.png']);
    const off = await loadMusicVideoGreybox(project, { ...scene, setReference: { ...setReference, blocking: false } }, d);
    expect(off).toMatchObject({ blockingAvailable: true });
    expect(off.blocking).toBeUndefined();
    expect(musicVideoSceneCreateSchema.safeParse({ setReference: { ...setReference, blocking: false } }).success).toBe(true);
    d.resolveImage.mockImplementation((file) => (file === 'layout.png' ? null : `/example/${file}`));
    await expect(loadMusicVideoGreybox(project, scene, d)).rejects.toThrow(/figure blocking capture is missing/);
  });

  describe('street furniture facts', () => {
    // Camera at +Z looking toward -Z: the viewer's right is +X, so poles at +X are on the right and their lamp arms reach left over the road.
    const street = (extra = {}) => ({ ...ingredient, payload: { greybox: { ...ingredient.payload.greybox,
      shots: [{ ...ingredient.payload.greybox.shots[0], position: [0, 2, 20], target: [0, 2, 0] }],
      parts: [
        { id: 'pole-b', label: 'Pole B', position: [8, 4, -20], street: { kind: 'pole' } },
        { id: 'pole-a', label: 'Pole A', position: [8, 4, -5], street: { kind: 'pole' } },
        { id: 'pole-behind', label: 'Pole Behind', position: [8, 4, 40], street: { kind: 'pole' } },
        { id: 'lamp-a', label: 'Lamp A', position: [8, 4, -10], street: { kind: 'lamp', armDegrees: -90, mount: 'pole' } },
        { id: 'curb', label: 'Curb', position: [0, 0, 0] },
      ], ...extra } } });

    // Uniquely catches a painter being left to guess wires and lamp-arm direction from a grey cylinder.
    it('states the pole line, wires and camera-relative lamp arm in the shot prompt as visible chips', async () => {
      const d = deps();
      d.catalog.getIngredient.mockResolvedValue(street());
      const greybox = await loadMusicVideoGreybox(project, scene, d);
      const input = musicVideoFrameModelInput(project, scene, { greybox });
      const chips = input.promptAdditions.filter((a) => a.id.startsWith('greybox-street-'));
      expect(chips.map((c) => c.label)).toEqual(['Greybox street 1', 'Greybox street 2']);
      expect(chips[0].text).toBe('Utility poles "Pole B", "Pole A" stand in one line along the road, all on the viewer\'s right side of the street, joined pole to pole by continuous overhead wires that also run on past the end poles; a pole never stands without wires and no wire crosses the road.');
      expect(chips[1].text).toBe('Streetlight "Lamp A" is bracketed on a utility pole: its arm reaches toward the viewer\'s left, out over the road with the lamp head above the pavement, never aimed at a house or yard.');
    });

    it('reads the lamp arm from the camera and lists poles the same way whatever the part order', async () => {
      const d = deps();
      const base = street();
      const parts = base.payload.greybox.parts;
      const lamp = (armDegrees) => ({ ...parts[3], street: { kind: 'lamp', armDegrees } });
      const texts = async (list) => {
        d.catalog.getIngredient.mockResolvedValue({ ...base, payload: { greybox: { ...base.payload.greybox, parts: list } } });
        return (await loadMusicVideoGreybox(project, scene, d)).streetAdditions.map((a) => a.text);
      };
      expect((await texts([lamp(90)]))[0]).toContain('reaches toward the viewer\'s right, out over the road');
      expect((await texts([lamp(-90)]))[0]).toContain('reaches toward the viewer\'s left, out over the road');
      expect((await texts([lamp(180)]))[0]).toContain('reaches away from the camera, out over the road');
      expect(await texts([...parts].reverse())).toEqual(await texts(parts));
      // Poles on both sides of a street running away from the camera say so rather than claiming one side.
      const moved = (id, position) => (part) => (part.id === id ? { ...part, position } : part);
      const both = await texts(parts.map(moved('pole-a', [-8, 4, -5])).map(moved('pole-b', [8, 4, -60])));
      expect(both[0]).toBe('Utility poles stand on both sides of the street: "Pole A" on the viewer\'s left and "Pole B" on the right. Each side is its own line, its poles joined pole to pole by continuous overhead wires that run on past the end poles along that side; a pole never stands without wires and no wire crosses the road.');
      // A line running across the frame has no single side, and a pole on the aim axis is on neither.
      expect((await texts(parts.map(moved('pole-a', [-8, 4, -20]))))[0]).not.toMatch(/viewer's (left|right) side|both sides/);
      expect((await texts(parts.map(moved('pole-a', [0, 4, -5])).map(moved('pole-b', [0, 4, -20]))))[0]).not.toMatch(/viewer's (left|right) side|both sides/);
      // A pole between the two clusters keeps the street one line, and every pole is still named.
      const middle = (await texts([...parts.map(moved('pole-a', [-8, 4, -5])).map(moved('pole-b', [8, 4, -60])), { id: 'pole-mid', label: 'Pole Mid', position: [0, 4, -30], street: { kind: 'pole' } }]))[0];
      expect(middle).toContain('"Pole Mid"');
      expect(middle).not.toMatch(/both sides|viewer's (left|right) side/);
    });

    it('states the absolute lamp bearing when the camera looks straight down and has no view direction', async () => {
      const d = deps();
      d.catalog.getIngredient.mockResolvedValue(street({ shots: [{ ...ingredient.payload.greybox.shots[0], position: [0, 50, 0], target: [0, 0, 0] }] }));
      const texts = (await loadMusicVideoGreybox(project, scene, d)).streetAdditions.map((a) => a.text);
      expect(texts.at(-1)).toContain('its arm reaches on bearing -90 degrees (0 toward +Z, 90 toward +X), out over the road');
      expect(texts[0]).toContain('"Pole Behind"');
    });

    it('requires wires for pole-mounted lamps with no pole in frame and keeps every lamp bearing past eight lamps', async () => {
      const d = deps();
      const base = street();
      const lamps = Array.from({ length: 10 }, (_, i) => ({ id: `lamp-${i}`, label: `Lamp ${i}`, position: [8, 4, -5 - i], street: { kind: 'lamp', armDegrees: i < 9 ? -90 : 90, mount: 'pole' } }));
      d.catalog.getIngredient.mockResolvedValue({ ...base, payload: { greybox: { ...base.payload.greybox, parts: lamps } } });
      const texts = (await loadMusicVideoGreybox(project, scene, d)).streetAdditions.map((a) => a.text);
      expect(texts[0]).toContain('continuous overhead wires that run past both ends');
      expect(texts.find((t) => t.includes('Lamp 9'))).toContain('toward the viewer\'s right');
      expect(texts.find((t) => t.includes('"Lamp 0"'))).toContain('and 1 more');
      expect(texts.at(-1)).toBe('Every streetlight here is arm-mounted on a utility pole; draw no separate lamp posts.');
    });

    it('omits street facts for a greybox without street furniture and for furniture behind the camera', async () => {
      const d = deps();
      const plain = await loadMusicVideoGreybox(project, scene, d);
      expect(plain.promptAdditions.some((a) => a.id.startsWith('greybox-street-'))).toBe(false);
      d.catalog.getIngredient.mockResolvedValue(street({ parts: [{ id: 'pole-behind', position: [8, 4, 40], street: { kind: 'pole' } }] }));
      expect((await loadMusicVideoGreybox(project, scene, d)).streetAdditions).toEqual([]);
    });

    it('puts the street facts, never the figure lines, into a people-free set plate prompt', async () => {
      const d = deps();
      d.catalog.getIngredient.mockResolvedValue(street());
      const greybox = await loadMusicVideoGreybox(project, scene, d);
      const direction = { protagonist: {}, looks: [], sets: [{ id: 'rink', name: 'Example Rink', description: 'An empty rink', setReference }], tests: [] };
      const prompt = buildCastAndSetsImagePlan(project, direction, { greyboxes: { rink: greybox } })['set:rink'].prompt;
      expect(prompt).toContain('a pole never stands without wires');
      expect(prompt).toContain('arm reaches toward the viewer\'s left');
      expect(prompt).toContain('all on the viewer\'s right side of the street');
      expect(prompt).toContain('no wire crosses the road');
      expect(prompt).not.toContain('stands at the "rail" mark');
    });
  });

  it('persists the optional selection through create, replan and split and rejects invalid camera ids', () => {
    const base = buildProjectRecord({ name: 'Example Video' }, { id: 'mv-example', now: '2026-01-01' });
    const added = addScene(base, { prompt: scene.prompt, startSec: 0, endSec: 8, setReference });
    expect(added.scene.setReference).toEqual(setReference);
    const replanned = replaceScenes(added.project, [{ startSec: 0, endSec: 8, prompt: 'A new direction' }]);
    expect(replanned.scenes[0].setReference).toEqual(setReference);
    expect(splitScene(replanned.project, replanned.scenes[0].sceneId, { atSec: 4 }).project.scenes.every((s) => s.setReference?.greyboxShotId === 'wide')).toBe(true);
    for (const greyboxShotId of ['../wide', '2wide', 'x'.repeat(52)]) {
      expect(musicVideoSceneCreateSchema.safeParse({ setReference: { ...setReference, greyboxShotId } }).success).toBe(false);
    }
  });

  it('conditions a Cast & Sets plate on a greybox only after an explicit choice', async () => {
    const greybox = await loadMusicVideoGreybox(project, scene, deps());
    const direction = { protagonist: {}, looks: [], sets: [{ id: 'rink', name: 'Example Rink', description: 'An empty rink', setReference }], tests: [] };
    const plan = buildCastAndSetsImagePlan(project, direction, { greyboxes: { rink: greybox } });
    expect(plan['set:rink'].refImages).toEqual(['layout.png']);
    const unselected = buildCastAndSetsImagePlan(project, { ...direction, sets: [{ ...direction.sets[0], setReference: undefined }] });
    expect(unselected['set:rink'].refImages).toBeUndefined();
  });
});
