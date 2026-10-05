import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { ServerError } from '../lib/errorHandler.js';
import { mkdtemp, open, rename, rm, symlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { request as httpRequest } from 'http';
import { Readable } from 'stream';
import { startLoopbackServer, closeLoopbackServer } from '../lib/testHelper.js';

vi.mock('../services/musicVideo/sharingCopy.js', () => ({ getSharingCopy: vi.fn(), prepareSharingCopy: vi.fn(), sharingCopyDownload: vi.fn() }));
import { sharingCopyDownload } from '../services/musicVideo/sharingCopy.js';

vi.mock('../services/musicVideo/projects.js', () => ({
  listProjects: vi.fn(async () => [{ id: 'mv-1', name: 'A' }]),
  getProject: vi.fn(),
  createProject: vi.fn(async (d) => ({ id: 'mv-new', ...d })),
  cloneProject: vi.fn(async (id, options) => ({
    id: 'mv-clone', name: options.name || 'A v2', version: 2, parentProjectId: id,
  })),
  updateProject: vi.fn(async (id, p) => ({ id, ...p })),
  deleteProject: vi.fn(async () => ({ ok: true })),
  setProjectAnalysis: vi.fn(async (id, analysis) => ({ id, audioAnalysis: analysis, status: 'analyzed' })),
  addProjectScene: vi.fn(async (_id, s) => ({ sceneId: 'mvs-1', order: 0, ...s })),
  updateScene: vi.fn(async (_id, sceneId, p) => ({ sceneId, ...p })),
  deleteScene: vi.fn(async (id) => ({ id, scenes: [] })),
  reorderProjectScenes: vi.fn(async (id, ids) => ({ id, scenes: ids.map((sceneId, order) => ({ sceneId, order })) })),
  // Scene split (#8977) — exercised against the real store in musicVideoSceneSplit.test.js.
  splitProjectScene: vi.fn(),
  setProjectMidiTranscription: vi.fn(async (id, midi) => ({ id, midiTranscription: midi })),
  // Scene takes (#8965) — exercised against the real store in musicVideoTakes.test.js.
  appendSceneTakes: vi.fn(),
  appendTakesAcrossScenes: vi.fn(),
  selectSceneTake: vi.fn(),
  reviewSceneTake: vi.fn(),
}));

// Keeps the real `buildManualAnalysisFromCached` (pure arithmetic, worth
// exercising for real) and only stubs the two ffmpeg-decode-backed functions.
vi.mock('../services/musicVideo/audioAnalysis.js', async (importOriginal) => ({
  ...(await importOriginal()),
  analyzeAudioFile: vi.fn(),
  analyzeAudioFileManual: vi.fn(),
}));

vi.mock('../services/tracks/index.js', () => ({
  getTrack: vi.fn(),
}));

// Mock the render service so the route test doesn't pull the real ffmpeg/
// video-history/spawn graph; the route's job is to dispatch + stream.
vi.mock('../services/musicVideo/render.js', () => ({
  renderMusicVideo: vi.fn(async () => ({ jobId: 'job-1' })),
  attachRenderSseClient: vi.fn(() => true),
  cancelRender: vi.fn(() => true),
  getActiveRenderJobId: vi.fn(() => null),
}));

// Same posture for the draft excerpt render (#8986) — the route's job is to
// validate + dispatch + stream; the ffmpeg/overlay pipeline is covered in
// excerptRender.js's own tests, and note/delete persistence in
// musicVideoExcerpt.test.js against the real file-backed store.
vi.mock('../services/musicVideo/excerptRender.js', () => ({
  startExcerptRender: vi.fn(async () => ({ jobId: 'mve-job-1', excerptId: 'mve-job-1' })),
  attachExcerptRenderSseClient: vi.fn(() => true),
  cancelExcerptRender: vi.fn(() => true),
}));
vi.mock('../services/musicVideo/excerptService.js', () => ({
  deleteExcerpt: vi.fn(async (id) => ({ id })),
  addReviewNote: vi.fn(async (id, _excerptId, input) => ({ project: { id }, note: { id: 'mvn-1', ...input } })),
  editReviewNote: vi.fn(async (id, _excerptId, noteId, patch) => ({ project: { id }, note: { id: noteId, ...patch } })),
  deleteReviewNote: vi.fn(async (id) => ({ id })),
}));

// Mock the MuScriptor transcription service so the route test doesn't depend
// on a provisioned venv; the route's job is to validate + resolve + dispatch.
vi.mock('../services/audioMidiTranscription.js', () => ({
  startMidiTranscription: vi.fn(async () => ({ jobId: 'midi-job-1', model: 'medium' })),
  attachMidiTranscriptionSseClient: vi.fn(() => true),
  cancelMidiTranscription: vi.fn(() => true),
  getActiveMidiTranscriptionJobId: vi.fn(() => null),
}));

vi.mock('../services/musicVideo/lyricAlign.js', () => ({
  alignProjectLyrics: vi.fn(async (id, opts) => ({ id, lyricCues: [], cueId: opts?.cueId || null })),
}));

vi.mock('../services/musicVideo/planner.js', () => ({
  planProject: vi.fn(async (id) => ({
    project: { id, scenes: [{ sceneId: 'mvs-1' }] },
    scenesAdded: 1,
    promptsSeeded: false,
    promptsSkippedReason: 'no-provider',
  })),
}));

import * as svc from '../services/musicVideo/projects.js';
import { analyzeAudioFile, analyzeAudioFileManual } from '../services/musicVideo/audioAnalysis.js';
import { getTrack } from '../services/tracks/index.js';
import * as renderSvc from '../services/musicVideo/render.js';
import * as excerptRenderSvc from '../services/musicVideo/excerptRender.js';
import * as excerptSvc from '../services/musicVideo/excerptService.js';
import * as midiSvc from '../services/audioMidiTranscription.js';
import { planProject } from '../services/musicVideo/planner.js';
import { alignProjectLyrics } from '../services/musicVideo/lyricAlign.js';
import musicVideoRoutes from './musicVideo.js';

describe('musicVideo routes', () => {
  let app;
  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/music-video', musicVideoRoutes);
    vi.clearAllMocks();
  });

  it('GET / lists projects', async () => {
    const r = await request(app).get('/api/music-video');
    expect(r.status).toBe(200);
    expect(r.body).toHaveLength(1);
    expect(r.body[0]).toMatchObject({ id: 'mv-1', name: 'A' });
    expect(r.body[0].productionReadiness).toMatchObject({ readyForProduction: false, art: { approved: false } });
  });

  it('GET /:id carries server-computed productionReadiness so stages derive from one record (#10136)', async () => {
    svc.getProject.mockResolvedValue({ id: 'mv-1', name: 'A' });
    const r = await request(app).get('/api/music-video/mv-1');
    expect(r.status).toBe(200);
    expect(r.body.productionReadiness).toMatchObject({
      art: { approved: false }, storyboard: { approved: false }, proof: { approved: false },
    });
  });

  it('GET /midi-sources returns only the newest transcription per track, trimmed (#10203)', async () => {
    const mk = (id, trackId, createdAt) => ({
      id, name: id, trackId, scenes: [{ big: true }],
      midiTranscription: createdAt ? { filename: `${id}.mid`, model: 'm', createdAt, notes: [1, 2] } : null,
    });
    svc.listProjects.mockResolvedValueOnce([
      mk('mv-old', 't1', '2026-01-01'), mk('mv-new', 't1', '2026-02-01'),
      mk('mv-none', 't1', null), mk('mv-other', 't2', '2026-01-05'), mk('mv-unlinked', null, '2026-03-01'),
    ]);
    const r = await request(app).get('/api/music-video/midi-sources');
    expect(r.status).toBe(200);
    expect(r.body).toEqual([
      { trackId: 't1', id: 'mv-new', name: 'mv-new', midiTranscription: { filename: 'mv-new.mid', model: 'm', createdAt: '2026-02-01' } },
      { trackId: 't2', id: 'mv-other', name: 'mv-other', midiTranscription: { filename: 'mv-other.mid', model: 'm', createdAt: '2026-01-05' } },
    ]);
  });

  it('GET / returns a bounded envelope when pagination is requested', async () => {
    svc.listProjects.mockResolvedValueOnce(
      Array.from({ length: 5 }, (_, i) => ({ id: `mv-${i}`, name: `P${i}` }))
    );
    const r = await request(app).get('/api/music-video?limit=2&offset=1');
    expect(r.status).toBe(200);
    expect(r.body.items).toHaveLength(2);
    expect(r.body.items[0].id).toBe('mv-1');
    expect(r.body.total).toBe(5);
    expect(r.body.limit).toBe(2);
    expect(r.body.offset).toBe(1);
  });

  it('GET /?summary=1 returns bounded summary projections with cursor pagination (#10169)', async () => {
    const p1 = {
      id: 'mv-older',
      name: 'Older Project',
      version: 1,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      scenes: [{ sceneId: 's1' }],
      productionRuns: [{ status: 'complete', usage: { spentUsd: 1.25 } }],
    };
    const p2 = {
      id: 'mv-newer',
      name: 'Newer Project',
      version: 2,
      rootProjectId: 'mv-root',
      createdAt: '2026-02-01T00:00:00Z',
      updatedAt: '2026-02-01T00:00:00Z',
      scenes: [{ sceneId: 's1' }, { sceneId: 's2' }],
      productionRuns: [{ status: 'running', limits: { spendCapUsd: 5.0 }, usage: { spentUsd: 0.5 } }],
    };
    svc.listProjects.mockResolvedValue([p1, p2]);

    // Page 1: limit=1
    const r1 = await request(app).get('/api/music-video?summary=1&limit=1');
    expect(r1.status).toBe(200);
    expect(r1.body.total).toBe(2);
    expect(r1.body.limit).toBe(1);
    expect(r1.body.offset).toBe(0);
    expect(r1.body.nextCursor).toBe('1');
    expect(r1.body.items).toHaveLength(1);

    const first = r1.body.items[0];
    expect(first.id).toBe('mv-newer');
    expect(first.name).toBe('Newer Project');
    expect(first.version).toBe(2);
    expect(first.rootProjectId).toBe('mv-root');
    expect(first.versionRoot).toBe('mv-root');
    expect(first.stage).toBe('produce');
    expect(first.status).toBe('draft');
    expect(first.runStatus).toBe('running');
    expect(first.spend).toMatchObject({ spentUsd: 0.5, capUsd: 5.0, autopilot: 0.5, manual: 0, autoReview: 0 });
    expect(first.updatedAt).toBe('2026-02-01T00:00:00Z');
    expect(first.scenes).toBeUndefined();

    // Page 2: limit=1, cursor=1
    const r2 = await request(app).get(`/api/music-video?summary=1&limit=1&cursor=${r1.body.nextCursor}`);
    expect(r2.status).toBe(200);
    expect(r2.body.total).toBe(2);
    expect(r2.body.offset).toBe(1);
    expect(r2.body.nextCursor).toBeNull();
    expect(r2.body.items).toHaveLength(1);
    expect(r2.body.items[0].id).toBe('mv-older');
  });

  it('GET /:id 404s when missing', async () => {
    svc.getProject.mockResolvedValue(null);
    const r = await request(app).get('/api/music-video/mv-x');
    expect(r.status).toBe(404);
    expect(r.body.code).toBe('NOT_FOUND');
  });

  it('POST / creates after Zod validation', async () => {
    const r = await request(app).post('/api/music-video').send({ name: 'New', mode: 'director' });
    expect(r.status).toBe(201);
    expect(r.body.name).toBe('New');
  });

  it('POST / rejects an invalid body (unknown mode)', async () => {
    const r = await request(app).post('/api/music-video').send({ name: 'New', mode: 'wat' });
    expect(r.status).toBe(400);
    expect(svc.createProject).not.toHaveBeenCalled();
  });

  it('POST / rejects a missing name', async () => {
    const r = await request(app).post('/api/music-video').send({ mode: 'director' });
    expect(r.status).toBe(400);
  });

  it('POST /:id/clone creates the next version and accepts an optional name', async () => {
    const r = await request(app).post('/api/music-video/mv-1/clone')
      .send({ name: 'Director Cut', includeGeneratedMedia: true });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ id: 'mv-clone', name: 'Director Cut', version: 2, parentProjectId: 'mv-1' });
    expect(svc.cloneProject).toHaveBeenCalledWith('mv-1', {
      name: 'Director Cut',
      includeGeneratedMedia: true,
    });
  });

  it('POST /:id/clone accepts an explicit video-generation variant', async () => {
    const r = await request(app).post('/api/music-video/mv-1/clone').send({ variant: 'video-generation' });
    expect(r.status).toBe(201);
    expect(svc.cloneProject).toHaveBeenCalledWith('mv-1', { variant: 'video-generation' });
  });

  it('POST /:id/clone rejects unsupported options', async () => {
    const r = await request(app).post('/api/music-video/mv-1/clone').send({ copyFinalRender: true });
    expect(r.status).toBe(400);
    expect(svc.cloneProject).not.toHaveBeenCalled();
  });

  it('PATCH /:id validates an image-free production bible and bounds its subjects', async () => {
    const concept = { universeId: 'u1', universeStyle: 'Ink silhouettes', moodBoardStyle: 'Watercolor', subjects: [
      { id: 'lead', kind: 'character', role: 'protagonist', name: 'Example singer', description: 'Silver coat' },
      { id: 'place', kind: 'place', name: 'Example stage' },
    ] };
    const saved = await request(app).patch('/api/music-video/mv-1').send({ concept });
    expect(saved.status).toBe(200);
    expect(saved.body.concept).toEqual(concept);
    const rejected = await request(app).patch('/api/music-video/mv-1').send({ concept: { subjects: Array(25).fill(concept.subjects[0]) } });
    expect(rejected.status).toBe(400);
    const invalidKind = await request(app).patch('/api/music-video/mv-1').send({ concept: { subjects: [{ ...concept.subjects[0], kind: 'unknown' }] } });
    expect(invalidKind.status).toBe(400);
  });

  it('PATCH /:id updates', async () => {
    const r = await request(app).patch('/api/music-video/mv-1').send({ name: 'Renamed' });
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('Renamed');
  });

  it('PATCH /:id accepts bounded project video-renderer settings', async () => {
    const videoSettings = {
      backend: 'local',
      modelId: 'ltx23_dgrauet_q4',
      grokDuration: 10,
      generationMode: 'audioReactive',
      audioReactiveLora: 'audio-reactive.safetensors',
      audioReactiveScale: 1.2,
    };
    const r = await request(app).patch('/api/music-video/mv-1').send({ videoSettings });
    expect(r.status).toBe(200);
    expect(svc.updateProject).toHaveBeenCalledWith('mv-1', { videoSettings });
  });

  it('PATCH /:id accepts the fal.ai video backend with a bounded clip duration, model and resolutions (#8968)', async () => {
    const videoSettings = {
      backend: 'fal', falDuration: 6, falModelId: 'minimax/h3-max/image-to-video', falResolution: '1080P', falLipSyncResolution: '2K',
    };
    const r = await request(app).patch('/api/music-video/mv-1').send({ videoSettings });
    expect(r.status).toBe(200);
    expect(svc.updateProject).toHaveBeenCalledWith('mv-1', { videoSettings });
  });

  it('PATCH /:id rejects an out-of-range fal.ai clip duration or a lip-sync resolution fal does not offer', async () => {
    for (const videoSettings of [{ backend: 'fal', falDuration: 90 }, { backend: 'fal', falLipSyncResolution: '720p' }]) {
      const r = await request(app).patch('/api/music-video/mv-1').send({ videoSettings });
      expect(r.status).toBe(400);
    }
    expect(svc.updateProject).not.toHaveBeenCalled();
  });

  it('PATCH /:id/scenes/:sceneId sets a scene to a performance shot and rejects an unknown shot mode (#8977)', async () => {
    const ok = await request(app).patch('/api/music-video/mv-1/scenes/mvs-1').send({ shotMode: 'performance' });
    expect(ok.status).toBe(200);
    expect(svc.updateScene).toHaveBeenCalledWith('mv-1', 'mvs-1', { shotMode: 'performance' });
    const bad = await request(app).patch('/api/music-video/mv-1/scenes/mvs-1').send({ shotMode: 'karaoke' });
    expect(bad.status).toBe(400);
    expect(svc.updateScene).toHaveBeenCalledTimes(1);
  });

  it('PATCH /:id accepts null to clear the project video-backend pin', async () => {
    const videoSettings = { backend: null };
    const r = await request(app).patch('/api/music-video/mv-1').send({ videoSettings });
    expect(r.status).toBe(200);
    expect(svc.updateProject).toHaveBeenCalledWith('mv-1', { videoSettings });
  });

  it('PATCH /:id rejects invalid video-renderer settings', async () => {
    const r = await request(app).patch('/api/music-video/mv-1')
      .send({ videoSettings: { backend: 'cloud-surprise', grokDuration: 9 } });
    expect(r.status).toBe(400);
    expect(svc.updateProject).not.toHaveBeenCalled();
  });

  it('PATCH /:id rejects an out-of-range pacing ceiling or an oversized lyric line', async () => {
    const pacing = await request(app).patch('/api/music-video/mv-1').send({ pacing: { maxShotSec: 0 } });
    expect(pacing.status).toBe(400);
    const cue = await request(app).patch('/api/music-video/mv-1')
      .send({ lyricCues: [{ text: 'x'.repeat(501), startSec: 1 }] });
    expect(cue.status).toBe(400);
    expect(svc.updateProject).not.toHaveBeenCalled();
  });

  it('PATCH /:id accepts a composition manifest and refuses an unknown motion template (#8984)', async () => {
    const bad = await request(app).patch('/api/music-video/mv-1')
      .send({ composition: { mode: 'composed', textCues: [{ text: 'hi', startSec: 1, endSec: 2, template: 'explode' }] } });
    expect(bad.status).toBe(400);
    expect(svc.updateProject).not.toHaveBeenCalled();
    const composition = { mode: 'composed', textCues: [{ text: 'hi', startSec: 1, endSec: 2, template: 'pop', placement: 'upper' }], posterSec: 1.5 };
    const ok = await request(app).patch('/api/music-video/mv-1').send({ composition });
    expect(ok.status).toBe(200);
    expect(svc.updateProject).toHaveBeenCalledWith('mv-1', { composition });
  });

  it('PATCH /:id takes an explicit sound-design bed, refuses a bed louder than the song, and clears it with null (#8988)', async () => {
    const loud = await request(app).patch('/api/music-video/mv-1').send({ soundBed: { trackId: 'trk-rain', volume: 1.5 } });
    expect(loud.status).toBe(400);
    expect(svc.updateProject).not.toHaveBeenCalled();
    const ok = await request(app).patch('/api/music-video/mv-1').send({ soundBed: { trackId: 'trk-rain', volume: 0.25 } });
    expect(ok.status).toBe(200);
    const cleared = await request(app).patch('/api/music-video/mv-1').send({ soundBed: null });
    expect(cleared.status).toBe(200);
    expect(svc.updateProject).toHaveBeenLastCalledWith('mv-1', { soundBed: null });
  });

  describe('POST /:id/lyrics/import (#8964)', () => {
    it('replaces the cue list with the parsed LRC and reports the detected format', async () => {
      svc.getProject.mockResolvedValue({ id: 'mv-1', lyricCues: [{ id: 'lc-old', text: 'old', startSec: 1, endSec: 2 }] });
      const r = await request(app).post('/api/music-video/mv-1/lyrics/import')
        .send({ text: '[00:01.00]one\n[00:03.00]two' });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ imported: 2, format: 'lrc' });
      expect(svc.updateProject).toHaveBeenCalledWith('mv-1', {
        lyricCues: [{ text: 'one', startSec: 1, endSec: 3 }, { text: 'two', startSec: 3, endSec: null }],
        lyricMarkers: [],
      });
    });

    it('appends plain lines after the existing cues, anchoring the sheet\'s markers after them', async () => {
      const existing = { id: 'lc-old', text: 'old', startSec: 1, endSec: 2 };
      const marker = { type: 'section', label: 'Verse 1', kind: 'verse', line: 0 };
      svc.getProject.mockResolvedValue({ id: 'mv-1', lyricCues: [existing], lyricMarkers: [marker] });
      const r = await request(app).post('/api/music-video/mv-1/lyrics/import')
        .send({ text: '[Chorus]\nnew line\n[Shouts]', mode: 'append' });
      expect(r.status).toBe(200);
      expect(svc.updateProject).toHaveBeenCalledWith('mv-1', {
        lyricCues: [existing, { text: 'new line', startSec: null, endSec: null }],
        lyricMarkers: [
          marker,
          { type: 'section', label: 'Chorus', kind: 'chorus', line: 1 },
          { type: 'direction', label: 'Shouts', kind: 'shouted', line: 2 },
        ],
      });
    });

    it('422s when the text holds no lyric lines, and 404s for a missing project', async () => {
      svc.getProject.mockResolvedValue({ id: 'mv-1', lyricCues: [] });
      const empty = await request(app).post('/api/music-video/mv-1/lyrics/import').send({ text: '[Chorus]\n\n' });
      expect(empty.status).toBe(422);
      svc.getProject.mockResolvedValue(null);
      const missing = await request(app).post('/api/music-video/mv-x/lyrics/import').send({ text: 'a' });
      expect(missing.status).toBe(404);
      expect(svc.updateProject).not.toHaveBeenCalled();
    });
  });

  describe('POST /:id/lyrics/import-track', () => {
    const SHEET = '[Verse 1]\nWalking home\n[Spoken, close]\nunder neon\n[Chorus]\nHold on';

    it('replaces the lines with the linked track\'s sheet, keeping its headers and directions as markers', async () => {
      svc.getProject.mockResolvedValue({ id: 'mv-1', trackId: 't1', lyricCues: [{ id: 'lc-old', text: 'old' }] });
      getTrack.mockResolvedValue({ id: 't1', lyrics: SHEET });
      const r = await request(app).post('/api/music-video/mv-1/lyrics/import-track').send({});
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ imported: 3, markers: 3, skipped: null });
      expect(svc.updateProject).toHaveBeenCalledWith('mv-1', {
        lyricCues: [
          { text: 'Walking home', startSec: null, endSec: null },
          { text: 'under neon', startSec: null, endSec: null },
          { text: 'Hold on', startSec: null, endSec: null },
        ],
        lyricMarkers: [
          { type: 'section', label: 'Verse 1', kind: 'verse', line: 0 },
          { type: 'direction', label: 'Spoken, close', kind: 'spoken', line: 1 },
          { type: 'section', label: 'Chorus', kind: 'chorus', line: 2 },
        ],
      });
    });

    it('if-empty never replaces lines the project already has, and skips a track with no lyrics', async () => {
      svc.getProject.mockResolvedValue({ id: 'mv-1', trackId: 't1', lyricCues: [{ id: 'lc-1', text: 'mine' }] });
      getTrack.mockResolvedValue({ id: 't1', lyrics: SHEET });
      const kept = await request(app).post('/api/music-video/mv-1/lyrics/import-track').send({ mode: 'if-empty' });
      expect(kept.status).toBe(200);
      expect(kept.body).toMatchObject({ imported: 0, skipped: 'has-lyrics' });

      svc.getProject.mockResolvedValue({ id: 'mv-1', trackId: 't1', lyricCues: [] });
      getTrack.mockResolvedValue({ id: 't1', lyrics: '' });
      const none = await request(app).post('/api/music-video/mv-1/lyrics/import-track').send({ mode: 'if-empty' });
      expect(none.body).toMatchObject({ imported: 0, skipped: 'no-track-lyrics' });
      const explicit = await request(app).post('/api/music-video/mv-1/lyrics/import-track').send({});
      expect(explicit.status).toBe(422);
      expect(explicit.body.code).toBe('NO_TRACK_LYRICS');
      expect(svc.updateProject).not.toHaveBeenCalled();
    });
  });

  describe('POST /:id/lyrics/align (#9074)', () => {
    const alignable = { id: 'mv-1', lyricCues: [{ id: 'lc-1', text: 'walking home' }] };

    // Hold the mocked alignment open so the job stays "running" for the test.
    const holdAlignment = () => {
      let release;
      alignProjectLyrics.mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ id: 'mv-1', lyricCues: [] }); }));
      return () => release();
    };

    it('starts a job only when the route is called, and a second click reuses it (#10155)', async () => {
      svc.getProject.mockResolvedValue(alignable);
      expect(alignProjectLyrics).not.toHaveBeenCalled();
      const release = holdAlignment();
      const first = await request(app).post('/api/music-video/mv-1/lyrics/align').send({});
      expect(first.status).toBe(202);
      expect(first.body.jobId).toEqual(expect.any(String));
      expect(first.body.reused).toBeUndefined();
      const second = await request(app).post('/api/music-video/mv-1/lyrics/align').send({ cueId: 'lc-1' });
      expect(second.status).toBe(202);
      expect(second.body).toEqual({ jobId: first.body.jobId, reused: true });
      expect(alignProjectLyrics).toHaveBeenCalledTimes(1);
      expect(alignProjectLyrics).toHaveBeenCalledWith('mv-1', expect.objectContaining({ cueId: null }));
      const active = await request(app).get('/api/music-video/mv-1/active-jobs');
      expect(active.body).toEqual({ alignment: first.body.jobId, separation: null, midi: null });
      release();
      await vi.waitFor(async () => {
        expect((await request(app).get('/api/music-video/mv-1/active-jobs')).body.alignment).toBeNull();
      });
    });

    it('fails before a job exists when the project or its lyrics are missing', async () => {
      svc.getProject.mockResolvedValue({ id: 'mv-1', lyricCues: [] });
      const none = await request(app).post('/api/music-video/mv-1/lyrics/align').send({});
      expect(none.status).toBe(400);
      expect(none.body.code).toBe('NO_LYRICS');
      svc.getProject.mockResolvedValue(alignable);
      const gone = await request(app).post('/api/music-video/mv-1/lyrics/align').send({ cueId: 'lc-gone' });
      expect(gone.status).toBe(404);
      expect(alignProjectLyrics).not.toHaveBeenCalled();
    });

    it('cancels a running job and 404s the stream of an unknown one', async () => {
      svc.getProject.mockResolvedValue(alignable);
      let isCancelled;
      alignProjectLyrics.mockImplementationOnce((_id, opts) => new Promise((_resolve, reject) => {
        isCancelled = opts.isCancelled;
        const timer = setInterval(() => {
          if (opts.isCancelled()) { clearInterval(timer); reject(Object.assign(new Error('cancelled'), { canceled: true })); }
        }, 5);
      }));
      const { body: { jobId } } = await request(app).post('/api/music-video/mv-1/lyrics/align').send({});
      expect(isCancelled()).toBe(false);
      const cancel = await request(app).post(`/api/music-video/lyrics/align/${jobId}/cancel`);
      expect(cancel.body).toEqual({ ok: true });
      await vi.waitFor(async () => {
        expect((await request(app).get('/api/music-video/mv-1/active-jobs')).body.alignment).toBeNull();
      });
      expect((await request(app).get('/api/music-video/lyrics/align/nope/events')).status).toBe(404);
    });

    it('rejects an unknown body and a cue id the schema cannot store', async () => {
      const extra = await request(app).post('/api/music-video/mv-1/lyrics/align').send({ force: true });
      expect(extra.status).toBe(400);
      const blank = await request(app).post('/api/music-video/mv-1/lyrics/align').send({ cueId: '' });
      expect(blank.status).toBe(400);
      expect(alignProjectLyrics).not.toHaveBeenCalled();
    });

    it('accepts a lyric cue with word timings and a cue that has none', async () => {
      const words = [
        { w: 'walking', startSec: 0.2, endSec: 0.6, conf: 'matched' },
        { w: 'home', startSec: 0.6, endSec: 1, conf: 'interpolated' },
      ];
      const timed = await request(app).patch('/api/music-video/mv-1').send({
        lyricCues: [{ id: 'lc-1', text: 'walking home', startSec: 0.2, endSec: 1, words }],
      });
      expect(timed.status).toBe(200);
      expect(svc.updateProject).toHaveBeenCalledWith('mv-1', expect.objectContaining({
        lyricCues: [expect.objectContaining({ words })],
      }));
      const legacy = await request(app).patch('/api/music-video/mv-1').send({
        lyricCues: [{ text: 'walking home', startSec: null, endSec: null }],
      });
      expect(legacy.status).toBe(200);
      const bad = await request(app).patch('/api/music-video/mv-1').send({
        lyricCues: [{ text: 'walking home', words: [{ w: 'walking', startSec: 1, endSec: 0.2, conf: 'guessed' }] }],
      });
      expect(bad.status).toBe(400);
    });
  });

  it('DELETE /:id soft-deletes', async () => {
    const r = await request(app).delete('/api/music-video/mv-1');
    expect(r.status).toBe(200);
    expect(svc.deleteProject).toHaveBeenCalledWith('mv-1');
  });

  describe('POST /:id/analyze', () => {
    it('400s when the project has no audio source', async () => {
      svc.getProject.mockResolvedValue({ id: 'mv-1', trackId: null, uploadedAudioFilename: null });
      const r = await request(app).post('/api/music-video/mv-1/analyze');
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('NO_AUDIO');
    });

    it('404s when the linked track is missing', async () => {
      svc.getProject.mockResolvedValue({ id: 'mv-1', trackId: 't-gone' });
      getTrack.mockResolvedValue(null);
      const r = await request(app).post('/api/music-video/mv-1/analyze');
      expect(r.status).toBe(404);
    });

    it('400s on a path-traversal audio filename', async () => {
      svc.getProject.mockResolvedValue({ id: 'mv-1', uploadedAudioFilename: '../../etc/passwd' });
      const r = await request(app).post('/api/music-video/mv-1/analyze');
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('VALIDATION_ERROR');
    });

    it('422s when the analyzer cannot decode', async () => {
      svc.getProject.mockResolvedValue({ id: 'mv-1', trackId: 't1' });
      getTrack.mockResolvedValue({ id: 't1', audioFilename: 'song.wav' });
      analyzeAudioFile.mockResolvedValue(null);
      const r = await request(app).post('/api/music-video/mv-1/analyze');
      expect(r.status).toBe(422);
      expect(r.body.code).toBe('ANALYZE_FAILED');
    });

    it('caches the analysis and returns the updated project', async () => {
      svc.getProject.mockResolvedValue({ id: 'mv-1', trackId: 't1' });
      getTrack.mockResolvedValue({ id: 't1', audioFilename: 'song.wav' });
      const analysis = { bpm: 120, beats: [0], downbeats: [0], sections: [], durationSec: 5 };
      analyzeAudioFile.mockResolvedValue(analysis);
      const r = await request(app).post('/api/music-video/mv-1/analyze');
      expect(r.status).toBe(200);
      expect(r.body.audioAnalysis).toEqual(analysis);
      expect(svc.setProjectAnalysis).toHaveBeenCalledWith('mv-1', analysis, { id: 'mv-1', trackId: 't1' });
    });
  });

  describe('POST /:id/analyze/manual', () => {
    it('400s on an out-of-range BPM', async () => {
      const r = await request(app).post('/api/music-video/mv-1/analyze/manual').send({ bpm: 400 });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('VALIDATION_ERROR');
    });

    it('400s when the project has no audio source', async () => {
      svc.getProject.mockResolvedValue({ id: 'mv-1', trackId: null, uploadedAudioFilename: null });
      const r = await request(app).post('/api/music-video/mv-1/analyze/manual').send({ bpm: 120 });
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('NO_AUDIO');
    });

    it('422s when the decoder cannot decode', async () => {
      svc.getProject.mockResolvedValue({ id: 'mv-1', trackId: 't1' });
      getTrack.mockResolvedValue({ id: 't1', audioFilename: 'song.wav' });
      analyzeAudioFileManual.mockResolvedValue(null);
      const r = await request(app).post('/api/music-video/mv-1/analyze/manual').send({ bpm: 120 });
      expect(r.status).toBe(422);
      expect(r.body.code).toBe('ANALYZE_FAILED');
    });

    it('caches the manual analysis, passing bpm/offsetSec through to the builder', async () => {
      svc.getProject.mockResolvedValue({ id: 'mv-1', trackId: 't1' });
      getTrack.mockResolvedValue({ id: 't1', audioFilename: 'song.wav' });
      const analysis = { bpm: 128, beats: [0.25], downbeats: [0.25], sections: [], durationSec: 5 };
      analyzeAudioFileManual.mockResolvedValue(analysis);
      const r = await request(app).post('/api/music-video/mv-1/analyze/manual').send({ bpm: 128, offsetSec: 0.25 });
      expect(r.status).toBe(200);
      expect(r.body.audioAnalysis).toEqual(analysis);
      expect(analyzeAudioFileManual).toHaveBeenCalledWith(expect.stringContaining('song.wav'), { bpm: 128, offsetSec: 0.25 });
      expect(svc.setProjectAnalysis).toHaveBeenCalledWith('mv-1', analysis, { id: 'mv-1', trackId: 't1' });
    });

    it('skips the ffmpeg decode and reuses cached sections/durationSec when a prior analysis exists', async () => {
      const cachedSections = [{ label: 'Section 1', startSec: 0, endSec: 20, energy: 1 }];
      svc.getProject.mockResolvedValue({
        id: 'mv-1',
        trackId: 't1',
        audioAnalysis: { bpm: null, beats: [], downbeats: [], sections: cachedSections, durationSec: 20 },
      });
      const r = await request(app).post('/api/music-video/mv-1/analyze/manual').send({ bpm: 100, offsetSec: 0.5 });
      expect(r.status).toBe(200);
      expect(analyzeAudioFileManual).not.toHaveBeenCalled();
      expect(getTrack).not.toHaveBeenCalled(); // never needed to resolve the audio path
      expect(r.body.audioAnalysis.sections).toEqual(cachedSections);
      expect(r.body.audioAnalysis.durationSec).toBe(20);
      expect(r.body.audioAnalysis.bpm).toBe(100);
      expect(r.body.audioAnalysis.beats[0]).toBeCloseTo(0.5, 3);

    });
  });

  describe('POST /:id/transcribe-midi', () => {
    it('202s with the jobId, resolving the project audio like analyze', async () => {
      svc.getProject.mockResolvedValue({ id: 'mv-1', name: 'Neon', trackId: 't1' });
      getTrack.mockResolvedValue({ id: 't1', audioFilename: 'song.wav' });
      const r = await request(app).post('/api/music-video/mv-1/transcribe-midi').send({ model: 'small' });
      expect(r.status).toBe(202);
      expect(r.body.jobId).toBe('midi-job-1');
      const call = midiSvc.startMidiTranscription.mock.calls[0][0];
      expect(call.audioPath).toMatch(/song\.wav$/);
      expect(call.model).toBe('small');
      expect(call.outputName).toBe('Neon-midi');
      // Lands in the music dir (not uploads) so the peer-sync asset manifest
      // federates the .mid with the project's other audio.
      expect(call.destDir).toMatch(/music$/);
      expect(typeof call.onComplete).toBe('function');
    });

    it('onComplete persists the pointer on the project and returns it for the SSE frame', async () => {
      svc.getProject.mockResolvedValue({ id: 'mv-1', name: 'Neon', trackId: 't1' });
      getTrack.mockResolvedValue({ id: 't1', audioFilename: 'song.wav' });
      await request(app).post('/api/music-video/mv-1/transcribe-midi').send({});
      const { onComplete } = midiSvc.startMidiTranscription.mock.calls[0][0];
      const extra = await onComplete({ filename: 'neon-midi.mid', model: 'medium' });
      expect(svc.setProjectMidiTranscription).toHaveBeenCalledWith('mv-1', expect.objectContaining({
        filename: 'neon-midi.mid', model: 'medium',
      }));
      expect(extra.midiTranscription.filename).toBe('neon-midi.mid');
    });

    it('onComplete drops a stale result when the audio source changed mid-transcription', async () => {
      svc.getProject.mockResolvedValueOnce({ id: 'mv-1', name: 'Neon', trackId: 't1' }); // kickoff read
      getTrack.mockResolvedValue({ id: 't1', audioFilename: 'song.wav' });
      await request(app).post('/api/music-video/mv-1/transcribe-midi').send({});
      const { onComplete } = midiSvc.startMidiTranscription.mock.calls[0][0];
      // By completion time the project points at a different track — the old
      // audio's MIDI must not be re-attached (applyProjectPatch cleared it).
      svc.getProject.mockResolvedValueOnce({ id: 'mv-1', name: 'Neon', trackId: 't2' });
      const extra = await onComplete({ filename: 'stale.mid', model: 'medium' });
      expect(extra.discarded).toBe(true);
      expect(svc.setProjectMidiTranscription).not.toHaveBeenCalled();
    });

    it('404s when the project is missing', async () => {
      svc.getProject.mockResolvedValue(null);
      const r = await request(app).post('/api/music-video/mv-x/transcribe-midi').send({});
      expect(r.status).toBe(404);
      expect(midiSvc.startMidiTranscription).not.toHaveBeenCalled();
    });

    it('400s when the project has no audio source', async () => {
      svc.getProject.mockResolvedValue({ id: 'mv-1', trackId: null, uploadedAudioFilename: null });
      const r = await request(app).post('/api/music-video/mv-1/transcribe-midi').send({});
      expect(r.status).toBe(400);
      expect(r.body.code).toBe('NO_AUDIO');
    });

    it('rejects an unknown model size', async () => {
      const r = await request(app).post('/api/music-video/mv-1/transcribe-midi').send({ model: 'xl' });
      expect(r.status).toBe(400);
      expect(midiSvc.startMidiTranscription).not.toHaveBeenCalled();
    });

    it('GET /transcribe-midi/:jobId/events 404s for an unknown job', async () => {
      midiSvc.attachMidiTranscriptionSseClient.mockReturnValueOnce(false);
      const r = await request(app).get('/api/music-video/transcribe-midi/nope/events');
      expect(r.status).toBe(404);
    });

    it('POST /transcribe-midi/:jobId/cancel forwards to the service', async () => {
      const r = await request(app).post('/api/music-video/transcribe-midi/midi-job-1/cancel');
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ ok: true });
      expect(midiSvc.cancelMidiTranscription).toHaveBeenCalledWith('midi-job-1');
    });
  });

  describe('POST /:id/plan', () => {
    it('plans with default options when no body is sent', async () => {
      const r = await request(app).post('/api/music-video/mv-1/plan');
      expect(r.status).toBe(200);
      expect(planProject).toHaveBeenCalledWith('mv-1', { seedPrompts: undefined, providerId: undefined, model: undefined, mode: 'require' });
      expect(r.body.scenesAdded).toBe(1);
      expect(r.body.promptsSeeded).toBe(false);
    });

    it('forwards seedPrompts/providerId/model overrides', async () => {
      const r = await request(app).post('/api/music-video/mv-1/plan')
        .send({ seedPrompts: false, providerId: 'p1', model: 'gpt-x' });
      expect(r.status).toBe(200);
      expect(planProject).toHaveBeenCalledWith('mv-1', { seedPrompts: false, providerId: 'p1', model: 'gpt-x', mode: 'require' });
    });

    it.each(['replace', 'append'])('forwards an explicit %s mode', async (mode) => {
      const r = await request(app).post('/api/music-video/mv-1/plan').send({ mode });
      expect(r.status).toBe(200);
      expect(planProject).toHaveBeenCalledWith('mv-1', expect.objectContaining({ mode }));
    });

    it('surfaces the 409 PLAN_MODE_REQUIRED the planner raises for a non-empty board', async () => {
      const { ServerError } = await import('../lib/errorHandler.js');
      planProject.mockRejectedValueOnce(new ServerError('choose', { status: 409, code: 'PLAN_MODE_REQUIRED' }));
      const r = await request(app).post('/api/music-video/mv-1/plan');
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('PLAN_MODE_REQUIRED');
    });

    it('rejects an unknown mode', async () => {
      const r = await request(app).post('/api/music-video/mv-1/plan').send({ mode: 'merge' });
      expect(r.status).toBe(400);
    });

    it('rejects an unknown body field', async () => {
      const r = await request(app).post('/api/music-video/mv-1/plan').send({ bogus: true });
      expect(r.status).toBe(400);
      expect(planProject).not.toHaveBeenCalled();
    });

    it('propagates a 422 from the planner (no cached analysis)', async () => {
      planProject.mockRejectedValueOnce(new ServerError('Project has no analyzed sections to plan from — run Analyze first', { status: 422, code: 'NOT_ANALYZED' }));
      const r = await request(app).post('/api/music-video/mv-1/plan');
      expect(r.status).toBe(422);
      expect(r.body.code).toBe('NOT_ANALYZED');
    });
  });

  describe('scene board', () => {
    it('POST /:id/scenes adds a scene', async () => {
      const r = await request(app).post('/api/music-video/mv-1/scenes').send({ prompt: 'wide shot' });
      expect(r.status).toBe(201);
      expect(r.body.prompt).toBe('wide shot');
    });

    it('POST /:id/scenes rejects endSec < startSec', async () => {
      const r = await request(app).post('/api/music-video/mv-1/scenes').send({ startSec: 9, endSec: 1 });
      expect(r.status).toBe(400);
      expect(svc.addProjectScene).not.toHaveBeenCalled();
    });

    it('PATCH /:id/scenes/:sceneId updates a scene', async () => {
      const r = await request(app).patch('/api/music-video/mv-1/scenes/mvs-1').send({ prompt: 'new' });
      expect(r.status).toBe(200);
      expect(r.body.prompt).toBe('new');
    });

    it('DELETE /:id/scenes/:sceneId removes a scene', async () => {
      const r = await request(app).delete('/api/music-video/mv-1/scenes/mvs-1');
      expect(r.status).toBe(200);
      expect(svc.deleteScene).toHaveBeenCalledWith('mv-1', 'mvs-1');
    });

    it('POST /:id/scenes/reorder reorders', async () => {
      const r = await request(app).post('/api/music-video/mv-1/scenes/reorder').send({ sceneIds: ['b', 'a'] });
      expect(r.status).toBe(200);
      expect(r.body.scenes.map((s) => s.sceneId)).toEqual(['b', 'a']);
    });

    it('POST /:id/scenes/reorder rejects an empty list', async () => {
      const r = await request(app).post('/api/music-video/mv-1/scenes/reorder').send({ sceneIds: [] });
      expect(r.status).toBe(400);
    });
  });

  describe('render (#1760 Phase 2)', () => {
    it('POST /:id/render kicks off the render and returns the jobId', async () => {
      const r = await request(app).post('/api/music-video/mv-1/render').send({});
      expect(r.status).toBe(200);
      expect(renderSvc.renderMusicVideo).toHaveBeenCalledWith('mv-1');
      expect(r.body).toEqual({ jobId: 'job-1' });
    });

    it('POST /:id/render does not collide with /:id/scenes', async () => {
      await request(app).post('/api/music-video/mv-1/render').send({});
      // The render handler ran, not the scene handler.
      expect(svc.addProjectScene).not.toHaveBeenCalled();
    });

    it('GET /:id/render reports the live job without starting a render (#9940)', async () => {
      renderSvc.getActiveRenderJobId.mockReturnValueOnce('job-live');
      const live = await request(app).get('/api/music-video/mv-1/render');
      expect(live.status).toBe(200);
      expect(live.body).toEqual({ jobId: 'job-live' });
      expect(renderSvc.getActiveRenderJobId).toHaveBeenCalledWith('mv-1');
      const idle = await request(app).get('/api/music-video/mv-1/render');
      expect(idle.body).toEqual({ jobId: null });
      // A page reload only READS — it must never kick off a render.
      expect(renderSvc.renderMusicVideo).not.toHaveBeenCalled();
    });

    it('POST /render/:jobId/cancel cancels the job', async () => {
      const r = await request(app).post('/api/music-video/render/job-1/cancel').send({});
      expect(r.status).toBe(200);
      expect(renderSvc.cancelRender).toHaveBeenCalledWith('job-1');
      expect(r.body).toEqual({ ok: true });
    });

    it('GET /render/:jobId/events 404s for an unknown job', async () => {
      renderSvc.attachRenderSseClient.mockReturnValueOnce(false);
      const r = await request(app).get('/api/music-video/render/nope/events');
      expect(r.status).toBe(404);
    });
  });

  describe('draft excerpt render (#8986)', () => {
    it('POST /:id/excerpt validates the range and dispatches to the excerpt render service', async () => {
      const r = await request(app).post('/api/music-video/mv-1/excerpt').send({ startSec: 10, endSec: 20 });
      expect(r.status).toBe(200);
      expect(excerptRenderSvc.startExcerptRender).toHaveBeenCalledWith('mv-1', { startSec: 10, endSec: 20 });
      expect(r.body).toEqual({ jobId: 'mve-job-1', excerptId: 'mve-job-1' });
    });

    it('POST /:id/excerpt rejects a non-forward range before dispatching', async () => {
      const r = await request(app).post('/api/music-video/mv-1/excerpt').send({ startSec: 20, endSec: 10 });
      expect(r.status).toBe(400);
      expect(excerptRenderSvc.startExcerptRender).not.toHaveBeenCalled();
    });

    it('POST /excerpt/:jobId/cancel cancels the job', async () => {
      const r = await request(app).post('/api/music-video/excerpt/mve-1/cancel').send({});
      expect(r.status).toBe(200);
      expect(excerptRenderSvc.cancelExcerptRender).toHaveBeenCalledWith('mve-1');
      expect(r.body).toEqual({ ok: true });
    });

    it('GET /excerpt/:jobId/events 404s for an unknown job', async () => {
      excerptRenderSvc.attachExcerptRenderSseClient.mockReturnValueOnce(false);
      const r = await request(app).get('/api/music-video/excerpt/nope/events');
      expect(r.status).toBe(404);
    });

    it('DELETE /:id/excerpt/:excerptId dispatches to the excerpt service', async () => {
      const r = await request(app).delete('/api/music-video/mv-1/excerpt/mve-1');
      expect(r.status).toBe(200);
      expect(excerptSvc.deleteExcerpt).toHaveBeenCalledWith('mv-1', 'mve-1');
    });

    it('POST /:id/excerpt/:excerptId/notes validates and adds a review note', async () => {
      const r = await request(app).post('/api/music-video/mv-1/excerpt/mve-1/notes').send({ atSec: 3, note: 'lip-sync drifts here' });
      expect(r.status).toBe(201);
      expect(excerptSvc.addReviewNote).toHaveBeenCalledWith('mv-1', 'mve-1', { atSec: 3, note: 'lip-sync drifts here' });
      expect(r.body.note).toMatchObject({ atSec: 3, note: 'lip-sync drifts here' });
    });

    it('POST /:id/excerpt/:excerptId/notes rejects a blank note', async () => {
      const r = await request(app).post('/api/music-video/mv-1/excerpt/mve-1/notes').send({ atSec: 3, note: '' });
      expect(r.status).toBe(400);
      expect(excerptSvc.addReviewNote).not.toHaveBeenCalled();
    });

    it('PATCH /:id/excerpt/:excerptId/notes/:noteId edits a note', async () => {
      const r = await request(app).patch('/api/music-video/mv-1/excerpt/mve-1/notes/mvn-1').send({ verdict: 'approved' });
      expect(r.status).toBe(200);
      expect(excerptSvc.editReviewNote).toHaveBeenCalledWith('mv-1', 'mve-1', 'mvn-1', { verdict: 'approved' });
    });

    it('PATCH /:id/excerpt/:excerptId/notes/:noteId rejects an empty patch', async () => {
      const r = await request(app).patch('/api/music-video/mv-1/excerpt/mve-1/notes/mvn-1').send({});
      expect(r.status).toBe(400);
      expect(excerptSvc.editReviewNote).not.toHaveBeenCalled();
    });

    it('DELETE /:id/excerpt/:excerptId/notes/:noteId dispatches to the excerpt service', async () => {
      const r = await request(app).delete('/api/music-video/mv-1/excerpt/mve-1/notes/mvn-1');
      expect(r.status).toBe(200);
      expect(excerptSvc.deleteReviewNote).toHaveBeenCalledWith('mv-1', 'mve-1', 'mvn-1');
    });
  });
});

