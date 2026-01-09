import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
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

describe('History Routes', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/history', historyRoutes);

    // Reset all mocks
    vi.clearAllMocks();
  });

  describe('GET /api/history', () => {
    it('should return history entries', async () => {
      const mockHistory = {
        entries: [
          { id: 'h1', action: 'start', target: 'app-001', success: true, timestamp: '2024-01-15T10:00:00Z' },
          { id: 'h2', action: 'stop', target: 'app-001', success: true, timestamp: '2024-01-15T11:00:00Z' }
        ],
        total: 2,
        limit: 100,
        offset: 0
      };
      history.getHistory.mockResolvedValue(mockHistory);

      const response = await request(app).get('/api/history');

      expect(response.status).toBe(200);
      expect(response.body.entries).toHaveLength(2);
      expect(response.body.total).toBe(2);
    });

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

    it('should filter by action', async () => {
      history.getHistory.mockResolvedValue({ entries: [], total: 0, limit: 100, offset: 0 });

      await request(app).get('/api/history?action=start');

      expect(history.getHistory).toHaveBeenCalledWith(expect.objectContaining({ action: 'start' }));
    });

    it('should filter by target', async () => {
      history.getHistory.mockResolvedValue({ entries: [], total: 0, limit: 100, offset: 0 });

      await request(app).get('/api/history?target=app-001');

      expect(history.getHistory).toHaveBeenCalledWith(expect.objectContaining({ target: 'app-001' }));
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
  });

  describe('GET /api/history/stats', () => {
    it('should return history statistics', async () => {
      const mockStats = {
        totalEntries: 150,
        successRate: 0.95,
        byAction: {
          start: 50,
          stop: 40,
          restart: 60
        },
        byApp: {
          'app-001': 80,
          'app-002': 70
        }
      };
      history.getHistoryStats.mockResolvedValue(mockStats);

      const response = await request(app).get('/api/history/stats');

      expect(response.status).toBe(200);
      expect(response.body.totalEntries).toBe(150);
      expect(response.body.successRate).toBe(0.95);
      expect(response.body.byAction).toBeDefined();
    });
  });

  describe('GET /api/history/actions', () => {
    it('should return unique action types', async () => {
      const mockActions = ['start', 'stop', 'restart', 'deploy', 'rollback'];
      history.getActionTypes.mockResolvedValue(mockActions);

      const response = await request(app).get('/api/history/actions');

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockActions);
      expect(response.body).toContain('start');
      expect(response.body).toContain('stop');
    });

    it('should return empty array when no actions', async () => {
      history.getActionTypes.mockResolvedValue([]);

      const response = await request(app).get('/api/history/actions');

      expect(response.status).toBe(200);
      expect(response.body).toEqual([]);
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
      history.deleteEntry.mockResolvedValue({ success: false, error: 'Entry not found' });

      const response = await request(app).delete('/api/history/h-nonexistent');

      expect(response.status).toBe(200);
      expect(history.deleteEntry).toHaveBeenCalledWith('h-nonexistent');
    });
  });

  describe('DELETE /api/history', () => {
    it('should clear all history', async () => {
      history.clearHistory.mockResolvedValue({ success: true, deletedCount: 150 });

      const response = await request(app).delete('/api/history');

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.deletedCount).toBe(150);
      expect(history.clearHistory).toHaveBeenCalledWith(null);
    });

    it('should clear history older than specified days', async () => {
      history.clearHistory.mockResolvedValue({ success: true, deletedCount: 50 });

      const response = await request(app).delete('/api/history?olderThanDays=7');

      expect(response.status).toBe(200);
      expect(history.clearHistory).toHaveBeenCalledWith(7);
    });

    it('should handle empty history', async () => {
      history.clearHistory.mockResolvedValue({ success: true, deletedCount: 0 });

      const response = await request(app).delete('/api/history');

      expect(response.status).toBe(200);
      expect(response.body.deletedCount).toBe(0);
    });
  });
});
