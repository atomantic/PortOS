/**
 * Music Video production run (#9066) — the browserless scene lanes. Pins the
 * contract the orchestration test doubles out: a step renders on EXACTLY its
 * pool route (a disabled backend refuses instead of resolving to another),
 * carries the step's job tag for correlation, and conditions on the visual
 * spec's references like the board does. The real render-target resolver runs;
 * only the queue and the video submit service are doubled.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { basename } from 'node:path';

const enqueueJob = vi.fn(async () => ({ jobId: 'job-image' }));
const submitVideoGenJob = vi.fn(async () => ({ jobId: 'job-video' }));
vi.mock('../mediaJobQueue/index.js', () => ({ enqueueJob: (...a) => enqueueJob(...a) }));
vi.mock('../videoGen/submitJob.js', () => ({ submitVideoGenJob: (...a) => submitVideoGenJob(...a) }));
vi.mock('./productionService.js', () => ({ assertProductionSubmission: vi.fn(async () => {}) }));
const assertRevisionOpen = vi.fn(async () => {});
vi.mock('./revisionService.js', () => ({ assertRevisionOpen: (...a) => assertRevisionOpen(...a) }));
vi.mock('../../lib/imageCleanDefaults.js', () => ({ resolveImageCleaners: () => ({ cleanC2PA: false, denoise: false }) }));

const { dispatchProductionStep } = await import('./productionDispatch.js');
const { assertProductionSubmission } = await import('./productionService.js');

const project = {
  id: 'mv-example',
  concept: { style: 'noir' },
  visualSpec: { references: [{ imageId: 'ref-example.png', condition: true }, { imageId: 'mood.png', condition: false }] },
  scenes: [],
};
const scene = { sceneId: 'mvs-a', framePrompt: 'a lighthouse', prompt: 'waves roll', startSec: 0, endSec: 4, referenceImageId: 'frame-example.png' };
const tag = { projectId: 'mv-example', sceneId: 'mvs-a', productionRunId: 'mvpr-example', productionStepKey: 'frame:mvs-a:base:1' };
const settings = { imageGen: { mode: 'local', local: { pythonPath: '/opt/example/python' }, codex: { enabled: true, model: 'codex-image' }, grok: { enabled: false } } };

beforeEach(() => vi.clearAllMocks());

describe('production scene dispatch (#9066)', () => {
  it('enqueues a frame on the chosen cloud route with the step tag and the conditioning references', async () => {
    await dispatchProductionStep({ stepKind: 'frame', project, scene, route: { kind: 'image', mode: 'codex', model: null }, tag, settings });
    const { kind, params, owner } = enqueueJob.mock.calls[0][0];
    expect(kind).toBe('image');
    expect(owner).toBe('music-video-production:mvpr-example');
    expect(params).toMatchObject({ mode: 'codex', musicVideo: tag, referenceImageStrengths: [1] });
    // Frames are requested at the project's aspect (16:9 by default), never left to the backend.
    expect(params).toMatchObject({ width: 1536, height: 864 });
    expect(params.prompt).toMatch(/^a lighthouse, noir/);
    expect(params.referenceImagePaths).toHaveLength(1);
    expect(params.referenceImagePaths[0]).toMatch(/ref-example\.png$/);
  });

  it('never conditions a frame on a mood board import or a Pinterest pin, even when flagged', async () => {
    const outside = { ...project, visualSpec: { references: [
      { id: 'mvr-board-1', imageId: 'board-still.png', condition: true },
      { id: 'picked', imageId: 'pinterest-0123456789abcdef.jpg', condition: true },
      { id: 'own', imageId: 'ref-example.png', condition: true },
    ] } };
    await dispatchProductionStep({ stepKind: 'frame', project: outside, scene, route: { kind: 'image', mode: 'codex', model: null }, tag, settings });
    expect(enqueueJob.mock.calls[0][0].params.referenceImagePaths.map((path) => basename(path))).toEqual(['ref-example.png']);
  });

  it('conditions an approved check-in frame on its character and mapped plate, even beyond the global cap', async () => {
    const checkedIn = { ...project,
      castAndSets: { status: 'approved', direction: { songMap: [{ section: 0, setId: 'harbor' }, { section: 1, setId: 'roof' }] } },
      visualSpec: { references: [
        { id: 'authored', imageId: 'authored.png', condition: true },
        { id: 'mvr-cs-character', imageId: 'character.png', condition: true },
        { id: 'mvr-cs-set-harbor', imageId: 'harbor.png', condition: true },
        { id: 'mvr-cs-set-roof', imageId: 'roof.png', condition: false },
      ] },
    };
    for (const [sectionIndex, plate] of [[0, 'harbor'], [1, 'roof']]) {
      await dispatchProductionStep({ stepKind: 'frame', project: checkedIn, scene: { ...scene, sectionIndex },
        route: { kind: 'image', mode: 'codex', model: null }, tag, settings });
      const params = enqueueJob.mock.calls.at(-1)[0].params;
      expect(params.referenceImagePaths.map((path) => basename(path))).toEqual(['character.png', `${plate}.png`]);
      expect(params.referenceImageStrengths).toEqual([1, 1]);
    }
  });

  it('appends capped style images after identities and carries a text look', async () => {
    await dispatchProductionStep({ stepKind: 'frame', project: { ...project,
      styleReferences: Array.from({ length: 8 }, (_, i) => ({ imageId: `style-${i}.png`, caption: 'teal shadows, fine grain' })),
    }, scene, route: { kind: 'image', mode: 'codex', model: null }, tag, settings });
    const params = enqueueJob.mock.calls[0][0].params;
    expect(params.referenceImagePaths.map((p) => basename(p))).toEqual(['ref-example.png', 'style-0.png', 'style-1.png', 'style-2.png']);
    expect(params.prompt).toContain('teal shadows, fine grain');
    expect(params.referenceImageStrengths).toEqual([1, 1, 1, 1]);
  });

  it('refuses a disabled backend instead of rendering on another one', async () => {
    await expect(dispatchProductionStep({ stepKind: 'frame', project, scene, route: { kind: 'image', mode: 'grok', model: null }, tag, settings }))
      .rejects.toThrow(/disabled/);
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('renders a local frame on the pool\'s exact model', async () => {
    await dispatchProductionStep({ stepKind: 'frame', project, scene, route: { kind: 'image', mode: 'local', model: 'flux2-dev' }, tag, settings });
    expect(enqueueJob.mock.calls[0][0].params).toMatchObject({ modelId: 'flux2-dev', pythonPath: '/opt/example/python' });
    expect(enqueueJob.mock.calls[0][0].params).not.toHaveProperty('mode');
  });

  it('refuses an image after provider preparation when the production plan changed before enqueue', async () => {
    assertProductionSubmission.mockRejectedValueOnce(Object.assign(new Error('Plan changed'), { code: 'PRODUCTION_BASIS_CHANGED' }));
    await expect(dispatchProductionStep({ stepKind: 'frame', project, scene,
      route: { kind: 'image', mode: 'codex', model: null }, tag, settings })).rejects.toMatchObject({ code: 'PRODUCTION_BASIS_CHANGED' });
    expect(assertProductionSubmission).toHaveBeenCalledWith(tag.projectId, tag.productionRunId, tag.productionStepKey,
      { sceneId: tag.sceneId, kind: 'image' });
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('dispatches a standalone auto-review frame (no production run): the revision guard runs, the production reservation does not (#10014)', async () => {
    const revisionTag = { projectId: 'mv-example', sceneId: 'mvs-a', revisionId: 'mvr-example' };
    await dispatchProductionStep({ stepKind: 'frame', project, scene, route: { kind: 'image', mode: 'codex', model: null }, tag: revisionTag, settings });
    expect(assertRevisionOpen).toHaveBeenCalledWith('mv-example', 'mvr-example', { sceneId: 'mvs-a', kind: 'image' });
    expect(assertProductionSubmission).not.toHaveBeenCalled();
    expect(enqueueJob.mock.calls[0][0]).toMatchObject({ kind: 'image', owner: 'music-video-auto-review:mvr-example', params: { musicVideo: revisionTag } });
    // A refused revision guard keeps the job out of the queue.
    assertRevisionOpen.mockRejectedValueOnce(Object.assign(new Error('Spend limit'), { code: 'AUTO_REVIEW_SPEND_LIMIT' }));
    await expect(dispatchProductionStep({ stepKind: 'frame', project, scene, route: { kind: 'image', mode: 'codex', model: null }, tag: revisionTag, settings }))
      .rejects.toMatchObject({ code: 'AUTO_REVIEW_SPEND_LIMIT' });
    expect(enqueueJob).toHaveBeenCalledTimes(1);
  });

  it('submits a clip with an explicit backend so the install pin ladder cannot substitute one', async () => {
    const clipTag = { ...tag, productionStepKey: 'clip:mvs-a:base:1' };
    await dispatchProductionStep({ stepKind: 'clip', project, scene, route: { kind: 'video', mode: 'grok', model: null }, tag: clipTag, settings });
    expect(submitVideoGenJob).toHaveBeenCalledWith(expect.objectContaining({
      backend: 'grok', mode: 'image', sourceImageFile: 'frame-example.png', grokDuration: 6, musicVideo: clipTag,
    }), {});
  });

  it('submits a fal clip as exactly the take the step was priced for (falSceneTake)', async () => {
    const clipTag = { ...tag, productionStepKey: 'clip:mvs-a:base:1' };
    const falProject = { ...project, videoSettings: { backend: 'fal', falModelId: 'fal-ai/veo3.1/fast/image-to-video', falResolution: '1080p' } };
    // A 4s cutaway on Veo 3.1 Fast (4/6/8s clips) renders 4s at the pinned resolution.
    await dispatchProductionStep({ stepKind: 'clip', project: falProject, scene, route: { kind: 'video', mode: 'fal', model: null }, tag: clipTag, settings });
    expect(submitVideoGenJob.mock.calls[0][0]).toMatchObject({
      backend: 'fal', falModelId: 'fal-ai/veo3.1/fast/image-to-video', falDuration: 4, falResolution: '1080p',
    });
    // A performance take sends only its lip-sync resolution: its length follows the song slice.
    await dispatchProductionStep({
      stepKind: 'clip', project: falProject, scene: { ...scene, shotMode: 'performance' },
      route: { kind: 'video', mode: 'fal', model: null }, tag: clipTag, settings,
    });
    const performance = submitVideoGenJob.mock.calls[1][0];
    expect(performance).toMatchObject({ backend: 'fal', falResolution: '1080P' });
    expect(performance).not.toHaveProperty('falDuration');
    expect(performance).not.toHaveProperty('falModelId');
  });
});
