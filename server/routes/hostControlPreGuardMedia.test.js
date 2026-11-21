import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import sharp from 'sharp';
import { expectAuthorizedWorkflows } from './hostControlTestHarness.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/paths.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-pre-guard-media-') }));
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-pre-guard-media-') }));
afterAll(cleanupTempDataRoots);

// Every write here is gated by the default-deny policy (#16018); the refusal and
// principal matrix live in services/authGate.test.js and server/test/guards/modules/hostControlCoverage.test.js.
// This suite proves each mounted media router still runs behind the real gates
// for a local operator and a delegated agent session. Host-process services are doubled.
const auth = vi.hoisted(() => ({ enabled: false }));
const effects = vi.hoisted(() => ({
  codeExport: vi.fn(async () => ({ status: 'queued' })),
  enqueue: vi.fn(async () => ({ jobId: 'example-job' })),
  resumeHold: vi.fn(async () => true),
  pull: vi.fn(async () => ({})),
  collage: vi.fn(async () => ({ filename: 'example-collage.png' })),
  postprocess: vi.fn(async () => ({ ok: true })),
  videoPoster: vi.fn(async () => ({ id: 'example-video' })),
  gpuClean: vi.fn(async () => ({ jobId: '22222222-2222-4222-8222-222222222222', modelId: 'example-model', strength: 0.3 })),
}));
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(), getSettings: vi.fn(async () => ({})),
}));
vi.mock('../services/codeAnimation/export.js', () => ({ startCodeAnimationExport: effects.codeExport }));
vi.mock('../services/mediaJobQueue/index.js', () => ({
  enqueueJob: effects.enqueue, resumeVideoHold: effects.resumeHold,
  attachSseClient: vi.fn(), cancelJob: vi.fn(), listJobs: vi.fn(() => []), listQueueJobs: vi.fn(() => []),
  getJob: vi.fn(() => null), cancelQueuedJobs: vi.fn(), removeArchivedJob: vi.fn(), runJobNow: vi.fn(),
  listVideoHolds: vi.fn(() => []),
  JOB_KINDS: ['image', 'video'], JOB_STATUSES: ['queued', 'running', 'completed', 'failed', 'canceled'],
  MEDIA_QUEUE_SHUTTING_DOWN: 'MEDIA_QUEUE_SHUTTING_DOWN',
}));
vi.mock('../services/mediaCollections.js', async (importOriginal) => ({
  ...await importOriginal(),
  getCollection: vi.fn(async (id) => ({ id, items: [{ kind: 'video', ref: 'example-video' }] })),
}));
vi.mock('../services/peerHostedMedia.js', () => ({
  resolveMediaLocations: vi.fn(async (items) => items.map((item) => ({ location: 'remote', hostPeerId: 'example-peer', filename: `${item.ref}.mp4` }))),
  findHostPeer: vi.fn(async (id) => ({ id })),
  unmarkHosted: vi.fn(),
}));
vi.mock('../services/sharing/peerSyncAssets.js', () => ({
  pullMissingAssetsFromPeer: effects.pull,
}));
vi.mock('../services/moodBoard/index.js', () => ({ composeBoardCollage: effects.collage }));
vi.mock('../services/sprites/walk.js', () => ({ rerunWalkPostprocess: effects.postprocess }));
vi.mock('../services/videoGen/poster.js', () => ({ updateVideoPoster: effects.videoPoster }));
vi.mock('../services/imageGen/cleanGpu.js', () => ({
  enqueueGpuClean: effects.gpuClean,
  readGpuCleanResult: vi.fn(), getGpuCleanStatus: vi.fn(), saveGpuCleanToGallery: vi.fn(),
}));
vi.mock('../services/videoGen/local.js', () => ({ BYOV_RUNTIME_INFO: {}, getHistoryItem: vi.fn() }));
vi.mock('../services/videoGen/batch.js', () => ({ MAX_VIDEO_BATCH_SIZE: 8 }));
vi.mock('../services/videoGen/prepareParams.js', () => ({ cleanupMultipartTemp: vi.fn(), validateVideoRetryParams: vi.fn() }));
vi.mock('../services/userActions.js', () => ({ recordUserAction: vi.fn() }));
// Service graphs the mounted routers import; their handlers are not reached.
vi.mock('../services/codeAnimation/index.js', () => ({}));
vi.mock('../services/codeAnimation/stages.js', () => ({}));
vi.mock('../services/codeAnimation/soundtrack.js', () => ({}));
vi.mock('../services/codeAnimation/soundAssets.js', () => ({}));
vi.mock('../services/codeAnimation/preflight.js', () => ({}));
vi.mock('../services/codeAnimation/package.js', () => ({}));
vi.mock('../services/codeAnimation/projects.js', () => ({}));
vi.mock('../services/mediaPromptRefiner.js', () => ({}));
vi.mock('../services/mediaPromptHistory.js', () => ({}));
vi.mock('../services/mediaPromptFromMedia.js', () => ({}));
vi.mock('../services/moodBoardStyleSynthesis.js', () => ({}));
vi.mock('../services/moodBoardCompositeStyle.js', () => ({}));
vi.mock('../services/moodBoard/analyzeJob.js', () => ({}));
vi.mock('../services/moodBoard/generateMore.js', () => ({}));
vi.mock('../services/sprites/walkTrims.js', () => ({}));
vi.mock('../services/sprites/records.js', () => ({}));
vi.mock('../services/sprites/importer.js', () => ({}));
vi.mock('../services/sprites/reference.js', () => ({}));
vi.mock('../services/sprites/assetPrompt.js', () => ({}));
vi.mock('../services/sprites/localAnimationRender.js', () => ({}));
vi.mock('../services/sprites/animationTrackWorkflow.js', () => ({}));
vi.mock('../services/sprites/animationTrackCrud.js', () => ({}));
vi.mock('../services/sprites/atlas.js', () => ({}));
vi.mock('../services/sprites/publish.js', () => ({}));
vi.mock('../services/sprites/assets.js', () => ({}));
vi.mock('../services/videoUpload.js', () => ({}));
vi.mock('../services/videoGen/runtimeInstaller.js', () => ({}));
vi.mock('../services/videoGen/upscaleJob.js', () => ({}));
vi.mock('../services/videoGen/trim.js', () => ({}));
vi.mock('../services/videoGen/submitJob.js', () => ({}));
vi.mock('../services/videoGen/reactor.js', () => ({}));
vi.mock('../services/videoGen/modelCache.js', () => ({}));
vi.mock('../services/videoGen/displayPower.js', () => ({}));
vi.mock('../services/hfDownloadStream.js', () => ({}));

