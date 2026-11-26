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
  getMemoryVersion: vi.fn(),
  getMemoryVersions: vi.fn(),
  createMemory: vi.fn(),
  updateMemory: vi.fn(),
  updateMemoryEmbedding: vi.fn(),
  archiveMemory: vi.fn(),
  purgeMemory: vi.fn(),
  searchMemories: vi.fn(),
  hybridSearchMemories: vi.fn(),
  consolidateMemories: vi.fn(),
  linkMemories: vi.fn(),
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
  checkAvailability: vi.fn(),
  resolveEmbeddingSource: vi.fn()
}));

vi.mock('../services/memoryRunUsage.js', () => ({
  findRecentRunsUsingMemory: vi.fn()
}));

// Mock the sync service
vi.mock('../services/memorySync.js', () => ({
  getChangesSince: vi.fn(),
  applyRemoteChanges: vi.fn()
}));

vi.mock('../services/provider/providers.js', () => ({
  getProviderById: vi.fn(),
}));
vi.mock('../lib/openAiModelsProbe.js', () => ({ probeOpenAiModels: vi.fn() }));

// The real peer-pull gate runs; only the peer registry and settings it reads
// are stubbed, as in routes/dataSync.test.js.
const peers = [];
vi.mock('../services/instances.js', async () => ({
  ...(await vi.importActual('../services/instances.js')),
  getPeers: async () => peers,
}));
let settings = {};
vi.mock('../services/settings.js', async () => ({
  ...(await vi.importActual('../services/settings.js')),
  getSettings: async () => settings,
}));

import { PEER_INSTANCE_ID_HEADER } from '../services/sharing/peerPullAuthorization.js';
import { ensureBackend, getMemories, getTimeline, archiveMemory, purgeMemory, linkMemories, searchMemories, hybridSearchMemories } from '../services/memoryBackend.js';
import { checkHealth } from '../lib/db.js';
import * as memorySync from '../services/memorySync.js';
import { findRecentRunsUsingMemory } from '../services/memoryRunUsage.js';
import * as embeddings from '../services/memoryEmbeddings.js';
import { getProviderById } from '../services/provider/providers.js';
import { probeOpenAiModels } from '../lib/openAiModelsProbe.js';

