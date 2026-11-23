import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { request } from '../lib/testHelper.js';
import { expectAuthorizedWorkflows, expectRemoteRefusal, hostControlApp, REMOTE_ADDRESS } from './hostControlTestHarness.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-mv-pre-guard-') }));
afterAll(cleanupTempDataRoots);

// Music Video routes the pre-guard audit moved behind operator authority
// (#13055): ffmpeg/ffprobe decodes, the headless-browser text check, Suno browser
// reads, retime/alignment jobs, image jobs and Cast & Sets releases, plus the
// automation brief and the sheet approval that steer unattended runs. Real
// router; each service sink is a spy. These are plain writes under the
// default-deny gate (#16018), whose principal matrix lives in
// services/authGate.test.js, so this suite keeps the authorized workflows.
const auth = vi.hoisted(() => ({ enabled: false }));
const effects = vi.hoisted(() => {
  const resolves = (value) => vi.fn(async () => value);
  const project = { id: 'example-project' };
  return {
    createProject: resolves(project),
    updateProject: resolves(project),
    analyzeProjectSong: resolves(project),
    analyzeAudioFileManual: resolves({ bpm: 120, sections: [], durationSec: 10 }),
    applyAudioTiming: resolves({ project }),
    previewAudioTiming: resolves({ preview: [] }),
    approveCastAndSets: resolves({ status: 'approved' }),
    skipCastAndSets: resolves({ status: 'skipped' }),
    acceptMixedMediaDocument: resolves({ project }),
    importDocumentZip: resolves({ project }),
    checkOverlayTextInBackground: vi.fn(),
    startDependencyRepair: resolves({ project }),
    getDependencyImpact: resolves({ shots: [], evidence: [] }),
    reviewArtifact: resolves({ project }),
    prepareProductionReview: resolves({ project }),
    renderProductionProof: resolves({ jobId: 'example-job' }),
    startOverlayTextCheck: resolves({ project: {}, readiness: {} }),
    paintYoutubeThumbnail: resolves({ project: {} }),
    resumeRevision: resolves({ project }),
    continueFromPreviousShot: resolves({ project }),
    startPerformanceRepair: resolves({ project }),
    prepareSharingCopy: resolves({ jobId: 'example-job' }),
    selectSongRevision: resolves({ project }),
    reviseSongFromTrack: resolves({ project }),
    refreshSongStyleFromSuno: resolves({ project }),
    autoPrepareSong: resolves({ project }),
    // The real parser streams the stem to a temp file the service would adopt.
    attachVocalStem: vi.fn(async (_id, { tempPath }) => {
      const { rm } = await import('node:fs/promises');
      await rm(tempPath, { force: true });
      return project;
    }),
  };
});

vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
  getSettings: vi.fn(async () => ({})),
  updateSettingsWith: vi.fn(async (mutate) => mutate({})),
}));
vi.mock('../services/instanceIdentity.js', () => ({
  ensureInstanceId: vi.fn(async () => 'example-self'),
  loadData: vi.fn(async () => ({ peers: [] })),
}));
vi.mock('../services/musicVideo/projects.js', async (importOriginal) => ({
  ...await importOriginal(),
  createProject: effects.createProject,
  updateProject: effects.updateProject,
  setProjectAnalysis: vi.fn(async () => ({ id: 'example-project' })),
}));
vi.mock('../services/musicVideo/projectFilmActions.js', async (importOriginal) => ({
  ...await importOriginal(),
  refreshSongStyleFromSuno: effects.refreshSongStyleFromSuno,
}));
vi.mock('../services/musicVideo/requireProject.js', async (importOriginal) => ({
  ...await importOriginal(),
  // No cached analysis, so manual analysis takes the ffmpeg decode path.
  requireProject: vi.fn(async (id) => ({ id, audioAnalysis: null })),
}));
vi.mock('../services/musicVideo/projectAudio.js', async (importOriginal) => ({
  ...await importOriginal(),
  analyzeProjectSong: effects.analyzeProjectSong,
  resolveProjectAudioPath: vi.fn(async () => 'example.mp3'),
}));
vi.mock('../services/musicVideo/audioAnalysis.js', async (importOriginal) => ({
  ...await importOriginal(),
  analyzeAudioFileManual: effects.analyzeAudioFileManual,
}));
vi.mock('../services/musicVideo/audioTiming.js', async (importOriginal) => ({
  ...await importOriginal(),
  applyAudioTiming: effects.applyAudioTiming,
  previewAudioTiming: effects.previewAudioTiming,
}));
vi.mock('../services/musicVideo/castAndSetsService.js', async (importOriginal) => ({
  ...await importOriginal(),
  approveCastAndSets: effects.approveCastAndSets,
  skipCastAndSets: effects.skipCastAndSets,
}));
vi.mock('../services/musicVideo/documentGeneration.js', async (importOriginal) => ({
  ...await importOriginal(),
  acceptMixedMediaDocument: effects.acceptMixedMediaDocument,
}));
vi.mock('../services/musicVideo/compositionDocument.js', async (importOriginal) => ({
  ...await importOriginal(),
  importDocumentZip: effects.importDocumentZip,
}));
vi.mock('../services/musicVideo/overlayTextService.js', async (importOriginal) => ({
  ...await importOriginal(),
  checkOverlayTextInBackground: effects.checkOverlayTextInBackground,
  startOverlayTextCheck: effects.startOverlayTextCheck,
}));
vi.mock('../services/musicVideo/revisionService.js', async (importOriginal) => ({
  ...await importOriginal(),
  startDependencyRepair: effects.startDependencyRepair,
  getDependencyImpact: effects.getDependencyImpact,
  resumeRevision: effects.resumeRevision,
}));
vi.mock('../services/musicVideo/devArtifactService.js', async (importOriginal) => ({
  ...await importOriginal(),
  reviewArtifact: effects.reviewArtifact,
}));
vi.mock('../services/musicVideo/productionReviewService.js', async (importOriginal) => ({
  ...await importOriginal(),
  prepareProductionReview: effects.prepareProductionReview,
  renderProductionProof: effects.renderProductionProof,
}));
vi.mock('../services/musicVideo/youtubeThumbnail.js', async (importOriginal) => ({
  ...await importOriginal(),
  paintYoutubeThumbnail: effects.paintYoutubeThumbnail,
}));
vi.mock('../services/musicVideo/continueShot.js', async (importOriginal) => ({
  ...await importOriginal(),
  continueFromPreviousShot: effects.continueFromPreviousShot,
}));
vi.mock('../services/musicVideo/performanceRepair.js', async (importOriginal) => ({
  ...await importOriginal(),
  startPerformanceRepair: effects.startPerformanceRepair,
}));
vi.mock('../services/musicVideo/sharingCopy.js', async (importOriginal) => ({
  ...await importOriginal(),
  prepareSharingCopy: effects.prepareSharingCopy,
}));
vi.mock('../services/musicVideo/songRevision.js', async (importOriginal) => ({
  ...await importOriginal(),
  selectSongRevision: effects.selectSongRevision,
  reviseSongFromTrack: effects.reviseSongFromTrack,
}));
vi.mock('../services/musicVideo/songAutoPrepare.js', async (importOriginal) => ({
  ...await importOriginal(),
  autoPrepareSong: effects.autoPrepareSong,
}));
vi.mock('../services/musicVideo/vocalStem.js', async (importOriginal) => ({
  ...await importOriginal(),
  attachVocalStem: effects.attachVocalStem,
}));

import musicVideoRoutes from './musicVideo.js';

const BOUNDARY = 'example-boundary';
const upload = (field, filename, type) => ({
  raw: Buffer.from([
    `--${BOUNDARY}`,
    `Content-Disposition: form-data; name="${field}"; filename="${filename}"`,
    `Content-Type: ${type}`,
    '',
    'example',
    `--${BOUNDARY}--`,
    '',
  ].join('\r\n')),
});

