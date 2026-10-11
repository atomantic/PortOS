import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER, SESSION_TTL_MS } from '../../lib/portosAuthCore.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { derivePeerAuthToken, PEER_AUTH_HEADER, PEER_INSTANCE_HEADER } from '../lib/peerHttpClient.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-media-authority-') }));
afterAll(cleanupTempDataRoots);
afterEach(() => vi.restoreAllMocks());
vi.mock('../services/instanceIdentity.js', () => ({
  loadData: vi.fn(async () => ({ peers: [{
    id: 'example-peer', instanceId: 'example-instance', enabled: true, syncSecret: 'a'.repeat(32),
  }] })),
}));

// Mount the production routers behind the real gates. Service boundaries are
// doubled so authoring, persistence, background jobs and processes cannot run.
const auth = vi.hoisted(() => ({ enabled: false }));
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
  verifyPassword: vi.fn(async () => true),
}));
vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(),
  getSettings: vi.fn(async () => ({})),
}));
vi.mock('../services/codeAnimation/index.js', () => ({
  generateCodeAnimationBrief: vi.fn(async () => ({ brief: {} })),
  startCodeAnimationGeneration: vi.fn(async () => ({ id: 'example-job' })),
  buildCodeAnimationRequest: vi.fn(async () => ({ prompt: 'Example preview' })),
  getCodeAnimationJob: vi.fn(async () => ({ status: 'completed' })),
}));
vi.mock('../services/codeAnimation/stages.js', () => ({
  startProductionStageRun: vi.fn(async () => ({ run: { status: 'running' } })),
  cancelProductionStageRun: vi.fn(() => ({ cancelled: true })),
}));
vi.mock('../services/codeAnimation/export.js', () => ({
  startCodeAnimationExport: vi.fn(async () => ({ status: 'queued' })),
}));
vi.mock('../services/musicDesigner.js', () => ({
  describeMusic: vi.fn(async () => ({ description: 'Example music' })),
  writeLyrics: vi.fn(async () => ({ lyrics: 'Example lyrics' })),
}));
vi.mock('../services/musicWaveform.js', () => ({
  drawWaveSketch: vi.fn(async () => ({ sketch: {} })),
  drawWaveSketchForTrack: vi.fn(async () => ({ track: {} })),
  renderWaveSketchToTrack: vi.fn(async () => ({ filename: 'example.wav' })),
}));
vi.mock('../services/musicCode.js', () => ({
  MUSIC_CODE_LANGUAGES: ['strudel', 'tonejs', 'supercollider'], MUSIC_CODE_MAX: 20000,
  writeMusicCode: vi.fn(async () => ({ language: 'strudel', code: 'silence' })),
}));
vi.mock('../services/musicVideo/autonomousService.js', () => ({
  startAutonomousVideo: vi.fn(async () => ({ status: 'running' })),
  resumeAutonomousVideo: vi.fn(async () => ({ status: 'running' })),
  getAutonomousRun: vi.fn(async () => ({ status: 'paused' })),
  stopAutonomousVideo: vi.fn(async () => ({ status: 'stopped' })),
  cancelAutonomousVideo: vi.fn(async () => ({ status: 'cancelled' })),
}));
vi.mock('../services/tracks/index.js', async () => ({ ...await import('../services/tracks/logic.js') }));
vi.mock('../services/pipeline/musicLibrary.js', () => ({ MUSIC_UPLOAD_MAX_BYTES: 1024 }));
vi.mock('../services/musicVideo/compositionDocument.js', () => ({ DOCUMENT_ZIP_MAX_BYTES: 1024 }));
vi.mock('../services/codeAnimation/soundAssets.js', () => ({}));
vi.mock('../services/codeAnimation/preflight.js', () => ({}));
vi.mock('../services/codeAnimation/package.js', () => ({}));
vi.mock('../services/codeAnimation/projects.js', () => ({}));
vi.mock('../services/pipeline/musicGen.js', () => ({}));
vi.mock('../services/audioModels.js', () => ({}));
vi.mock('../services/musicEngineCapabilities.js', () => ({}));
vi.mock('../services/hfDownloadStream.js', () => ({}));
vi.mock('../services/musicGeneration.js', () => ({}));
vi.mock('../services/trackAudioAttach.js', () => ({}));
vi.mock('../services/trackAlbumMembership.js', () => ({}));
vi.mock('../services/trackYoutubeImport.js', () => ({}));
vi.mock('../services/chiptune.js', () => ({}));
vi.mock('../services/musicVideo/vocalStem.js', () => ({}));
vi.mock('../services/musicVideo/projects.js', () => ({}));
vi.mock('../services/musicVideo/handoff.js', () => ({}));
vi.mock('../services/videoGen/history.js', () => ({}));
vi.mock('../services/audioMidiTranscription.js', () => ({}));
vi.mock('../services/musicVideo/audioAnalysis.js', () => ({}));
vi.mock('../services/musicVideo/projectAudio.js', () => ({}));
vi.mock('../services/musicVideo/render.js', () => ({}));
vi.mock('../services/musicVideo/codeRender.js', () => ({}));
vi.mock('../services/musicVideo/codeGeneration.js', () => ({
  generateMusicVideoCode: vi.fn(async () => ({ code: 'example' })),
  regenerateMusicVideoCodeSection: vi.fn(async () => ({ code: 'example' })),
}));
vi.mock('../services/musicVideo/excerptRender.js', () => ({}));
vi.mock('../services/musicVideo/excerptService.js', () => ({}));
vi.mock('../services/musicVideo/socialCuts.js', () => ({}));
vi.mock('../services/musicVideo/publishKit.js', () => ({
  draftPublishKitCopy: vi.fn(async () => ({ project: {} })),
}));
vi.mock('../services/musicVideo/publish/index.js', () => ({}));
vi.mock('../services/musicVideo/publish/platforms.js', () => ({}));
vi.mock('../services/musicVideo/revisionService.js', () => ({}));
vi.mock('../services/musicVideo/autoReviewService.js', () => ({
  startAutoReview: vi.fn(async () => ({ status: 'running' })),
  resumeAutoReview: vi.fn(async () => ({ status: 'running' })),
}));
vi.mock('../services/musicVideo/productionService.js', () => ({
  startProduction: vi.fn(async () => ({ status: 'running' })),
  resumeProduction: vi.fn(async () => ({ status: 'running' })),
}));
vi.mock('../services/musicVideo/planner.js', () => ({
  planProject: vi.fn(async () => ({ project: {}, promptsSeeded: false })),
}));
vi.mock('../services/musicVideo/documentPreview.js', () => ({}));
vi.mock('../services/musicVideo/documentGeneration.js', () => ({
  generateMixedMediaDocument: vi.fn(async () => ({ document: {} })),
  reviseMixedMediaEvents: vi.fn(async () => ({ document: {} })),
  regenerateMixedMediaSection: vi.fn(async () => ({ document: {} })),
}));
vi.mock('../services/musicVideo/timedText.js', () => ({}));
vi.mock('../services/musicVideo/lyricAlign.js', () => ({}));
vi.mock('../services/musicVideo/trackLyrics.js', () => ({}));
vi.mock('../services/musicVideo/lyricMarkers.js', () => ({}));
vi.mock('../services/musicVideo/treatmentService.js', () => ({
  compileTreatment: vi.fn(async () => ({ treatment: {} })),
}));
vi.mock('../services/musicVideo/devArtifactService.js', () => ({}));
vi.mock('../services/musicVideo/devArtifacts.js', () => ({}));
vi.mock('../services/musicVideo/castAndSetsService.js', () => ({
  startCastAndSets: vi.fn(async () => ({ status: 'running' })),
  regenerateCastAndSets: vi.fn(async () => ({ status: 'running' })),
  editCastAndSetsDirection: vi.fn(async () => ({ status: 'running' })),
  resumeCastAndSets: vi.fn(async () => ({ status: 'running' })),
  applyCastAndSetsFeedback: vi.fn(async () => ({ status: 'running' })),
}));

