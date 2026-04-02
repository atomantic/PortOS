import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import memoryRoutes from './memory.js';

// Mock the memory backend service
vi.mock('../services/memoryBackend.js', () => ({
  ensureBackend: vi.fn(),
  getMemories: vi.fn(),
  getStats: vi.fn(),
  getCategories: vi.fn(),
  getTags: vi.fn(),
  getTimeline: vi.fn(),
  getGraphData: vi.fn(),
  getMemory: vi.fn(),
  getRelatedMemories: vi.fn(),
  createMemory: vi.fn(),
  updateMemory: vi.fn(),
  updateMemoryEmbedding: vi.fn(),
  deleteMemory: vi.fn(),
  searchMemories: vi.fn(),
  consolidateMemories: vi.fn(),
  linkMemories: vi.fn(),
  applyDecay: vi.fn(),
  clearExpired: vi.fn(),
  approveMemory: vi.fn(),
  rejectMemory: vi.fn()
}));

// Mock the db health check
vi.mock('../lib/db.js', () => ({
  checkHealth: vi.fn()
}));

// Mock the embedding service
vi.mock('../services/memoryEmbeddings.js', () => ({
  generateQueryEmbedding: vi.fn(),
  generateMemoryEmbedding: vi.fn(),
  checkAvailability: vi.fn()
}));

// Mock the sync service
vi.mock('../services/memorySync.js', () => ({
  getChangesSince: vi.fn(),
  applyRemoteChanges: vi.fn()
}));

import { ensureBackend } from '../services/memoryBackend.js';
import { checkHealth } from '../lib/db.js';
import * as memorySync from '../services/memorySync.js';

describe('Memory Routes', () => {
  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/memory', memoryRoutes);
    vi.clearAllMocks();
  });

  // ===========================================================================
  // BACKEND STATUS
  // ===========================================================================

  describe('GET /api/memory/backend/status', () => {
    it('should return backend name and health info', async () => {
      ensureBackend.mockResolvedValue('postgres');
      checkHealth.mockResolvedValue({ connected: true, hasSchema: true });

      const response = await request(app).get('/api/memory/backend/status');

      expect(response.status).toBe(200);
      expect(response.body.backend).toBe('postgres');
      expect(response.body.db.connected).toBe(true);
    });

    it('should return file backend when postgres is unavailable', async () => {
      ensureBackend.mockResolvedValue('file');
      checkHealth.mockResolvedValue({ connected: false, error: 'connection refused' });

      const response = await request(app).get('/api/memory/backend/status');

      expect(response.status).toBe(200);
      expect(response.body.backend).toBe('file');
      expect(response.body.db.connected).toBe(false);
    });
  });

  // ===========================================================================
  // SYNC - GET
  // ===========================================================================

  describe('GET /api/memory/sync', () => {
    it('should return 400 when backend is not postgres', async () => {
      ensureBackend.mockResolvedValue('file');

      const response = await request(app).get('/api/memory/sync');

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/PostgreSQL/);
    });

    it('should return changes since sequence when backend is postgres', async () => {
      ensureBackend.mockResolvedValue('postgres');
      memorySync.getChangesSince.mockResolvedValue({
        memories: [{ id: 'mem-001' }],
        maxSequence: '42'
      });

      const response = await request(app).get('/api/memory/sync?since=10&limit=50');

      expect(response.status).toBe(200);
      expect(response.body.maxSequence).toBe('42');
      expect(memorySync.getChangesSince).toHaveBeenCalledWith('10', 50);
    });

    it('should default since to 0 and limit to 100', async () => {
      ensureBackend.mockResolvedValue('postgres');
      memorySync.getChangesSince.mockResolvedValue({ memories: [], maxSequence: '0' });

      await request(app).get('/api/memory/sync');

      expect(memorySync.getChangesSince).toHaveBeenCalledWith('0', 100);
    });

    it('should cap limit at 1000', async () => {
      ensureBackend.mockResolvedValue('postgres');
      memorySync.getChangesSince.mockResolvedValue({ memories: [], maxSequence: '0' });

      await request(app).get('/api/memory/sync?limit=5000');

      expect(memorySync.getChangesSince).toHaveBeenCalledWith('0', 1000);
    });
  });

  // ===========================================================================
  // SYNC - POST
  // ===========================================================================

  describe('POST /api/memory/sync', () => {
    it('should return 400 when backend is not postgres', async () => {
      ensureBackend.mockResolvedValue('file');

      const response = await request(app)
        .post('/api/memory/sync')
        .send({ memories: [] });

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/PostgreSQL/);
    });

    it('should return 400 when body is not an array', async () => {
      ensureBackend.mockResolvedValue('postgres');

      const response = await request(app)
        .post('/api/memory/sync')
        .send({ memories: 'not-an-array' });

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/Validation failed/);
    });

    it('should return 400 when memories key is missing', async () => {
      ensureBackend.mockResolvedValue('postgres');

      const response = await request(app)
        .post('/api/memory/sync')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/Validation failed/);
    });

    it('should return 400 when memory item has invalid id', async () => {
      ensureBackend.mockResolvedValue('postgres');

      const response = await request(app)
        .post('/api/memory/sync')
        .send({ memories: [{ id: 'not-a-uuid', type: 'fact', content: 'test', createdAt: '2024-01-01T00:00:00.000Z', updatedAt: '2024-01-01T00:00:00.000Z' }] });

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/Validation failed/);
    });

    it('should apply remote changes when body is valid', async () => {
      ensureBackend.mockResolvedValue('postgres');
      const remoteMems = [{
        id: '00000000-0000-0000-0000-000000000001',
        type: 'fact',
        content: 'synced memory',
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-01T00:00:00.000Z'
      }];
      memorySync.applyRemoteChanges.mockResolvedValue({ inserted: 1, updated: 0, skipped: 0 });

      const response = await request(app)
        .post('/api/memory/sync')
        .send({ memories: remoteMems });

      expect(response.status).toBe(200);
      expect(response.body.inserted).toBe(1);
      expect(memorySync.applyRemoteChanges).toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ id: '00000000-0000-0000-0000-000000000001', type: 'fact', content: 'synced memory' })])
      );
    });
  });
});