const PROJECT = '/api/music-video/example-project';
// [method, path, body, sink, authorized status]
const operations = [
  ['post', '/api/music-video', { name: 'Example video', automation: { guidance: 'Example guidance', checkins: { castAndSets: 'auto' } } },
    effects.createProject, 201],
  ['patch', PROJECT, { automation: { checkins: { castAndSets: 'auto' } } }, effects.updateProject, 200],
  ['post', `${PROJECT}/dev-artifacts/mvda-example/review`, { status: 'approved' }, effects.reviewArtifact, 200],
  ['post', `${PROJECT}/analyze`, {}, effects.analyzeProjectSong, 200],
  ['post', `${PROJECT}/analyze/manual`, { bpm: 120, offsetSec: 0 }, effects.analyzeAudioFileManual, 200],
  ['post', `${PROJECT}/audio-timing/apply`, {
    targetTrackId: 'example-track', intervals: [{ oldStartSec: 0, oldEndSec: 10, newStartSec: 0 }], basis: '0123456789abcdef0123456789abcdef',
  }, effects.applyAudioTiming, 200],
  ['post', `${PROJECT}/audio-timing/preview`, {
    targetTrackId: 'example-track', intervals: [{ oldStartSec: 0, oldEndSec: 10, newStartSec: 0 }],
  }, effects.previewAudioTiming, 200],
  ['post', `${PROJECT}/cast-and-sets/approve`, {}, effects.approveCastAndSets, 200],
  ['post', `${PROJECT}/cast-and-sets/skip`, {}, effects.skipCastAndSets, 200],
  ['post', `${PROJECT}/dependency-repairs`, { basis: 'example-basis' }, effects.startDependencyRepair, 201],
  // The preview decodes the song master with ffmpeg (#13097).
  ['get', `${PROJECT}/dependency-impact`, undefined, effects.getDependencyImpact, 200],
  ['post', `${PROJECT}/production-review/prepare`, { providerId: 'example-provider', model: 'example-model' }, effects.prepareProductionReview, 200],
  ['post', `${PROJECT}/production-review/proof`, { startSec: 0, endSec: 12 }, effects.renderProductionProof, 202],
  ['post', `${PROJECT}/production-review/text-check`, {}, effects.startOverlayTextCheck, 202],
  ['post', `${PROJECT}/publish-kit/youtube-thumbnail/paint`, { title: 'Example title', source: { kind: 'image', filename: 'example.png' } },
    effects.paintYoutubeThumbnail, 200],
  ['post', `${PROJECT}/revisions/mvrev-example/resume`, {}, effects.resumeRevision, 200],
  ['post', `${PROJECT}/scenes/example-scene/continue-from-previous`, {}, effects.continueFromPreviousShot, 200],
  ['post', `${PROJECT}/scenes/example-scene/performance-repair`, { excerptId: 'example-excerpt', sourceAssetId: 'example-asset', boundarySec: 1 },
    effects.startPerformanceRepair, 201],
  ['post', `${PROJECT}/sharing-copy`, {}, effects.prepareSharingCopy, 202],
  ['post', `${PROJECT}/song-revision/select`, { revisionId: 'example-revision', songId: 'example-song' }, effects.selectSongRevision, 200],
  ['post', `${PROJECT}/song-revision/track`, { trackId: 'example-track' }, effects.reviseSongFromTrack, 201],
  ['post', `${PROJECT}/song-style/suno`, { url: 'https://example.com/song/example' }, effects.refreshSongStyleFromSuno, 200],
  ['post', `${PROJECT}/song/prepare`, {}, effects.autoPrepareSong, 200],
  ['post', `${PROJECT}/vocal-stem`, upload('stem', 'example.mp3', 'audio/mpeg'), effects.attachVocalStem, 200],
];

const mounts = [['/api/music-video', musicVideoRoutes]];
const multipart = (app, path, { raw }) => request(app).post(path)
  .set('Content-Type', `multipart/form-data; boundary=${BOUNDARY}`).send(raw);

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
});

describe('Music Video pre-guard writes behind the default-deny gate (#13055, #16114)', () => {
  it('still runs every guarded route for a local operator and a delegated agent session', async () => {
    const plain = operations.filter(([, , body]) => !body?.raw);
    await expectAuthorizedWorkflows({ auth, mounts, workflows: plain.map(([method, path, body, effect, status]) => [method, path, body, effect, status]) });
    expect(effects.createProject).toHaveBeenLastCalledWith(expect.objectContaining({ automation: operations[0][2].automation }));
  });

  it('refuses the dependency-impact read, which decodes the song master with ffmpeg (#13097), from a remote caller', async () => {
    await expectRemoteRefusal(mounts, ['get', `${PROJECT}/dependency-impact`, undefined, effects.getDependencyImpact]);
  });

  it('refuses a remote composition import or vocal-stem upload and starts the overlay check for a local import', async () => {
    const zip = upload('file', 'example.zip', 'application/zip');
    const remote = await hostControlApp(REMOTE_ADDRESS, mounts);
    for (const [path, body, effect] of [
      [`${PROJECT}/composition/document/zip`, zip, effects.importDocumentZip],
      [`${PROJECT}/vocal-stem`, upload('stem', 'example.mp3', 'audio/mpeg'), effects.attachVocalStem],
    ]) {
      const refused = await multipart(remote, path, body);
      expect([refused.status, refused.body.code], path).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
      expect(effect, path).not.toHaveBeenCalled();
    }
    const local = await hostControlApp('127.0.0.1', mounts);
    expect((await multipart(local, `${PROJECT}/composition/document/zip`, zip)).status).toBe(201);
    expect((await multipart(local, `${PROJECT}/vocal-stem`, upload('stem', 'example.mp3', 'audio/mpeg'))).status).toBe(200);
    expect(effects.importDocumentZip).toHaveBeenCalledTimes(1);
    expect(effects.attachVocalStem).toHaveBeenCalledTimes(1);
    // The check starts behind two lazy imports, which a cold CI worker loads slowly.
    await vi.waitFor(() => expect(effects.checkOverlayTextInBackground).toHaveBeenCalledWith('example-project'), { timeout: 10_000 });
  });

  it('refuses a remote composition accept before it starts the browser overlay check', async () => {
    const accept = ['post', `${PROJECT}/composition/document/accept`, { directory: 'music-video/example-project/composition/doc-example' }];
    await expectRemoteRefusal(mounts, [...accept, effects.acceptMixedMediaDocument]);
    await expectAuthorizedWorkflows({ auth, mounts, workflows: [[...accept, effects.acceptMixedMediaDocument, 200]] });
  });
});
