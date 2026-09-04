import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const mocks = vi.hoisted(() => ({
  loadMeta: vi.fn(),
  updateMeta: vi.fn(),
  getProviderById: vi.fn(),
}));

vi.mock('../services/brain.js', () => ({
  loadMeta: (...args) => mocks.loadMeta(...args),
  updateMeta: (...args) => mocks.updateMeta(...args),
  getSummary: vi.fn(),
}));
vi.mock('../services/providers.js', () => ({
  getProviderById: (...args) => mocks.getProviderById(...args),
}));

const settingsRoutes = (await import('./brainSettings.js')).default;

const app = express();
app.use(express.json());
app.use('/api/brain', settingsRoutes);
app.use(errorMiddleware);

const put = (body) => request(app).put('/api/brain/settings').send(body);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.loadMeta.mockResolvedValue({ defaultProvider: 'claude-code', defaultModel: 'claude-opus-4-7' });
  mocks.updateMeta.mockImplementation(async (data) => ({ defaultProvider: 'claude-code', ...data }));
});

describe('PUT /api/brain/settings', () => {
  it('saves a model the provider offers', async () => {
    mocks.getProviderById.mockResolvedValue({
      id: 'claude-code', type: 'cli', models: ['claude-opus-4-7', 'claude-haiku-4-5'],
    });

    const response = await put({ defaultProvider: 'claude-code', defaultModel: 'claude-haiku-4-5' });

    expect(response.status).toBe(200);
    expect(mocks.updateMeta).toHaveBeenCalledWith({ defaultProvider: 'claude-code', defaultModel: 'claude-haiku-4-5' });
  });

  it('rejects a retired model on a cloud provider whose catalog is authoritative', async () => {
    mocks.getProviderById.mockResolvedValue({
      id: 'claude-code', type: 'cli', models: ['claude-opus-4-7', 'claude-haiku-4-5'],
    });

    const response = await put({ defaultProvider: 'claude-code', defaultModel: 'claude-2' });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_MODEL');
    expect(mocks.updateMeta).not.toHaveBeenCalled();
  });

  // The record's `models` is only a cached snapshot for a local daemon — a model
  // pulled since the last refresh is installed and serving, so a 400 here blocks
  // a save the user can legitimately make.
  it('saves a model a local-runtime provider\'s cached list omits', async () => {
    mocks.getProviderById.mockResolvedValue({
      id: 'grok-ollama', type: 'cli', command: 'grok', ollamaBacked: true,
      models: ['qwen3-coder:30b'], defaultModel: 'qwen3-coder:30b',
    });

    const response = await put({ defaultProvider: 'grok-ollama', defaultModel: 'gemma3:27b' });

    expect(response.status).toBe(200);
    expect(mocks.updateMeta).toHaveBeenCalledWith({ defaultProvider: 'grok-ollama', defaultModel: 'gemma3:27b' });
  });

  // An empty catalog validates nothing, so the pin is the caller's to choose —
  // this replaced the old NO_MODELS 400.
  it('saves a model on a provider that enumerates no models', async () => {
    mocks.getProviderById.mockResolvedValue({ id: 'bare-cli', type: 'cli', models: [] });

    const response = await put({ defaultProvider: 'bare-cli', defaultModel: 'anything-goes' });

    expect(response.status).toBe(200);
    expect(mocks.updateMeta).toHaveBeenCalledWith({ defaultProvider: 'bare-cli', defaultModel: 'anything-goes' });
  });

  it('rejects an unknown provider', async () => {
    mocks.getProviderById.mockResolvedValue(null);

    const response = await put({ defaultProvider: 'nope', defaultModel: 'x' });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('INVALID_PROVIDER');
  });
});
