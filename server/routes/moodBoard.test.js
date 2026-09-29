import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// Stub the service graph — this test verifies routing + the pagination envelope,
// not the DB-backed board logic (covered by moodBoard/db.test.js).
vi.mock('../services/moodBoard/index.js', () => ({
  listBoards: vi.fn(async () => []),
  listBoardNames: vi.fn(async () => []),
  getBoard: vi.fn(),
  createBoard: vi.fn(),
  updateBoard: vi.fn(),
  deleteBoard: vi.fn(),
  addBoardItem: vi.fn(),
  backfillGalleryPrompts: vi.fn(),
  updateBoardItem: vi.fn(),
  removeBoardItem: vi.fn(),
  linkPinterestBoard: vi.fn(),
  unlinkPinterestBoard: vi.fn(),
  syncPinterestBoard: vi.fn(),
  importXPost: vi.fn(),
}));

// The synthesis service pulls the aiProvider/promptRunner stack — stub it so
// this stays a routing test (service behavior is covered in its own suite).
vi.mock('../services/moodBoardStyleSynthesis.js', () => ({
  synthesizeBoardStyle: vi.fn(),
}));

vi.mock('../services/moodBoardCompositeStyle.js', () => ({
  composeBoardPrompt: vi.fn(),
}));

import * as svc from '../services/moodBoard/index.js';
import { synthesizeBoardStyle } from '../services/moodBoardStyleSynthesis.js';
import { composeBoardPrompt } from '../services/moodBoardCompositeStyle.js';
import moodBoardRoutes from './moodBoard.js';

const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/mood-boards', moodBoardRoutes);
  app.use(errorMiddleware);
  return app;
};

