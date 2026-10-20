import { describe, expect, it, vi } from 'vitest';
import express, { Router } from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { createPortOSProviderRoutes } from './providers.js';

// Synthetic record: the Secret box was left off for a hand-entered key.
const stored = () => ({
  id: 'example-cli',
  name: 'Example CLI',
  type: 'cli',
  command: 'example',
  models: [],
  enabled: true,
  envVars: { OPENAI_API_KEY: 'sk-example-real', EXAMPLE_BASE_URL: 'http://localhost:1234' },
  secretEnvVars: [],
});

function appWith(providerService) {
  const toolkit = { services: { providers: providerService }, routes: { providers: Router() } };
  const app = express();
  app.use(express.json());
  app.use('/api/providers', createPortOSProviderRoutes(toolkit));
  app.use(errorMiddleware);
  return app;
}

describe('credential-named provider env vars', () => {
  it('masks a credential-named var that is not in secretEnvVars, but not a base URL', async () => {
    const record = stored();
    const res = await request(appWith({ getProviderById: vi.fn().mockResolvedValue(record) }))
      .get('/api/providers/example-cli');

    expect(res.status).toBe(200);
    expect(res.body.envVars.OPENAI_API_KEY).toBe('***');
    expect(res.body.envVars.EXAMPLE_BASE_URL).toBe('http://localhost:1234');
    expect(JSON.stringify(res.body)).not.toContain('sk-example-real');
  });

  it('keeps the stored key when a save resends ***, and replaces it for a new value', async () => {
    const updateProvider = vi.fn(async (_id, next) => next);
    const app = appWith({ getProviderById: vi.fn().mockResolvedValue(stored()), updateProvider });

    const kept = await request(app).put('/api/providers/example-cli')
      .send({ envVars: { OPENAI_API_KEY: '***', EXAMPLE_BASE_URL: 'http://localhost:1234' } });
    expect(kept.status).toBe(200);
    expect(updateProvider.mock.calls[0][1].envVars.OPENAI_API_KEY).toBe('sk-example-real');

    const replaced = await request(app).put('/api/providers/example-cli')
      .send({ envVars: { OPENAI_API_KEY: 'sk-example-new' } });
    expect(replaced.status).toBe(200);
    expect(updateProvider.mock.calls[1][1].envVars.OPENAI_API_KEY).toBe('sk-example-new');
  });
});
