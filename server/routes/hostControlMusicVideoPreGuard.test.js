import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER } from '../../lib/portosAuthCore.js';
import { derivePeerAuthToken, PEER_AUTH_HEADER, PEER_INSTANCE_HEADER } from '../lib/peerHttpClient.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-mv-pre-guard-') }));
afterAll(cleanupTempDataRoots);

// Music Video routes the pre-guard audit moved behind operator authority
// (#13055): ffmpeg/ffprobe decodes, the headless-browser text check, Suno browser
// reads, retime/alignment jobs, image jobs and Cast & Sets releases, plus the
// automation brief and the sheet approval that steer unattended runs. Real
// router behind the real gates; each service sink is a spy, so a refused
// caller that reached one is visible, and an open body must still reach it.
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
  verifyPassword: vi.fn(async () => true),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: { on: vi.fn(), off: vi.fn(), emit: vi.fn() },
  getSettings: vi.fn(async () => ({})),
  updateSettingsWith: vi.fn(async (mutate) => mutate({})),
}));
vi.mock('../services/instanceIdentity.js', () => ({
  ensureInstanceId: vi.fn(async () => 'example-self'),
  loadData: vi.fn(async () => ({ peers: [{
    id: 'example-peer', instanceId: 'example-instance', enabled: true, syncSecret: 'a'.repeat(32),
  }] })),
}));
vi.mock('../services/musicVideo/projects.js', async (importOriginal) => ({
  ...await importOriginal(),
  createProject: effects.createProject,
  updateProject: effects.updateProject,
  refreshSongStyleFromSuno: effects.refreshSongStyleFromSuno,
  setProjectAnalysis: vi.fn(async () => ({ id: 'example-project' })),
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

import { authGate, hostControlBodyGate, hostControlRouteGate } from '../services/authGate.js';
import { createSession } from '../services/auth.js';
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
// [method, path, body, sink, authorized status, open body (body-gated rows only)]
const operations = [
  ['post', '/api/music-video', { name: 'Example video', automation: { guidance: 'Example guidance', checkins: { castAndSets: 'auto' } } },
    effects.createProject, 201, { name: 'Example video' }],
  ['patch', PROJECT, { automation: { checkins: { castAndSets: 'auto' } } }, effects.updateProject, 200, { name: 'Example video' }],
  ['post', `${PROJECT}/dev-artifacts/mvda-example/review`, { status: 'approved' }, effects.reviewArtifact, 200,
    { status: 'changes-requested', note: 'Example note' }],
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

const appFor = (address = '192.0.2.10') => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address });
    next();
  });
  app.use(authGate, hostControlRouteGate, express.json(), hostControlBodyGate);
  app.use('/api/music-video', musicVideoRoutes);
  app.use(errorMiddleware);
  return app;
};
const call = (app, [method, path, body], headers = {}) => {
  const pending = request(app)[method](path);
  if (body?.raw) pending.set('Content-Type', `multipart/form-data; boundary=${BOUNDARY}`);
  for (const [name, value] of Object.entries(headers)) pending.set(name, value);
  return pending.send(body?.raw ?? body);
};
const expectNoEffects = () => {
  for (const effect of Object.values(effects)) expect(effect).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
});