describe('mood-board routes', () => {
  beforeEach(() => vi.clearAllMocks());

  it('GET /names serves the picker projection rather than a board lookup', async () => {
    svc.listBoardNames.mockResolvedValueOnce([{ id: 'mb-1', name: 'A' }]);
    const res = await request(makeApp()).get('/api/mood-boards/names');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([{ id: 'mb-1', name: 'A' }]);
    expect(svc.getBoard).not.toHaveBeenCalled();
  });

  describe('GET /', () => {
    it('returns the full boards array by default', async () => {
      svc.listBoards.mockResolvedValueOnce([{ id: 'mb-1', name: 'A' }]);
      const res = await request(makeApp()).get('/api/mood-boards');
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect(res.body).toHaveLength(1);
    });

    it('returns a bounded envelope when pagination is requested', async () => {
      svc.listBoards.mockResolvedValueOnce(
        Array.from({ length: 5 }, (_, i) => ({ id: `mb-${i}`, name: `B${i}` }))
      );
      const res = await request(makeApp()).get('/api/mood-boards?limit=2&offset=1');
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(2);
      expect(res.body.items[0].id).toBe('mb-1');
      expect(res.body.total).toBe(5);
      expect(res.body.limit).toBe(2);
      expect(res.body.offset).toBe(1);
    });
  });

  describe('GET /:id', () => {
    it('returns 404 when the board is missing', async () => {
      svc.getBoard.mockResolvedValueOnce(null);
      const res = await request(makeApp()).get('/api/mood-boards/nope');
      expect(res.status).toBe(404);
    });

    it('returns the board when found', async () => {
      svc.getBoard.mockResolvedValueOnce({ id: 'mb-1', name: 'A' });
      const res = await request(makeApp()).get('/api/mood-boards/mb-1');
      expect(res.status).toBe(200);
      expect(res.body.id).toBe('mb-1');
    });
  });

  describe('POST /:id/synthesize-style (#4188 Phase 4)', () => {
    it('404s when the board is missing', async () => {
      svc.getBoard.mockResolvedValueOnce(null);
      const res = await request(makeApp()).post('/api/mood-boards/nope/synthesize-style').send({});
      expect(res.status).toBe(404);
      expect(synthesizeBoardStyle).not.toHaveBeenCalled();
    });

    it('passes the board and the validated style context to the service', async () => {
      const board = { id: 'mb-1', name: 'A', items: [] };
      svc.getBoard.mockResolvedValueOnce(board);
      synthesizeBoardStyle.mockResolvedValueOnce({ proposed: {}, diff: { hasChanges: false } });
      const res = await request(makeApp()).post('/api/mood-boards/mb-1/synthesize-style').send({
        styleNotes: 'current',
        influences: { embrace: ['a'], avoid: [] },
        locked: { influencesAvoid: true },
        providerId: 'ollama',
        model: 'qwen',
      });
      expect(res.status).toBe(200);
      expect(synthesizeBoardStyle).toHaveBeenCalledWith({
        board,
        styleNotes: 'current',
        influences: { embrace: ['a'], avoid: [] },
        locked: { influencesAvoid: true },
        providerId: 'ollama',
        model: 'qwen',
      });
    });

    it('400s on an unknown body key (strict schema)', async () => {
      const res = await request(makeApp()).post('/api/mood-boards/mb-1/synthesize-style').send({
        universeId: 'w-1',
      });
      expect(res.status).toBe(400);
      expect(synthesizeBoardStyle).not.toHaveBeenCalled();
    });
  });

  describe('POST /:id/compose-prompt', () => {
    it('404s when the board is missing', async () => {
      svc.getBoard.mockResolvedValueOnce(null);
      const res = await request(makeApp()).post('/api/mood-boards/nope/compose-prompt').send({});
      expect(res.status).toBe(404);
      expect(composeBoardPrompt).not.toHaveBeenCalled();
    });

    it('persists the composed style on the board', async () => {
      const board = { id: 'mb-1', name: 'A', items: [] };
      const style = { prompt: 'ink wash dusk', negativePrompt: null, rationale: 'tactile', analyzedItemCount: 1, providerId: 'ollama', model: 'qwen', composedAt: '2026-08-14T00:00:00.000Z' };
      svc.getBoard.mockResolvedValueOnce(board);
      composeBoardPrompt.mockResolvedValueOnce(style);
      svc.updateBoard.mockResolvedValueOnce({ ...board, style });
      const res = await request(makeApp()).post('/api/mood-boards/mb-1/compose-prompt').send({ providerId: 'ollama', model: 'qwen' });
      expect(res.status).toBe(200);
      expect(composeBoardPrompt).toHaveBeenCalledWith({ board, providerId: 'ollama', model: 'qwen' });
      expect(svc.updateBoard).toHaveBeenCalledWith('mb-1', { style });
      expect(res.body.style.prompt).toBe('ink wash dusk');
    });

    it('400s on an unknown body key', async () => {
      const res = await request(makeApp()).post('/api/mood-boards/mb-1/compose-prompt').send({ effort: 'high' });
      expect(res.status).toBe(400);
      expect(composeBoardPrompt).not.toHaveBeenCalled();
    });
  });

  describe('POST /:id/backfill-prompts', () => {
    it('404s when the board is missing and returns the updated board otherwise', async () => {
      svc.backfillGalleryPrompts.mockResolvedValueOnce(null);
      expect((await request(makeApp()).post('/api/mood-boards/nope/backfill-prompts')).status).toBe(404);
      svc.backfillGalleryPrompts.mockResolvedValueOnce({ id: 'mb-1', items: [{ id: 'i1', caption: 'p' }] });
      const res = await request(makeApp()).post('/api/mood-boards/mb-1/backfill-prompts');
      expect(res.status).toBe(200);
      expect(res.body.items[0].caption).toBe('p');
    });
  });

  describe('POST /:id/x-post', () => {
    it('validates the body and passes it to the service', async () => {
      svc.importXPost.mockResolvedValueOnce({ board: { id: 'mb-1' }, added: 2 });
      const res = await request(makeApp()).post('/api/mood-boards/mb-1/x-post').send({ url: 'https://x.com/user/status/1' });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ board: { id: 'mb-1' }, added: 2 });
      expect(svc.importXPost).toHaveBeenCalledWith('mb-1', { url: 'https://x.com/user/status/1' });
    });

    it('400s on a non-http(s) url (schema gate)', async () => {
      const res = await request(makeApp()).post('/api/mood-boards/mb-1/x-post').send({ url: 'not a url' });
      expect(res.status).toBe(400);
      expect(svc.importXPost).not.toHaveBeenCalled();
    });
  });
});