import { authGate, hostControlRouteGate } from '../services/authGate.js';
import codeAnimationRoutes from './codeAnimation.js';
import musicRoutes from './music.js';
import tracksRoutes from './tracks.js';
import musicVideoRoutes from './musicVideo.js';
import { generateCodeAnimationBrief, startCodeAnimationGeneration } from '../services/codeAnimation/index.js';
import { startProductionStageRun } from '../services/codeAnimation/stages.js';
import { describeMusic, writeLyrics } from '../services/musicDesigner.js';
import { drawWaveSketch, drawWaveSketchForTrack } from '../services/musicWaveform.js';
import { writeMusicCode } from '../services/musicCode.js';
import { startAutonomousVideo, resumeAutonomousVideo } from '../services/musicVideo/autonomousService.js';

import { createSession, revokeSessionById } from '../services/auth.js';
import { planProject } from '../services/musicVideo/planner.js';
import { compileTreatment } from '../services/musicVideo/treatmentService.js';
import { draftPublishKitCopy } from '../services/musicVideo/publishKit.js';
import { generateMusicVideoCode, regenerateMusicVideoCodeSection } from '../services/musicVideo/codeGeneration.js';
import { generateMixedMediaDocument, reviseMixedMediaEvents, regenerateMixedMediaSection } from '../services/musicVideo/documentGeneration.js';
import { startAutoReview, resumeAutoReview } from '../services/musicVideo/autoReviewService.js';
import { startProduction, resumeProduction } from '../services/musicVideo/productionService.js';
import { startCastAndSets, regenerateCastAndSets, editCastAndSetsDirection, resumeCastAndSets, applyCastAndSetsFeedback } from '../services/musicVideo/castAndSetsService.js';

