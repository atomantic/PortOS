import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, expect, it as vitestIt, vi } from 'vitest';
import { ServerError } from '../../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, ownTestBodies } from '../../lib/mockPathsDataRoot.js';
import { loadMediaRuntimeModule } from '../bootHookRegistry.js';
import { attachGeneratedMedia } from '../catalog/catalogDB.js';
import { catalogEvents } from '../catalog/catalogEvents.js';
import { assertCatalogIdentityWritable } from '../catalogDB/identityAccess.js';
import { attachNodeImage } from '../fableLoom/records.js';
import { prepareRemoteMediaJob } from '../federatedMedia/remoteSubmission.js';
import { enqueueJob } from '../mediaJobQueue/index.js';
import { assertCatalogRenderParams } from '../musicVideo/clipCastReferences.js';
import { assertRevisionOpen } from '../musicVideo/revisionService.js';
import { fileIntoMusicVideoCollection } from '../musicVideoCollectionHook.js';
import { fileIntoRequestedCollection } from '../requestedCollectionHook.js';
import { recordUserAction } from '../userActions.js';
import { finishVisualProfileImage } from './finishVisualProfile.js';
import { generateImage } from './index.js';
import { prepareGenerateParams, quickEditCompositionDigest, resolveLocalImageModel } from './prepareParams.js';
import { previewQuickImageEdit } from './promptPreview.js';
import { reviewedReferenceDigest } from './reviewedReference.js';
import { executeImageGenerate } from './submitJob.js';

vi.mock('../bootHookRegistry.js', () => ({ loadMediaRuntimeModule: vi.fn() }));
vi.mock('../catalog/catalogDB.js', () => ({ attachGeneratedMedia: vi.fn() }));
vi.mock('../catalog/catalogEvents.js', () => ({ catalogEvents: { emit: vi.fn() } }));
vi.mock('../catalogDB/identityAccess.js', () => ({ assertCatalogIdentityWritable: vi.fn() }));
vi.mock('../fableLoom/records.js', () => ({ attachNodeImage: vi.fn() }));
vi.mock('../federatedMedia/remoteSubmission.js', () => ({ prepareRemoteMediaJob: vi.fn() }));
vi.mock('../mediaJobQueue/index.js', () => ({ enqueueJob: vi.fn() }));
vi.mock('../musicVideo/clipCastReferences.js', () => ({ assertCatalogRenderParams: vi.fn() }));
vi.mock('../musicVideo/revisionService.js', () => ({ assertRevisionOpen: vi.fn() }));
vi.mock('../musicVideoCollectionHook.js', () => ({ fileIntoMusicVideoCollection: vi.fn() }));
vi.mock('../requestedCollectionHook.js', () => ({ fileIntoRequestedCollection: vi.fn() }));
vi.mock('../universeRunTag.js', () => ({ buildUniverseRunTag: vi.fn() }));
vi.mock('../userActions.js', () => ({ recordUserAction: vi.fn() }));
vi.mock('./fableLoomParams.js', () => ({ prepareFableLoomImageParams: vi.fn() }));
vi.mock('./finishVisualProfile.js', () => ({ finishVisualProfileImage: vi.fn() }));
vi.mock('./index.js', () => ({ generateImage: vi.fn() }));
vi.mock('./prepareParams.js', () => ({
  prepareGenerateParams: vi.fn(), quickEditCompositionDigest: vi.fn(), resolveLocalImageModel: vi.fn(),
}));
vi.mock('./promptPreview.js', () => ({ previewQuickImageEdit: vi.fn() }));

const { it, drain } = ownTestBodies(vitestIt);
const queued = { jobId: 'image-job', position: 2, status: 'queued' };
const queuedBody = {
  ...queued, generationId: queued.jobId, filename: 'image-job.png', path: '/data/images/image-job.png',
};
const revision = { projectId: 'project', revisionId: 'revision', sceneId: 'scene' };
const revisionError = new ServerError('Revision is closed', { code: 'REVISION_CLOSED', status: 409 });

function prepare(mode, params = {}, options = {}) {
  prepareGenerateParams.mockResolvedValue({
    mode, data: { prompt: 'A synthetic landscape', ...params },
    settings: {}, uploadedTempPaths: [], ...options,
  });
}

async function writeInput(name, bytes) {
  const path = join(lazyTempDataRoot('portos-image-submit-'), name);
  await writeFile(path, bytes);
  return path;
}

