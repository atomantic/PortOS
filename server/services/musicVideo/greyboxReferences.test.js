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

  // Uniquely catches a street plate prompt that leaves the painter to guess the pole side, drops, sidewalks or which houses are derelict (#15327, #15328).
  it('states the street layout the greybox models, with the pole line side for the camera', async () => {
    const d = deps();
    const street = { zones: [{ id: 'pole', label: 'Poles', color: '#5a4a3a' }, { id: 'drop', label: 'Drops', color: '#222222' }, { id: 'lamp', label: 'Lamps', color: '#dddd88' }, { id: 'road', label: 'Road', color: '#333333' }, { id: 'derelict', label: 'Derelict', color: '#664444' }],
      parts: [{ id: 'p1', zone: 'pole', position: [6, 5, 0] }, { id: 'p2', zone: 'pole', position: [6, 5, -40] }, { id: 'd1', zone: 'drop', position: [12, 6, 0] },
        { id: 'l1', zone: 'lamp', position: [4, 8, 0] }, { id: 'r', zone: 'road', position: [0, 0, 0] },
        { id: 'h4a', label: 'Derelict house 4', zone: 'derelict', position: [-14, 3, -20] }, { id: 'h4b', label: 'Derelict house 4', zone: 'derelict', position: [-14, 6, -20] }],
      anchors: [], shots: [{ id: 'wide', label: 'Wide camera', position: [0, 1.6, 10], target: [0, 1, 0], figures: [] }] };
    d.catalog.getIngredient.mockResolvedValue({ ...ingredient, payload: { greybox: street } });
    const greybox = await loadMusicVideoGreybox(project, scene, d);
    const lines = greybox.promptAdditions.filter((item) => item.id.startsWith('greybox-street-')).map((item) => item.text);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^Street power: 2 wooden utility poles in one line on the right of the frame, .*service drop .*hang from those poles/);
    expect(lines[1]).toMatch(/no sidewalks/);
    expect(lines[2]).toBe('Derelict: Derelict house 4. Only this looks abandoned (boarded or broken windows, overgrown yard); every other building is lived-in and kept up.');
    expect(musicVideoFrameModelInput(project, scene, { greybox }).prompt).toContain(lines[0]);
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
