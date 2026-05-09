import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mocks must be declared before importing the module under test.
const mockEnqueueJob = vi.fn(() => ({ jobId: 'job-fake' }));
const mockGetSettings = vi.fn(async () => ({ imageGen: { local: { pythonPath: '/usr/bin/python3' } } }));
const mockUpdateScene = vi.fn(async () => undefined);
const mockUpdateProject = vi.fn(async () => undefined);
const mockGetProject = vi.fn();
const mockExtractLastFrame = vi.fn(async () => ({ filename: 'last-frame.png' }));
const mockSampleEvaluationFrames = vi.fn(async () => []);
const mockExistsSync = vi.fn(() => true);

vi.mock('../../lib/fileUtils.js', () => ({
  PATHS: { images: '/fake/images', videos: '/fake/videos' },
}));

vi.mock('../../lib/ffmpeg.js', () => ({
  verifyVideoPlayable: vi.fn(async () => ({ ok: true })),
}));

vi.mock('../../lib/creativeDirectorPresets.js', () => ({
  presetToRenderParams: () => ({ width: 768, height: 432, numFrames: 121, fps: 24, steps: 30, guidanceScale: 3 }),
}));

vi.mock('../videoGen/local.js', () => ({
  extractLastFrame: (...args) => mockExtractLastFrame(...args),
  sampleEvaluationFrames: (...args) => mockSampleEvaluationFrames(...args),
}));

vi.mock('../mediaJobQueue/index.js', () => ({
  enqueueJob: (...args) => mockEnqueueJob(...args),
  // The runner attaches listeners but for this test we never fire events,
  // so a no-op emitter is enough.
  mediaJobEvents: { on: vi.fn(), off: vi.fn() },
}));

vi.mock('../settings.js', () => ({
  getSettings: (...args) => mockGetSettings(...args),
}));

vi.mock('./local.js', () => ({
  updateScene: (...args) => mockUpdateScene(...args),
  updateProject: (...args) => mockUpdateProject(...args),
  getProject: (...args) => mockGetProject(...args),
}));

vi.mock('./agentBridge.js', () => ({
  enqueueEvaluateTask: vi.fn(async () => undefined),
}));

vi.mock('fs', async () => {
  const actual = await vi.importActual('fs');
  return { ...actual, existsSync: (...args) => mockExistsSync(...args) };
});

const { runSceneRender } = await import('./sceneRunner.js');

const baseProject = {
  id: 'cd-1',
  name: 'Test',
  aspectRatio: '16:9',
  quality: 'standard',
  modelId: 'ltx2_unified',
  collectionId: 'mc-1',
  disableAudio: true,
  treatment: { scenes: [] },
};

beforeEach(() => {
  mockEnqueueJob.mockReset().mockReturnValue({ jobId: 'job-fake' });
  mockUpdateScene.mockReset().mockResolvedValue(undefined);
  mockUpdateProject.mockReset().mockResolvedValue(undefined);
  mockGetProject.mockReset();
  mockExtractLastFrame.mockReset().mockResolvedValue({ filename: 'last-frame.png' });
  mockSampleEvaluationFrames.mockReset().mockResolvedValue([]);
  mockExistsSync.mockReset().mockReturnValue(true);
  mockGetSettings.mockReset().mockResolvedValue({ imageGen: { local: { pythonPath: '/usr/bin/python3' } } });
});

const enqueuedParams = () => mockEnqueueJob.mock.calls[0][0].params;

