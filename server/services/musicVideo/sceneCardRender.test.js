/**
 * Shot-card frame references resolved on the server (#15583).
 * A request that names only the project, shot and slot must send the same
 * files and composed prompt as the body the card builder produces, and a
 * picked reference that cannot be loaded must be refused.
 */

import { describe, it, expect, vi, afterAll } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';

vi.mock('../../lib/paths.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-scene-card-') }));
afterAll(cleanupTempDataRoots);

const catalog = vi.hoisted(() => ({ getIngredient: vi.fn(), listMediaForIngredient: vi.fn() }));
vi.mock('../catalogDB.js', () => catalog);

const getProject = vi.fn(async () => null);
const clipQueue = vi.hoisted(() => ({ submit: vi.fn(async () => ({ jobId: 'synthetic-clip-job' })) }));
vi.mock('../videoGen/submitJob.js', () => ({ submitVideoGenJob: clipQueue.submit }));
vi.mock('./projects.js', () => ({ getProject: (...args) => getProject(...args) }));
vi.mock('../settings.js', () => ({ getSettings: vi.fn(async () => ({ imageGen: { mode: 'codex', codex: { enabled: true, codexPath: '/bin/codex' } } })) }));
vi.mock('../universeBuilder/crud.js', () => ({ getUniverseRenderPin: vi.fn(async () => null), getUniverseVisualProfile: vi.fn(async () => null) }));
vi.mock('../storyboards/index.js', () => ({ getStoryboard: vi.fn(async () => null) }));

const { prepareGenerateParams } = await import('../imageGen/prepareParams.js');
const { buildSceneFrameGenerateBody } = await import('./sceneFrameReferences.js');
const { musicVideoLinkedReferenceId } = await import('../../lib/musicVideoConditioning.js');
const { validateRequest } = await import('../../lib/validation.js');
const { musicVideoSceneClipRenderSchema, musicVideoSceneClipsRenderSchema } = await import('../../lib/musicVideoValidation.js');
const { renderSceneClips } = await import('./sceneCardRender.js');

const names = (result) => result.data.referenceImagePaths.map((file) => file.split(/[\\/]/).at(-1));

async function prepared(project, data) {
  getProject.mockResolvedValue(project);
  return prepareGenerateParams({ data, files: undefined, referenceImageFields: [] });
}

const linkedPortrait = musicVideoLinkedReferenceId('portrait.png');

function cardProject(scenePatch = {}) {
  return {
    id: 'mv-card',
    concept: { subjects: [
      { id: 'lead', name: 'Lead', kind: 'character', ingredientId: 'cat-lead' },
      { id: 'pier', name: 'Pier', kind: 'place', ingredientId: 'cat-pier' },
    ] },
    visualSpec: { references: [{ id: 'plate', imageId: 'plate.png', role: 'set', label: 'Pier', condition: true }] },
    scenes: [{
      sceneId: 's1', prompt: 'harbor at dawn', framePrompt: 'harbor at dawn',
      frameReferenceIds: [linkedPortrait, 'plate'],
      setReference: { subjectId: 'pier', greyboxShotId: 'wide' },
      ...scenePatch,
    }],
  };
}

function installCardCatalog({ portrait = true } = {}) {
  catalog.getIngredient.mockResolvedValue({ type: 'place', payload: { greybox: { shots: [{ id: 'wide' }] } } });
  catalog.listMediaForIngredient.mockImplementation(async (id) => {
    if (id === 'cat-lead') return portrait ? [{ kind: 'portrait', mediaKey: 'portrait.png' }] : [];
    if (id === 'cat-pier') return [{ kind: 'reference', role: 'greybox-shot:wide', mediaKey: 'layout.png' }];
    return [];
  });
}

