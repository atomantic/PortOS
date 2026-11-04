import { describe, expect, it, vi } from 'vitest';

const getProject = vi.fn();
vi.mock('./projects.js', () => ({ getProject: (...args) => getProject(...args) }));
const { preparePerformanceShot } = await import('./performanceShot.js');

describe('performance shot type guard', () => {
  it.each([
    ['lipsync', { shotMode: 'cutaway' }],
    ['music', { shotMode: 'performance' }],
    ['cutaway', { shotMode: 'performance', performanceStyle: 'music' }],
  ])('rejects a %s request against a different saved shot before preparing audio', async (expectedShot, scene) => {
    getProject.mockResolvedValue({ scenes: [{ sceneId: 's1', ...scene }] });
    await expect(preparePerformanceShot({ musicVideo: { projectId: 'p1', sceneId: 's1', expectedShot }, backend: 'fal', mode: 'image' }))
      .rejects.toMatchObject({ status: 409, code: 'MUSIC_VIDEO_SHOT_TYPE_CHANGED' });
  });

  it('accepts a matching cutaway without preparing performance audio', async () => {
    getProject.mockResolvedValue({ scenes: [{ sceneId: 's1', shotMode: 'cutaway' }] });
    await expect(preparePerformanceShot({ musicVideo: { projectId: 'p1', sceneId: 's1', expectedShot: 'cutaway' }, backend: 'fal', mode: 'image' }))
      .resolves.toBeNull();
  });

  it('refuses a deferred storyboard cutaway that has become a still', async () => {
    getProject.mockResolvedValue({ composition: { mode: 'document' }, scenes: [{ sceneId: 's1', visualLayer: 'still', referenceImageId: 'frame.png' }] });
    await expect(preparePerformanceShot({ musicVideo: { projectId: 'p1', sceneId: 's1', expectedShot: 'cutaway', storyboardStill: 'frame.png' }, backend: 'fal', mode: 'image' }))
      .rejects.toMatchObject({ status: 409, code: 'MUSIC_VIDEO_STORYBOARD_STALE' });
  });

  it('accepts a still layer in a plain video where it remains footage', async () => {
    getProject.mockResolvedValue({ scenes: [{ sceneId: 's1', visualLayer: 'still', referenceImageId: 'frame.png' }] });
    await expect(preparePerformanceShot({ musicVideo: { projectId: 'p1', sceneId: 's1', expectedShot: 'cutaway', storyboardStill: 'frame.png' }, backend: 'fal', mode: 'image' }))
      .resolves.toBeNull();
  });

  it('refuses a deferred clip when another still is selected', async () => {
    getProject.mockResolvedValue({ scenes: [{ sceneId: 's1', referenceImageId: 'other.png' }] });
    await expect(preparePerformanceShot({ musicVideo: { projectId: 'p1', sceneId: 's1', expectedShot: 'cutaway', storyboardStill: 'frame.png' }, backend: 'fal', mode: 'image' }))
      .rejects.toMatchObject({ status: 409, code: 'MUSIC_VIDEO_STORYBOARD_STALE' });
  });
});