beforeEach(() => {
  vi.resetAllMocks();
  enqueueJob.mockResolvedValue(queued);
  resolveLocalImageModel.mockReturnValue({ selectedModel: { id: 'local-model' }, pythonPath: 'python3' });
  attachGeneratedMedia.mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  try {
    await drain();
  } finally {
    cleanupTempDataRoots();
  }
});

it('queues the local lane with the resolved model and records only a job pointer', async () => {
  const upload = 'upload.tmp';
  prepare('local', {}, { uploadedTempPaths: [upload] });

  const { body, uploadedTempPaths } = await executeImageGenerate({}, {}, { source: 'image-gen' });

  expect(body).toEqual({ ...queuedBody, mode: 'local', model: 'local-model', mediaProviderPeerId: null });
  expect(uploadedTempPaths).toEqual([upload]);
  expect(enqueueJob).toHaveBeenCalledExactlyOnceWith({
    kind: 'image', params: { prompt: 'A synthetic landscape', pythonPath: 'python3', modelId: 'local-model' },
  });
  expect(recordUserAction).toHaveBeenCalledExactlyOnceWith({
    type: 'media.image.enqueue', actor: 'user', target: queued.jobId, summary: 'enqueued image job',
    payload: { jobId: queued.jobId }, source: 'image-gen', happenedAt: expect.any(String),
    dedupeKey: `media.image.enqueue:${queued.jobId}`,
  });
  expect(generateImage).not.toHaveBeenCalled();
});

it('queues cloud work with the effective model and its provenance', async () => {
  prepare('codex', { cloudModel: 'chosen-model', cloudModelIsShippedDefault: true }, {
    settings: { imageGen: { codex: { enabled: true, model: 'configured-model', effort: 'medium' } } },
  });

  const { body } = await executeImageGenerate({});

  expect(body).toEqual({ ...queuedBody, mode: 'codex', model: 'chosen-model', mediaProviderPeerId: null });
  expect(enqueueJob).toHaveBeenCalledExactlyOnceWith({
    kind: 'image',
    params: {
      mode: 'codex', model: 'chosen-model', modelIsShippedDefault: true,
      effort: 'medium', prompt: 'A synthetic landscape',
    },
  });
  expect(resolveLocalImageModel).not.toHaveBeenCalled();
  expect(generateImage).not.toHaveBeenCalled();
});

it('refuses a disabled cloud provider before queueing', async () => {
  prepare('codex');
  await expect(executeImageGenerate({})).rejects.toMatchObject({ code: 'CODEX_IMAGEGEN_DISABLED' });
  expect(enqueueJob).not.toHaveBeenCalled();
  expect(generateImage).not.toHaveBeenCalled();
});

it('projects a federated request and queues the marker with destination tags and without local routing fields', async () => {
  const remoteMedia = { peerId: 'private-peer', requestVersion: 1 };
  const reference = 'staged-reference.png';
  const writersRoom = { projectId: 'writing-project' };
  prepareRemoteMediaJob.mockResolvedValue({ peer: { id: 'private-peer' }, remoteMedia });
  prepare('codex', {
    mediaProviderPeerId: 'private-peer', mediaProviderEngine: 'local', modelId: 'peer-model',
    mode: 'codex', cloudModel: 'local-cloud-model', cloudModelIsShippedDefault: true,
    width: 512, height: 768, guidanceScale: 3, referenceImagePaths: [reference], writersRoom,
    catalogIngredientId: 'ingredient', catalogMediaKind: 'concept',
  });

  const { body } = await executeImageGenerate({ catalogIngredientId: 'ingredient' });

  expect(body).toEqual({ ...queuedBody, mode: null, model: 'peer-model', mediaProviderPeerId: 'private-peer' });
  expect(prepareRemoteMediaJob).toHaveBeenCalledExactlyOnceWith({
    peerId: 'private-peer', kind: 'image',
    request: {
      kind: 'image', engine: 'local', modelId: 'peer-model', prompt: 'A synthetic landscape',
      width: 512, height: 768, guidance: 3,
    },
    inputAssets: [{ role: 'referenceImages', path: reference }],
  });
  expect(enqueueJob).toHaveBeenCalledExactlyOnceWith({
    kind: 'image',
    params: {
      modelId: 'peer-model', prompt: 'A synthetic landscape', width: 512, height: 768,
      guidanceScale: 3, referenceImagePaths: [reference], writersRoom,
      catalogAttach: { ingredientId: 'ingredient', kind: 'concept' }, remoteMedia,
    },
  });
  expect(assertCatalogIdentityWritable).toHaveBeenCalledExactlyOnceWith('ingredient');
  expect(resolveLocalImageModel).not.toHaveBeenCalled();
  expect(generateImage).not.toHaveBeenCalled();
});

