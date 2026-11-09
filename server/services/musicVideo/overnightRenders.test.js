import { describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/pathSafety.js', () => ({ resolveGalleryImage: (file) => `/gallery/${file}` }));
const { overnightBatches, overnightModelKind, overnightRenderBodies } = await import('./overnightRenders.js');

const ltx = { id: 'ltx25_example', runtime: 'ltx25' };
const omni = { id: 'omni_example', runtime: 'fastvideo', fastvideoFamily: 'fasth3omni' };
const scene = (extra) => ({ sceneId: 's1', referenceImageId: 'start.png', prompt: 'She rides on.', startSec: 0, endSec: 4, ...extra });
const project = (scenes) => ({ id: 'mv-1', scenes, castAndSets: { catalogCheckin: { basis: 'a'.repeat(64) } } });
const schedule = { startAt: '2026-11-09T23:00:00.000Z', stopBy: '2026-11-10T07:00:00.000Z' };
const build = (scenes, models, clipReferences = vi.fn(async () => [{ path: '/refs/lead.png' }, { path: '/refs/bike.png' }])) =>
  overnightRenderBodies({ project: project(scenes), sceneIds: scenes.map((s) => s.sceneId), models, schedule, batchId: 'batch-1', clipReferences });

describe('overnight render requests', () => {
  it('sends each shot the Shot card Render for an LTX reference clip and a FastH3 Omni clip', async () => {
    const clipReferences = vi.fn(async () => [{ path: '/refs/lead.png' }, { path: '/refs/bike.png' }]);
    const { bodies, skipped } = await build([scene()], [ltx, omni], clipReferences);
    expect(skipped).toEqual([]);
    const tag = { projectId: 'mv-1', sceneId: 's1', compose: true, promptAsTyped: true, expectedShot: 'cutaway',
      songAudio: false, batchId: 'batch-1', catalogBasis: 'a'.repeat(64) };
    expect(bodies[0].body).toEqual({ prompt: 'She rides on.', backend: 'local', modelId: ltx.id, sourceImageFile: 'start.png',
      disableAudio: true, schedule, mode: 'ic-ingredients-25', numFrames: 121, icReferenceImageFiles: ['lead.png', 'bike.png'], musicVideo: tag });
    expect(clipReferences).toHaveBeenCalledWith(tag, 8, expect.objectContaining({ excludePath: '/gallery/start.png' }));
    expect(bodies[1].body).toMatchObject({ modelId: omni.id, mode: 'image', musicVideo: tag, schedule });
    expect(bodies[1].body.icReferenceImageFiles).toBeUndefined();
  });

  it('names why a shot cannot render instead of queuing it', async () => {
    const { bodies, skipped } = await build([
      scene({ sceneId: 'no-frame', referenceImageId: null }),
      scene({ sceneId: 'singer', shotMode: 'performance' }),
      scene({ sceneId: 'no-refs' }),
    ], [ltx], vi.fn(async () => []));
    expect(bodies).toEqual([]);
    expect(skipped.map((s) => s.sceneId)).toEqual(['no-frame', 'singer', 'no-refs']);
    expect(skipped[2].reason).toMatch(/no clip references/);
  });

  it('only offers local models that take clip references', () => {
    expect(overnightModelKind(ltx)).toBe('ltxReferences');
    expect(overnightModelKind(omni)).toBe('omni');
    expect(overnightModelKind({ id: 'wan', runtime: 'wan22' })).toBeNull();
  });

  it('groups a project batch from its queue jobs, with finished takes and failures', () => {
    const tag = (sceneId, batchId = 'b1', projectId = 'mv-1') => ({ projectId, sceneId, batchId });
    const batches = overnightBatches([
      { id: 'j1', status: 'completed', queuedAt: '2026-11-09T02:00:00Z', params: { modelId: 'm', musicVideo: tag('s1'), schedule }, result: { generationId: 'j1' } },
      { id: 'j2', status: 'failed', error: 'Out of memory', queuedAt: '2026-11-09T02:00:01Z', params: { modelId: 'm', musicVideo: tag('s2') } },
      { id: 'j3', status: 'queued', queuedAt: '2026-11-09T02:00:00Z', params: { musicVideo: tag('s1', 'b2', 'other') } },
      { id: 'j4', status: 'completed', params: { musicVideo: { projectId: 'mv-1', sceneId: 's1' } } },
    ], 'mv-1');
    expect(batches).toEqual([{ batchId: 'b1', queuedAt: '2026-11-09T02:00:00Z', schedule, jobs: [
      { jobId: 'j1', sceneId: 's1', modelId: 'm', status: 'completed', videoHistoryId: 'j1' },
      { jobId: 'j2', sceneId: 's2', modelId: 'm', status: 'failed', error: 'Out of memory' },
    ] }]);
  });
});