it('validates a project moodboard as up to eight bounded gallery images', async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/music-video', musicVideoRoutes);
  const styleReferences = Array.from({ length: 8 }, (_, i) => ({ imageId: `style-${i}.png`, caption: 'silver grain' }));
  const saved = await request(app).patch('/api/music-video/mv-1').send({ styleReferences });
  expect(saved.status).toBe(200);
  expect(saved.body.styleReferences).toEqual(styleReferences);
  for (const refs of [[...styleReferences, styleReferences[0]], [{ imageId: '../escape.png' }], [{ imageId: 'style.png', caption: 'a'.repeat(501) }]]) {
    expect((await request(app).patch('/api/music-video/mv-1').send({ styleReferences: refs })).status).toBe(400);
  }
});

describe('sharing downloads retain verified descriptor ownership', () => {
  const url = '/api/music-video/example/sharing-copy/download';
  async function fixture(run, size = 32) {
    const root = await mkdtemp(join(tmpdir(), 'sharing-http-'));
    const path = join(root, 'copy.mp4');
    await writeFile(path, Buffer.from('0123456789abcdef'.repeat(Math.ceil(size / 16)).slice(0, size)));
    const file = await open(path, 'r');
    const modifiedAt = new Date('2026-01-01T00:00:00Z');
    const copy = { filename: 'sharing.mp4', bytes: size, hash: 'a'.repeat(64) };
    const app = express();
    app.use('/api/music-video', musicVideoRoutes);
    sharingCopyDownload.mockResolvedValue({ file, copy, modifiedAt });
    try { await run({ app, file, path, root, etag: `"${copy.hash}"` }); }
    finally { await file.close(); await rm(root, { recursive: true, force: true }); }
  }

  it.each(['replacement', 'symlink'])('streams the verified descriptor after a %s pathname swap', async swap => fixture(async ({ app, file, path, root }) => {
    await rename(path, `${path}.old`);
    const different = join(root, 'different.mp4');
    await writeFile(different, 'replacement bytes');
    if (swap === 'symlink') await symlink(different, path);
    else await writeFile(path, 'replacement bytes');
    const response = await request(app).get(url);
    expect(response.status).toBe(200);
    expect(response.text).toBe('0123456789abcdef0123456789abcdef');
    expect(response.headers['content-disposition']).toContain('attachment; filename="sharing.mp4"');
    expect(response.headers['content-type']).toContain('video/mp4');
    expect(response.headers['cache-control']).toBe('private, no-store');
    await vi.waitFor(() => expect(file.fd).toBe(-1));
  }));

  it.each([
    ['HEAD', {}, 200, ''],
    ['GET', { Range: 'bytes=2-5' }, 206, '2345'],
    ['GET', { Range: 'bytes=-4' }, 206, 'cdef'],
    ['GET', { Range: 'bytes=999-' }, 416, ''],
    ['GET', { Range: 'invalid' }, 200, '0123456789abcdef0123456789abcdef'],
    ['GET', { Range: 'bytes=0-1,4-5' }, 200, '0123456789abcdef0123456789abcdef'],
    ['GET', { Range: 'bytes=2-5', 'If-Range': '"outdated"' }, 200, '0123456789abcdef0123456789abcdef'],
    ['GET', { 'If-Match': '"outdated"' }, 412, ''],
    ['GET', { 'If-Unmodified-Since': 'Wed, 01 Jan 2025 00:00:00 GMT' }, 412, ''],
  ])('supports %s %j with status %i and closes the descriptor', async (method, headers, status, text) => fixture(async ({ app, file }) => {
    let query = method === 'HEAD' ? request(app).head(url) : request(app).get(url);
    for (const [key, value] of Object.entries(headers)) query = query.set(key, value);
    const response = await query;
    expect(response.status).toBe(status);
    expect(response.text).toBe(text);
    if (status === 206) expect(response.headers['content-range']).toMatch(/^bytes \d+-\d+\/32$/);
    if (status === 416) expect(response.headers['content-range']).toBe('bytes */32');
    await vi.waitFor(() => expect(file.fd).toBe(-1));
  }));

  it('supports conditional 304 and a current If-Range without reopening the path', async () => {
    await fixture(async ({ app, file, etag }) => {
      const response = await request(app).get(url).set('If-None-Match', etag).set('Cache-Control', 'max-age=0');
      expect(response.status).toBe(304);
      expect(response.text).toBe('');
      await vi.waitFor(() => expect(file.fd).toBe(-1));
    });
    await fixture(async ({ app, file, etag }) => {
      const response = await request(app).get(url).set('Range', 'bytes=0-3').set('If-Range', etag);
      expect(response.status).toBe(206);
      expect(response.text).toBe('0123');
      await vi.waitFor(() => expect(file.fd).toBe(-1));
    });
  });

  it('closes the descriptor on client disconnect and stream error', async () => {
    await fixture(async ({ app, file }) => {
      const server = await startLoopbackServer(app);
      try {
        await new Promise((resolve, reject) => {
          const req = httpRequest(`http://127.0.0.1:${server.address().port}${url}`, response => {
            response.once('data', () => { req.destroy(); response.destroy(); resolve(); });
          });
          req.once('error', reject); req.end();
        });
        await vi.waitFor(() => expect(file.fd).toBe(-1));
      } finally { server.closeAllConnections(); await closeLoopbackServer(server); }
    }, 5_000_000);
    await fixture(async ({ app, file }) => {
      vi.spyOn(file, 'createReadStream').mockImplementation(() => new Readable({ read() { this.destroy(new Error('Synthetic read failure')); } }));
      await expect(request(app).get(url)).rejects.toThrow();
      await vi.waitFor(() => expect(file.fd).toBe(-1));
    });
  });
});
