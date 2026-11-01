import { describe, it, expect, vi, beforeEach } from 'vitest';

const enqueueJob = vi.fn(async () => ({ jobId: 'job-seq-1' }));
vi.mock('../mediaJobQueue/index.js', () => ({ enqueueJob }));
let stored = null;
vi.mock('./projects.js', () => ({ getProject: async () => stored }));
vi.mock('../../lib/pathSafety.js', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveGalleryImage: (id) => (id ? `/gallery/${id}` : null),
}));

const { previewSequenceCoverage, submitSequenceCoverage } = await import('./sequenceCoverage.js');

const scene = (sceneId, startSec, endSec, extra = {}) => ({
  sceneId, sectionIndex: 0, coverage: 'sequence', startSec, endSec, shotMode: 'cutaway', visualLayer: 'footage',
  set: { id: 'attic' }, protagonist: 'mara', prompt: `shot ${sceneId}`, referenceImageId: `${sceneId}.png`, ...extra,
});
const project = (scenes, falModelId = 'minimax/h3-max/reference-to-video') => ({ id: 'p1', videoSettings: { backend: 'fal', falModelId }, scenes });

describe('previewSequenceCoverage', () => {
  it('shows a three-shot section as one H3 request with expansion disabled and three clip spans; the performance shot stays out', () => {
    const preview = previewSequenceCoverage(project([
      scene('a', 0, 4), scene('b', 4, 8), scene('c', 8, 12), scene('p', 12, 18, { shotMode: 'performance' }),
    ]));
    expect(preview.groups).toHaveLength(1);
    const [group] = preview.groups;
    expect(group.prompt).toBe('0-4s: Image 1. shot a\n4-8s: Image 2. shot b\n8-12s: Image 3. shot c');
    expect(group.request.body).toMatchObject({ prompt: group.prompt, prompt_expansion_mode: 'disabled', duration: 12 });
    expect(group.request.promptAdditions).toEqual([expect.objectContaining({ id: 'prompt-expansion', text: expect.stringMatching(/disabled/) })]);
    expect(group.spans.map((s) => [s.clipStartSec, s.clipEndSec])).toEqual([[0, 4], [4, 8], [8, 12]]);
    expect(preview.perShot).toEqual([expect.objectContaining({ sceneId: 'p', reason: expect.stringMatching(/performance/) })]);
  });

  it('keeps a section longer than the model max per-shot', () => {
    const preview = previewSequenceCoverage(project([scene('a', 0, 9), scene('b', 9, 18)]));
    expect(preview.groups).toEqual([]);
    expect(preview.perShot).toHaveLength(2);
  });
});

describe('submitSequenceCoverage', () => {
  beforeEach(() => enqueueJob.mockClear());

  // Uniquely catches a submit that fans out per shot, drifts from the preview's
  // prompt, or loses the in/out points the completion hook cuts at.
  it('queues the planned three-shot run as one fal request carrying each shot\'s frame and its clip spans', async () => {
    stored = project([scene('a', 10, 14), scene('b', 14, 18), scene('c', 18, 22), scene('p', 22, 26, { shotMode: 'performance' })]);
    const out = await submitSequenceCoverage('p1', { sceneIds: ['a', 'b', 'c'] });
    expect(out).toMatchObject({ jobId: 'job-seq-1', sceneIds: ['a', 'b', 'c'], prompt: previewSequenceCoverage(stored).groups[0].prompt });
    expect(enqueueJob).toHaveBeenCalledTimes(1);
    const [{ kind, params }] = enqueueJob.mock.calls[0];
    expect(kind).toBe('video');
    expect(params).toMatchObject({
      mode: 'fal', modelId: 'minimax/h3-max/reference-to-video', prompt: out.prompt, duration: 12,
      referenceImagePaths: ['/gallery/a.png', '/gallery/b.png', '/gallery/c.png'],
      musicVideo: { projectId: 'p1', sequence: { sceneIds: ['a', 'b', 'c'], spans: [
        { sceneId: 'a', clipStartSec: 0, clipEndSec: 4 }, { sceneId: 'b', clipStartSec: 4, clipEndSec: 8 }, { sceneId: 'c', clipStartSec: 8, clipEndSec: 12 },
      ] } },
    });
    expect(params.musicVideo.sceneId).toBeUndefined();
    expect(params.sourceImagePath).toBeUndefined();
    expect(Object.keys(params.musicVideoSequenceDependencies)).toEqual(['a', 'b', 'c']);
  });

  it('refuses a run that includes the performance shot or is longer than the model max', async () => {
    stored = project([scene('a', 0, 4), scene('p', 4, 8, { shotMode: 'performance' })]);
    await expect(submitSequenceCoverage('p1', { sceneIds: ['a', 'p'] })).rejects.toMatchObject({ code: 'SEQUENCE_NOT_PLANNED' });
    stored = project([scene('a', 0, 9), scene('b', 9, 18)]);
    await expect(submitSequenceCoverage('p1', { sceneIds: ['a', 'b'] })).rejects.toMatchObject({ code: 'SEQUENCE_NOT_PLANNED' });
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it('refuses before queueing when a shot has no reference frame', async () => {
    stored = project([scene('a', 0, 4), scene('b', 4, 8, { referenceImageId: null })]);
    await expect(submitSequenceCoverage('p1', { sceneIds: ['a', 'b'] })).rejects.toMatchObject({ code: 'PRODUCTION_FRAME_MISSING' });
    expect(enqueueJob).not.toHaveBeenCalled();
  });
});
