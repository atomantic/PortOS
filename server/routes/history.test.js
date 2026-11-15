import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import historyRoutes from './history.js';

// Mock the history service
vi.mock('../services/history.js', () => ({
  getHistory: vi.fn(),
  getHistoryStats: vi.fn(),
  getActionTypes: vi.fn(),
  deleteEntry: vi.fn(),
  clearHistory: vi.fn()
}));

// Import mocked modules
import * as history from '../services/history.js';

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/history', historyRoutes);
  app.use(errorMiddleware);
  return app;
};

describe('History Routes', () => {
  let app;

  beforeEach(() => {
    app = buildApp();

    // Reset all mocks
    vi.clearAllMocks();
  });

  describe('GET /api/history', () => {
    it('should respect limit parameter', async () => {
      history.getHistory.mockResolvedValue({ entries: [], total: 0, limit: 50, offset: 0 });

      await request(app).get('/api/history?limit=50');

      expect(history.getHistory).toHaveBeenCalledWith(expect.objectContaining({ limit: 50 }));
    });

    it('should respect offset parameter', async () => {
      history.getHistory.mockResolvedValue({ entries: [], total: 0, limit: 100, offset: 10 });

      await request(app).get('/api/history?offset=10');

      expect(history.getHistory).toHaveBeenCalledWith(expect.objectContaining({ offset: 10 }));
    });

    it('should filter by success status', async () => {
      history.getHistory.mockResolvedValue({ entries: [], total: 0, limit: 100, offset: 0 });

      await request(app).get('/api/history?success=true');

      expect(history.getHistory).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    });

    it('should use default limit and offset', async () => {
      history.getHistory.mockResolvedValue({ entries: [], total: 0 });

      await request(app).get('/api/history');

      expect(history.getHistory).toHaveBeenCalledWith(expect.objectContaining({
        limit: 100,
        offset: 0
      }));
    });

    it('should propagate service errors as 500', async () => {
      history.getHistory.mockRejectedValue(new Error('DB unavailable'));

      const response = await request(app).get('/api/history');

      expect(response.status).toBe(500);
    });
  });

  describe('DELETE /api/history/:id', () => {
    it('should delete a history entry', async () => {
      history.deleteEntry.mockResolvedValue({ success: true, deleted: 'h1' });

      const response = await request(app).delete('/api/history/h1');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(history.deleteEntry).toHaveBeenCalledWith('h1');
    });

    it('should handle deletion of non-existent entry', async () => {
      history.deleteEntry.mockResolvedValue(null);

      const response = await request(app).delete('/api/history/h-nonexistent');

      expect(response.status).toBe(404);
      expect(response.body.error).toMatch(/not found/i);
      expect(history.deleteEntry).toHaveBeenCalledWith('h-nonexistent');
    });

    it('should propagate service errors as 500', async () => {
      history.deleteEntry.mockRejectedValue(new Error('DB connection lost'));

      const response = await request(app).delete('/api/history/h-err');

      expect(response.status).toBe(500);
    });
  });

  describe('DELETE /api/history', () => {
    it.each(['abc', '-5', '0', '1e'])('rejects olderThanDays=%s with 400 and clears nothing', async (v) => {
      const response = await request(app).delete(`/api/history?olderThanDays=${v}`);

      expect(response.status).toBe(400);
      expect(history.clearHistory).not.toHaveBeenCalled();
    });

    it('should clear all history', async () => {
      history.clearHistory.mockResolvedValue({ success: true, deletedCount: 150 });

      const response = await request(app).delete('/api/history');

      expect(response.status).toBe(200);
      expect(history.clearHistory).toHaveBeenCalledWith(null);
    });

    it('should clear history older than specified days', async () => {
      history.clearHistory.mockResolvedValue({ success: true, deletedCount: 50 });

      const response = await request(app).delete('/api/history?olderThanDays=7');

      expect(response.status).toBe(200);
      expect(history.clearHistory).toHaveBeenCalledWith(7);
    });
  });
});
