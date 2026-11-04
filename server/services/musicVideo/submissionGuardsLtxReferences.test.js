import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ project: null, references: vi.fn() }));
vi.mock('./projects.js', () => ({ getProject: async () => m.project }));
vi.mock('./clipCastReferences.js', () => ({ musicVideoClipReferences: (...args) => m.references(...args) }));
vi.mock('./greyboxReferences.js', () => ({ loadMusicVideoGreybox: async () => null }));

import { applyMusicVideoSubmissionGuards } from './submissionGuards.js';

const tag = { projectId: 'project', sceneId: 'shot', promptAsTyped: true, expectedClipReferenceFiles: ['a.png'], expectedClipReferenceLabels: ['Rider'] };
const request = () => ({
  body: { mode: 'ic-ingredients-25', musicVideo: tag }, backend: 'local', performance: null,
  params: { prompt: 'Reference sheet: Rider.\n\nGenerated video: A rider turns', icReferencePaths: ['/gallery/a.png'] },
  prepared: { sourceImagePath: '/gallery/start.png' },
});

beforeEach(() => {
  m.project = { id: 'project', scenes: [{ sceneId: 'shot', referenceImageId: 'start.png',
    clipReferenceIds: ['ref-a'], prompt: 'A rider turns' }],
  visualSpec: { references: [{ id: 'ref-a', imageId: 'a.png', role: 'character' }, { id: 'ref-b', imageId: 'b.png', role: 'character' }] } };
  m.references.mockReset().mockImplementation(async (_tag, _limit, { project }) => project.scenes[0].clipReferenceIds
    .map((id) => ({ path: `/gallery/${id === 'ref-a' ? 'a' : 'b'}.png`, promptLabel: project.label || 'Rider' })));
});

describe('LTX clip reference snapshot', () => {
  it('rejects a selection changed after the reference files were prepared', async () => {
    m.project.scenes[0].clipReferenceIds = ['ref-b'];
    await expect(applyMusicVideoSubmissionGuards(request())).rejects.toMatchObject({ code: 'MUSIC_VIDEO_CLIP_REFERENCES_CHANGED' });
    expect(m.references).toHaveBeenCalledWith(tag, 8, { project: m.project, excludePath: '/gallery/start.png', includePromptLabels: true });
  });

  it('rejects labels changed after the shot prompt was built', async () => {
    m.project.label = 'Another rider';
    await expect(applyMusicVideoSubmissionGuards(request())).rejects.toMatchObject({ code: 'MUSIC_VIDEO_CLIP_REFERENCES_CHANGED' });
  });

  it('builds reference labels for a tagged caller without a client snapshot', async () => {
    const input = request();
    input.body.musicVideo = { projectId: 'project', sceneId: 'shot', compose: true, promptAsTyped: true };
    input.params.prompt = 'A rider turns';
    await applyMusicVideoSubmissionGuards(input);
    expect(input.params.prompt).toBe('Reference sheet: Rider.\n\nGenerated video: A rider turns');
  });

  it('still rejects changed reference files when the label snapshot is omitted', async () => {
    const input = request();
    input.body.musicVideo = { projectId: 'project', sceneId: 'shot' };
    m.project.scenes[0].clipReferenceIds = ['ref-b'];
    await expect(applyMusicVideoSubmissionGuards(input)).rejects.toMatchObject({ code: 'MUSIC_VIDEO_CLIP_REFERENCES_CHANGED' });
  });

  it('records the same snapshot that resolved the actual files', async () => {
    const input = request();
    await applyMusicVideoSubmissionGuards(input);
    expect(input.params.musicVideoDependencies.references).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'clipReferences', untrackedCastGuides: false }),
    ]));
  });
});
