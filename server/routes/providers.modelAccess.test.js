import { describe, it, expect, vi } from 'vitest';
import express, { Router } from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { createPortOSProviderRoutes } from './providers.js';

// The PortOS provider routes SHADOW the toolkit's own GET handlers, so the
// toolkit's scoping never reaches the client on its own — `presentProvider` has
// to apply it too. Everything downstream reads `provider.models` off this
// payload (every `filterSelectableModels(provider.models)` picker in the client,
// the CoS model allowlists, the comparison chart), which is what makes one
// narrowing here cover the whole app.

const CATALOG = ['meta/llama-3.3-70b-instruct', 'nvidia/nemotron-4-340b-instruct', 'moonshotai/kimi-k2.5'];

const NVIDIA = {
  id: 'nvidia-nim',
  name: 'NVIDIA NIM',
  type: 'api',
  endpoint: 'https://integrate.api.nvidia.com/v1',
  apiKey: 'nvapi-secret',
  envVars: {},
  models: CATALOG,
  defaultModel: 'moonshotai/kimi-k2.5',
  modelAccess: { mode: 'allow', patterns: ['meta/*'] },
};

function appWith(providerService) {
  const toolkit = { services: { providers: providerService }, routes: { providers: Router() } };
  const app = express();
  app.use(express.json());
  app.use('/api/providers', createPortOSProviderRoutes(toolkit));
  app.use(errorMiddleware);
  return app;
}

describe('provider payloads carry the model-access-scoped catalog', () => {
  it('GET / narrows models, keeps the full catalog, and still strips the key', async () => {
    const app = appWith({
      getAllProviders: vi.fn().mockResolvedValue({ activeProvider: 'nvidia-nim', providers: [NVIDIA] }),
    });

    const res = await request(app).get('/api/providers');
    expect(res.status).toBe(200);
    const [provider] = res.body.providers;
    // `defaultModel` is pinned to a model the policy does not match and stays
    // visible — a picker whose stored value is missing from its options renders
    // blank and re-points the provider on the next save.
    expect(provider.models).toEqual(['meta/llama-3.3-70b-instruct', 'moonshotai/kimi-k2.5']);
    expect(provider.modelCatalog).toEqual(CATALOG);
    expect(provider.modelAccessHiddenCount).toBe(1);
    // Scoping runs at the END of the presentation chain, so redaction is
    // unaffected by it.
    expect(provider.apiKey).toBeUndefined();
    expect(provider.hasApiKey).toBe(true);
  });

  it('GET /:id and GET /active scope the same way', async () => {
    const app = appWith({
      getProviderById: vi.fn().mockResolvedValue(NVIDIA),
      getActiveProvider: vi.fn().mockResolvedValue(NVIDIA),
    });

    for (const path of ['/api/providers/nvidia-nim', '/api/providers/active']) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(200);
      expect(res.body.models, path).toEqual(['meta/llama-3.3-70b-instruct', 'moonshotai/kimi-k2.5']);
    }
  });

  it('a provider with no policy serializes exactly as before', async () => {
    // Every install that has not configured this must see no change at all —
    // no redundant `modelCatalog` copy on every provider in the list.
    const plain = { ...NVIDIA, modelAccess: undefined };
    const app = appWith({ getAllProviders: vi.fn().mockResolvedValue({ activeProvider: 'nvidia-nim', providers: [plain] }) });

    const [provider] = (await request(app).get('/api/providers')).body.providers;
    expect(provider.models).toEqual(CATALOG);
    expect(provider).not.toHaveProperty('modelCatalog');
    expect(provider).not.toHaveProperty('modelAccessHiddenCount');
  });
});

describe('a write response is scoped the same way a read is', () => {
  // A write returns the persisted record, and a gateway-backed wrapper stores no
  // policy of its own. Without carrying the resolution forward, saving or
  // refreshing a wrapper answers with the unscoped catalog and the next page load
  // with the scoped one — which reads as a bug.
  const WRAPPER = {
    id: 'opencode-nvidia-nim', name: 'NVIDIA NIM via OpenCode', type: 'cli',
    command: 'opencode', gatewayBacked: 'nvidia-nim', envVars: {}, models: CATALOG,
  };
  const resolved = { ...WRAPPER, modelAccessEffective: { mode: 'allow', patterns: ['meta/*'] }, modelAccessSource: 'nvidia-nim' };

  it('PUT /:id returns the inherited scope', async () => {
    const app = appWith({
      getProviderById: vi.fn().mockResolvedValue(resolved),
      updateProvider: vi.fn().mockResolvedValue({ ...WRAPPER, name: 'Renamed' }),
    });
    const res = await request(app).put('/api/providers/opencode-nvidia-nim').send({ name: 'Renamed' });
    expect(res.status).toBe(200);
    expect(res.body.models).toEqual(['meta/llama-3.3-70b-instruct']);
    expect(res.body.modelAccessSource).toBe('nvidia-nim');
  });

  it('a policy the write just SET outranks the inherited one carried forward', async () => {
    const app = appWith({
      getProviderById: vi.fn().mockResolvedValue(resolved),
      updateProvider: vi.fn().mockResolvedValue({ ...WRAPPER, modelAccess: { mode: 'allow', patterns: ['moonshotai/*'] } }),
    });
    const res = await request(app).put('/api/providers/opencode-nvidia-nim')
      .send({ modelAccess: { mode: 'allow', patterns: ['moonshotai/*'] } });
    expect(res.body.models).toEqual(['moonshotai/kimi-k2.5']);
  });

  it('POST /:id/refresh-models returns the inherited scope over the fresh catalog', async () => {
    const app = appWith({
      getProviderById: vi.fn().mockResolvedValue(resolved),
      refreshProviderModels: vi.fn().mockResolvedValue({ ...WRAPPER, models: [...CATALOG, 'meta/llama-4-scout'] }),
    });
    const res = await request(app).post('/api/providers/opencode-nvidia-nim/refresh-models');
    expect(res.status).toBe(200);
    expect(res.body.models).toEqual(['meta/llama-3.3-70b-instruct', 'meta/llama-4-scout']);
    // The full probe result is still what landed on disk and what the editor sees.
    expect(res.body.modelCatalog).toEqual([...CATALOG, 'meta/llama-4-scout']);
  });
});
