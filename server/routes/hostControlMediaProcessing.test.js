import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const state = vi.hoisted(() => ({ enabled: false }));
const effects = vi.hoisted(() => ({
  startVideoDownload: vi.fn(async () => ({ jobId: 'dl-1' })),
  startYoutubeImport: vi.fn(async () => ({ jobId: 'yt-1' })),
  startReferenceAudioImport: vi.fn(async () => ({ jobId: 'ref-1' })),
  startMidiTranscription: vi.fn(async () => ({ jobId: 'midi-1', model: 'medium' })),
  startVocalSeparation: vi.fn(async () => ({ jobId: 'vocal-1' })),
  startLyricAlign: vi.fn(async () => ({ jobId: 'align-1' })),
  probeLoraEffect: vi.fn(async () => ({ status: 'active' })),
  renderTimelineProject: vi.fn(async () => ({ jobId: 'render-1' })),
  addCoverFont: vi.fn(async () => ({ id: 'font-1' })),
}));

vi.mock('../services/auth.js', () => ({
  isAuthEnabled: vi.fn(async () => state.enabled),
  verifyRequestSession: vi.fn(async (req) => req.headers.authorization === 'Bearer example-session'),
  verifyPassword: vi.fn(async () => true),
}));

vi.mock('../services/settings.js', () => ({
  settingsEvents: new EventEmitter(),
  getSettings: vi.fn(async () => ({})),
}));

vi.mock('../services/videoDownload.js', () => ({
  startVideoDownload: effects.startVideoDownload,
  listDownloads: vi.fn(async () => []),
  deleteDownload: vi.fn(async () => ({ ok: true })),
  cancelVideoDownload: vi.fn(() => ({ ok: true })),
}));

vi.mock('../services/ytdlpUpdate.js', () => ({
  getYtDlpUpdateStatus: vi.fn(async () => ({ version: '2024.01.01' })),
  updateYtDlp: vi.fn(async () => ({ success: true, version: '2024.01.02' })),
}));

vi.mock('../services/trackYoutubeImport.js', () => ({
  startYoutubeImport: effects.startYoutubeImport,
  cancelYoutubeImport: vi.fn(() => true),
  attachImportSseClient: vi.fn(() => true),
}));

vi.mock('../services/trackSunoImport.js', () => ({
  startSunoImport: vi.fn(async () => ({ jobId: 'suno-1' })),
  cancelSunoImport: vi.fn(() => true),
  attachSunoImportSseClient: vi.fn(() => true),
}));

vi.mock('../services/tracks/index.js', async () => ({
  ...await import('../services/tracks/logic.js'),
  getTrack: vi.fn(async (id) => ({ id })),
}));

vi.mock('../services/roundReferenceAudioImport.js', () => ({
  startReferenceAudioImport: effects.startReferenceAudioImport,
  cancelReferenceAudioImport: vi.fn(() => true),
  attachReferenceAudioSseClient: vi.fn(() => true),
}));

vi.mock('../services/audioMidiTranscription.js', () => ({
  startMidiTranscription: effects.startMidiTranscription,
  cancelMidiTranscription: vi.fn(() => true),
  attachMidiTranscriptionSseClient: vi.fn(() => true),
  getActiveMidiTranscriptionJobId: vi.fn(() => null),
  MUSCRIPTOR_MODELS: ['small', 'medium', 'large'],
}));

vi.mock('../services/musicVideo/projects.js', () => ({
  getProject: vi.fn(async (id) => ({
    id,
    name: 'Example Video',
    trackId: 'track-1',
    uploadedAudioFilename: 'audio.wav',
    lyricCues: [{ id: 'cue-1', text: 'Example lyrics' }],
  })),
  updateProject: vi.fn(async () => ({})),
}));

vi.mock('../services/musicVideo/projectAudio.js', () => ({
  resolveProjectAudioPath: vi.fn(async () => '/fake/audio.wav'),
  analyzeProjectSong: vi.fn(async () => ({})),
}));

vi.mock('../services/musicVideo/vocalSeparation.js', () => ({
  startVocalSeparation: effects.startVocalSeparation,
  cancelVocalSeparation: vi.fn(() => true),
  attachVocalSeparationSseClient: vi.fn(() => true),
}));

vi.mock('../services/musicVideo/coverFonts.js', () => ({
  addCoverFont: effects.addCoverFont,
  coverFontPath: vi.fn(async () => null),
  listCoverFonts: vi.fn(async () => []),
  removeCoverFont: vi.fn(async () => ({ ok: true })),
  MAX_COVER_FONT_BYTES: 8 * 1024 * 1024,
}));

vi.mock('../services/musicVideo/lyricAlignJob.js', () => ({
  startLyricAlign: effects.startLyricAlign,
  cancelLyricAlign: vi.fn(() => true),
  attachLyricAlignSseClient: vi.fn(() => true),
  getActiveLyricAlignJobId: vi.fn(() => null),
}));

vi.mock('../services/loraEffectProbe.js', () => ({
  probeLoraEffect: effects.probeLoraEffect,
}));

vi.mock('../services/videoTimeline/local.js', () => ({
  listProjects: vi.fn(async () => []),
  getProject: vi.fn(async () => ({})),
  createProject: vi.fn(async () => ({})),
  updateProject: vi.fn(async () => ({})),
  deleteProject: vi.fn(async () => ({})),
  renderProject: effects.renderTimelineProject,
  attachSseClient: vi.fn(() => true),
  cancelRender: vi.fn(() => true),
}));

vi.mock('../services/loras.js', () => ({
  listLoras: vi.fn(async () => []),
  assertSafeLoraFilename: vi.fn(),
}));

