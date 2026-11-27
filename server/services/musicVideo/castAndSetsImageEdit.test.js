import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveGalleryImage } from '../../lib/pathSafety.js';
import { acceptCastSetsImageEdit, discardCastSetsImageEdit, previewCastSetsImageEdit,
  requestCastSetsImageEdit, settleCastSetsImageEdit } from './castAndSetsImageEdit.js';
import { getProject, mutateProjectRecord } from './projects.js';

vi.mock('./projects.js', () => ({ getProject: vi.fn(), mutateProjectRecord: vi.fn() }));
vi.mock('./castAndSets.js', () => ({ CAST_SETS_MAX_KEY_NOTES: 8, CAST_SETS_MAX_IMAGE_HISTORY: 20 }));
vi.mock('../../lib/pathSafety.js', async (importOriginal) => ({
  ...(await importOriginal()), resolveGalleryImage: vi.fn(),
}));

const projectId = 'project-1';
const input = { key: 'character', revision: 3, imageId: 'source.png', instruction: 'Remove the lantern' };
const modelInput = { sentPrompt: 'Remove the lantern only', promptAdditions: [{ id: 'edit', label: 'Edit', text: 'Preserve the rest' }] };
const stage = () => ({
  revision: input.revision, status: 'approved', route: { mode: 'codex' }, approvedAt: '2026-01-01T00:00:00.000Z',
  plan: { character: { label: 'Character', prompt: 'A figure with a lantern' } },
  images: { character: { status: 'done', imageId: input.imageId, jobId: 'source-job', inspection: { verdict: 'pass' } } },
});
let project;
let deps;
const request = () => requestCastSetsImageEdit(projectId, input, deps);
const image = () => project.castAndSets.images.character;
const decision = () => ({ key: input.key, requestId: image().edit.requestId });
const settle = (overrides = {}) => settleCastSetsImageEdit({
  projectId, key: input.key, editRequestId: image().edit?.requestId, jobId: 'edit-job', filename: 'edit.png', ...overrides,
}, deps.publish);

beforeEach(() => {
  vi.resetAllMocks();
  project = { id: projectId, castAndSets: stage() };
  getProject.mockImplementation(async () => project);
  mutateProjectRecord.mockImplementation(async (_id, update) => {
    const result = update(project);
    project = result.project;
    return result;
  });
  resolveGalleryImage.mockImplementation((file) => file === 'missing.png' ? null : `/example/gallery/${file}`);
  deps = {
    processId: 'process-1',
    getSettings: vi.fn(async () => ({})),
    imageParams: vi.fn(async (_settings, _route, params) => params),
    previewPrompt: vi.fn(async () => modelInput),
    enqueue: vi.fn(async () => ({ jobId: 'edit-job' })),
    publish: vi.fn(),
  };
});

describe('Cast & Sets image edits', () => {
  it('previews the saved source as the sole edit input without writing or queueing', async () => {
    expect(await previewCastSetsImageEdit(projectId, input, deps)).toEqual(modelInput);
    expect(deps.previewPrompt).toHaveBeenCalledWith({
      settings: {}, mode: 'codex', params: expect.objectContaining({
        initImagePath: '/example/gallery/source.png', initImageStrength: 0.15, prompt: expect.stringContaining(input.instruction),
        musicVideo: { projectId, castAndSets: { key: input.key, revision: input.revision, editRequestId: expect.any(String) } },
      }),
    });
    expect(mutateProjectRecord).not.toHaveBeenCalled();
    expect(deps.enqueue).not.toHaveBeenCalled();
  });

  it('reserves, settles and accepts the candidate with its exact prompt and source provenance', async () => {
    await request();
    const { requestId } = decision();
    expect(deps.enqueue).toHaveBeenCalledWith(expect.objectContaining({ kind: 'image', params: expect.objectContaining({
      musicVideo: { projectId, castAndSets: { key: input.key, revision: input.revision, editRequestId: requestId } },
    }) }));
    expect(deps.publish.mock.calls[0][1].castAndSets.images.character.edit).toMatchObject({ status: 'queued', jobId: null });
    expect(image()).toMatchObject({ imageId: input.imageId, edit: { jobId: 'edit-job', status: 'queued', modelInput } });
    await expect(acceptCastSetsImageEdit(projectId, decision(), deps.processId)).rejects.toMatchObject({ code: 'CAST_SETS_EDIT_STALE' });

    expect(await settle()).toBe(true);
    expect(image()).toMatchObject({ imageId: input.imageId, edit: { imageId: 'edit.png', status: 'done' } });
    const accepted = await acceptCastSetsImageEdit(projectId, decision(), deps.processId);
    expect(accepted.stage).toMatchObject({ revision: 4, status: 'imaging', manualImageEditReview: true, approvedAt: null,
      keyNotes: { character: [input.instruction] } });
    expect(image()).toMatchObject({ imageId: 'edit.png', edit: null, inspection: null, history: [input.imageId],
      submittedRevision: 4, submittedPrompt: modelInput.sentPrompt, promptAdditions: modelInput.promptAdditions,
      submittedReferences: [{ kind: 'image', filename: input.imageId }] });
  });

  it('refuses to reserve an edit when the saved prompt changes during preview at the same revision', async () => {
    deps.previewPrompt.mockImplementationOnce(async () => {
      const current = project.castAndSets;
      project = { ...project, castAndSets: { ...current, plan: {
        character: { ...current.plan.character, prompt: 'A different figure' },
      } } };
      return modelInput;
    });
    await expect(request()).rejects.toMatchObject({ status: 409, code: 'CAST_SETS_EDIT_STALE' });
    expect(image().edit).toBeUndefined();
    expect(deps.enqueue).not.toHaveBeenCalled();
    expect(deps.publish).not.toHaveBeenCalled();
  });

  it('keeps a queue refusal separate from the saved image', async () => {
    deps.enqueue.mockRejectedValueOnce(new Error('Queue closed'));
    await request();
    expect(image()).toMatchObject({ imageId: input.imageId, status: 'done',
      edit: { status: 'failed', jobId: null, imageId: null, error: expect.stringContaining('could not be queued') } });
  });

  it('ignores a mismatched job and a completion after discard', async () => {
    await request();
    const { requestId } = decision();
    deps.publish.mockClear();
    expect(await settle({ jobId: 'another-job' })).toBe(false);
    expect(deps.publish).not.toHaveBeenCalled();
    expect(image().edit.status).toBe('queued');

    await discardCastSetsImageEdit(projectId, decision(), deps.publish);
    expect(await settle({ editRequestId: requestId })).toBe(false);
    expect(image()).toMatchObject({ imageId: input.imageId, edit: null });
    expect(deps.publish).toHaveBeenCalledExactlyOnceWith(projectId, project);
  });

  it('marks missing output as failed without changing saved inspection evidence', async () => {
    await request();
    expect(await settle({ filename: 'missing.png' })).toBe(true);
    expect(image()).toMatchObject({ imageId: input.imageId, inspection: { verdict: 'pass' },
      edit: { status: 'failed', imageId: null } });
  });
});
