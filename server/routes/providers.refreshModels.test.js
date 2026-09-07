import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { Router } from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { createPortOSProviderRoutes } from './providers.js';

const refreshHarnessModels = vi.hoisted(() => vi.fn());
vi.mock('../services/harnesses.js', async (importOriginal) => ({
  ...await importOriginal(), refreshHarnessModels,
}));

const RAW_PROVIDER = {
  id: 'openai',
  name: 'OpenAI',
  type: 'api',
  apiKey: 'sk-example-secret',
  envVars: { OPENAI_ORG: 'example-org', OPENAI_API_KEY: 'sk-env-secret' },
  secretEnvVars: ['OPENAI_API_KEY'],
  models: ['gpt-example'],
};

function appWith(providerService) {
  const toolkit = { services: { providers: providerService }, routes: { providers: Router() } };
  const app = express();
  app.use(express.json());
  app.use('/api/providers', createPortOSProviderRoutes(toolkit));
  app.use(errorMiddleware);
  return app;
}

describe('POST /:id/refresh-models provider redaction', () => {
  it('returns refreshed models without the API key or secret env value', async () => {
    const app = appWith({ getProviderById: vi.fn().mockResolvedValue(RAW_PROVIDER), refreshProviderModels: vi.fn().mockResolvedValue(RAW_PROVIDER) });

    const res = await request(app).post('/api/providers/openai/refresh-models');

    expect(res.status).toBe(200);
    expect(res.body.apiKey).toBeUndefined();
    expect(res.body.hasApiKey).toBe(true);
    expect(res.body.envVars.OPENAI_API_KEY).toBe('***');
    expect(res.body.envVars.OPENAI_ORG).toBe('example-org');
    expect(res.body.models).toEqual(['gpt-example']);
    expect(res.body.canRefreshModels).toBe(true);
  });

  it('returns 404 when the provider does not exist', async () => {
    const app = appWith({ getProviderById: vi.fn().mockResolvedValue(null) });

    const res = await request(app).post('/api/providers/missing/refresh-models');

    expect(res.status).toBe(404);
  });
});

describe('OpenCode Zen card refresh', () => {
  const zen = { id: 'opencode-zen-cli', name: 'OpenCode Zen', type: 'cli', command: 'opencode', models: ['opencode/old'] };

  it.each(['cli', 'tui'])('exposes refresh and returns the persisted scoped catalog through the harness workflow (%s)', async (type) => {
    const provider = { ...zen, type };
    const refreshed = { ...provider, models: ['opencode/new'], defaultModel: 'opencode/new' };
    const service = {
      getProviderById: vi.fn().mockResolvedValueOnce(provider).mockResolvedValueOnce(provider).mockResolvedValue(refreshed),
      refreshProviderModels: vi.fn(),
    };
    refreshHarnessModels.mockResolvedValue({ ok: true, updated: [zen.id] });
    const app = appWith(service);
    expect((await request(app).get('/api/providers/' + zen.id)).body.canRefreshModels).toBe(true);
    const res = await request(app).post('/api/providers/' + zen.id + '/refresh-models');
    expect(res.status).toBe(200);
    expect(res.body.models).toEqual(['opencode/new']);
    expect(refreshHarnessModels).toHaveBeenCalledWith('opencode');
    expect(service.refreshProviderModels).not.toHaveBeenCalled();
  });

  it.each([
    { ok: false, reason: 'OpenCode is not installed.', updated: [] },
    { ok: true, updated: [] },
  ])('reports an unsuccessful refresh without claiming success', async (result) => {
    refreshHarnessModels.mockResolvedValue(result);
    const app = appWith({ getProviderById: vi.fn().mockResolvedValue(zen) });
    const res = await request(app).post('/api/providers/' + zen.id + '/refresh-models');
    expect(res.status).toBe(502);
  });
});

it('does not offer harness refresh for a hand-declared OpenCode backend', async () => {
  const provider = {
    id: 'example-custom', type: 'tui', command: 'opencode',
    envVars: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ provider: { example: { models: {} } } }) },
  };
  const app = appWith({ getProviderById: vi.fn().mockResolvedValue(provider) });
  const res = await request(app).get('/api/providers/example-custom');
  expect(res.body.canRefreshModels).toBe(false);
});
