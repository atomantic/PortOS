import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { callRoute, expectAuthorizedWorkflows, expectRemoteRefusal, hostControlApp } from './hostControlTestHarness.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-media-processing-') }));
afterAll(cleanupTempDataRoots);

// Process-spawning media routes are plain writes under the default-deny gate
// (#16018, #12493); the principal matrix lives in services/authGate.test.js.
const state = vi.hoisted(() => ({ enabled: false }));
const effects = vi.hoisted(() => ({
  startVideoDownload: vi.fn(async () => ({ jobId: 'dl-1' })),
  startYoutubeImport: vi.fn(async () => ({ jobId: 'yt-1' })),
  startReferenceAudioImport: vi.fn(async () => ({ jobId: 'ref-1' })),
  startMidiTranscription: vi.fn(async () => ({ jobId: 'midi-1', model: 'medium' })),
  startVocalSeparation: vi.fn(async () => ({ jobId: 'vocal-1' })),
  startLyricAlign: vi.fn(async () => ({ jobId: 'align-1' })),
  startLyricVerify: vi.fn(async () => ({ jobId: 'verify-1' })),
  probeLoraEffect: vi.fn(async () => ({ status: 'active' })),
  renderTimelineProject: vi.fn(async () => ({ jobId: 'render-1' })),
  addCoverFont: vi.fn(async () => ({ id: 'font-1' })),
}));

vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(), isAuthEnabled: vi.fn(async () => state.enabled),
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
  installYtDlp: vi.fn(),
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

vi.mock('../services/musicVideo/lyricVerifyJob.js', () => ({
  startLyricVerify: effects.startLyricVerify,
  cancelLyricVerify: vi.fn(() => true),
  attachLyricVerifySseClient: vi.fn(() => true),
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

import { getYtDlpUpdateStatus } from '../services/ytdlpUpdate.js';
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
  ['/api/music-video/proj-1/lyrics/verify', {}, effects.startLyricVerify],
  ['/api/loras/test-lora.safetensors/effect', {}, effects.probeLoraEffect],
  ['/api/video-timeline/projects/proj-1/render', {}, effects.renderTimelineProject],
];

const mounts = [
  ['/api/devtools/video-download', videoDownloadRoutes],
  ['/api/tracks', tracksRoutes],
  ['/api/rounds', roundsRoutes],
  ['/api/music-video', musicVideoRoutes],
  ['/api/loras', lorasRoutes],
  ['/api/video-timeline', videoTimelineRoutes],
];

beforeEach(() => {
  vi.clearAllMocks();
  state.enabled = false;
});

describe('media process execution operator authority', () => {
  it('refuses a remote caller before spawning a host process', async () => {
    const [path, body, effect] = routes[0];
    await expectRemoteRefusal(mounts, ['post', path, body, effect]);
  });

  it('keeps every process-starting route working for local and delegated-agent callers', async () => {
    await expectAuthorizedWorkflows({
      auth: state, mounts,
      workflows: routes.map(([path, body, effect]) => ['post', path, body, effect, path.endsWith('/render') || path.endsWith('/effect') ? 200 : 202]),
    });
  });

  it('reaches the cover font upload handler for a local caller (#12493)', async () => {
    // Past the gate, the upload middleware rejects a JSON body (not multipart).
    const local = await callRoute(await hostControlApp('127.0.0.1', mounts), ['post', '/api/music-video/publish/cover-fonts', {}]);
    expect([local.status, local.body.code]).toEqual([400, 'INVALID_CONTENT_TYPE']);
    expect(effects.addCoverFont).not.toHaveBeenCalled();
  });

  it('requires operator authority before probing yt-dlp status', async () => {
    const workflow = ['get', '/api/devtools/video-download/yt-dlp', undefined, getYtDlpUpdateStatus, 200];
    await expectRemoteRefusal(mounts, workflow);
    await expectAuthorizedWorkflows({ auth: state, mounts, workflows: [workflow] });
  });

  it('keeps download and LoRA listings open to remote callers', async () => {
    const app = await hostControlApp('192.0.2.10', mounts);
    for (const path of ['/api/devtools/video-download/downloads', '/api/loras']) {
      expect((await callRoute(app, ['get', path])).status, path).toBe(200);
    }
  });
});