const mounts = [
  ['/api/code-animation', (await import('./codeAnimation.js')).default],
  ['/api/html-composition', (await import('./htmlComposition.js')).default],
  ['/api/image-clean', (await import('./imageClean.js')).default],
  ['/api/media-jobs', (await import('./mediaJobs.js')).default],
  ['/api/media/collections', (await import('./mediaCollections.js')).default],
  ['/api/mood-boards', (await import('./moodBoard.js')).default],
  ['/api/sprites', (await import('./sprites.js')).default],
  ['/api/video-gen', (await import('./videoGen.js')).default],
];

const id = '00000000-0000-4000-8000-000000000001';
const png = await sharp({ create: { width: 64, height: 64, channels: 3, background: { r: 200, g: 100, b: 50 } } }).png().toBuffer();
// One write per router: [method, path, body, effect, success status].
const workflows = [
  ['post', `/api/code-animation/${id}/export`, {}, effects.codeExport, 202],
  ['post', '/api/html-composition/render', { directory: 'compositions/example' }, effects.enqueue, 202],
  ['post', '/api/image-clean?diffusion=gpu', png, effects.gpuClean, 202],
  ['post', `/api/media-jobs/holds/${id}/resume`, {}, effects.resumeHold, 200],
  ['post', '/api/media/collections/example-collection/localize', {}, effects.pull, 202],
  ['post', '/api/mood-boards/example-board/collage', {}, effects.collage, 200],
  ['post', '/api/sprites/example-sprite/walk/postprocess', { runId: 'walk-south-0123abcd' }, effects.postprocess, 200],
  ['patch', `/api/video-gen/history/${id}/poster`, { atSec: 1.5 }, effects.videoPoster, 200],
];

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
});

describe('media routers behind the default-deny gate (#16114)', () => {
  it('still run for a local operator and a delegated agent session', async () => {
    await expectAuthorizedWorkflows({ auth, mounts, workflows });
    expect(effects.enqueue).toHaveBeenLastCalledWith({ kind: 'html-composition', params: { directory: 'compositions/example' } });
    expect(effects.pull).toHaveBeenLastCalledWith('example-peer', [{ kind: 'video', filename: 'example-video.mp4' }], { includeMismatched: false });
    expect(effects.videoPoster).toHaveBeenLastCalledWith(id, 1.5);
  });
});