describe('shot-card clip body validation', () => {
  it('covers shared source windows in an LTX reference clip and refuses an explicitly shorter or oversized window', async () => {
    const mediaModels = await import('../../lib/mediaModels.js');
    const models = vi.spyOn(mediaModels, 'getVideoModels').mockReturnValue([{ id: 'example-ltx', runtime: 'ltx25' }]);
    try {
      clipQueue.submit.mockClear();
      const project = { id: 'mv-card', videoSettings: { backend: 'local', modelId: 'example-ltx' }, scenes: [
        { sceneId: 'source', startSec: 0, endSec: 1, referenceImageId: 'start.png', prompt: 'The rider turns' },
        { sceneId: 'return', startSec: 8, endSec: 9, sourceTake: { sceneId: 'source' } },
      ] };
      const input = { sceneId: 'source', card: { ltxReferences: true, expectedClipReferenceFiles: ['sheet.png'] } };
      await renderSceneClips(project, input);
      expect(clipQueue.submit.mock.calls[0][0]).toMatchObject({ mode: 'ic-ingredients-25', numFrames: 217 });
      clipQueue.submit.mockClear();
      await expect(renderSceneClips(project, { ...input, target: { numFrames: 121 } })).rejects.toMatchObject({ code: 'MUSIC_VIDEO_CLIP_TOO_LONG' });
      project.scenes[1].endSec = 100;
      await expect(renderSceneClips(project, input)).rejects.toMatchObject({ code: 'MUSIC_VIDEO_CLIP_TOO_LONG' });
      expect(clipQueue.submit).not.toHaveBeenCalled();
    } finally {
      models.mockRestore();
    }
  });
  it('requests enough hosted footage for every return to a shared source', async () => {
    for (const [backend, field, seconds] of [['fal', 'falDuration', 10], ['runway', 'runwayDuration', 9], ['grok', 'grokDuration', 10]]) {
      clipQueue.submit.mockClear();
      const project = { id: 'mv-card', videoSettings: { backend, falDuration: 6, runwayDuration: 5 }, scenes: [
        { sceneId: 'source', startSec: 0, endSec: 1, referenceImageId: 'start.png', prompt: 'The rider turns' },
        { sceneId: 'return', startSec: 8, endSec: 9, sourceTake: { sceneId: 'source' } },
      ] };
      const result = await renderSceneClips(project, { sceneId: 'source' });
      expect(result.jobId).toBe('synthetic-clip-job');
      expect(clipQueue.submit.mock.calls[0][0][field]).toBe(seconds);
    }
  });
  const videoBody = {
    mode: 'image', sourceImageFile: 'start.png', prompt: 'a rider turns', backend: 'grok',
    musicVideo: JSON.stringify({ projectId: 'mv-card', sceneId: 's1', compose: true }),
  };

  it('keeps a prepared video body, including on the bulk form', () => {
    const one = validateRequest(musicVideoSceneClipRenderSchema, videoBody);
    expect(one).toMatchObject(videoBody);
    const bulk = validateRequest(musicVideoSceneClipsRenderSchema, { ...videoBody, sceneIds: ['s1', 's2'] });
    expect(bulk.sceneIds).toEqual(['s1', 's2']);
    expect(bulk.mode).toBe('image');
    expect(bulk.sourceImageFile).toBe('start.png');
    expect(bulk.musicVideo).toBe(videoBody.musicVideo);
  });
});