vitestIt.each([
  [{ loraFilenames: ['style.safetensors'], modelId: 'peer-model' }, 'MEDIA_PROVIDER_INPUT_UNSUPPORTED'],
  [{ loraPaths: ['style.safetensors'], modelId: 'peer-model' }, 'MEDIA_PROVIDER_INPUT_UNSUPPORTED'],
  [{}, 'MEDIA_PROVIDER_MODEL_REQUIRED'],
])('refuses unsupported federated inputs %j', async (params, code) => {
  prepare('local', { mediaProviderPeerId: 'private-peer', ...params });
  await expect(executeImageGenerate({})).rejects.toMatchObject({ status: 400, code });
  expect(prepareRemoteMediaJob).not.toHaveBeenCalled();
  expect(enqueueJob).not.toHaveBeenCalled();
});

vitestIt.each([
  { reviewedPromptDigest: 'latest-prompt' },
  { reviewedPromptDigest: 'old-prompt', reviewedReferenceDigest: 'reviewed-image' },
])('requires current prompt and reference review before a quick edit', async review => {
  prepare('local');
  quickEditCompositionDigest.mockResolvedValue('latest-prompt');

  await expect(executeImageGenerate({ quickEdit: true, ...review })).rejects.toMatchObject({
    status: 409, code: 'REVIEWED_PROMPT_CHANGED',
  });
  expect(previewQuickImageEdit).not.toHaveBeenCalled();
  expect(enqueueJob).not.toHaveBeenCalled();
});

vitestIt.each([
  ['local', { initImagePath: 'init.png', referenceImagePaths: ['reference.png'] }],
  ['local', { referenceImagePaths: [] }],
  ['local', { referenceImagePaths: ['first.png', 'second.png'] }],
  ['external', { referenceImagePaths: ['reference.png'] }],
])('rejects incompatible reviewed references for %s with %j', async (mode, params) => {
  prepare(mode, params);

  await expect(executeImageGenerate({ reviewedReferenceDigest: 'a'.repeat(64) })).rejects.toMatchObject({
    status: 400, code: 'REVIEWED_REFERENCE_UNSUPPORTED',
  });
  expect(enqueueJob).not.toHaveBeenCalled();
  expect(generateImage).not.toHaveBeenCalled();
});

it('binds the reviewed prompt and the first reference bytes, even with an additional reference', async () => {
  const first = await writeInput('edited.png', 'reviewed image bytes');
  const additional = await writeInput('additional.png', 'other image bytes');
  const data = {
    quickEdit: true, reviewedPromptDigest: 'current-prompt', reviewedReferenceDigest: await reviewedReferenceDigest(first),
  };
  quickEditCompositionDigest.mockResolvedValue(data.reviewedPromptDigest);
  previewQuickImageEdit.mockResolvedValue({ sentPrompt: 'The full reviewed edit prompt' });
  const params = { referenceImagePaths: [first, additional] };

  prepare('local', params);
  await executeImageGenerate(data);
  expect(enqueueJob.mock.calls[0][0].params).toMatchObject({
    ...params, reviewedReferenceDigest: data.reviewedReferenceDigest, sentPrompt: 'The full reviewed edit prompt',
  });

  enqueueJob.mockClear();
  await writeFile(first, 'replacement image bytes');
  prepare('local', params);
  await expect(executeImageGenerate(data)).rejects.toMatchObject({ status: 409, code: 'REVIEWED_REFERENCE_CHANGED' });
  expect(enqueueJob).not.toHaveBeenCalled();
});

vitestIt.each(['local', 'external'])('checks the revision before %s dispatch', async mode => {
  assertRevisionOpen.mockRejectedValue(revisionError);
  prepare(mode, { musicVideo: revision });

  await expect(executeImageGenerate({})).rejects.toBe(revisionError);
  expect(assertRevisionOpen).toHaveBeenCalledExactlyOnceWith('project', 'revision', { sceneId: 'scene', kind: 'image' });
  expect(enqueueJob).not.toHaveBeenCalled();
  expect(generateImage).not.toHaveBeenCalled();
});

it('checks current catalog conditioning before a synchronous render', async () => {
  const failure = new Error('Conditioning changed');
  assertCatalogRenderParams.mockRejectedValue(failure);
  prepare('external', { musicVideo: revision });

  await expect(executeImageGenerate({})).rejects.toBe(failure);
  expect(assertRevisionOpen).toHaveBeenCalledBefore(assertCatalogRenderParams);
  expect(generateImage).not.toHaveBeenCalled();
});

