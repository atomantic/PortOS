import { describe, it, expect, vi } from 'vitest';
import { loadMusicVideoGreybox } from './greyboxReferences.js';
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
    expect(musicVideoConditioningReferences(withPlate, withPlate.scenes[0], null, greybox).map((r) => r.imageId)).toEqual(['wall-photo.png', 'cast.png']);
    // A plate no longer attached to the place falls back to the capture.
    d.catalog.listMediaForIngredient.mockResolvedValue(media);
    expect((await loadMusicVideoGreybox(project, scene, d)).reference).toMatchObject({ imageId: 'layout.png' });
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
