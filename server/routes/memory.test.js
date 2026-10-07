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
  archiveMemory: vi.fn(),
  purgeMemory: vi.fn(),
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

vi.mock('../services/memoryRunUsage.js', () => ({
  findRecentRunsUsingMemory: vi.fn()
}));

// Mock the sync service
vi.mock('../services/memorySync.js', () => ({
  getChangesSince: vi.fn(),
  applyRemoteChanges: vi.fn()
}));

import { ensureBackend, getMemories, getTimeline, archiveMemory, purgeMemory, applyDecay, linkMemories } from '../services/memoryBackend.js';
import { checkHealth } from '../lib/db.js';
import * as memorySync from '../services/memorySync.js';
import { findRecentRunsUsingMemory } from '../services/memoryRunUsage.js';

describe('Memory Routes', () => {
  it('GET /:id/runs lists recent runs that used the memory (#10495)', async () => {
    const app = express();
    app.use('/api/memory', memoryRoutes);
    findRecentRunsUsingMemory.mockResolvedValue([{ runId: 'r1', agentId: 'a1' }]);
    const res = await request(app).get('/api/memory/mem-1/runs');
    expect(res.status).toBe(200);
    expect(res.body.runs).toEqual([{ runId: 'r1', agentId: 'a1' }]);
    expect(findRecentRunsUsingMemory).toHaveBeenCalledWith('mem-1');
  });

  let app;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api/memory', memoryRoutes);
    vi.clearAllMocks();
  });

  describe('DELETE /api/memory/:id', () => {
    it.each([
      ['../outside', 404],
      ['%2Ftmp', 400],
      ['nested%2Fmemory', 400],
    ])('rejects unsafe memory id %j', async (id, status) => {
      const response = await request(app).delete(`/api/memory/${id}`);

      expect(response.status).toBe(status);
      expect(archiveMemory).not.toHaveBeenCalled();
      expect(purgeMemory).not.toHaveBeenCalled();
    });

    it('does not route an empty memory id to deletion', async () => {
      const response = await request(app).delete('/api/memory/');

      expect(response.status).toBe(404);
      expect(archiveMemory).not.toHaveBeenCalled();
      expect(purgeMemory).not.toHaveBeenCalled();
    });

    it('purges a valid memory id when hard=true', async () => {
      purgeMemory.mockResolvedValue({ success: true });

      const response = await request(app).delete('/api/memory/mem-42?hard=true');

      expect(response.status).toBe(200);
      expect(purgeMemory).toHaveBeenCalledWith('mem-42');
      expect(archiveMemory).not.toHaveBeenCalled();
    });

    it('archives a valid memory id by default', async () => {
      archiveMemory.mockResolvedValue({ success: true });

      const response = await request(app).delete('/api/memory/mem-42');

      expect(response.status).toBe(200);
      expect(archiveMemory).toHaveBeenCalledWith('mem-42');
      expect(purgeMemory).not.toHaveBeenCalled();
    });
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

  // ===========================================================================
  // LIST
  // ===========================================================================

  describe('GET /api/memory', () => {
    it('should pass schema defaults through when no filters are given', async () => {
      getMemories.mockResolvedValue({ memories: [], total: 0 });

      const response = await request(app).get('/api/memory');

      expect(response.status).toBe(200);
      expect(getMemories).toHaveBeenCalledWith({
        status: 'active',
        limit: 50,
        offset: 0,
        sortBy: 'createdAt',
        sortOrder: 'desc'
      });
    });

    it('should split csv filters and coerce numeric params', async () => {
      getMemories.mockResolvedValue({ memories: [], total: 0 });

      const response = await request(app)
        .get('/api/memory?types=fact,learning&categories=codebase&tags=a,b&status=archived&appId=brain&limit=10&offset=5&sortBy=importance&sortOrder=asc');

      expect(response.status).toBe(200);
      expect(getMemories).toHaveBeenCalledWith({
        types: ['fact', 'learning'],
        categories: ['codebase'],
        tags: ['a', 'b'],
        status: 'archived',
        appId: 'brain',
        limit: 10,
        offset: 5,
        sortBy: 'importance',
        sortOrder: 'asc'
      });
    });

    it('should reject a limit above the 500 ceiling', async () => {
      const response = await request(app).get('/api/memory?limit=501');

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/Validation failed/);
      expect(getMemories).not.toHaveBeenCalled();
    });

    it('should reject an unknown memory type', async () => {
      const response = await request(app).get('/api/memory?types=fact,nonsense');

      expect(response.status).toBe(400);
      expect(getMemories).not.toHaveBeenCalled();
    });

    it('should reject a non-numeric limit instead of silently defaulting', async () => {
      const response = await request(app).get('/api/memory?limit=abc');

      expect(response.status).toBe(400);
      expect(getMemories).not.toHaveBeenCalled();
    });

    it('should reject an unknown sortBy', async () => {
      const response = await request(app).get('/api/memory?sortBy=unknown');

      expect(response.status).toBe(400);
      expect(getMemories).not.toHaveBeenCalled();
    });

    it('should reject an unknown sortOrder', async () => {
      const response = await request(app).get('/api/memory?sortOrder=up');

      expect(response.status).toBe(400);
      expect(getMemories).not.toHaveBeenCalled();
    });

    it('should reject a negative offset', async () => {
      const response = await request(app).get('/api/memory?offset=-1');

      expect(response.status).toBe(400);
      expect(getMemories).not.toHaveBeenCalled();
    });

    it('should reject an unknown status', async () => {
      const response = await request(app).get('/api/memory?status=deleted');

      expect(response.status).toBe(400);
      expect(getMemories).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // TIMELINE
  // ===========================================================================

  describe('GET /api/memory/timeline', () => {
    it('should pass the default limit through', async () => {
      getTimeline.mockResolvedValue({});

      const response = await request(app).get('/api/memory/timeline');

      expect(response.status).toBe(200);
      expect(getTimeline).toHaveBeenCalledWith({ limit: 100 });
    });

    it('should pass validated date range, types and limit', async () => {
      getTimeline.mockResolvedValue({});

      const response = await request(app)
        .get('/api/memory/timeline?startDate=2026-01-01T00:00:00.000Z&endDate=2026-01-31&types=fact&limit=5');

      expect(response.status).toBe(200);
      expect(getTimeline).toHaveBeenCalledWith({
        startDate: '2026-01-01T00:00:00.000Z',
        endDate: '2026-01-31',
        types: ['fact'],
        limit: 5
      });
    });

    it('should reject a malformed date boundary', async () => {
      const response = await request(app).get('/api/memory/timeline?startDate=yesterday');

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/Validation failed/);
      expect(getTimeline).not.toHaveBeenCalled();
    });

    it('should reject a limit above the 500 ceiling', async () => {
      const response = await request(app).get('/api/memory/timeline?limit=501');

      expect(response.status).toBe(400);
      expect(getTimeline).not.toHaveBeenCalled();
    });

    it('should forward the appId filter to the backend', async () => {
      getTimeline.mockResolvedValue({});

      const response = await request(app).get('/api/memory/timeline?appId=__not_brain');

      expect(response.status).toBe(200);
      expect(getTimeline).toHaveBeenCalledWith({ appId: '__not_brain', limit: 100 });
    });

    it('should reject a date that matches the shape but is not a real day', async () => {
      const response = await request(app).get('/api/memory/timeline?startDate=2026-02-30');

      expect(response.status).toBe(400);
      expect(getTimeline).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/memory/decay', () => {
    it.each([[{ decayRate: 5 }], [{ decayRate: -1 }], [{ decayRate: 'abc' }], [{ decayRate: 0 }], [{ decayRate: null }]])(
      'rejects %j without applying decay', async (body) => {
        const response = await request(app).post('/api/memory/decay').send(body);
        expect(response.status).toBe(400);
        expect(response.body.code).toBe('VALIDATION_ERROR');
        expect(applyDecay).not.toHaveBeenCalled();
      });

    it('applies the default rate for an empty object or no body', async () => {
      applyDecay.mockResolvedValue({});
      expect((await request(app).post('/api/memory/decay').send({})).status).toBe(200);
      expect((await request(app).post('/api/memory/decay')).status).toBe(200);
      expect(applyDecay).toHaveBeenCalledTimes(2);
      expect(applyDecay).toHaveBeenNthCalledWith(1, 0.01);
      expect(applyDecay).toHaveBeenNthCalledWith(2, 0.01);
    });

    it('accepts the maximum rate', async () => {
      applyDecay.mockResolvedValue({});
      const response = await request(app).post('/api/memory/decay').send({ decayRate: 0.02 });
      expect(response.status).toBe(200);
      expect(applyDecay).toHaveBeenCalledWith(0.02);
    });
  });

  describe('POST /api/memory/link', () => {
    const sourceId = '550e8400-e29b-41d4-a716-446655440000';
    const targetId = '550e8400-e29b-41d4-a716-446655440001';

    it('passes a typed link and its note through to the backend', async () => {
      linkMemories.mockResolvedValue({ success: true, sourceId, targetId, linkType: 'supersedes', linkId: 'id-1' });

      const response = await request(app).post('/api/memory/link')
        .send({ sourceId, targetId, linkType: 'supersedes', note: 'newer decision' });

      expect(response.status).toBe(200);
      expect(response.body.linkType).toBe('supersedes');
      expect(linkMemories).toHaveBeenCalledWith(sourceId, targetId, { linkType: 'supersedes', note: 'newer decision', createdBy: undefined });
    });

    it('keeps an untyped legacy call valid (backend defaults it to related)', async () => {
      linkMemories.mockResolvedValue({ success: true, sourceId, targetId, linkType: 'related', linkId: 'id-2' });

      const response = await request(app).post('/api/memory/link').send({ sourceId, targetId });

      expect(response.status).toBe(200);
      expect(linkMemories).toHaveBeenCalledWith(sourceId, targetId, { linkType: undefined, note: undefined, createdBy: undefined });
    });

    it('rejects an unknown link type and a directed self-link with 400', async () => {
      const unknown = await request(app).post('/api/memory/link').send({ sourceId, targetId, linkType: 'befriends' });
      const self = await request(app).post('/api/memory/link').send({ sourceId, targetId: sourceId, linkType: 'supersedes' });

      expect(unknown.status).toBe(400);
      expect(self.status).toBe(400);
      expect(linkMemories).not.toHaveBeenCalled();
    });
  });
});
