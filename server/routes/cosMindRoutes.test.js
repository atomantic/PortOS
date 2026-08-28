import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const mocks = vi.hoisted(() => ({
  readPersistentMindEvents: vi.fn(),
  readPersistentMindHistory: vi.fn(),
  loadState: vi.fn(),
  getPersistentMindState: vi.fn(),
  enqueuePersistentMindMessage: vi.fn(),
  appendPersistentMindAnnotation: vi.fn(),
  createPersistentMindMemory: vi.fn(),
  preparePersistentMindContext: vi.fn(),
  promotePersistentMindMemory: vi.fn(),
  readPersistentMindMemories: vi.fn(),
  readPersistentMindRollups: vi.fn(),
  updatePersistentMindMemory: vi.fn(),
  getProviderById: vi.fn(),
  createPersistentMindAttachment: vi.fn(),
  deletePersistentMindAttachment: vi.fn(),
  startPersistentMind: vi.fn(),
  pausePersistentMind: vi.fn(),
  resumePersistentMind: vi.fn(),
  stopPersistentMind: vi.fn(),
  inspectPersistentMindRuntime: vi.fn(),
  readPersistentMindVisibility: vi.fn(),
  readPersistentMindTaskCatalog: vi.fn(),
  resolveImageCapability: vi.fn(),
  cleanupPersistentMind: vi.fn(),
}));

vi.mock('../services/agentRunEventLog.js', () => ({
  readPersistentMindEvents: mocks.readPersistentMindEvents,
  readPersistentMindHistory: mocks.readPersistentMindHistory,
}));
vi.mock('../services/cosState.js', () => ({ loadState: mocks.loadState }));
vi.mock('../services/persistentMindContext.js', () => ({
  appendPersistentMindAnnotation: mocks.appendPersistentMindAnnotation,
  createPersistentMindMemory: mocks.createPersistentMindMemory,
  preparePersistentMindContext: mocks.preparePersistentMindContext,
  promotePersistentMindMemory: mocks.promotePersistentMindMemory,
  readPersistentMindMemories: mocks.readPersistentMindMemories,
  readPersistentMindRollups: mocks.readPersistentMindRollups,
  updatePersistentMindMemory: mocks.updatePersistentMindMemory,
}));
vi.mock('../services/providers.js', () => ({ getProviderById: mocks.getProviderById }));
vi.mock('../services/persistentMindAdapter.js', () => ({
  persistentMindHarnessInfo: (provider) => ({
    type: provider?.type || null,
    label: provider?.type === 'api' ? 'Direct API' : 'Headless CLI',
    recommendation: provider?.type === 'api' ? 'recommended' : 'supported',
    detail: 'Structured provider harness.',
  }),
}));
vi.mock('../services/persistentMindImageCapability.js', () => ({
  resolvePersistentMindImageCapability: (...args) => mocks.resolveImageCapability(...args),
}));
vi.mock('../services/persistentMindMaintenance.js', () => ({
  cleanupPersistentMind: (...args) => mocks.cleanupPersistentMind(...args),
}));
vi.mock('../services/persistentMindTaskCapability.js', () => ({
  readPersistentMindTaskCatalog: mocks.readPersistentMindTaskCatalog,
}));
vi.mock('../services/persistentMindSupervisor.js', () => ({
  createPersistentMindAttachment: mocks.createPersistentMindAttachment,
  deletePersistentMindAttachment: mocks.deletePersistentMindAttachment,
  getPersistentMindState: mocks.getPersistentMindState,
  enqueuePersistentMindMessage: mocks.enqueuePersistentMindMessage,
  startPersistentMind: mocks.startPersistentMind,
  pausePersistentMind: mocks.pausePersistentMind,
  resumePersistentMind: mocks.resumePersistentMind,
  stopPersistentMind: mocks.stopPersistentMind,
}));
vi.mock('../services/persistentMindRuntime.js', () => ({
  inspectPersistentMindRuntime: mocks.inspectPersistentMindRuntime,
}));
vi.mock('../services/persistentMindVisibility.js', () => ({
  readPersistentMindVisibility: mocks.readPersistentMindVisibility,
}));

