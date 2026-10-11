import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// Exercise the real gates, memory route, embedding budget and summarizer. All
// persisted state, provider execution and embedding HTTP are synthetic sinks.
vi.mock('../services/auth.js', () => ({
  isAuthEnabled: vi.fn().mockResolvedValue(false),
  verifyPassword: vi.fn(),
  verifyRequestSession: vi.fn(),
}));
vi.mock('../services/settings.js', () => ({
  getSettings: vi.fn().mockResolvedValue({}),
  settingsEvents: new EventEmitter(),
}));
vi.mock('../services/voice/config.js', () => ({ getVoiceConfig: vi.fn() }));
vi.mock('../services/instanceIdentity.js', () => ({ loadData: vi.fn() }));
vi.mock('../lib/securityAuditLog.js', () => ({ logSecurityEvent: vi.fn() }));
vi.mock('../services/memoryBackend.js', () => ({ createMemory: vi.fn(), ensureBackend: vi.fn() }));
vi.mock('../services/memorySync.js', () => ({}));
vi.mock('../services/memoryRunUsage.js', () => ({ findRecentRunsUsingMemory: vi.fn() }));
vi.mock('../lib/db.js', () => ({ checkHealth: vi.fn() }));
vi.mock('../services/cosState.js', () => ({ getConfig: vi.fn() }));
vi.mock('../services/providers.js', () => ({ getProviderById: vi.fn() }));
vi.mock('../services/brainStorage.js', () => ({ loadMeta: vi.fn() }));
vi.mock('../services/chatgptImport.js', () => ({ readArchivedConversation: vi.fn() }));
vi.mock('../services/promptRunner.js', () => ({ runPromptThroughProvider: vi.fn() }));

import memoryRoutes from './memory.js';
import { authGate, hostControlRouteGate, hostControlBodyGate } from '../services/authGate.js';
import { isAuthEnabled } from '../services/auth.js';
import { createMemory } from '../services/memoryBackend.js';
import { reinitialize } from '../services/memoryEmbeddings.js';
import { getConfig } from '../services/cosState.js';
import { getProviderById } from '../services/providers.js';
import { loadMeta } from '../services/brainStorage.js';
import { runPromptThroughProvider } from '../services/promptRunner.js';

const embeddingProvider = { id: 'embed', type: 'api', endpoint: 'https://embedding.example.com/v1' };
const summaryProvider = { id: 'summary', type: 'cli', command: 'claude', defaultModel: 'example-model' };
const vector = [0.1, 0.2, 0.3];
const budget = Math.floor(2048 * 0.85 * 3);
const longContent = 'Reference text. '.repeat(420);
let app;
let inputs;

beforeEach(() => {
  vi.resetAllMocks();
  isAuthEnabled.mockResolvedValue(false);
  reinitialize();
  inputs = [];
  getConfig.mockResolvedValue({ embeddingProviderId: 'embed', embeddingModel: 'example-embed' });
  loadMeta.mockResolvedValue({ defaultProvider: 'summary' });
  getProviderById.mockImplementation(async (id) => id === 'embed' ? embeddingProvider : summaryProvider);
  runPromptThroughProvider.mockResolvedValue({ text: 'A factual summary.' });
  createMemory.mockImplementation(async (data, embedding) => ({ id: 'example-memory', ...data, embedding }));

  const realFetch = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, options) => {
    if (String(url).startsWith('http://127.0.0.1:')) return realFetch(url, options);
    if (String(url) === 'https://embedding.example.com/api/v0/models') {
      return new Response('', { status: 404 });
    }
    if (String(url) === 'https://embedding.example.com/v1/embeddings') {
      inputs.push(JSON.parse(options.body).input);
      return new Response(JSON.stringify({ data: [{ embedding: vector }] }));
    }
    throw new Error('Unexpected network request in memory authority test');
  });
  app = express();
  app.use((req, res, next) => {
    Object.defineProperty(req.socket, 'remoteAddress', { value: '192.0.2.10', configurable: true });
    next();
  });
  app.use(authGate);
  app.use(hostControlRouteGate);
  app.use(express.json());
  app.use(hostControlBodyGate);
  app.use('/api/memory', memoryRoutes);
  app.use(errorMiddleware);
});

afterEach(() => vi.restoreAllMocks());

describe('memory creation embedding authority (#11038)', () => {
  // Uniquely catches accepted data-only remote writes acquiring host tools in
  // the automatic over-budget summarizer, before the memory is persisted.
  it('summarizes an over-budget remote memory with tools and fallback disabled', async () => {
    const response = await request(app).post('/api/memory').send({ type: 'fact', content: longContent });

    expect(response.status).toBe(201);
    expect(response.body.content).toBe(longContent);
    expect(response.body.embedding).toEqual(vector);
    expect(runPromptThroughProvider).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      provider: summaryProvider,
      prompt: expect.stringContaining(longContent),
      toolFree: true,
      allowFallback: false,
    }));
    expect(inputs).toEqual(['Type: fact\nCategory: other\nA factual summary.']);
  });

  it.each([
    { id: 'summary', type: 'tui', command: 'claude' },
    { id: 'summary', type: 'cli', command: 'codex' },
  ])('truncates safely when the configured summarizer cannot disable tools ($type)', async (provider) => {
    getProviderById.mockImplementation(async (id) => id === 'embed' ? embeddingProvider : provider);

    const response = await request(app).post('/api/memory').send({ type: 'fact', content: longContent });

    expect(response.status).toBe(201);
    expect(response.body.content).toBe(longContent);
    expect(response.body.embedding).toEqual(vector);
    expect(runPromptThroughProvider).not.toHaveBeenCalled();
    expect(inputs).toEqual([`Type: fact\nCategory: other\n${longContent}`.slice(0, budget)]);
  });

  it('preserves the write and bounded embedding when tool-free inference is unavailable', async () => {
    runPromptThroughProvider.mockRejectedValue(new Error('Synthetic provider unavailable'));

    const response = await request(app).post('/api/memory').send({ type: 'fact', content: longContent });

    expect(response.status).toBe(201);
    expect(response.body.content).toBe(longContent);
    expect(response.body.embedding).toEqual(vector);
    expect(runPromptThroughProvider).toHaveBeenCalledTimes(1);
    expect(inputs).toEqual([`Type: fact\nCategory: other\n${longContent}`.slice(0, budget)]);
  });

  it('embeds an in-budget remote memory directly without provider inference', async () => {
    const response = await request(app).post('/api/memory').send({ type: 'fact', content: 'A short fact.' });

    expect(response.status).toBe(201);
    expect(response.body.embedding).toEqual(vector);
    expect(runPromptThroughProvider).not.toHaveBeenCalled();
    expect(inputs).toEqual(['Type: fact\nCategory: other\nA short fact.']);
  });
});
