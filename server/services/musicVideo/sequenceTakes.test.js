import { describe, it, expect, vi, beforeEach } from 'vitest';

const enqueueJob = vi.fn(async () => ({ jobId: 'job-take-1' }));
vi.mock('../mediaJobQueue/index.js', () => ({ enqueueJob }));
let stored = null;
vi.mock('./projects.js', () => ({ getProject: async () => stored }));
vi.mock('../../lib/pathSafety.js', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveGalleryImage: (id) => (id ? `/gallery/${id}` : null),
}));
// Each shot's clip references, as the shot card's own clip render would send them.
const castRefs = {
  a: [{ path: '/refs/alice.png', label: 'Alice' }, { path: '/refs/diner.png', label: 'Diner', role: 'set' }],
  b: [{ path: '/refs/alice.png', label: 'Alice' }, { path: '/refs/bob.png', label: 'Bob' }],
  c: [],
};
vi.mock('./clipCastReferences.js', () => ({
  musicVideoClipReferences: async ({ sceneId }) => castRefs[sceneId] || [],
}));

const { sequenceTake } = await import('./sequenceTakes.js');

const H3 = 'minimax/h3-max/reference-to-video';
const shot = (sceneId, order, startSec, endSec, extra = {}) => ({
  sceneId, label: sceneId.toUpperCase(), order, startSec, endSec, visualLayer: 'footage', prompt: `shot ${sceneId}`, referenceImageId: `${sceneId}.png`, ...extra,
});
const project = (scenes, videoSettings = { backend: 'fal', falModelId: H3, falResolution: '768P' }) => ({ id: 'p1', videoSettings, scenes });

describe('sequenceTake', () => {
  beforeEach(() => {
    enqueueJob.mockClear();
    stored = project([shot('a', 0, 0, 3), shot('b', 1, 3, 6), shot('c', 2, 6, 8), shot('d', 3, 8, 24)]);
  });

  // Uniquely catches a preview that drifts from the submit, leaks local paths, or prices a different length.
  it('previews the composed prompt, reference union and price without sending anything', async () => {
    const plan = await sequenceTake('p1', { sceneIds: ['a', 'b', 'c'], dryRun: true });
    expect(enqueueJob).not.toHaveBeenCalled();
    expect(plan).toMatchObject({ dryRun: true, modelId: H3, sceneIds: ['a', 'b', 'c'], runSec: 8, seconds: 8, resolution: '768P', promptOverride: false });
    expect(plan.estimatedCostUsd).toBeGreaterThan(0);
    expect(plan.references.map((r) => [r.kind, r.imageId])).toEqual([
      ['frame', 'a.png'], ['frame', 'b.png'], ['frame', 'c.png'], ['reference', 'alice.png'], ['reference', 'diner.png'], ['reference', 'bob.png'],
    ]);
    expect(JSON.stringify(plan)).not.toContain('/gallery/');
    expect(JSON.stringify(plan)).not.toContain('/refs/');
    expect(plan.prompt).toContain('Shot 1 (0-3s): Image 1. shot a');
    expect(plan.prompt).toContain('Image 4 is Alice');
    expect(plan.prompt).toContain('Image 5 is the set "Diner"');
    expect(plan.body).toMatchObject({ prompt: plan.prompt, duration: 8, prompt_expansion_mode: 'disabled' });
    expect(plan.windows).toEqual([{ sceneId: 'a', startSec: 0, endSec: 3 }, { sceneId: 'b', startSec: 3, endSec: 6 }, { sceneId: 'c', startSec: 6, endSec: 8 }]);
  });

  it('queues the same request as one fal job tagged for the sequence-take hook', async () => {
    const plan = await sequenceTake('p1', { sceneIds: ['a', 'b', 'c'], dryRun: true });
    const queued = await sequenceTake('p1', { sceneIds: ['a', 'b', 'c'] });
    expect(queued).toMatchObject({ dryRun: false, jobId: 'job-take-1', prompt: plan.prompt, estimatedCostUsd: plan.estimatedCostUsd });
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    const [{ kind, params }] = enqueueJob.mock.calls[0];
    expect(kind).toBe('video');
    expect(params).toMatchObject({
      mode: 'fal', modelId: H3, prompt: plan.prompt, duration: 8, resolution: '768P',
      referenceImagePaths: ['/gallery/a.png', '/gallery/b.png', '/gallery/c.png', '/refs/alice.png', '/refs/diner.png', '/refs/bob.png'],
      promptAdditions: plan.promptAdditions,
      musicVideo: { projectId: 'p1', sequenceTake: { sceneIds: ['a', 'b', 'c'], windows: plan.windows } },
      musicVideoCostUsd: plan.estimatedCostUsd,
    });
    expect(params.musicVideo).not.toHaveProperty('sceneId');
    expect(Object.keys(params.musicVideoSequenceDependencies)).toEqual(['a', 'b', 'c']);
  });

  it('sends a typed prompt as written, with no additions', async () => {
    const plan = await sequenceTake('p1', { sceneIds: ['a', 'b'], prompt: 'Two shots of Alice at the diner.', dryRun: true });
    expect(plan).toMatchObject({ prompt: 'Two shots of Alice at the diner.', promptOverride: true, promptAdditions: [] });
    expect(plan.composedPrompt).toContain('Shot 2');
  });

  it('caps the references at the model limit, keeping every frame', async () => {
    castRefs.c = Array.from({ length: 8 }, (_, i) => ({ path: `/refs/extra-${i}.png`, label: `Extra ${i}` }));
    try {
      const plan = await sequenceTake('p1', { sceneIds: ['a', 'b', 'c'], dryRun: true });
      expect(plan.references).toHaveLength(9);
      expect(plan.references.filter((r) => r.kind === 'frame')).toHaveLength(3);
      expect(plan.omittedReferences).toBe(5);
    } finally {
      castRefs.c = [];
    }
  });

  it('refuses a run too long for the model, a shot without a frame, a gap and a non-reference model', async () => {
    await expect(sequenceTake('p1', { sceneIds: ['c', 'd'], dryRun: true })).rejects.toMatchObject({ code: 'SEQUENCE_TAKE_TOO_LONG' });
    stored.scenes[1].referenceImageId = null;
    await expect(sequenceTake('p1', { sceneIds: ['a', 'b'], dryRun: true })).rejects.toMatchObject({ code: 'PRODUCTION_FRAME_MISSING' });
    await expect(sequenceTake('p1', { sceneIds: ['a', 'c'], dryRun: true })).rejects.toMatchObject({ code: 'SEQUENCE_TAKE_NOT_CONSECUTIVE' });
    await expect(sequenceTake('p1', { sceneIds: ['a', 'b'], modelId: 'minimax/h3-max/image-to-video', dryRun: true })).rejects.toMatchObject({ code: 'SEQUENCE_TAKE_MODEL' });
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('refuses a prompt over the model\'s length, never shortening it', async () => {
    await expect(sequenceTake('p1', { sceneIds: ['a', 'b'], prompt: 'x'.repeat(2001), dryRun: true }))
      .rejects.toMatchObject({ code: 'VALIDATION_ERROR', message: expect.stringMatching(/2,001 characters/) });
  });
});
