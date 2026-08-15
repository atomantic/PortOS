import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// Stub the service graph — this test verifies routing + the pagination envelope,
// not the DB-backed board logic (covered by moodBoard/db.test.js).
vi.mock('../services/moodBoard/index.js', () => ({
  listBoards: vi.fn(async () => []),
  getBoard: vi.fn(),
  createBoard: vi.fn(),
  updateBoard: vi.fn(),
  deleteBoard: vi.fn(),
  addBoardItem: vi.fn(),
  updateBoardItem: vi.fn(),
  removeBoardItem: vi.fn(),
  linkPinterestBoard: vi.fn(),
  unlinkPinterestBoard: vi.fn(),
  syncPinterestBoard: vi.fn(),
}));

// The synthesis service pulls the aiProvider/promptRunner stack — stub it so
// this stays a routing test (service behavior is covered in its own suite).
vi.mock('../services/moodBoardStyleSynthesis.js', () => ({
  synthesizeBoardStyle: vi.fn(),
}));

import * as svc from '../services/moodBoard/index.js';
import { synthesizeBoardStyle } from '../services/moodBoardStyleSynthesis.js';
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
});
