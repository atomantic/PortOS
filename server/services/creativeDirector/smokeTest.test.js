import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockReadJSONFile = vi.fn();
const mockAtomicWrite = vi.fn();
const mockEnsureDir = vi.fn();

vi.mock('../../lib/fileUtils.js', () => ({
  PATHS: { data: '/fake/data' },
  readJSONFile: (...args) => mockReadJSONFile(...args),
  atomicWrite: (...args) => mockAtomicWrite(...args),
  ensureDir: (...args) => mockEnsureDir(...args),
}));

vi.mock('../mediaCollections.js', () => ({
  createCollection: vi.fn(async () => ({ id: 'col-smoke' })),
}));

const { createSmokeTestProject } = await import('./smokeTest.js');

beforeEach(() => {
  // Persisted file starts empty; each save returns the latest snapshot.
  let snapshot = [];
  mockReadJSONFile.mockReset().mockImplementation(async () => snapshot);
  mockAtomicWrite.mockReset().mockImplementation(async (_path, data) => {
    snapshot = data;
  });
  mockEnsureDir.mockReset().mockResolvedValue(undefined);
});

describe('createSmokeTestProject', () => {
  it('creates a deterministic 3-scene project with disableAudio=true and autoAcceptScenes=true', async () => {
    const project = await createSmokeTestProject();
    expect(project.disableAudio).toBe(true);
    expect(project.autoAcceptScenes).toBe(true);
    expect(project.aspectRatio).toBe('1:1');
    expect(project.quality).toBe('draft');
    expect(project.targetDurationSeconds).toBe(9);
    expect(project.treatment.scenes).toHaveLength(3);
  });

  it('scene 1 is text-to-video (no continuation, no source image)', async () => {
    const project = await createSmokeTestProject();
    const scene1 = project.treatment.scenes.find((s) => s.sceneId === 'scene-1');
    expect(scene1.useContinuationFromPrior).toBe(false);
    expect(scene1.sourceImageFile).toBeNull();
    expect(scene1.prompt.toLowerCase()).toContain('red');
  });

  it('scene 2 continues from scene 1 with a color-change prompt', async () => {
    const project = await createSmokeTestProject();
    const scene2 = project.treatment.scenes.find((s) => s.sceneId === 'scene-2');
    expect(scene2.useContinuationFromPrior).toBe(true);
    expect(scene2.prompt.toLowerCase()).toContain('blue');
    // Negative prompt should explicitly reject the prior color so the i2v
    // doesn't drift back to red.
    expect(scene2.negativePrompt.toLowerCase()).toContain('red');
  });

  it('scene 3 is a pure continuation of scene 2 (same prompt)', async () => {
    const project = await createSmokeTestProject();
    const scene2 = project.treatment.scenes.find((s) => s.sceneId === 'scene-2');
    const scene3 = project.treatment.scenes.find((s) => s.sceneId === 'scene-3');
    expect(scene3.useContinuationFromPrior).toBe(true);
    expect(scene3.prompt).toBe(scene2.prompt);
  });

  it('respects overrides (e.g. flip autoAcceptScenes off for a real-evaluator dry run)', async () => {
    const project = await createSmokeTestProject({ autoAcceptScenes: false });
    expect(project.autoAcceptScenes).toBe(false);
    // Other defaults still applied.
    expect(project.disableAudio).toBe(true);
  });
});
