import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/writersRoom/local.js', () => ({
  listFolders: vi.fn(async () => [{ id: 'wr-folder-1', name: 'Drafts' }]),
  createFolder: vi.fn(async (data) => ({ id: 'wr-folder-new', ...data })),
  deleteFolder: vi.fn(async () => ({ ok: true })),
  listWorks: vi.fn(async () => [{ id: 'wr-work-1', title: 'A' }]),
  createWork: vi.fn(async (data) => ({ id: 'wr-work-new', title: data.title, kind: data.kind || 'short-story' })),
  getWorkWithBody: vi.fn(),
  updateWork: vi.fn(async (id, patch) => ({ id, ...patch })),
  deleteWork: vi.fn(async () => ({ ok: true })),
  saveDraftBody: vi.fn(async (id, body) => ({ manifest: { id }, body })),
  snapshotDraft: vi.fn(async (id) => ({ id, drafts: [{}, {}] })),
  setActiveDraft: vi.fn(async (id, draftId) => ({ id, activeDraftVersionId: draftId })),
  getDraftBody: vi.fn(async () => 'draft body text'),
  listExercises: vi.fn(async () => []),
  createExercise: vi.fn(async (data) => ({ id: 'wr-ex-new', ...data })),
  finishExercise: vi.fn(async (id) => ({ id, status: 'finished' })),
  discardExercise: vi.fn(async (id) => ({ id, status: 'discarded' })),
  ensureWorkMediaCollection: vi.fn(async () => ({ id: 'col-1' })),
}));

vi.mock('../services/writersRoom/characters.js', () => ({
  listCharacters: vi.fn(async () => [{ id: 'wr-char-1', name: 'Aria' }]),
  createCharacter: vi.fn(async (workId, data) => ({ id: 'wr-char-new', name: data.name })),
  updateCharacter: vi.fn(async (workId, charId, data) => ({ id: charId, ...data })),
  deleteCharacter: vi.fn(async () => ({ ok: true })),
}));

vi.mock('../services/writersRoom/settings.js', () => ({
  listSettings: vi.fn(async () => [{ id: 'wr-setting-1', slugline: 'INT. KITCHEN — NIGHT' }]),
  createSetting: vi.fn(async (workId, data) => ({ id: 'wr-setting-new', ...data })),
  updateSetting: vi.fn(async (workId, settingId, data) => ({ id: settingId, ...data })),
  deleteSetting: vi.fn(async () => ({ ok: true })),
}));

vi.mock('../services/writersRoom/evaluator.js', () => ({
  runAnalysis: vi.fn(),
  listAnalyses: vi.fn(async () => []),
  getAnalysis: vi.fn(),
  attachSceneImage: vi.fn(async () => ({})),
}));

vi.mock('../services/mediaCollections.js', () => ({
  addItem: vi.fn(async () => ({ ok: true })),
  ERR_DUPLICATE: 'ERR_DUPLICATE',
}));

import * as svc from '../services/writersRoom/local.js';
import * as charSvc from '../services/writersRoom/characters.js';
import * as settingsSvc from '../services/writersRoom/settings.js';
import writersRoomRoutes from './writersRoom.js';