it('rolls back staged references and uploads after enqueue fails, preserving the original error', async () => {
  const staged = await writeInput('staged.png', 'staged bytes');
  const upload = await writeInput('upload.tmp', 'upload bytes');
  const absent = join(lazyTempDataRoot('portos-image-submit-'), 'already-removed.tmp');
  const failure = new Error('Queue unavailable');
  enqueueJob.mockRejectedValue(failure);
  prepare('local', {}, { stagedRefPaths: [staged], uploadedTempPaths: [absent, upload] });

  await expect(executeImageGenerate({})).rejects.toBe(failure);
  await expect(readFile(staged)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(upload)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(recordUserAction).not.toHaveBeenCalled();
});

it('returns an already queued job when action logging fails', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  recordUserAction.mockRejectedValue(new Error('History unavailable'));
  prepare('local');

  await expect(executeImageGenerate({})).resolves.toMatchObject({ body: queuedBody });
  expect(error).toHaveBeenCalledWith(expect.stringContaining('History unavailable'));
});

it('uses the finished synchronous image for filing, attachments, and requested verification', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const raw = { filename: 'raw.png', generationId: 'raw-render' };
  const finished = { filename: 'finished.png', generationId: 'finished-render' };
  const verifyImageAsync = vi.fn();
  const visualProfile = { id: 'profile' };
  const visualConditioning = { reference: 'style.png' };
  generateImage.mockResolvedValue(raw);
  finishVisualProfileImage.mockResolvedValue(finished);
  fileIntoRequestedCollection.mockRejectedValue(new Error('Collection unavailable'));
  loadMediaRuntimeModule.mockResolvedValue({ verifyImageAsync });
  prepare('external', {
    visualProfile, visualConditioning, musicVideo: revision, musicVideoProjectId: 'project',
    collectionName: 'Test collection', fableLoom: { loomId: 'loom', episodeId: 'episode', nodeId: 'node' },
    catalogIngredientId: 'ingredient', verifyImage: true,
  });

  const { body } = await executeImageGenerate({ catalogIngredientId: 'ingredient' });

  expect(body).toEqual(finished);
  expect(assertCatalogRenderParams).toHaveBeenCalledBefore(generateImage);
  expect(finishVisualProfileImage).toHaveBeenCalledExactlyOnceWith({
    result: raw, profile: visualProfile, signal: expect.any(AbortSignal),
  });
  const item = { kind: 'image', ref: finished.filename };
  expect(fileIntoMusicVideoCollection).toHaveBeenCalledExactlyOnceWith('project', [item]);
  expect(fileIntoRequestedCollection).toHaveBeenCalledExactlyOnceWith('Test collection', item);
  expect(attachNodeImage).toHaveBeenCalledExactlyOnceWith('loom', 'episode', 'node', {
    filename: finished.filename, jobId: finished.generationId, visualConditioning,
  });
  expect(attachGeneratedMedia).toHaveBeenCalledExactlyOnceWith('ingredient', finished.filename, { kind: 'reference' });
  expect(catalogEvents.emit).toHaveBeenCalledExactlyOnceWith('primitive-changed', { ingredientId: 'ingredient' });
  expect(loadMediaRuntimeModule).toHaveBeenCalledExactlyOnceWith('imageVerifier');
  expect(verifyImageAsync).toHaveBeenCalledExactlyOnceWith(finished.filename, {
    prompt: 'A synthetic landscape', isImport: false,
  });
  expect(error).toHaveBeenCalledWith(expect.stringContaining('Collection unavailable'));
  expect(enqueueJob).not.toHaveBeenCalled();
});

it('keeps render inputs when an attachment fails after a successful synchronous render', async () => {
  const reference = await writeInput('render-reference.png', 'retained reference');
  const failure = new Error('Attachment failed');
  generateImage.mockResolvedValue({ filename: 'rendered.png' });
  fileIntoMusicVideoCollection.mockRejectedValue(failure);
  prepare('external', {
    referenceImagePaths: [reference], musicVideoProjectId: 'project',
  }, { stagedRefPaths: [reference] });

  await expect(executeImageGenerate({})).rejects.toBe(failure);
  await expect(readFile(reference, 'utf8')).resolves.toBe('retained reference');
  expect(loadMediaRuntimeModule).not.toHaveBeenCalled();
});
