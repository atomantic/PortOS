import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { DEV_PROXY_CLIENT_ADDRESS_HEADER } from '../../lib/portosAuthCore.js';

// Mount the production routers behind the real gates. Service boundaries are
// doubled so authoring, persistence, background jobs and processes cannot run.
const auth = vi.hoisted(() => ({ enabled: false }));
vi.mock('../services/auth.js', () => ({
  isAuthEnabled: vi.fn(async () => auth.enabled),
  verifyRequestSession: vi.fn(async req => req.headers.authorization === 'Bearer example-session'),
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
vi.mock('../services/musicVideo/codeGeneration.js', () => ({}));
vi.mock('../services/musicVideo/excerptRender.js', () => ({}));
vi.mock('../services/musicVideo/excerptService.js', () => ({}));
vi.mock('../services/musicVideo/socialCuts.js', () => ({}));
vi.mock('../services/musicVideo/publishKit.js', () => ({}));
vi.mock('../services/musicVideo/publish/index.js', () => ({}));
vi.mock('../services/musicVideo/publish/platforms.js', () => ({}));
vi.mock('../services/musicVideo/revisionService.js', () => ({}));
vi.mock('../services/musicVideo/autoReviewService.js', () => ({}));
vi.mock('../services/musicVideo/productionService.js', () => ({}));
vi.mock('../services/musicVideo/planner.js', () => ({}));
vi.mock('../services/musicVideo/documentPreview.js', () => ({}));
vi.mock('../services/musicVideo/documentGeneration.js', () => ({}));
vi.mock('../services/musicVideo/timedText.js', () => ({}));
vi.mock('../services/musicVideo/lyricAlign.js', () => ({}));
vi.mock('../services/musicVideo/trackLyrics.js', () => ({}));
vi.mock('../services/musicVideo/lyricMarkers.js', () => ({}));
vi.mock('../services/musicVideo/treatmentService.js', () => ({}));
vi.mock('../services/musicVideo/devArtifactService.js', () => ({}));
vi.mock('../services/musicVideo/devArtifacts.js', () => ({}));
vi.mock('../services/musicVideo/castAndSetsService.js', () => ({}));

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
const call = (app, [path, body], headers = {}) => {
  const pending = request(app).post(path);
  for (const [name, value] of Object.entries(headers)) pending.set(name, value);
  return pending.send(body);
};
const expectNoAuthoring = () => {
  for (const [, , service] of authoring) expect(service).not.toHaveBeenCalled();
};

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
});

describe('media authoring operator authority (#9512)', () => {
  it('refuses every direct and deferred authoring entry point before any service effects', async () => {
    for (const operation of authoring) {
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
    for (const operation of authoring) {
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
    for (const [enabled, address, headers] of [
      [false, '127.0.0.1', {}],
      [false, '127.0.0.1', { [DEV_PROXY_CLIENT_ADDRESS_HEADER]: '::ffff:127.0.0.1' }],
      [true, '192.0.2.10', { Authorization: 'Bearer example-session' }],
    ]) {
      auth.enabled = enabled;
      for (const operation of authoring) {
        const response = await call(appFor(address), operation, headers);
        expect(response.status, `${operation[0]}: ${JSON.stringify(response.body)}`).toBe(operation[3]);
      }
    }
    for (const [, body, service] of authoring) {
      expect(service).toHaveBeenCalledTimes(3);
      if (body.providerId) expect(service).toHaveBeenLastCalledWith(expect.objectContaining(picker));
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
