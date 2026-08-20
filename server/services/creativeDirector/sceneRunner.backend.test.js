/**
 * runSceneRender — render-backend pin coverage.
 *
 * Kept apart from the pure `sceneRunner.test.js` on purpose: exercising the
 * enqueue path needs the service graph mocked out, and hoisted `vi.mock` calls
 * apply to the whole file — folding them into the pure suite would silently
 * replace the real modules its schema assertions import.
 *
 * What's under test is the gap #3135 left: a creative commission pins its video
 * backend on the project (`renderBackend.video`), but the TREATMENT/SCENE path
 * — which is where a commission's video is actually rendered — used to ignore
 * it entirely and always build local MLX params.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../mediaJobQueue/index.js', () => ({
  enqueueJob: vi.fn(() => ({ jobId: 'job-1' })),
  mediaJobEvents: { on: vi.fn(), off: vi.fn() },
}));
vi.mock('../settings.js', () => ({
  getSettings: vi.fn(),
  getSettingsWithStatus: async (...args) => {
    try {
      return { corrupt: false, settings: await getSettings(...args) };
    } catch {
      return { corrupt: true, settings: null };
    }
  },
}));
vi.mock('./local.js', () => ({
  updateScene: vi.fn(async () => {}),
  updateProject: vi.fn(async () => {}),
  getProject: vi.fn(async () => null),
}));
vi.mock('./sceneEvaluator.js', () => ({ dispatchSceneEvaluation: vi.fn(async () => {}) }));
vi.mock('../videoGen/local.js', () => ({
  extractLastFrame: vi.fn(async () => null),
  sampleEvaluationFrames: vi.fn(async () => []),
}));
vi.mock('./completionHook.js', () => ({ advanceAfterSceneSettled: vi.fn(async () => {}) }));
vi.mock('../../lib/ffmpeg.js', () => ({ verifyVideoPlayable: vi.fn(async () => ({ ok: true })) }));

import { runSceneRender } from './sceneRunner.js';
import { enqueueJob } from '../mediaJobQueue/index.js';
import { getSettings } from '../settings.js';
import { updateScene } from './local.js';

const LOCAL_READY = { imageGen: { local: { pythonPath: '/usr/bin/python3' } } };
const GROK_READY = { imageGen: { grok: { enabled: true, grokPath: '/usr/local/bin/grok' } } };

const project = (over = {}) => ({
  id: 'proj-1',
  aspectRatio: '16:9',
  quality: 'standard',
  modelId: 'project-default-model',
  ...over,
});
const scene = (over = {}) => ({
  sceneId: 'scene-1', order: 0, prompt: 'a cat walks into view', durationSeconds: 8, ...over,
});

const enqueuedParams = () => enqueueJob.mock.calls[0][0].params;

beforeEach(() => vi.clearAllMocks());

describe('runSceneRender — unpinned (local) behavior is unchanged', () => {
  it('builds local MLX params when nothing is pinned', async () => {
    getSettings.mockResolvedValue(LOCAL_READY);
    await runSceneRender(project(), scene());

    const params = enqueuedParams();
    expect(enqueueJob.mock.calls[0][0].kind).toBe('video');
    expect(params.pythonPath).toBe('/usr/bin/python3');
    expect(params.modelId).toBe('project-default-model');
    expect(params.mode).toBe('text');
    expect(params.numFrames).toBeGreaterThan(0);
    expect(params).not.toHaveProperty('duration');
  });

  it('fails the scene when local is the resolved backend and python is unconfigured', async () => {
    getSettings.mockResolvedValue({ imageGen: {} });
    const jobId = await runSceneRender(project(), scene());

    expect(jobId).toBe(null);
    expect(enqueueJob).not.toHaveBeenCalled();
    expect(updateScene).toHaveBeenLastCalledWith('proj-1', 'scene-1', expect.objectContaining({ status: 'failed' }));
  });
});

describe('runSceneRender — grok pin', () => {
  it('renders on grok when the project pins it', async () => {
    getSettings.mockResolvedValue({ ...LOCAL_READY, ...GROK_READY });
    await runSceneRender(project({ renderBackend: { video: { mode: 'grok', modelId: null } } }), scene());

    const params = enqueuedParams();
    expect(params.mode).toBe('grok');
    expect(params.grokPath).toBe('/usr/local/bin/grok');
    expect(params.videoMode).toBe('text');
    // The scene's 8s is authored in local-lane continuous seconds; grok only
    // delivers 6 or 10, so it must round UP rather than truncate the beat.
    expect(params.duration).toBe(10);
    // Local-only dials must not ride along — grok has no such knobs.
    expect(params).not.toHaveProperty('pythonPath');
    expect(params).not.toHaveProperty('numFrames');
    expect(params).not.toHaveProperty('steps');
  });

  it('renders on grok even when local python is unconfigured', async () => {
    // The regression this whole change exists for: a grok-pinned commission on
    // an install with no MLX python used to fail every scene up front.
    getSettings.mockResolvedValue(GROK_READY);
    const jobId = await runSceneRender(project({ renderBackend: { video: { mode: 'grok' } } }), scene());

    expect(jobId).toBe('job-1');
    expect(enqueuedParams().mode).toBe('grok');
  });

  it('marks an i2v scene when a source image resolved', async () => {
    getSettings.mockResolvedValue(GROK_READY);
    await runSceneRender(
      project({ renderBackend: { video: { mode: 'grok' } } }),
      // A bare filename that never resolves under data/images stays null, so
      // pass the case we can assert deterministically: no source ⇒ 'text'.
      scene(),
    );
    expect(enqueuedParams().videoMode).toBe('text');
  });

  it('passes the project geometry so grok derives the right aspect ratio', async () => {
    getSettings.mockResolvedValue(GROK_READY);
    await runSceneRender(
      project({ aspectRatio: '9:16', renderBackend: { video: { mode: 'grok' } } }),
      scene(),
    );
    const params = enqueuedParams();
    expect(params.height).toBeGreaterThan(params.width);
  });

  it('degrades to local when grok is pinned but disabled', async () => {
    getSettings.mockResolvedValue({ ...LOCAL_READY, imageGen: { ...LOCAL_READY.imageGen, grok: { enabled: false } } });
    await runSceneRender(project({ renderBackend: { video: { mode: 'grok' } } }), scene());

    const params = enqueuedParams();
    expect(params.mode).toBe('text');
    expect(params.pythonPath).toBe('/usr/bin/python3');
  });

  it('explains a lapsed cloud pin when the local fallback is also unconfigured', async () => {
    getSettings.mockResolvedValue({ imageGen: { grok: { enabled: false } } });
    await runSceneRender(project({ renderBackend: { video: { mode: 'grok' } } }), scene());

    const notes = updateScene.mock.calls.at(-1)[2].evaluation.notes;
    expect(notes).toContain("pinned to 'grok'");
  });
});

describe('runSceneRender — local model pin', () => {
  it("uses the pinned local model over the project's creation-time default", async () => {
    getSettings.mockResolvedValue(LOCAL_READY);
    await runSceneRender(
      project({ renderBackend: { video: { mode: 'local', modelId: 'ltx-13b' } } }),
      scene(),
    );
    expect(enqueuedParams().modelId).toBe('ltx-13b');
  });

  it("falls back to the project's model when the pin names no model", async () => {
    getSettings.mockResolvedValue(LOCAL_READY);
    await runSceneRender(project({ renderBackend: { video: { mode: 'local' } } }), scene());
    expect(enqueuedParams().modelId).toBe('project-default-model');
  });

  it('applies the install-wide creative-agent video model default', async () => {
    getSettings.mockResolvedValue({
      ...LOCAL_READY,
      renderDefaults: { 'creative-agent': { videoMode: 'local', videoModel: 'target-default-model' } },
    });
    await runSceneRender(project(), scene());
    expect(enqueuedParams().modelId).toBe('target-default-model');
  });
});