describe('shot-card frame references (#15583)', () => {
  it('uses an explicitly supplied start-frame source as the leading conditioning reference without requiring fromFrame', async () => {
    const project = { id: 'mv-card', scenes: [{ sceneId: 's1', framePrompt: 'A rider at dawn', referenceImageId: 'selected.png' }] };
    const body = await buildSceneFrameGenerateBody(project, project.scenes[0], { referenceImageId: 'source-take.png' });
    expect(body.referenceImageFiles[0]).toBe('source-take.png');
    expect(body.musicVideo).toMatchObject({ leadImageId: 'source-take.png', fromFrame: true });
  });
  it('sends the same files and prompt for a linked portrait, a set plate and a greybox plate', async () => {
    const { PATHS } = await import('../../lib/paths.js');
    mkdirSync(PATHS.images, { recursive: true });
    for (const file of ['layout.png', 'portrait.png', 'plate.png']) writeFileSync(join(PATHS.images, file), 'fixture');
    installCardCatalog();
    const project = cardProject();
    const body = await buildSceneFrameGenerateBody(project, project.scenes[0], { slot: 'start' });
    expect(body.referenceImageFiles).toEqual(['layout.png', 'portrait.png', 'plate.png']);
    expect(body.musicVideo.castInputs).toEqual({ ingredientId: null, guides: ['portrait.png'], sheets: [] });
    const { referenceImageFiles, castInputs, ...withoutFiles } = body;
    const viaCard = await prepared(project, body);
    const viaSlot = await prepared(project, withoutFiles);
    expect(names(viaSlot)).toEqual(names(viaCard));
    expect(names(viaSlot)).toEqual(['layout.png', 'portrait.png', 'plate.png']);
    expect(viaSlot.data.prompt).toBe(viaCard.data.prompt);
    expect(referenceImageFiles).toEqual(['layout.png', 'portrait.png', 'plate.png']);
    expect(castInputs.guides).toEqual(['portrait.png']);
  });

  it('refuses a picked linked asset that is not in the catalog, and a sent list that drops it', async () => {
    const { PATHS } = await import('../../lib/paths.js');
    mkdirSync(PATHS.images, { recursive: true });
    for (const file of ['layout.png', 'portrait.png', 'plate.png']) writeFileSync(join(PATHS.images, file), 'fixture');
    installCardCatalog({ portrait: false });
    const project = cardProject();
    await expect(buildSceneFrameGenerateBody(project, project.scenes[0], { slot: 'start' })).rejects.toMatchObject({
      code: 'MUSIC_VIDEO_FRAME_REFERENCE_MISSING',
    });
    await expect(buildSceneFrameGenerateBody(project, project.scenes[0], { slot: 'start' })).rejects.toThrow(/unavailable/);
    await expect(prepared(project, {
      prompt: 'harbor at dawn',
      musicVideo: { projectId: project.id, sceneId: 's1', compose: true },
    })).rejects.toMatchObject({ code: 'MUSIC_VIDEO_FRAME_REFERENCE_MISSING' });

    installCardCatalog();
    await expect(prepared(project, {
      prompt: 'harbor at dawn',
      referenceImageFiles: ['plate.png'],
      musicVideo: { projectId: project.id, sceneId: 's1', compose: true },
    })).rejects.toMatchObject({ code: 'MUSIC_VIDEO_FRAME_REFERENCE_MISSING' });
    const complete = await prepared(project, {
      prompt: 'harbor at dawn',
      referenceImageFiles: ['layout.png', 'portrait.png', 'plate.png'],
      musicVideo: { projectId: project.id, sceneId: 's1', compose: true },
    });
    expect(names(complete)).toEqual(['layout.png', 'portrait.png', 'plate.png']);
  });

  it('allows an explicit empty reference row', async () => {
    const { PATHS } = await import('../../lib/paths.js');
    mkdirSync(PATHS.images, { recursive: true });
    writeFileSync(join(PATHS.images, 'layout.png'), 'fixture');
    installCardCatalog();
    const project = cardProject({ frameReferenceIds: [] });
    const result = await prepared(project, {
      prompt: 'harbor at dawn',
      musicVideo: { projectId: project.id, sceneId: 's1', compose: true },
    });
    expect(names(result)).toEqual(['layout.png']);
  });

  it('sends only the flagged mood reference when the set plate is turned off', async () => {
    const { PATHS } = await import('../../lib/paths.js');
    mkdirSync(PATHS.images, { recursive: true });
    for (const file of ['mood.png', 'set.png']) writeFileSync(join(PATHS.images, file), 'fixture');
    catalog.getIngredient.mockResolvedValue(null);
    catalog.listMediaForIngredient.mockResolvedValue([]);
    const project = {
      id: 'mv-spec',
      concept: { style: 'grainy 16mm' },
      visualSpec: { references: [
        { id: 'r1', imageId: 'mood.png', role: 'character', label: 'Lead', condition: true },
        { id: 'r2', imageId: 'set.png', role: 'set', label: 'Pier', condition: false },
      ] },
      scenes: [{ sceneId: 's1', prompt: 'waves', framePrompt: 'harbor at dawn' }],
    };
    const body = await buildSceneFrameGenerateBody(project, project.scenes[0], { slot: 'start' });
    expect(body.referenceImageFiles).toEqual(['mood.png']);
    const { referenceImageFiles, castInputs, ...withoutFiles } = body;
    expect(names(await prepared(project, withoutFiles))).toEqual(names(await prepared(project, body)));
    expect(referenceImageFiles).toEqual(['mood.png']);
    expect(castInputs.guides).toEqual([]);
  });

  it('sends the approved character and the section plate even when that plate is unflagged', async () => {
    const { PATHS } = await import('../../lib/paths.js');
    mkdirSync(PATHS.images, { recursive: true });
    for (const file of ['authored.png', 'character.png', 'harbor.png', 'roof.png']) writeFileSync(join(PATHS.images, file), 'fixture');
    catalog.getIngredient.mockResolvedValue(null);
    catalog.listMediaForIngredient.mockResolvedValue([]);
    const project = {
      id: 'mv-spec',
      concept: { style: 'grainy 16mm' },
      castAndSets: { status: 'approved', direction: { songMap: [{ section: 0, setId: 'harbor' }, { section: 1, setId: 'roof' }] } },
      visualSpec: { references: [
        { id: 'authored', imageId: 'authored.png', condition: true },
        { id: 'mvr-cs-character', imageId: 'character.png', condition: true },
        { id: 'mvr-cs-set-harbor', imageId: 'harbor.png', condition: true },
        { id: 'mvr-cs-set-roof', imageId: 'roof.png', condition: false },
      ] },
      scenes: [{ sceneId: 's1', prompt: 'waves', framePrompt: 'harbor at dawn', sectionIndex: 1 }],
    };
    const body = await buildSceneFrameGenerateBody(project, project.scenes[0], { slot: 'start' });
    expect(body.referenceImageFiles).toEqual(['character.png', 'roof.png']);
    const { referenceImageFiles, ...withoutFiles } = body;
    expect(names(await prepared(project, withoutFiles))).toEqual(['character.png', 'roof.png']);
    expect(referenceImageFiles).toEqual(['character.png', 'roof.png']);
  });

  it('sends only the age-compatible cast guide', async () => {
    const { PATHS } = await import('../../lib/paths.js');
    mkdirSync(PATHS.images, { recursive: true });
    for (const file of ['adult.png', 'child.png']) writeFileSync(join(PATHS.images, file), 'fixture');
    catalog.getIngredient.mockResolvedValue(null);
    catalog.listMediaForIngredient.mockImplementation(async (id) => (id === 'cat-chr-x' ? [
      { mediaKey: 'adult.png', kind: 'reference', library: { variant: { age: 30 }, guide: true } },
      { mediaKey: 'child.png', kind: 'reference', library: { variant: { age: 7 }, guide: true } },
    ] : []));
    const project = {
      id: 'mv-age',
      concept: { subjects: [{ id: 'mvc-1', kind: 'character', name: 'Example Lead', ingredientId: 'cat-chr-x' }] },
      scenes: [{ sceneId: 's1', prompt: 'a lighthouse', framePrompt: 'a lighthouse', characterVariant: { ingredientId: 'cat-chr-x', age: 7 } }],
    };
    const body = await buildSceneFrameGenerateBody(project, project.scenes[0], { slot: 'start' });
    expect(body.referenceImageFiles).toEqual(['child.png']);
    expect(body.musicVideo.castInputs).toEqual({ ingredientId: 'cat-chr-x', guides: ['child.png'], sheets: [] });
    const { referenceImageFiles, ...withoutFiles } = body;
    expect(names(await prepared(project, withoutFiles))).toEqual(['child.png']);
    expect(referenceImageFiles).toEqual(['child.png']);
  });

  it('leads a refine with the start frame and then every picked reference', async () => {
    const { PATHS } = await import('../../lib/paths.js');
    mkdirSync(PATHS.images, { recursive: true });
    for (const file of ['start.png', 'a.png', 'b.png', 'c.png', 'd.png']) writeFileSync(join(PATHS.images, file), 'fixture');
    catalog.getIngredient.mockResolvedValue(null);
    catalog.listMediaForIngredient.mockResolvedValue([]);
    const references = ['a', 'b', 'c', 'd'].map((key) => ({ id: `r-${key}`, imageId: `${key}.png`, role: 'character', label: key, condition: true }));
    const project = {
      id: 'mv-refine',
      visualSpec: { references },
      scenes: [{ sceneId: 's1', prompt: 'harbor at dawn', framePrompt: 'harbor at dawn', referenceImageId: 'start.png', frameReferenceIds: references.map((ref) => ref.id) }],
    };
    const body = await buildSceneFrameGenerateBody(project, project.scenes[0], { slot: 'start', refine: 'remove the hand', referenceImageId: 'start.png' });
    expect(body.prompt).toBe('remove the hand');
    expect(body.referenceImageFiles).toEqual(['start.png', 'a.png', 'b.png', 'c.png', 'd.png']);
    const { referenceImageFiles, ...withoutFiles } = body;
    expect(names(await prepared(project, withoutFiles))).toEqual(['start.png', 'a.png', 'b.png', 'c.png', 'd.png']);
    expect(referenceImageFiles).toEqual(body.referenceImageFiles);
  });
});