describe('runSceneRender — imageStrength resolution', () => {
  it('applies the continuation default (0.85) when scene asks for continuation and no explicit value is set', async () => {
    // A prior accepted scene exists, so the continuation branch will
    // successfully resolve a sourceImagePath.
    mockGetProject.mockResolvedValue({
      ...baseProject,
      treatment: {
        scenes: [
          { sceneId: 's0', order: 0, status: 'accepted', renderedJobId: 'prior-job' },
        ],
      },
    });
    const scene = {
      sceneId: 's1',
      order: 1,
      prompt: 'A continuation shot',
      durationSeconds: 5,
      useContinuationFromPrior: true,
    };
    await runSceneRender({ ...baseProject, treatment: { scenes: [{ sceneId: 's0', order: 0, status: 'accepted', renderedJobId: 'prior-job' }] } }, scene);
    expect(mockEnqueueJob).toHaveBeenCalledTimes(1);
    expect(enqueuedParams().imageStrength).toBe(0.85);
    expect(enqueuedParams().mode).toBe('image');
  });

  it('honors an explicit scene.imageStrength over the continuation default', async () => {
    mockGetProject.mockResolvedValue({
      ...baseProject,
      treatment: {
        scenes: [
          { sceneId: 's0', order: 0, status: 'accepted', renderedJobId: 'prior-job' },
        ],
      },
    });
    const scene = {
      sceneId: 's1',
      order: 1,
      prompt: 'A continuation shot with deliberate change',
      durationSeconds: 5,
      useContinuationFromPrior: true,
      imageStrength: 0.6,
    };
    await runSceneRender({ ...baseProject, treatment: { scenes: [{ sceneId: 's0', order: 0, status: 'accepted', renderedJobId: 'prior-job' }] } }, scene);
    expect(enqueuedParams().imageStrength).toBe(0.6);
  });

  it('honors imageStrength=0 (do not let the explicit zero be confused with "unset" and replaced with the default)', async () => {
    mockGetProject.mockResolvedValue({
      ...baseProject,
      treatment: {
        scenes: [
          { sceneId: 's0', order: 0, status: 'accepted', renderedJobId: 'prior-job' },
        ],
      },
    });
    const scene = {
      sceneId: 's1',
      order: 1,
      prompt: 'Pure T2V despite the seed',
      durationSeconds: 5,
      useContinuationFromPrior: true,
      imageStrength: 0,
    };
    await runSceneRender({ ...baseProject, treatment: { scenes: [{ sceneId: 's0', order: 0, status: 'accepted', renderedJobId: 'prior-job' }] } }, scene);
    expect(enqueuedParams().imageStrength).toBe(0);
  });

  it('does NOT default imageStrength for a text-to-video scene (no source image)', async () => {
    mockGetProject.mockResolvedValue({ ...baseProject });
    const scene = {
      sceneId: 's1',
      order: 0,
      prompt: 'Opening text-to-video shot',
      durationSeconds: 5,
      useContinuationFromPrior: false,
    };
    await runSceneRender({ ...baseProject }, scene);
    expect(enqueuedParams().imageStrength).toBeNull();
    expect(enqueuedParams().mode).toBe('text');
  });

  it('does NOT default imageStrength for a non-continuation i2v scene (sourceImageFile set directly)', async () => {
    // mlx_video defaults to 1.0 in this case, which preserves prior behavior
    // for users who supplied a starting image without a strength preference.
    mockGetProject.mockResolvedValue({ ...baseProject });
    const scene = {
      sceneId: 's1',
      order: 0,
      prompt: 'Seeded i2v shot',
      durationSeconds: 5,
      useContinuationFromPrior: false,
      sourceImageFile: 'hero.png',
    };
    await runSceneRender({ ...baseProject }, scene);
    expect(enqueuedParams().imageStrength).toBeNull();
    expect(enqueuedParams().mode).toBe('image');
  });

  it('does NOT default imageStrength when continuation falls back to text-to-video (no prior accepted scene)', async () => {
    // Continuation fallback should leave imageStrength null — feeding 0.85
    // to a T2V render is meaningless and would obscure the fallback in logs.
    mockGetProject.mockResolvedValue({
      ...baseProject,
      treatment: { scenes: [] },
    });
    const scene = {
      sceneId: 's1',
      order: 1,
      prompt: 'Wants continuation but has no prior scene',
      durationSeconds: 5,
      useContinuationFromPrior: true,
    };
    await runSceneRender({ ...baseProject, treatment: { scenes: [] } }, scene);
    expect(enqueuedParams().imageStrength).toBeNull();
    expect(enqueuedParams().mode).toBe('text');
  });

  it('does NOT default imageStrength when prior-frame extraction fails', async () => {
    mockGetProject.mockResolvedValue({
      ...baseProject,
      treatment: {
        scenes: [
          { sceneId: 's0', order: 0, status: 'accepted', renderedJobId: 'prior-job' },
        ],
      },
    });
    mockExtractLastFrame.mockResolvedValue(null);
    const scene = {
      sceneId: 's1',
      order: 1,
      prompt: 'Continuation but extraction breaks',
      durationSeconds: 5,
      useContinuationFromPrior: true,
    };
    await runSceneRender({ ...baseProject, treatment: { scenes: [{ sceneId: 's0', order: 0, status: 'accepted', renderedJobId: 'prior-job' }] } }, scene);
    expect(enqueuedParams().imageStrength).toBeNull();
  });
});
