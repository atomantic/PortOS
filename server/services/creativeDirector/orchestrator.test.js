import { describe, it, expect, vi, beforeEach } from 'vitest';
import { nextPendingScene, nextTaskKind, buildTimelineClips } from './orchestrator.js';
import { presetToRenderParams } from '../../lib/creativeDirectorPresets.js';

// Mocks for advanceAfterSceneSettled integration test.
const mockRunSceneRender = vi.fn(async () => undefined);
const mockUpdateProject = vi.fn(async () => undefined);

vi.mock('./local.js', () => ({
  getProject: vi.fn(),
  updateProject: (...args) => mockUpdateProject(...args),
}));

vi.mock('./sceneRunner.js', () => ({
  runSceneRender: (...args) => mockRunSceneRender(...args),
}));

vi.mock('./stitchRunner.js', () => ({
  runStitch: vi.fn(async () => undefined),
}));

vi.mock('./agentBridge.js', () => ({
  enqueueTreatmentTask: vi.fn(async () => undefined),
}));

import * as localMod from './local.js';
import { advanceAfterSceneSettled } from './completionHook.js';

const baseProject = {
  id: 'cd-1',
  name: 'Test',
  status: 'rendering',
  aspectRatio: '16:9',
  quality: 'standard',
  modelId: 'ltx2_unified',
  collectionId: 'mc-1',
  finalVideoId: null,
  treatment: null,
};

describe('orchestrator', () => {
  describe('nextPendingScene', () => {
    it('returns null when no treatment', () => {
      expect(nextPendingScene({ ...baseProject, treatment: null })).toBeNull();
    });

    it('returns the lowest-order non-terminal scene', () => {
      const project = {
        ...baseProject,
        treatment: {
          scenes: [
            { sceneId: 's1', order: 0, status: 'accepted' },
            { sceneId: 's2', order: 1, status: 'pending' },
            { sceneId: 's3', order: 2, status: 'pending' },
          ],
        },
      };
      expect(nextPendingScene(project).sceneId).toBe('s2');
    });

    it('considers rendering / evaluating as in-flight (not next)', () => {
      // The currently running scene IS the "next" scene from the queue
      // perspective — the orchestrator returns it so a re-enqueue picks
      // up where it left off rather than skipping ahead.
      const project = {
        ...baseProject,
        treatment: {
          scenes: [
            { sceneId: 's1', order: 0, status: 'accepted' },
            { sceneId: 's2', order: 1, status: 'rendering' },
            { sceneId: 's3', order: 2, status: 'pending' },
          ],
        },
      };
      expect(nextPendingScene(project).sceneId).toBe('s2');
    });

    it('returns null when every scene is terminal', () => {
      const project = {
        ...baseProject,
        treatment: {
          scenes: [
            { sceneId: 's1', order: 0, status: 'accepted' },
            { sceneId: 's2', order: 1, status: 'failed' },
          ],
        },
      };
      expect(nextPendingScene(project)).toBeNull();
    });
  });

  describe('nextTaskKind', () => {
    it('returns "treatment" when no treatment exists', () => {
      expect(nextTaskKind({ ...baseProject, treatment: null })).toBe('treatment');
    });

    it('returns "scene" when at least one scene is pending', () => {
      const project = {
        ...baseProject,
        treatment: { scenes: [{ sceneId: 's1', order: 0, status: 'pending' }] },
      };
      expect(nextTaskKind(project)).toBe('scene');
    });

    it('returns "stitch" when every scene accepted and no final video', () => {
      const project = {
        ...baseProject,
        treatment: {
          scenes: [
            { sceneId: 's1', order: 0, status: 'accepted' },
            { sceneId: 's2', order: 1, status: 'accepted' },
          ],
        },
      };
      expect(nextTaskKind(project)).toBe('stitch');
    });

    it('returns null when finalVideoId is already set', () => {
      const project = {
        ...baseProject,
        finalVideoId: 'final-uuid',
        treatment: { scenes: [{ sceneId: 's1', order: 0, status: 'accepted' }] },
      };
      expect(nextTaskKind(project)).toBeNull();
    });

    it('returns null when project is paused or failed', () => {
      const paused = { ...baseProject, status: 'paused', treatment: null };
      const failed = { ...baseProject, status: 'failed', treatment: null };
      expect(nextTaskKind(paused)).toBeNull();
      expect(nextTaskKind(failed)).toBeNull();
    });

    it('returns null when no scenes were ever accepted (full failure)', () => {
      const project = {
        ...baseProject,
        treatment: {
          scenes: [
            { sceneId: 's1', order: 0, status: 'failed' },
            { sceneId: 's2', order: 1, status: 'failed' },
          ],
        },
      };
      expect(nextTaskKind(project)).toBeNull();
    });
  });

  describe('buildTimelineClips', () => {
    it('orders accepted scenes by order field', () => {
      const project = {
        ...baseProject,
        treatment: {
          scenes: [
            { sceneId: 's2', order: 1, status: 'accepted', renderedJobId: 'job-2', durationSeconds: 4 },
            { sceneId: 's1', order: 0, status: 'accepted', renderedJobId: 'job-1', durationSeconds: 5 },
            { sceneId: 's3', order: 2, status: 'failed', renderedJobId: 'job-3', durationSeconds: 3 },
          ],
        },
      };
      const clips = buildTimelineClips(project);
      expect(clips).toEqual([
        { clipId: 'job-1', inSec: 0, outSec: 5 },
        { clipId: 'job-2', inSec: 0, outSec: 4 },
      ]);
    });
  });
});