describe('Music Video pre-guard operator authority (#13055)', () => {
  it('imports a composition document for any caller and starts the browser overlay check only with host control', async () => {
    const imports = [
      [['post', `${PROJECT}/composition/document/zip`, upload('file', 'example.zip', 'application/zip')], effects.importDocumentZip, 201],
      [['post', `${PROJECT}/composition/document/accept`, { directory: 'music-video/example-project/composition/doc-example' }],
        effects.acceptMixedMediaDocument, 200],
    ];
    const importAs = async (address) => {
      for (const [operation, , status] of imports) {
        expect((await call(appFor(address), operation)).status, `${address} ${operation[1]}`).toBe(status);
      }
    };
    await importAs('127.0.0.1');
    // The check starts behind two lazy imports, which a cold CI worker loads slowly.
    await vi.waitFor(() => expect(effects.checkOverlayTextInBackground).toHaveBeenCalledTimes(2), { timeout: 10_000 });
    expect(effects.checkOverlayTextInBackground).toHaveBeenLastCalledWith('example-project');

    // The check starts behind a dynamic import of a now-cached module, so a
    // check the remote imports had started would land before the next local one.
    await importAs('192.0.2.10');
    for (const [, effect] of imports) expect(effect).toHaveBeenCalledTimes(2);
    await importAs('127.0.0.1');
    await vi.waitFor(() => expect(effects.checkOverlayTextInBackground.mock.calls.length).toBeGreaterThanOrEqual(4), { timeout: 10_000 });
    expect(effects.checkOverlayTextInBackground).toHaveBeenCalledTimes(4);
  });

  it('refuses remote password-free callers, spoofed-proxy and case variants before any service runs', async () => {
    for (const operation of operations) {
      const [method, path, body, , , open] = operation;
      const variants = [
        ['192.0.2.10', {}, path],
        ['127.0.0.1', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '192.0.2.10' }, path],
        ['192.0.2.10', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '127.0.0.1' }, path],
      ];
      if (!open) variants.push(['192.0.2.10', {}, path.toUpperCase() + '/']);
      for (const [address, headers, target] of variants) {
        const response = await call(appFor(address), [method, target, body], headers);
        expect([response.status, response.body.code], `${method} ${target}`).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
      }
    }
    expectNoEffects();
  });

  it('requires authentication with a password and denies legacy Basic and scoped-peer credentials', async () => {
    auth.enabled = true;
    for (const operation of operations) {
      for (const [headers, status, code] of [
        [{}, 401, 'AUTH_REQUIRED'],
        [{ Authorization: 'Basic ' + Buffer.from(':example-password').toString('base64') }, 403, 'HOST_CONTROL_FORBIDDEN'],
        [{
          [PEER_AUTH_HEADER]: derivePeerAuthToken('a'.repeat(32), 'example-instance'),
          [PEER_INSTANCE_HEADER]: 'example-instance',
        }, 403, 'PEER_SCOPE_FORBIDDEN'],
      ]) {
        const response = await call(appFor(), operation, headers);
        expect([response.status, response.body.code], `${operation[0]} ${operation[1]}`).toEqual([status, code]);
      }
    }
    expectNoEffects();
  });

  it('keeps working for local callers, operator sessions and delegated agent sessions', async () => {
    const operator = await createSession();
    const agent = await createSession({ label: 'agent' });
    for (const [enabled, address, headers] of [
      [false, '127.0.0.1', {}],
      [true, '192.0.2.10', { Authorization: `Bearer ${operator.token}` }],
      [true, '192.0.2.10', { Authorization: `Bearer ${agent.token}` }],
    ]) {
      auth.enabled = enabled;
      for (const operation of operations) {
        const response = await call(appFor(address), operation, headers);
        expect(response.status, `${operation[0]} ${operation[1]}: ${JSON.stringify(response.body)}`).toBe(operation[4]);
      }
    }
    for (const [method, path, , effect] of operations) expect(effect, `${method} ${path}`).toHaveBeenCalledTimes(3);
    expect(effects.createProject).toHaveBeenLastCalledWith(expect.objectContaining({ automation: operations[0][2].automation }));
  });

  it('leaves the open body of each body-gated route available to a remote caller', async () => {
    for (const [method, path, , effect, status, open] of operations.filter((operation) => operation[5])) {
      const response = await call(appFor(), [method, path, open]);
      expect(response.status, `${method} ${path}: ${JSON.stringify(response.body)}`).toBe(status);
      expect(effect, `${method} ${path}`).toHaveBeenCalledTimes(1);
    }
  });
});