let ownerSession;
const id = '00000000-0000-4000-8000-000000000001';
const picker = { providerId: 'example-provider', model: 'example-model' };
const authoring = [
  ['/api/code-animation/brief', { seedIdea: 'Example scene', ...picker }, generateCodeAnimationBrief, 200],
  ['/api/code-animation/generate', { concept: 'Example scene', ...picker }, startCodeAnimationGeneration, 202],
  [`/api/code-animation/projects/${id}/stage-runs`, {}, startProductionStageRun, 202],
  ['/api/music/describe', { concept: 'Example song', ...picker }, describeMusic, 200],
  ['/api/music/lyrics', { description: 'Example song', ...picker }, writeLyrics, 200],
  ['/api/music/waveform', { description: 'Example song', ...picker }, drawWaveSketch, 200],
  ['/api/music/code', { description: 'Example song', ...picker }, writeMusicCode, 200],
  [`/api/tracks/${id}/waveform/draw`, { description: 'Example song', ...picker }, drawWaveSketchForTrack, 200],
  ['/api/music-video/autonomous', { prompt: 'Example video', ...picker }, startAutonomousVideo, 202],
  [`/api/music-video/${id}/autonomous/resume`, {}, resumeAutonomousVideo, 200],
];
const musicVideoAuthoring = [
  [`/api/music-video/${id}/plan`, { ...picker }, planProject, 200, 'post'],
  [`/api/music-video/${id}/treatment/compile`, { baseRevision: 0, ...picker }, compileTreatment, 200, 'post'],
  [`/api/music-video/${id}/publish-kit/copy`, { notes: 'Example copy', ...picker }, draftPublishKitCopy, 200, 'post'],
  [`/api/music-video/${id}/cast-and-sets`, { ...picker }, startCastAndSets, 202, 'post'],
  [`/api/music-video/${id}/cast-and-sets/regenerate`, { ...picker }, regenerateCastAndSets, 202, 'post'],
  [`/api/music-video/${id}/cast-and-sets/direction`, { protagonist: { movement: 'Example movement' } }, editCastAndSetsDirection, 202, 'patch'],
  [`/api/music-video/${id}/cast-and-sets/resume`, { ...picker }, resumeCastAndSets, 202, 'post'],
  [`/api/music-video/${id}/cast-and-sets/feedback`, { text: 'Fewer light sources', ...picker }, applyCastAndSetsFeedback, 202, 'post'],
  [`/api/music-video/${id}/code/generate`, { ...picker }, generateMusicVideoCode, 200, 'post'],
  [`/api/music-video/${id}/code/sections/example-section/regenerate`, { ...picker }, regenerateMusicVideoCodeSection, 200, 'post'],
  [`/api/music-video/${id}/composition/document/generate`, { ...picker }, generateMixedMediaDocument, 201, 'post'],
  [`/api/music-video/${id}/composition/document/events/revise`, { expectedDraft: 'music-video/example/composition/example-draft', ...picker }, reviseMixedMediaEvents, 201, 'post'],
  [`/api/music-video/${id}/composition/document/sections/example-section/regenerate`, { expectedDraft: 'music-video/example/composition/example-draft', ...picker }, regenerateMixedMediaSection, 201, 'post'],
  [`/api/music-video/${id}/production-runs`, { pool: [], limits: { maxGenerations: 2, maxReviewAttempts: 1 }, ...picker }, startProduction, 201, 'post'],
  [`/api/music-video/${id}/production-runs/example-run/resume`, {}, resumeProduction, 200, 'post'],
  [`/api/music-video/${id}/auto-reviews`, { startSec: 0, endSec: 2, limits: { maxAttempts: 1, maxGenerations: 2 }, ...picker }, startAutoReview, 201, 'post'],
  [`/api/music-video/${id}/auto-reviews/example-run/resume`, {}, resumeAutoReview, 200, 'post'],
];
const allAuthoring = [...authoring, ...musicVideoAuthoring];
const appFor = (address = '192.0.2.10') => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address });
    next();
  });
  app.use(authGate, hostControlRouteGate, express.json());
  app.use('/api/code-animation', codeAnimationRoutes);
  app.use('/api/music', musicRoutes);
  app.use('/api/tracks', tracksRoutes);
  app.use('/api/music-video', musicVideoRoutes);
  app.use(errorMiddleware);
  return app;
};
const call = (app, [path, body, , , method = 'post'], headers = {}) => {
  const pending = request(app)[method](path);
  for (const [name, value] of Object.entries(headers)) pending.set(name, value);
  return pending.send(body);
};
const expectNoAuthoring = () => {
  for (const [, , service] of allAuthoring) expect(service).not.toHaveBeenCalled();
};

