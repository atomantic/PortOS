/**
 * Music Video production run (#9066) — the browserless scene lanes. Pins the
 * contract the orchestration test doubles out: a step renders on EXACTLY its
 * pool route (a disabled backend refuses instead of resolving to another),
 * carries the step's job tag for correlation, and conditions on the visual
 * spec's references like the board does. The real render-target resolver runs;
 * only the queue and the video submit service are doubled.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const enqueueJob = vi.fn(async () => ({ jobId: 'job-image' }));
const submitVideoGenJob = vi.fn(async () => ({ jobId: 'job-video' }));
vi.mock('../mediaJobQueue/index.js', () => ({ enqueueJob: (...a) => enqueueJob(...a) }));
vi.mock('../videoGen/submitJob.js', () => ({ submitVideoGenJob: (...a) => submitVideoGenJob(...a) }));
vi.mock('../imageGen/index.js', () => ({ resolveImageCleaners: () => ({ cleanC2PA: false, denoise: false }) }));

const { dispatchProductionStep } = await import('./productionDispatch.js');

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
    expect(params.prompt).toMatch(/^a lighthouse, noir/);
    expect(params.referenceImagePaths).toHaveLength(1);
    expect(params.referenceImagePaths[0]).toMatch(/ref-example\.png$/);
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
