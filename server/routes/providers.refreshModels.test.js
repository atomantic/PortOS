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
    expect(refreshHarnessModels).toHaveBeenCalledWith('opencode', { providerId: zen.id });
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

describe('harness-catalog refresh is generic over the runtimes that list models', () => {
  // The bug #7505 fixed: these cards offered no Refresh Models button at all,
  // because the route asked `providerRuntimeKey === 'opencode'` while
  // `refreshHarnessModels` was already generic over every runtime declaring
  // `modelsArgs`. `kilo` and `grok` are the two the literal excluded and that
  // no `MODEL_FETCHERS` row claims.
  it.each([
    { id: 'kilo-cli', name: 'Kilo Code CLI', command: 'kilo', runtime: 'kilo' },
    { id: 'kilo-tui', name: 'Kilo Code TUI', command: 'kilo', runtime: 'kilo', type: 'tui' },
    { id: 'grok-cli', name: 'Grok Build CLI', command: 'grok', runtime: 'grok' },
    { id: 'grok-tui', name: 'Grok Build TUI', command: 'grok', runtime: 'grok', type: 'tui' },
  ])('offers the button and refreshes $id through its own harness', async ({ id, name, command, runtime, type = 'cli' }) => {
    const provider = { id, name, type, command, models: [`${runtime}/old`] };
    const refreshed = { ...provider, models: [`${runtime}/new`] };
    const service = {
      getProviderById: vi.fn().mockResolvedValueOnce(provider).mockResolvedValueOnce(provider).mockResolvedValue(refreshed),
      refreshProviderModels: vi.fn(),
    };
    refreshHarnessModels.mockResolvedValue({ ok: true, updated: [id] });
    const app = appWith(service);

    expect((await request(app).get(`/api/providers/${id}`)).body.canRefreshModels).toBe(true);
    const res = await request(app).post(`/api/providers/${id}/refresh-models`);

    expect(res.status).toBe(200);
    expect(res.body.models).toEqual([`${runtime}/new`]);
    // Scoped to this record, not the whole harness — the per-credential
    // bucketing #7506 added must survive on the widened path too.
    expect(refreshHarnessModels).toHaveBeenCalledWith(runtime, { providerId: id });
    expect(service.refreshProviderModels).not.toHaveBeenCalled();
  });

  // The precedence this route fixes: a record can match BOTH paths, and the
  // toolkit's per-record fetcher wins. `cursor-cli` and `antigravity-cli` are
  // in the harness-catalog set AND claimed by a `MODEL_FETCHERS` row — widening
  // the predicate must not move them off the fetcher they refresh through today.
  it.each([
    { id: 'cursor-cli', name: 'Cursor Agent CLI', command: 'cursor-agent' },
    { id: 'antigravity-cli', name: 'Antigravity CLI', command: 'agy' },
    { id: 'pi-cli', name: 'Pi Coding Agent CLI', command: 'pi' },
    // The weak `cliNameMatch` column claims this one by DISPLAY NAME alone;
    // it is still a fetcher claim, so it still outranks the harness path.
    { id: 'renamed-kilo', name: 'My Claude via Kilo', command: 'kilo' },
  ])('routes $id to its toolkit fetcher, not the harness catalog', async ({ id, name, command }) => {
    const provider = { id, name, type: 'cli', command, models: ['old'] };
    const service = {
      getProviderById: vi.fn().mockResolvedValue(provider),
      refreshProviderModels: vi.fn().mockResolvedValue({ ...provider, models: ['new'] }),
    };
    refreshHarnessModels.mockClear();
    const app = appWith(service);

    const res = await request(app).post(`/api/providers/${id}/refresh-models`);

    expect(res.status).toBe(200);
    expect(res.body.models).toEqual(['new']);
    expect(service.refreshProviderModels).toHaveBeenCalledWith(id);
    expect(refreshHarnessModels).not.toHaveBeenCalled();
  });

  // `usesHarnessCatalog` is the other half of the predicate, and widening the
  // runtime half must not reach past it: a wrapper pointed at a gateway or a
  // local daemon serves ids its harness never prints.
  it.each([
    { label: 'a gateway-backed wrapper', provider: { id: 'kilo-openrouter', name: 'Kilo OpenRouter', command: 'kilo', gatewayBacked: 'openrouter' } },
    { label: 'a local-daemon wrapper', provider: { id: 'kilo-ollama', name: 'Kilo Ollama', command: 'kilo', ollamaBacked: true } },
  ])('never refreshes $label from the harness catalog', async ({ provider }) => {
    const stored = { type: 'cli', models: ['old'], ...provider };
    const service = {
      getProviderById: vi.fn().mockResolvedValue(stored),
      refreshProviderModels: vi.fn().mockResolvedValue({ ...stored, models: ['new'] }),
    };
    refreshHarnessModels.mockClear();
    const app = appWith(service);

    await request(app).post(`/api/providers/${stored.id}/refresh-models`);

    expect(refreshHarnessModels).not.toHaveBeenCalled();
  });

  // A custom binary resolves to no runtime row at all, so neither half applies.
  it('offers no refresh for a custom binary with no runtime row', async () => {
    const provider = { id: 'example-custom-binary', name: 'Example Harness', type: 'cli', command: 'example-harness' };
    const app = appWith({ getProviderById: vi.fn().mockResolvedValue(provider) });

    const res = await request(app).get('/api/providers/example-custom-binary');

    expect(res.body.canRefreshModels).toBe(false);
  });
});