beforeEach(async () => {
  vi.clearAllMocks();
  auth.enabled = false;
  ownerSession = await createSession();
});

describe('media authoring operator authority (#9512, #9869)', () => {
  it('refuses every direct and deferred authoring entry point before any service effects', async () => {
    for (const operation of allAuthoring) {
      for (const [address, headers] of [
        ['192.0.2.10', {}],
        ['127.0.0.1', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '192.0.2.10' }],
        ['192.0.2.10', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '127.0.0.1' }],
      ]) {
        const response = await call(appFor(address), operation, headers);
        expect([response.status, response.body.code], operation[0]).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
      }
    }
    expectNoAuthoring();
  });

  it('requires authentication with a password and denies legacy Basic authoring', async () => {
    auth.enabled = true;
    for (const operation of allAuthoring) {
      for (const [headers, status, code] of [
        [{}, 401, 'AUTH_REQUIRED'],
        [{ Authorization: 'Basic ' + Buffer.from(':example-password').toString('base64') }, 403, 'HOST_CONTROL_FORBIDDEN'],
      ]) {
        const response = await call(appFor(), operation, headers);
        expect([response.status, response.body.code], operation[0]).toEqual([status, code]);
      }
    }
    expectNoAuthoring();
  });

  it('retains local and operator authoring without changing provider/model selections', async () => {
    const agentSession = await createSession({ label: 'agent' });
    for (const [enabled, address, headers] of [
      [false, '127.0.0.1', {}],
      [false, '127.0.0.1', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '::ffff:127.0.0.1' }],
      [true, '192.0.2.10', { Authorization: `Bearer ${ownerSession.token}` }],
      [true, '192.0.2.10', { Cookie: `portos_auth=${ownerSession.token}` }],
      [true, '192.0.2.10', { Authorization: `Bearer ${agentSession.token}` }],
      [true, '192.0.2.10', { Cookie: `portos_auth=${agentSession.token}` }],
    ]) {
      auth.enabled = enabled;
      for (const operation of allAuthoring) {
        const response = await call(appFor(address), operation, headers);
        expect(response.status, `${operation[0]}: ${JSON.stringify(response.body)}`).toBe(operation[3]);
      }
    }
    for (const [, body, service] of allAuthoring) {
      expect(service).toHaveBeenCalledTimes(6);
      if (body.providerId) {
        const args = service.mock.lastCall;
        const options = args.find(value => value && typeof value === 'object' && (value.providerId || value.reviewer));
        expect(options.reviewer || options).toEqual(expect.objectContaining(picker));
      }
    }
  });

  it('preserves pinned and default authoring/reviewer choices for delegated agents', async () => {
    auth.enabled = true;
    const session = await createSession({ label: 'agent' });
    const headers = { Authorization: `Bearer ${session.token}` };
    for (const provider of [{ providerId: 'example-tui', model: 'example-model' }, {}]) {
      for (const operation of musicVideoAuthoring.filter(([, body]) => body.providerId)) {
        const selected = [...operation];
        const { providerId: _provider, model: _model, ...body } = selected[1];
        selected[1] = { ...body, ...provider };
        expect((await call(appFor(), selected, headers)).status, selected[0]).toBe(selected[3]);
        const options = selected[2].mock.lastCall.find(value => value && typeof value === 'object');
        const choice = options.reviewer || options;
        expect(choice.providerId).toBe(provider.providerId);
        expect(choice.model).toBe(provider.model);
      }
    }
  });

  it('fails closed for invalid, expired, revoked and scoped-peer credentials', async () => {
    auth.enabled = true;
    const expired = await createSession({ label: 'agent' });
    const revoked = await createSession({ label: 'agent' });
    await revokeSessionById(revoked.id);
    // Advance the verifier's clock without timers or production sleeps.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + SESSION_TTL_MS + 1);
    for (const operation of musicVideoAuthoring) {
      for (const [headers, status, code] of [
        [{ Authorization: 'Bearer invalid-session' }, 401, 'AUTH_REQUIRED'],
        [{ Authorization: `Bearer ${expired.token}` }, 401, 'AUTH_REQUIRED'],
        [{ Cookie: `portos_auth=${revoked.token}` }, 401, 'AUTH_REQUIRED'],
        [{
          [PEER_AUTH_HEADER]: derivePeerAuthToken('a'.repeat(32), 'example-instance'),
          [PEER_INSTANCE_HEADER]: 'example-instance',
        }, 403, 'PEER_SCOPE_FORBIDDEN'],
      ]) {
        const response = await call(appFor(), operation, headers);
        expect([response.status, response.body.code], operation[0]).toEqual([status, code]);
      }
    }
    clock.mockRestore();
    expectNoAuthoring();
  });

  it('matches case and trailing-slash variants before any service effects', async () => {
    for (const operation of musicVideoAuthoring) {
      const variant = [...operation];
      variant[0] = operation[0].toUpperCase() + '/';
      const response = await call(appFor(), variant);
      expect([response.status, response.body.code], operation[0]).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
    }
    expectNoAuthoring();
  });

  it('keeps deterministic plan/compile under the same operation authority', async () => {
    const operations = [
      [`/api/music-video/${id}/plan`, { seedPrompts: false }, planProject, 200],
      [`/api/music-video/${id}/treatment/compile`, { baseRevision: 0, useAi: false }, compileTreatment, 200],
    ];
    for (const operation of operations) {
      expect((await call(appFor(), operation)).status).toBe(403);
      expect(operation[2]).not.toHaveBeenCalled();
      expect((await call(appFor('127.0.0.1'), operation)).status).toBe(200);
      auth.enabled = true;
      const session = await createSession({ label: 'agent' });
      expect((await call(appFor(), operation, { Authorization: `Bearer ${session.token}` })).status).toBe(200);
      expect(operation[2].mock.lastCall).toEqual([id, expect.objectContaining(operation[1])]);
      auth.enabled = false;
    }
  });

  it('keeps previews, reads, cancellation and contained rendering available remotely', async () => {
    const app = appFor();
    for (const path of [`/api/code-animation/generate/${id}`, `/api/music-video/${id}/autonomous`]) {
      expect((await request(app).get(path)).status, path).toBe(200);
    }
    for (const [path, body, status] of [
      ['/api/code-animation/prompt', { concept: 'Example scene' }, 200],
      [`/api/code-animation/projects/${id}/stage-runs/${id}/cancel`, {}, 200],
      [`/api/code-animation/${id}/export`, {}, 202],
      [`/api/tracks/${id}/waveform/render`, {}, 200],
      [`/api/music-video/${id}/autonomous/stop`, {}, 200],
      [`/api/music-video/${id}/autonomous/cancel`, {}, 200],
    ]) expect((await call(app, [path, body])).status, path).toBe(status);
    expectNoAuthoring();
  });
});