describe('Memory Routes', () => {
  it.each([
    { probe: { reachable: true, models: ['qwen3:8b'] }, available: true },
    { probe: { reachable: true, models: ['different-model'] }, available: false },
    { probe: { reachable: true, error: 'authentication required', models: null }, available: false },
    { probe: { reachable: false }, available: false },
  ])('includes the selected classifier reachability alongside embeddings ($probe)', async ({ probe, available }) => {
    const app = express();
    app.use('/api/memory', memoryRoutes);
    settings = { memoryClassifier: { providerId: 'ollama', model: 'qwen3:8b' } };
    embeddings.checkAvailability.mockResolvedValue({ available: true, embeddingModel: 'synthetic-embed' });
    getProviderById.mockResolvedValue({ id: 'ollama', type: 'api', enabled: true, endpoint: 'http://127.0.0.1:11434/v1' });
    probeOpenAiModels.mockResolvedValue(probe);

    const res = await request(app).get('/api/memory/embeddings/status');
    settings = {};
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      available: true,
      embeddingModel: 'synthetic-embed',
      classifier: { available, disabled: false },
    });
    expect(probeOpenAiModels).toHaveBeenCalledWith('http://127.0.0.1:11434/v1', expect.any(Object));
  });

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
  let authContext;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    authContext = null;
    app.use((req, _res, next) => { req.portosAuthContext = authContext; next(); });
    app.use('/api/memory', memoryRoutes);
    vi.clearAllMocks();
    settings = {};
    peers.length = 0;
  });

  describe('POST /search', () => {
    const filters = { types: ['fact'], categories: ['codebase'], tags: ['build'], appId: 'example-app', limit: 3, offset: 6 };
    const query = 'build instructions';

    it('uses lexical search with the requested filters when the embedding is unavailable', async () => {
      const result = { memories: [{ id: 'lexical-hit', searchMethod: 'fts' }], total: 7 };
      embeddings.generateQueryEmbedding.mockResolvedValue(null);
      hybridSearchMemories.mockResolvedValue(result);

      const response = await request(app).post('/api/memory/search').send({ query, ...filters });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ...result, searchMode: 'lexical' });
      expect(hybridSearchMemories).toHaveBeenCalledExactlyOnceWith(query, null, { ...filters, lexicalMatch: 'any' });
      expect(searchMemories).not.toHaveBeenCalled();
    });

    it('uses semantic search and the requested relevance threshold when an embedding is available', async () => {
      const embedding = [0.1, 0.2];
      const result = { memories: [{ id: 'semantic-hit', similarity: 0.91 }], total: 7 };
      embeddings.generateQueryEmbedding.mockResolvedValue(embedding);
      searchMemories.mockResolvedValue(result);

      const response = await request(app).post('/api/memory/search').send({ query, ...filters, minRelevance: 0.85 });

      expect(response.status).toBe(200);
      expect(response.body).toEqual({ ...result, searchMode: 'semantic' });
      expect(embeddings.generateQueryEmbedding).toHaveBeenCalledExactlyOnceWith(query, {
        types: filters.types,
        categories: filters.categories,
      });
      expect(searchMemories).toHaveBeenCalledExactlyOnceWith(embedding, { ...filters, minRelevance: 0.85 });
      expect(hybridSearchMemories).not.toHaveBeenCalled();
    });
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
      expect(archiveMemory).toHaveBeenCalledWith('mem-42', {});
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

  });

  // ===========================================================================
  // SYNC - GET
  // ===========================================================================

  describe('GET /api/memory/sync', () => {
    beforeEach(() => {
      peers.push({ instanceId: 'peer-a-instance-id', enabled: true, syncEnabled: true, syncCategories: { memory: true } });
    });
    it('should return 400 when backend is not postgres', async () => {
      ensureBackend.mockResolvedValue('file');

      const response = await request(app).get('/api/memory/sync').set(PEER_INSTANCE_ID_HEADER, 'peer-a-instance-id');

      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/PostgreSQL/);
    });

    it('should return changes since sequence when backend is postgres', async () => {
      ensureBackend.mockResolvedValue('postgres');
      memorySync.getChangesSince.mockResolvedValue({
        memories: [{ id: 'mem-001' }],
        maxSequence: '42'
      });

      const response = await request(app).get('/api/memory/sync?since=10&limit=50').set(PEER_INSTANCE_ID_HEADER, 'peer-a-instance-id');

      expect(response.status).toBe(200);
      expect(memorySync.getChangesSince).toHaveBeenCalledWith('10', 50, undefined, false);
    });

    it('should default since to 0 and limit to 100', async () => {
      ensureBackend.mockResolvedValue('postgres');
      memorySync.getChangesSince.mockResolvedValue({ memories: [], maxSequence: '0' });

      await request(app).get('/api/memory/sync').set(PEER_INSTANCE_ID_HEADER, 'peer-a-instance-id');

      expect(memorySync.getChangesSince).toHaveBeenCalledWith('0', 100, undefined, false);
    });

    it('should cap limit at 1000', async () => {
      ensureBackend.mockResolvedValue('postgres');
      memorySync.getChangesSince.mockResolvedValue({ memories: [], maxSequence: '0' });

      await request(app).get('/api/memory/sync?limit=5000').set(PEER_INSTANCE_ID_HEADER, 'peer-a-instance-id');

      expect(memorySync.getChangesSince).toHaveBeenCalledWith('0', 1000, undefined, false);
    });

    it('forwards the sender schema version', async () => {
      ensureBackend.mockResolvedValue('postgres');
      memorySync.getChangesSince.mockResolvedValue({ memories: [], maxSequence: '0' });

      const response = await request(app).get('/api/memory/sync?since=10&limit=50&schemaVersion=3&tombstoneVersion=1').set(PEER_INSTANCE_ID_HEADER, 'peer-a-instance-id');

      expect(response.status).toBe(200);
      expect(memorySync.getChangesSince).toHaveBeenCalledWith('10', 50, 3, true);
    });

    it('refuses a peer the user does not share memory with by default', async () => {
      ensureBackend.mockResolvedValue('postgres');
      peers.splice(0, peers.length, {
        instanceId: 'peer-a-instance-id', enabled: true, syncEnabled: true,
        directions: ['outbound', 'inbound'], syncCategories: { brain: true, memory: false },
      });

      const response = await request(app).get('/api/memory/sync').set(PEER_INSTANCE_ID_HEADER, 'peer-a-instance-id');

      expect(response.status).toBe(403);
      expect(response.body.code).toBe('PEER_PULL_FORBIDDEN');
      expect(memorySync.getChangesSince).not.toHaveBeenCalled();
    });

    it('refuses unidentified and unknown callers without strict mode', async () => {
      ensureBackend.mockResolvedValue('postgres');
      for (const instanceId of [null, 'unknown-instance']) {
        const pending = request(app).get('/api/memory/sync');
        const response = await (instanceId ? pending.set(PEER_INSTANCE_ID_HEADER, instanceId) : pending);
        expect(response.status).toBe(403);
        expect(response.body.code).toBe('PEER_PULL_FORBIDDEN');
      }
      expect(memorySync.getChangesSince).not.toHaveBeenCalled();
    });

    it('preserves local and delegated operator reads', async () => {
      ensureBackend.mockResolvedValue('postgres');
      memorySync.getChangesSince.mockResolvedValue({ memories: [], maxSequence: '0' });
      for (const auth of [
        { enabled: false, authenticated: false, method: null },
        { enabled: true, authenticated: true, method: 'session' },
      ]) {
        authContext = auth;
        const response = await request(app).get('/api/memory/sync');
        expect(response.status).toBe(200);
      }
      expect(memorySync.getChangesSince).toHaveBeenCalledTimes(2);
    });

    it('serves memory when fullSync grants the category', async () => {
      ensureBackend.mockResolvedValue('postgres');
      peers[0] = { ...peers[0], fullSync: true, syncCategories: { memory: false } };
      memorySync.getChangesSince.mockResolvedValue({ memories: [], maxSequence: '0' });
      const response = await request(app).get('/api/memory/sync').set(PEER_INSTANCE_ID_HEADER, 'peer-a-instance-id');
      expect(response.status).toBe(200);
      expect(memorySync.getChangesSince).toHaveBeenCalledOnce();
    });

    it('passes a schema-version conflict through at the HTTP boundary', async () => {
      ensureBackend.mockResolvedValue('postgres');
      memorySync.getChangesSince.mockRejectedValue(Object.assign(new Error('schema version is ahead'), { status: 409 }));

      const response = await request(app).get('/api/memory/sync?schemaVersion=99').set(PEER_INSTANCE_ID_HEADER, 'peer-a-instance-id');

      expect(response.status).toBe(409);
      expect(response.body.error).toMatch(/schema version is ahead/);
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

    it('rejects an invalid deletion before applying a sync page', async () => {
      ensureBackend.mockResolvedValue('postgres');
      const response = await request(app).post('/api/memory/sync')
        .send({ memories: [], deletedIds: [{ id: 'invalid', deletedAt: 'yesterday' }] });
      expect(response.status).toBe(400);
      expect(memorySync.applyRemoteChanges).not.toHaveBeenCalled();
    });

    it('forwards the sender schema version and deletions with remote changes', async () => {
      ensureBackend.mockResolvedValue('postgres');
      memorySync.applyRemoteChanges.mockResolvedValue({ inserted: 0, updated: 0, skipped: 0 });

      const response = await request(app)
        .post('/api/memory/sync')
        .send({ memories: [], schemaVersion: 3, deletedIds: [{ id: '00000000-0000-4000-8000-00000000aaaa', deletedAt: '2026-01-02T00:00:00Z' }] });

      expect(response.status).toBe(200);
      expect(memorySync.applyRemoteChanges).toHaveBeenCalledWith([], 3, [{ id: '00000000-0000-4000-8000-00000000aaaa', deletedAt: '2026-01-02T00:00:00Z' }]);
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

  it('returns 404 for the retired POST /api/memory/decay endpoint', async () => {
    const response = await request(app).post('/api/memory/decay').send({ decayRate: 0.01 });
    expect(response.status).toBe(404);
  });

  describe('POST /api/memory/link', () => {
    const sourceId = '550e8400-e29b-41d4-a716-446655440000';
    const targetId = '550e8400-e29b-41d4-a716-446655440001';

    it('passes a typed link and its note through to the backend', async () => {
      linkMemories.mockResolvedValue({ success: true, sourceId, targetId, linkType: 'supersedes', linkId: 'id-1' });

      const response = await request(app).post('/api/memory/link')
        .send({ sourceId, targetId, linkType: 'supersedes', note: 'newer decision' });

      expect(response.status).toBe(200);
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

describe('Memory version API', () => {
  it('validates version reads and propagates stale-write conflicts without embedding work', async () => {
    const backend = await import('../services/memoryBackend.js');
    const embeddings = await import('../services/memoryEmbeddings.js');
    const { errorMiddleware, ServerError } = await import('../lib/errorHandler.js');
    const app = express();
    app.use(express.json());
    app.use('/api/memory', memoryRoutes);
    app.use(errorMiddleware);
    backend.getMemoryVersion.mockResolvedValue({ id: 'mem-1', version: 1, content: 'Original' });
    expect((await request(app).get('/api/memory/mem-1?version=1')).body.content).toBe('Original');
    expect((await request(app).get('/api/memory/mem-1?version=-1')).status).toBe(400);
    backend.getMemoryVersions.mockResolvedValue([{ version: 1 }]);
    expect((await request(app).get('/api/memory/mem-1/versions?limit=1')).body.versions).toEqual([{ version: 1 }]);
    backend.updateMemory.mockRejectedValue(new ServerError('Stale memory', { status: 409 }));
    embeddings.generateMemoryEmbedding.mockClear();
    const response = await request(app).put('/api/memory/mem-1').send({ content: 'Overwrite', expectedVersion: 1 });
    expect(response.status).toBe(409);
    expect(embeddings.generateMemoryEmbedding).not.toHaveBeenCalled();
  });
});

describe('Memory reject API', () => {
  it('treats rejecting an already-deleted memory as success', async () => {
    const memoryService = await import('../services/memoryBackend.js');
    const app = express();
    app.use(express.json());
    app.use('/api/memory', memoryRoutes);
    memoryService.rejectMemory.mockResolvedValue({ success: false, error: 'Memory not found' });
    const response = await request(app).post('/api/memory/gone-1/reject').send({});
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ success: true, alreadyResolved: true });
  });
});

describe('Memory embedding config API (#18296)', () => {
  const makeApp = async () => {
    const { errorMiddleware } = await import('../lib/errorHandler.js');
    const app = express();
    app.use(express.json());
    app.use('/api/memory', memoryRoutes);
    app.use(errorMiddleware);
    return app;
  };

  it('GET /embeddings/config reports the resolved backend without probing it', async () => {
    const embeddings = await import('../services/memoryEmbeddings.js');
    embeddings.checkAvailability.mockClear();
    embeddings.resolveEmbeddingSource.mockResolvedValue({
      source: 'settings', provider: 'ollama', model: 'nomic-embed-text', endpoint: 'http://192.0.2.10:11434/v1/embeddings', disabled: false,
    });
    const response = await request(await makeApp()).get('/api/memory/embeddings/config');
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ source: 'settings', provider: 'ollama', model: 'nomic-embed-text', disabled: false });
    expect(embeddings.checkAvailability).not.toHaveBeenCalled();
  });
});