import { authGate, hostControlRouteGate } from '../services/authGate.js';
import { isHostControlRoute } from '../lib/hostControlRoutes.js';
import videoDownloadRoutes from './videoDownload.js';
import tracksRoutes from './tracks.js';
import roundsRoutes from './rounds.js';
import musicVideoRoutes from './musicVideo.js';
import lorasRoutes from './loras.js';
import videoTimelineRoutes from './videoTimeline.js';

const routes = [
  ['/api/devtools/video-download', { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }, effects.startVideoDownload],
  ['/api/tracks/import/youtube', { url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' }, effects.startYoutubeImport],
  ['/api/rounds/reference-audio/import', { url: 'https://example.com/audio.mp3', roundId: '00000000-0000-4000-8000-000000000001', referenceId: 'ref-1' }, effects.startReferenceAudioImport],
  ['/api/rounds/reference-audio/transcribe-midi', { filename: 'audio.wav' }, effects.startMidiTranscription],
  ['/api/music-video/proj-1/transcribe-midi', {}, effects.startMidiTranscription],
  ['/api/music-video/proj-1/vocal-stem/separate', {}, effects.startVocalSeparation],
  ['/api/music-video/proj-1/lyrics/align', {}, effects.startLyricAlign],
  ['/api/loras/test-lora.safetensors/effect', {}, effects.probeLoraEffect],
  ['/api/video-timeline/projects/proj-1/render', {}, effects.renderTimelineProject],
];

const appFor = (address = '192.0.2.10') => {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: address });
    next();
  });
  app.use(authGate, hostControlRouteGate, express.json());
  app.use('/api/devtools/video-download', videoDownloadRoutes);
  app.use('/api/tracks', tracksRoutes);
  app.use('/api/rounds', roundsRoutes);
  app.use('/api/music-video', musicVideoRoutes);
  app.use('/api/loras', lorasRoutes);
  app.use('/api/video-timeline', videoTimelineRoutes);
  app.use(errorMiddleware);
  return app;
};

const post = (app, path, body = {}, headers = {}) => {
  const pending = request(app).post(path);
  for (const [k, v] of Object.entries(headers)) pending.set(k, v);
  return pending.send(body);
};

const expectNoEffects = () => {
  for (const [, , effect] of routes) {
    expect(effect).not.toHaveBeenCalled();
  }
};

beforeEach(() => {
  vi.clearAllMocks();
  state.enabled = false;
});

describe('media process execution operator authority', () => {
  it('lists every media process execution endpoint as a host-control route', () => {
    for (const [path] of routes) {
      expect(isHostControlRoute('POST', path), path).toBe(true);
    }
  });

  it('refuses remote password-free callers before spawning any host processes', async () => {
    const app = appFor();
    for (const [path, body] of routes) {
      const res = await post(app, path, body);
      expect([res.status, res.body.code], path).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
      expect(res.headers['content-type']).toMatch(/^application\/json/);
    }
    expectNoEffects();
  });

  it('rejects anonymous (401) and legacy Basic (403) callers on a password-enabled install', async () => {
    state.enabled = true;
    const basic = { Authorization: 'Basic ' + Buffer.from(':example-password').toString('base64') };
    const app = appFor();
    for (const [path, body] of routes) {
      const anon = await post(app, path, body);
      expect([anon.status, anon.body.code], path).toEqual([401, 'AUTH_REQUIRED']);
      const legacy = await post(app, path, body, basic);
      expect([legacy.status, legacy.body.code], path).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
    }
    expectNoEffects();
  });

  it('admits local callers when auth is off, and operator sessions when auth is on', async () => {
    const local = appFor('127.0.0.1');
    const [path, body, effect] = routes[0];
    const resLocal = await post(local, path, body);
    expect(resLocal.status).toBe(202);
    expect(effect).toHaveBeenCalledTimes(1);

    state.enabled = true;
    const operator = appFor();
    const resOp = await post(operator, path, body, { Authorization: 'Bearer example-session' });
    expect(resOp.status).toBe(202);
    expect(effect).toHaveBeenCalledTimes(2);
  });

  it('gates the cover font install (host-wide font folder) while local and operator callers reach the handler (#12493)', async () => {
    const path = '/api/music-video/publish/cover-fonts';
    const remote = await post(appFor(), path, {});
    expect([remote.status, remote.body.code]).toEqual([403, 'HOST_CONTROL_FORBIDDEN']);
    // Past the gate, the upload middleware rejects a JSON body (not multipart).
    const local = await post(appFor('127.0.0.1'), path, {});
    expect([local.status, local.body.code]).toEqual([400, 'INVALID_CONTENT_TYPE']);
    state.enabled = true;
    const operator = await post(appFor(), path, {}, { Authorization: 'Bearer example-session' });
    expect([operator.status, operator.body.code]).toEqual([400, 'INVALID_CONTENT_TYPE']);
    expect(effects.addCoverFont).not.toHaveBeenCalled();
  });

  it('keeps timeline render available to local and operator callers', async () => {
    const [path, body, effect] = routes.at(-1);
    const resLocal = await post(appFor('127.0.0.1'), path, body);
    expect(resLocal.status).toBe(200);
    expect(effect).toHaveBeenCalledTimes(1);

    state.enabled = true;
    const resOp = await post(appFor(), path, body, { Authorization: 'Bearer example-session' });
    expect(resOp.status).toBe(200);
    expect(effect).toHaveBeenCalledTimes(2);
  });

  it('keeps reads and status endpoints open to remote callers', async () => {
    const app = appFor();
    const downloads = await request(app).get('/api/devtools/video-download/downloads');
    expect(downloads.status).toBe(200);

    const ytdlp = await request(app).get('/api/devtools/video-download/yt-dlp');
    expect(ytdlp.status).toBe(200);

    const loras = await request(app).get('/api/loras');
    expect(loras.status).toBe(200);
  });
});