import cosMindRoutes from './cosMindRoutes.js';

const app = () => {
  const instance = express();
  instance.use(express.json());
  instance.use('/api/cos', cosMindRoutes);
  instance.use(errorMiddleware);
  return instance;
};

const get = (path) => request(app()).get(`/api/cos${path}`);
const post = (path, body) => request(app()).post(`/api/cos${path}`).send(body);
const put = (path, body) => request(app()).put(`/api/cos${path}`).send(body);

describe('persistent mind routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.readPersistentMindEvents.mockResolvedValue({ events: [], cursor: null, gap: false, hasMore: false, snapshot: {} });
    mocks.readPersistentMindHistory.mockResolvedValue([{ eventId: 'event-1' }]);
    mocks.getPersistentMindState.mockResolvedValue({
      enabled: true, status: 'idle', started: false, queuedMessages: [{ id: 'private', text: 'must not leak' }],
      activeTurn: null, lastCompletedTurnId: null, lastCompletedAt: null, nextEligibleWakeAt: null,
      failureCount: 0, pauseReason: null, lastError: 'provider failed with \"apiKey\": \"secret-value\"',
    });
    mocks.loadState.mockResolvedValue({ config: {
      domainAutonomy: { cos: 'execute' },
      persistentMindCapabilities: { schemaVersion: 1, createTasks: true },
      persistentMindProfile: { enabled: true, providerId: 'demo', model: 'demo-model', effort: 'high' },
      persistentMindPrompt: { schemaVersion: 1, identity: 'Resident mind', instructions: 'Stay grounded.' },
    } });
    mocks.getProviderById.mockResolvedValue({ id: 'demo', type: 'api' });
    mocks.resolveImageCapability.mockResolvedValue({ status: 'unknown', reason: 'No authoritative metadata.', settingsPath: '/settings?tab=ai-providers' });
    mocks.readPersistentMindMemories.mockResolvedValue([{ id: 'memory-1', content: 'A durable fact', sourceAgentId: 'cos-persistent-mind' }]);
    mocks.readPersistentMindRollups.mockResolvedValue([]);
    mocks.preparePersistentMindContext.mockResolvedValue({ text: '# Context', chars: 9, approximateTokens: 3, summaryState: 'empty' });
    mocks.createPersistentMindMemory.mockResolvedValue({ id: 'memory-2', content: 'A new fact', sourceAgentId: 'cos-persistent-mind' });
    mocks.updatePersistentMindMemory.mockResolvedValue({ id: 'memory-1', content: 'An edited fact', sourceAgentId: 'cos-persistent-mind' });
    mocks.enqueuePersistentMindMessage.mockResolvedValue({ success: true, duplicate: false, messageId: 'message-1' });
    mocks.createPersistentMindAttachment.mockResolvedValue({
      success: true,
      attachment: {
        attachmentId: 'attachment-1',
        filename: 'mind-attachment-1.png',
        path: '/api/screenshots/mind-attachment-1.png',
        originalName: 'diagram.png',
        mimeType: 'image/png',
        size: 12,
        expiresAt: '2026-08-28T00:00:00.000Z',
      },
    });
    mocks.deletePersistentMindAttachment.mockResolvedValue({ success: true, attachmentId: 'attachment-1' });
    mocks.appendPersistentMindAnnotation.mockResolvedValue({ appended: true, duplicate: false });
    mocks.promotePersistentMindMemory.mockResolvedValue({ success: true, memory: { id: 'memory-1' } });
    mocks.startPersistentMind.mockResolvedValue({ success: true });
    mocks.pausePersistentMind.mockResolvedValue({ success: true });
    mocks.resumePersistentMind.mockResolvedValue({ success: true });
    mocks.stopPersistentMind.mockResolvedValue({ success: true });
    mocks.cleanupPersistentMind.mockResolvedValue({
      success: true,
      scopes: ['history'],
      historyEventsCleared: 12,
      historyEventsPreserved: 0,
      rollupsCleared: 2,
      memoriesArchived: 0,
      runtimeResidueCleared: true,
    });
    mocks.inspectPersistentMindRuntime.mockResolvedValue({
      observedAt: '2026-08-27T12:00:00.000Z',
      inference: {
        active: false,
        providerId: 'demo',
        model: 'demo-model',
        residency: { status: 'provider-managed', backend: null, loaded: null },
      },
      context: { chars: 9, maxChars: 32000, approximateTokens: 3, summaryState: 'empty', memoryCount: 1 },
      system: { memory: { total: 100, used: 40, free: 60, usagePercent: 40 } },
    });
    mocks.readPersistentMindVisibility.mockResolvedValue({
      schemaVersion: 1,
      capturedAt: '2026-08-27T12:00:00.000Z',
      freshness: { state: 'fresh', ageMs: 0, ttlMs: 30_000 },
      readiness: 'degraded',
      truncated: false,
      workspaces: [{ appId: 'demo-app', appName: 'Demo App', readiness: 'degraded', preflight: { warnings: [] } }],
    });
    mocks.readPersistentMindTaskCatalog.mockResolvedValue({
      apps: [{ id: 'demo-app', name: 'Demo App', planOnly: true }],
      providers: [{ id: 'codex', name: 'Codex', type: 'cli', models: [{ id: 'gpt-5', efforts: ['low', 'high'] }] }],
    });
  });

  it('serves a bounded cursor snapshot with only the safe profile fields', async () => {
    const res = await get('/mind?cursor=12%3Amind-message%3Aone&limit=25');
    expect(res.status).toBe(200);
    expect(mocks.readPersistentMindEvents).toHaveBeenCalledWith({ mindId: 'cos-persistent-mind', cursor: '12:mind-message:one', limit: 25 });
    expect(res.body).toMatchObject({
      events: [], gap: false, state: { status: 'idle' },
      profile: {
        enabled: true,
        providerId: 'demo',
        model: 'demo-model',
        effort: 'high',
        thinkingInterface: 'text',
        wakeIntervalMinutes: 30,
      },
      capabilities: { schemaVersion: 3, createTasks: true, manageMind: false, readPortos: false, writePortos: false, taskModelAllowlist: [] },
      harness: { type: 'api', recommendation: 'recommended' },
      imageCapability: { status: 'unknown' },
      autonomyMode: 'execute',
    });
    expect(res.body.profile).not.toHaveProperty('credential');
    expect(res.body).not.toHaveProperty('snapshot');
    expect(res.body.state).not.toHaveProperty('queuedMessages');
    expect(res.body.state.queuedMessageCount).toBe(1);
    expect(JSON.stringify(res.body)).not.toContain('secret-value');
  });

  it('exposes the editable prompt, owned memories, derived rollups, and exact context preview', async () => {
    const res = await get('/mind/context');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      prompt: { identity: 'Resident mind', instructions: 'Stay grounded.' },
      preview: { text: '# Context', summaryState: 'empty' },
      memories: [{ id: 'memory-1', content: 'A durable fact' }],
      rollups: [],
      harness: { type: 'api', recommendation: 'recommended' },
    });
    expect(mocks.preparePersistentMindContext).toHaveBeenCalledWith(expect.objectContaining({
      mindId: 'cos-persistent-mind',
      identity: 'Resident mind',
      instructions: 'Stay grounded.',
      memories: expect.any(Array),
    }));
  });

  it('serves a server-described inventory of persistent-mind tools', async () => {
    const res = await get('/mind/tools');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      schemaVersion: 3,
      capabilities: { schemaVersion: 3, createTasks: true, manageMind: false, readPortos: false, writePortos: false, taskModelAllowlist: [] },
      boundaries: expect.arrayContaining([expect.stringMatching(/arbitrary shell/i)]),
      tools: expect.arrayContaining([
        expect.objectContaining({ id: 'cos.create-task', capability: 'createTasks', granted: true, defaultEnabled: false }),
        expect.objectContaining({ id: 'portos.read', capability: 'readPortos', granted: false, defaultEnabled: false }),
        expect.objectContaining({ id: 'portos.write', capability: 'writePortos', granted: false, defaultEnabled: false }),
        expect.objectContaining({ id: 'mind.cleanup', capability: 'manageMind', granted: false, defaultEnabled: false }),
      ]),
      taskCatalog: {
        apps: [{ id: 'demo-app', planOnly: true }],
        providers: [{ id: 'codex' }],
      },
    });
    expect(res.body.tools[0].guardrails).toEqual(expect.arrayContaining([
      expect.stringMatching(/isolated-worktree/i),
    ]));
  });

  it('marks revoked managed apps without removing them from the settings inventory', async () => {
    mocks.loadState.mockResolvedValue({ config: {
      persistentMindCapabilities: { schemaVersion: 3, createTasks: true, allowedAppIds: [] },
    } });
    mocks.readPersistentMindTaskCatalog.mockResolvedValue({
      apps: [{ id: 'demo-app', name: 'Demo App', planOnly: true }],
      providers: [],
    });

    const res = await get('/mind/tools');

    expect(res.status).toBe(200);
    expect(res.body.taskCatalog.apps).toEqual([{ id: 'demo-app', name: 'Demo App', planOnly: true, granted: false }]);
    expect(mocks.readPersistentMindTaskCatalog).toHaveBeenCalledWith({ includeAllApps: true });
  });

  it('exposes live context, system, inference, and model-residency telemetry', async () => {
    mocks.getPersistentMindState.mockResolvedValue({
      enabled: true,
      started: true,
      status: 'thinking',
      activeTurn: { id: 'turn-1', providerId: 'ollama', model: 'active-model' },
    });
    mocks.getProviderById.mockResolvedValue({ id: 'ollama', type: 'api' });
    const res = await get('/mind/runtime');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      inference: { active: false, providerId: 'demo', model: 'demo-model', residency: { status: 'provider-managed' } },
      context: { approximateTokens: 3, memoryCount: 1 },
      system: { memory: { usagePercent: 40 } },
    });
    expect(mocks.inspectPersistentMindRuntime).toHaveBeenCalledWith(expect.objectContaining({
      state: expect.objectContaining({ status: 'thinking' }),
      profile: expect.objectContaining({ providerId: 'demo', model: 'demo-model' }),
      prompt: expect.objectContaining({ identity: 'Resident mind' }),
      provider: expect.objectContaining({ id: 'ollama' }),
    }));
    expect(mocks.getProviderById).toHaveBeenCalledWith('ollama');
  });

  it('serves the shared environment visibility projection and accepts an explicit refresh', async () => {
    const res = await get('/mind/visibility?refresh=true');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      schemaVersion: 1,
      readiness: 'degraded',
      freshness: { state: 'fresh' },
      workspaces: [{ appId: 'demo-app', readiness: 'degraded' }],
    });
    expect(mocks.readPersistentMindVisibility).toHaveBeenCalledWith(expect.objectContaining({
      force: true,
      state: expect.objectContaining({ status: 'idle' }),
      profile: expect.objectContaining({ providerId: 'demo' }),
      provider: expect.objectContaining({ id: 'demo' }),
    }));
  });

  it('creates and edits only validated persistent-mind memories', async () => {
    const created = await post('/mind/memories', { content: 'A new fact' });
    expect(created.status).toBe(201);
    expect(mocks.createPersistentMindMemory).toHaveBeenCalledWith({
      content: 'A new fact', type: 'observation', category: 'other', tags: [], importance: 0.5,
    });

    const updated = await put('/mind/memories/memory-1', { content: 'An edited fact' });
    expect(updated.status).toBe(200);
    expect(mocks.updatePersistentMindMemory).toHaveBeenCalledWith('memory-1', { content: 'An edited fact' });
    expect((await put('/mind/memories/memory-1', {})).status).toBe(400);
  });

  it('returns not found when an edited memory is not owned by this mind', async () => {
    mocks.updatePersistentMindMemory.mockResolvedValue(null);
    expect((await put('/mind/memories/foreign', { content: 'No access' })).status).toBe(404);
  });

  it('stops the mind and performs only an explicitly confirmed cleanup', async () => {
    expect((await post('/mind/cleanup', { scopes: ['history'], confirmation: 'no' })).status).toBe(400);
    expect(mocks.stopPersistentMind).not.toHaveBeenCalled();

    const res = await post('/mind/cleanup', {
      scopes: ['history'],
      reason: 'Discard stale failures',
      confirmation: 'CLEAR',
    });

    expect(res.status).toBe(200);
    expect(mocks.stopPersistentMind).toHaveBeenCalledWith({ waitForTurn: true });
    expect(mocks.cleanupPersistentMind).toHaveBeenCalledWith({
      scopes: ['history'],
      reason: 'Discard stale failures',
      requestedBy: 'user',
    });
    expect(res.body).toMatchObject({
      success: true,
      historyEventsCleared: 12,
      state: { status: 'idle' },
    });
  });

  it('rejects malformed cursors, oversized pages, and unknown query fields', async () => {
    expect((await get('/mind?cursor=broken')).status).toBe(400);
    expect((await get('/mind?limit=501')).status).toBe(400);
    expect((await get('/mind?secret=1')).status).toBe(400);
    expect(mocks.readPersistentMindEvents).not.toHaveBeenCalled();
  });

  it('passes the caller id through so a retried message is idempotent', async () => {
    const first = await post('/mind/messages', { id: 'message-1', text: 'Consider the next bounded slice.' });
    mocks.enqueuePersistentMindMessage.mockResolvedValue({ success: true, duplicate: true, messageId: 'message-1' });
    const retry = await post('/mind/messages', { id: 'message-1', text: 'Consider the next bounded slice.' });

    expect(first.status).toBe(202);
    expect(retry.status).toBe(202);
    expect(retry.body.duplicate).toBe(true);
    expect(mocks.enqueuePersistentMindMessage).toHaveBeenNthCalledWith(2, { id: 'message-1', text: 'Consider the next bounded slice.' });
  });

  it('admits image-only messages and forwards strict image references', async () => {
    const res = await post('/mind/messages', { id: 'message-image', images: ['attachment-1'] });
    expect(res.status).toBe(202);
    expect(mocks.enqueuePersistentMindMessage).toHaveBeenCalledWith({
      id: 'message-image', images: ['attachment-1'],
    });
  });

  it('rejects empty, duplicate, oversized, and traversal image references', async () => {
    expect((await post('/mind/messages', { id: 'empty' })).status).toBe(400);
    expect((await post('/mind/messages', { id: 'duplicate', images: ['attachment-1', 'attachment-1'] })).status).toBe(400);
    expect((await post('/mind/messages', {
      id: 'too-many',
      images: Array.from({ length: 9 }, (_, index) => `attachment-${index}`),
    })).status).toBe(400);
    expect((await post('/mind/messages', { id: 'traversal', images: ['../screenshot.png'] })).status).toBe(400);
    expect(mocks.enqueuePersistentMindMessage).not.toHaveBeenCalled();
  });

  it('stores and removes attachments through the Mind-specific endpoints', async () => {
    const upload = await post('/mind/attachments', { filename: 'diagram.png', data: 'iVBORw0KGgo=' });
    expect(upload.status).toBe(201);
    expect(mocks.createPersistentMindAttachment).toHaveBeenCalledWith({ filename: 'diagram.png', data: 'iVBORw0KGgo=' });
    expect(upload.body.attachment).toMatchObject({ attachmentId: 'attachment-1', path: '/api/screenshots/mind-attachment-1.png' });

    const deleteResponse = await request(app()).delete('/api/cos/mind/attachments/attachment-1');
    expect(deleteResponse.status).toBe(200);
    expect(mocks.deletePersistentMindAttachment).toHaveBeenCalledWith('attachment-1');
  });

  it('validates annotation targets and lifecycle inputs', async () => {
    expect((await post('/mind/annotations', { id: '', text: 'Idea' })).status).toBe(400);
    expect((await post('/mind/annotations', { id: 'annotation-1', text: 'Idea', extra: true })).status).toBe(400);
    expect((await post('/mind/pause', { reason: '' })).status).toBe(400);

    const accepted = await post('/mind/annotations', {
      id: 'annotation-1', text: 'Keep this as context.', turnId: 'turn-1', targetEventId: 'event-1',
    });
    expect(accepted.status).toBe(202);
    expect(mocks.appendPersistentMindAnnotation).toHaveBeenCalledWith({
      id: 'annotation-1', text: 'Keep this as context.', turnId: 'turn-1', targetEventId: 'event-1',
    });
  });

  it('rejects an annotation target outside the retained mind ledger', async () => {
    mocks.readPersistentMindHistory.mockResolvedValue([]);
    const res = await post('/mind/annotations', {
      id: 'annotation-1', text: 'Dangling idea.', targetEventId: 'missing',
    });
    expect(res.status).toBe(404);
    expect(mocks.appendPersistentMindAnnotation).not.toHaveBeenCalled();
  });

  it('projects lifecycle state instead of returning queued message bodies', async () => {
    mocks.pausePersistentMind.mockResolvedValue({
      success: true,
      state: {
        enabled: true, started: true, status: 'paused', queuedMessages: [{ id: 'private', text: 'must not leak' }],
        pauseReason: 'Paused from Mind page', activeTurn: null, failureCount: 0,
      },
    });
    const res = await post('/mind/pause', { reason: 'Paused from Mind page' });
    expect(res.status).toBe(200);
    expect(res.body.state).toMatchObject({ status: 'paused', queuedMessageCount: 1 });
    expect(JSON.stringify(res.body)).not.toContain('must not leak');
  });

  it('fails visibly when the supervisor refuses a lifecycle transition', async () => {
    mocks.startPersistentMind.mockResolvedValue({ success: false, error: 'Lifecycle transition refused' });
    const res = await post('/mind/start');
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Lifecycle transition refused');
  });

  it('requires explicit approval before promoting a redacted event summary', async () => {
    expect((await post('/mind/events/event-1/promote', { id: 'promotion-1', approved: false, content: 'Safe summary' })).status).toBe(400);
    const res = await post('/mind/events/event-1/promote', {
      id: 'promotion-1', approved: true, content: 'Safe summary', type: 'insight', category: 'other',
    });
    expect(res.status).toBe(201);
    expect(mocks.promotePersistentMindMemory).toHaveBeenCalledWith(expect.objectContaining({
      id: 'promotion-1', approved: true, content: 'Safe summary', sourceEventId: 'event-1',
    }));
  });

  it('refuses action annotations for an event outside the retained mind ledger', async () => {
    mocks.readPersistentMindHistory.mockResolvedValue([]);
    expect((await post('/mind/events/missing/acknowledge', { id: 'ack-1' })).status).toBe(404);
    expect((await post('/mind/events/missing/promote', {
      id: 'promotion-1', approved: true, content: 'Safe summary',
    })).status).toBe(404);
    expect(mocks.appendPersistentMindAnnotation).not.toHaveBeenCalled();
    expect(mocks.promotePersistentMindMemory).not.toHaveBeenCalled();
  });
});