describe('presetToRenderParams', () => {
  it('maps 16:9 + standard at 5s into the LTX-friendly numbers', () => {
    const r = presetToRenderParams({ aspectRatio: '16:9', quality: 'standard', durationSeconds: 5 });
    expect(r.width).toBe(768);
    expect(r.height).toBe(432);
    expect(r.fps).toBe(24);
    expect(r.steps).toBe(20);
    expect(r.guidanceScale).toBe(3.0);
    // 5s × 24fps = 120 → rounds to 120 (multiple of 8).
    expect(r.numFrames).toBe(120);
  });

  it('rounds frame count to multiple of 8 (LTX latent compression requires it)', () => {
    // 1.3s × 24fps = 31.2 — rounds to nearest 8 → 32.
    const r = presetToRenderParams({ aspectRatio: '1:1', quality: 'draft', durationSeconds: 1.3 });
    expect(r.numFrames % 8).toBe(0);
    expect(r.numFrames).toBe(32);
  });

  it('floors at 8 frames so a tiny scene still renders', () => {
    const r = presetToRenderParams({ aspectRatio: '16:9', quality: 'draft', durationSeconds: 0.1 });
    expect(r.numFrames).toBe(8);
  });

  it('throws on unknown aspect ratio', () => {
    expect(() => presetToRenderParams({ aspectRatio: '4:3', quality: 'standard', durationSeconds: 1 }))
      .toThrow(/aspectRatio/);
  });

  it('throws on unknown quality preset', () => {
    expect(() => presetToRenderParams({ aspectRatio: '16:9', quality: 'ultra', durationSeconds: 1 }))
      .toThrow(/quality/);
  });
});

describe('advanceAfterSceneSettled', () => {
  const makeProject = (overrides = {}) => ({
    id: 'cd-test',
    status: 'rendering',
    finalVideoId: null,
    treatment: {
      scenes: [
        { sceneId: 'scene-1', order: 0, status: 'accepted', renderedJobId: 'job-1' },
        { sceneId: 'scene-2', order: 1, status: 'pending' },
        { sceneId: 'scene-3', order: 2, status: 'pending' },
        { sceneId: 'scene-4', order: 3, status: 'pending' },
        { sceneId: 'scene-5', order: 4, status: 'pending' },
        { sceneId: 'scene-6', order: 5, status: 'pending' },
      ],
    },
    ...overrides,
  });

  beforeEach(() => {
    mockRunSceneRender.mockClear();
    mockUpdateProject.mockClear();
  });

  it('picks scene-2 (lowest-order pending) when scene-1 is accepted and scenes 2-6 are pending', async () => {
    const project = makeProject();
    // getProject called twice: initial fetch + fresh fetch before runSceneRender.
    localMod.getProject
      .mockResolvedValueOnce(project)
      .mockResolvedValueOnce(project);

    await advanceAfterSceneSettled(project.id);

    expect(mockRunSceneRender).toHaveBeenCalledTimes(1);
    const [, sceneArg] = mockRunSceneRender.mock.calls[0];
    expect(sceneArg.sceneId).toBe('scene-2');
  });
});
