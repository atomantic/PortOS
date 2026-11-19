import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { callRoute, expectAuthorizedWorkflows, expectRemoteRefusal, hostControlApp } from './hostControlTestHarness.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-media-authority-') }));
afterAll(cleanupTempDataRoots);
// Authoring writes are gated by the default-deny policy (#16018); the principal
// matrix lives in services/authGate.test.js. This suite keeps one authorized
// workflow per router plus the per-request splits. Service boundaries are doubled.
const auth = vi.hoisted(() => ({ enabled: false }));
vi.mock('../services/auth.js', async (importOriginal) => ({
  ...await importOriginal(),
  isAuthEnabled: vi.fn(async () => auth.enabled),
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
vi.mock('../services/codeAnimation/soundtrack.js', () => ({
  startCodeAnimationSoundtrack: vi.fn(async () => ({ mediaJobId: 'example-media' })),
  ensureCodeAnimationSoundtrackTrack: vi.fn(async () => ({ trackId: 'example-track' })),
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
vi.mock('../services/musicVideo/songRevision.js', () => ({
  resolveSongRevisionScenes: vi.fn(async () => ({ project: {} })),
  generateSongRevision: vi.fn(async () => ({ project: {} })),
}));
vi.mock('../services/musicVideo/productionReviewService.js', () => ({
  reviseProductionFromFeedback: vi.fn(async () => ({ project: {} })),
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

import codeAnimationRoutes from './codeAnimation.js';
import musicRoutes from './music.js';
import tracksRoutes from './tracks.js';
import musicVideoRoutes from './musicVideo.js';
import { buildCodeAnimationRequest, generateCodeAnimationBrief, } from '../services/codeAnimation/index.js';
import { writeLyrics } from '../services/musicDesigner.js';
import { drawWaveSketchForTrack } from '../services/musicWaveform.js';

import { resolveSongRevisionScenes } from '../services/musicVideo/songRevision.js';
import { reviseProductionFromFeedback } from '../services/musicVideo/productionReviewService.js';
import { planProject } from '../services/musicVideo/planner.js';
import { generateMusicVideoCode, regenerateMusicVideoCodeSection } from '../services/musicVideo/codeGeneration.js';
import { generateMixedMediaDocument, reviseMixedMediaEvents, regenerateMixedMediaSection } from '../services/musicVideo/documentGeneration.js';
import { DIRECTOR_STARTED } from '../services/musicVideo/productionReview.js';
import { startAutoReview, } from '../services/musicVideo/autoReviewService.js';
import { startCastAndSets, } from '../services/musicVideo/castAndSetsService.js';

const id = '00000000-0000-4000-8000-000000000001';
const picker = { providerId: 'example-provider', model: 'example-model' };
const mounts = [
  ['/api/code-animation', codeAnimationRoutes],
  ['/api/music', musicRoutes],
  ['/api/tracks', tracksRoutes],
  ['/api/music-video', musicVideoRoutes],
];

beforeEach(() => {
  vi.clearAllMocks();
  auth.enabled = false;
});

describe('media authoring behind the default-deny gate (#9512, #9869, #16114)', () => {
  it('still runs one authoring entry point per router for a local operator and a delegated agent session', async () => {
    await expectAuthorizedWorkflows({ auth, mounts, workflows: [
      ['post', '/api/code-animation/brief', { seedIdea: 'Example scene', ...picker }, generateCodeAnimationBrief, 200],
      ['post', '/api/music/lyrics', { description: 'Example song', ...picker }, writeLyrics, 200],
      ['post', `/api/tracks/${id}/waveform/draw`, { description: 'Example song', ...picker }, drawWaveSketchForTrack, 200],
      ['post', `/api/music-video/${id}/plan`, { ...picker }, planProject, 200],
    ] });
    // The provider/model selection reaches the service unchanged.
    expect(writeLyrics.mock.lastCall.find(value => value && typeof value === 'object')).toEqual(expect.objectContaining(picker));
  });

  it('marks code and document authoring started from these routes as director-started, and refuses a body that claims it', async () => {
    const forged = { ...picker };
    const workflows = [
      ['post', `/api/music-video/${id}/code/generate`, forged, generateMusicVideoCode, 200],
      ['post', `/api/music-video/${id}/code/sections/a/regenerate`, forged, regenerateMusicVideoCodeSection, 200],
      ['post', `/api/music-video/${id}/composition/document/generate`, forged, generateMixedMediaDocument, 201],
      ['post', `/api/music-video/${id}/composition/document/events/revise`, { ...forged, expectedDraft: 'music-video/example/composition/example' }, reviseMixedMediaEvents, 201],
      ['post', `/api/music-video/${id}/composition/document/sections/a/regenerate`, { ...forged, expectedDraft: 'music-video/example/composition/example' }, regenerateMixedMediaSection, 201],
    ];
    await expectAuthorizedWorkflows({ auth, mounts, workflows });
    auth.enabled = false;
    const claim = await callRoute(await hostControlApp('127.0.0.1', mounts), ['post', `/api/music-video/${id}/code/generate`, { ...picker, startedBy: 'director' }]);
    expect(claim.status).toBe(400);
    for (const [,,, effect] of workflows) {
      expect(effect.mock.lastCall.find(value => value && typeof value === 'object' && 'startedBy' in value).startedBy).toBe(DIRECTOR_STARTED);
    }
  });

  it('refuses a remote caller before authoring and keeps the pinned or default reviewer choice for an agent', async () => {
    await expectRemoteRefusal(mounts, ['post', `/api/music-video/${id}/cast-and-sets`, { ...picker }, startCastAndSets]);
    for (const provider of [{ providerId: 'example-tui', model: 'example-model' }, {}]) {
      await expectAuthorizedWorkflows({ auth, mounts, workflows: [
        ['post', `/api/music-video/${id}/auto-reviews`, { startSec: 0, endSec: 2, limits: { maxAttempts: 1, maxGenerations: 2 }, ...provider }, startAutoReview, 201],
      ] });
      const options = startAutoReview.mock.lastCall.find(value => value && typeof value === 'object' && (value.providerId || value.reviewer));
      const choice = options?.reviewer || options;
      expect(choice?.providerId).toBe(provider.providerId);
      expect(choice?.model).toBe(provider.model);
    }
  });

  it('gates the code-animation prompt with or without a reference video (#13055)', async () => {
    const withVideo = { concept: 'Example scene', referenceVideo: { filename: 'example.mp4' } };
    await expectRemoteRefusal(mounts, ['post', '/api/code-animation/prompt', withVideo, buildCodeAnimationRequest]);
    await expectRemoteRefusal(mounts, ['post', '/api/code-animation/prompt', { concept: 'Example scene', referenceVideo: null }, buildCodeAnimationRequest]);
    await expectAuthorizedWorkflows({ auth, mounts, workflows: [
      ['post', '/api/code-animation/prompt', withVideo, buildCodeAnimationRequest, 200],
    ] });
    expect(buildCodeAnimationRequest).toHaveBeenLastCalledWith(expect.objectContaining({ referenceVideo: expect.objectContaining({ filename: 'example.mp4' }) }));
  });

  it('resolves song-revision remove and dismiss locally without authoring, refusing them remotely', async () => {
    const body = { revisionId: 'example-revision', action: 'remove' };
    await expectRemoteRefusal(mounts, ['post', `/api/music-video/${id}/song-revision/scenes`, body, resolveSongRevisionScenes]);
    await expectAuthorizedWorkflows({ auth, mounts, workflows: [
      ['post', `/api/music-video/${id}/song-revision/scenes`, body, resolveSongRevisionScenes, 200],
    ] });
    expect(resolveSongRevisionScenes).toHaveBeenLastCalledWith(id, body);
    expect(reviseProductionFromFeedback).not.toHaveBeenCalled();
  });
});