describe('writersRoom routes', () => {
  let app;

  beforeEach(() => {
    app = express();
    // Match the production parser limit so the schema's 5 MB ceiling, not the
    // express body parser, is what produces the 400 in the body-too-large test.
    app.use(express.json({ limit: '55mb' }));
    app.use('/api/writers-room', writersRoomRoutes);
    app.use(errorMiddleware);
    vi.clearAllMocks();
  });

  describe('folders', () => {
    it('GET /folders returns the list', async () => {
      const r = await request(app).get('/api/writers-room/folders');
      expect(r.status).toBe(200);
      expect(r.body[0].id).toBe('wr-folder-1');
    });

    it('POST /folders rejects empty name', async () => {
      const r = await request(app).post('/api/writers-room/folders').send({ name: '' });
      expect(r.status).toBe(400);
    });

    it('POST /folders accepts valid payload', async () => {
      const r = await request(app).post('/api/writers-room/folders').send({ name: 'Novels' });
      expect(r.status).toBe(201);
      expect(svc.createFolder).toHaveBeenCalledWith({ name: 'Novels' });
    });

    it('DELETE /folders/:id forwards to the service', async () => {
      const r = await request(app).delete('/api/writers-room/folders/wr-folder-1');
      expect(r.status).toBe(200);
      expect(svc.deleteFolder).toHaveBeenCalledWith('wr-folder-1');
    });
  });

  describe('works', () => {
    it('POST /works rejects unknown kind', async () => {
      const r = await request(app).post('/api/writers-room/works').send({ title: 'X', kind: 'manifesto' });
      expect(r.status).toBe(400);
    });

    it('POST /works defaults kind to short-story', async () => {
      const r = await request(app).post('/api/writers-room/works').send({ title: 'Untitled' });
      expect(r.status).toBe(201);
      expect(svc.createWork).toHaveBeenCalledWith({ title: 'Untitled', kind: 'short-story' });
    });

    it('GET /works/:id flattens manifest + activeDraftBody', async () => {
      svc.getWorkWithBody.mockResolvedValue({
        manifest: { id: 'wr-work-1', title: 'A' },
        body: 'prose',
      });
      const r = await request(app).get('/api/writers-room/works/wr-work-1');
      expect(r.status).toBe(200);
      expect(r.body.title).toBe('A');
      expect(r.body.activeDraftBody).toBe('prose');
    });

    it('PATCH /works/:id rejects unknown status', async () => {
      const r = await request(app).patch('/api/writers-room/works/wr-work-1').send({ status: 'wat' });
      expect(r.status).toBe(400);
    });

    it('PATCH /works/:id rejects extra fields (strict schema)', async () => {
      const r = await request(app).patch('/api/writers-room/works/wr-work-1').send({ tags: ['a'] });
      expect(r.status).toBe(400);
    });

    it('DELETE /works/:id forwards to the service', async () => {
      const r = await request(app).delete('/api/writers-room/works/wr-work-1');
      expect(r.status).toBe(200);
      expect(svc.deleteWork).toHaveBeenCalledWith('wr-work-1');
    });
  });

  describe('drafts', () => {
    it('PUT /works/:id/draft rejects body over 5MB', async () => {
      const big = 'x'.repeat(5_000_001);
      const r = await request(app).put('/api/writers-room/works/wr-work-1/draft').send({ body: big });
      expect(r.status).toBe(400);
    });

    it('PUT /works/:id/draft persists and echoes the body', async () => {
      const r = await request(app).put('/api/writers-room/works/wr-work-1/draft').send({ body: 'new prose' });
      expect(r.status).toBe(200);
      expect(svc.saveDraftBody).toHaveBeenCalledWith('wr-work-1', 'new prose');
      expect(r.body.activeDraftBody).toBe('new prose');
    });

    it('POST /works/:id/versions accepts an optional label', async () => {
      const r = await request(app).post('/api/writers-room/works/wr-work-1/versions').send({ label: 'Pre-revision' });
      expect(r.status).toBe(201);
      expect(svc.snapshotDraft).toHaveBeenCalledWith('wr-work-1', { label: 'Pre-revision' });
    });
  });

  describe('exercises', () => {
    it('POST /exercises clamps duration via schema (rejects 30 seconds)', async () => {
      const r = await request(app).post('/api/writers-room/exercises').send({ durationSeconds: 30 });
      expect(r.status).toBe(400);
    });

    it('POST /exercises accepts default duration', async () => {
      const r = await request(app).post('/api/writers-room/exercises').send({});
      expect(r.status).toBe(201);
      expect(svc.createExercise).toHaveBeenCalled();
    });

    it('POST /exercises/:id/finish forwards endingWords', async () => {
      const r = await request(app).post('/api/writers-room/exercises/wr-ex-1/finish').send({ endingWords: 100 });
      expect(r.status).toBe(200);
      expect(svc.finishExercise).toHaveBeenCalledWith('wr-ex-1', { endingWords: 100 });
    });

    it('POST /exercises/:id/discard hits the discard handler', async () => {
      const r = await request(app).post('/api/writers-room/exercises/wr-ex-1/discard');
      expect(r.status).toBe(200);
      expect(svc.discardExercise).toHaveBeenCalledWith('wr-ex-1');
    });
  });

  describe('characters', () => {
    it('GET /works/:id/characters returns the bible', async () => {
      const r = await request(app).get('/api/writers-room/works/wr-work-1/characters');
      expect(r.status).toBe(200);
      expect(r.body[0].id).toBe('wr-char-1');
      expect(charSvc.listCharacters).toHaveBeenCalledWith('wr-work-1');
    });

    it('POST /works/:id/characters rejects empty name (schema validation)', async () => {
      const r = await request(app).post('/api/writers-room/works/wr-work-1/characters').send({ name: '' });
      expect(r.status).toBe(400);
      expect(charSvc.createCharacter).not.toHaveBeenCalled();
    });

    it('POST /works/:id/characters rejects extra/unknown fields (strict schema)', async () => {
      const r = await request(app)
        .post('/api/writers-room/works/wr-work-1/characters')
        .send({ name: 'Mila', wat: 'not allowed' });
      expect(r.status).toBe(400);
    });

    it('POST /works/:id/characters accepts a valid payload', async () => {
      const r = await request(app)
        .post('/api/writers-room/works/wr-work-1/characters')
        .send({ name: 'Mila', physicalDescription: 'tall, copper hair' });
      expect(r.status).toBe(201);
      expect(charSvc.createCharacter).toHaveBeenCalledWith('wr-work-1', {
        name: 'Mila',
        physicalDescription: 'tall, copper hair',
      });
    });

    it('PATCH /works/:id/characters/:characterId forwards a partial update', async () => {
      const r = await request(app)
        .patch('/api/writers-room/works/wr-work-1/characters/wr-char-1')
        .send({ role: 'protagonist' });
      expect(r.status).toBe(200);
      expect(charSvc.updateCharacter).toHaveBeenCalledWith('wr-work-1', 'wr-char-1', { role: 'protagonist' });
    });

    it('PATCH /works/:id/characters/:characterId rejects empty name', async () => {
      const r = await request(app)
        .patch('/api/writers-room/works/wr-work-1/characters/wr-char-1')
        .send({ name: '   ' });
      expect(r.status).toBe(400);
    });

    it('DELETE /works/:id/characters/:characterId forwards to the service', async () => {
      const r = await request(app).delete('/api/writers-room/works/wr-work-1/characters/wr-char-1');
      expect(r.status).toBe(200);
      expect(charSvc.deleteCharacter).toHaveBeenCalledWith('wr-work-1', 'wr-char-1');
    });
  });

  describe('settings', () => {
    it('GET /works/:id/settings returns the bible', async () => {
      const r = await request(app).get('/api/writers-room/works/wr-work-1/settings');
      expect(r.status).toBe(200);
      expect(r.body[0].id).toBe('wr-setting-1');
      expect(settingsSvc.listSettings).toHaveBeenCalledWith('wr-work-1');
    });

    it('POST /works/:id/settings rejects payload missing both slugline and name', async () => {
      const r = await request(app).post('/api/writers-room/works/wr-work-1/settings').send({});
      expect(r.status).toBe(400);
      expect(settingsSvc.createSetting).not.toHaveBeenCalled();
    });

    it('POST /works/:id/settings accepts slugline-only payload', async () => {
      const r = await request(app)
        .post('/api/writers-room/works/wr-work-1/settings')
        .send({ slugline: 'INT. KITCHEN — NIGHT', description: 'cozy' });
      expect(r.status).toBe(201);
      expect(settingsSvc.createSetting).toHaveBeenCalledWith('wr-work-1', {
        slugline: 'INT. KITCHEN — NIGHT',
        description: 'cozy',
      });
    });

    it('POST /works/:id/settings rejects unknown extra fields', async () => {
      const r = await request(app)
        .post('/api/writers-room/works/wr-work-1/settings')
        .send({ slugline: 'INT. ATTIC — DUSK', tags: ['a'] });
      expect(r.status).toBe(400);
    });

    it('PATCH /works/:id/settings/:settingId forwards a partial update', async () => {
      const r = await request(app)
        .patch('/api/writers-room/works/wr-work-1/settings/wr-setting-1')
        .send({ palette: 'amber and ochre' });
      expect(r.status).toBe(200);
      expect(settingsSvc.updateSetting).toHaveBeenCalledWith('wr-work-1', 'wr-setting-1', { palette: 'amber and ochre' });
    });

    it('DELETE /works/:id/settings/:settingId forwards to the service', async () => {
      const r = await request(app).delete('/api/writers-room/works/wr-work-1/settings/wr-setting-1');
      expect(r.status).toBe(200);
      expect(settingsSvc.deleteSetting).toHaveBeenCalledWith('wr-work-1', 'wr-setting-1');
    });
  });
});
