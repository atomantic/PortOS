import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { ServerError } from '../lib/errorHandler.js';

vi.mock('../services/musicVideo/projects.js', () => ({
  listProjects: vi.fn(async () => [{ id: 'mv-1', name: 'A' }]),
  getProject: vi.fn(),
  createProject: vi.fn(async (d) => ({ id: 'mv-new', ...d })),
  updateProject: vi.fn(async (id, p) => ({ id, ...p })),
  deleteProject: vi.fn(async () => ({ ok: true })),
  setProjectAnalysis: vi.fn(async (id, analysis) => ({ id, audioAnalysis: analysis, status: 'analyzed' })),
  addProjectScene: vi.fn(async (id, s) => ({ sceneId: 'mvs-1', order: 0, ...s })),
  updateScene: vi.fn(async (id, sceneId, p) => ({ sceneId, ...p })),
  deleteScene: vi.fn(async (id) => ({ id, scenes: [] })),
  reorderProjectScenes: vi.fn(async (id, ids) => ({ id, scenes: ids.map((sceneId, order) => ({ sceneId, order })) })),
  setProjectMidiTranscription: vi.fn(async (id, midi) => ({ id, midiTranscription: midi })),
}));

vi.mock('../services/musicVideo/audioAnalysis.js', () => ({
  analyzeAudioFile: vi.fn(),
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
}));

// Mock the MuScriptor transcription service so the route test doesn't depend
// on a provisioned venv; the route's job is to validate + resolve + dispatch.
vi.mock('../services/audioMidiTranscription.js', () => ({
  startMidiTranscription: vi.fn(async () => ({ jobId: 'midi-job-1', model: 'medium' })),
  attachMidiTranscriptionSseClient: vi.fn(() => true),
  cancelMidiTranscription: vi.fn(() => true),
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
import { analyzeAudioFile } from '../services/musicVideo/audioAnalysis.js';
import { getTrack } from '../services/tracks/index.js';
import * as renderSvc from '../services/musicVideo/render.js';
import * as midiSvc from '../services/audioMidiTranscription.js';
import { planProject } from '../services/musicVideo/planner.js';
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
    expect(r.body).toEqual([{ id: 'mv-1', name: 'A' }]);
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

  it('PATCH /:id updates', async () => {
    const r = await request(app).patch('/api/music-video/mv-1').send({ name: 'Renamed' });
    expect(r.status).toBe(200);
    expect(r.body.name).toBe('Renamed');
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
      expect(svc.setProjectAnalysis).toHaveBeenCalledWith('mv-1', analysis);
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
      expect(planProject).toHaveBeenCalledWith('mv-1', { seedPrompts: undefined, providerId: undefined, model: undefined });
      expect(r.body.scenesAdded).toBe(1);
      expect(r.body.promptsSeeded).toBe(false);
    });

    it('forwards seedPrompts/providerId/model overrides', async () => {
      const r = await request(app).post('/api/music-video/mv-1/plan')
        .send({ seedPrompts: false, providerId: 'p1', model: 'gpt-x' });
      expect(r.status).toBe(200);
      expect(planProject).toHaveBeenCalledWith('mv-1', { seedPrompts: false, providerId: 'p1', model: 'gpt-x' });
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
});
