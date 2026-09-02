import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { Router } from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { createPortOSProviderRoutes } from './providers.js';

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
    const app = appWith({ refreshProviderModels: vi.fn().mockResolvedValue(RAW_PROVIDER) });

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
    const app = appWith({ refreshProviderModels: vi.fn().mockResolvedValue(null) });

    const res = await request(app).post('/api/providers/missing/refresh-models');

    expect(res.status).toBe(404);
  });
});
