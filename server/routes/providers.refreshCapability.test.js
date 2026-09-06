import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { Router } from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { createPortOSProviderRoutes } from './providers.js';

// #3620 — these PortOS routes SHADOW the toolkit's own GET handlers (they strip
// secrets first), so the toolkit's decoration alone never reaches the client.
// This suite pins that the sanitized responses carry `canRefreshModels` too,
// and that it is derived BEFORE redaction — the Claude-Ollama case below is the
// one where deriving after would silently hide the Refresh button.

const CLAUDE_OLLAMA = {
  id: 'claude-ollama',
  name: 'Claude Ollama',
  type: 'cli',
  command: 'claude',
  apiKey: 'sk-secret',
  envVars: { ANTHROPIC_BASE_URL: 'http://localhost:11434' },
  secretEnvVars: ['ANTHROPIC_BASE_URL'],
};
const CODEX = { id: 'codex', name: 'Codex CLI', type: 'cli', command: 'codex', envVars: {} };
const UNREFRESHABLE = { id: 'kimi-cli', name: 'Kimi CLI', type: 'cli', command: 'kimi', envVars: {} };

function appWith(providerService) {
  const toolkit = { services: { providers: providerService }, routes: { providers: Router() } };
  const app = express();
  app.use(express.json());
  app.use('/api/providers', createPortOSProviderRoutes(toolkit));
  app.use(errorMiddleware);
  return app;
}

describe('#3620: sanitized PortOS provider routes carry canRefreshModels', () => {
  it('GET / decorates each provider and still strips the apiKey', async () => {
    const app = appWith({
      getAllProviders: vi.fn().mockResolvedValue({ activeProvider: 'codex', providers: [CLAUDE_OLLAMA, CODEX, UNREFRESHABLE] }),
    });

    const res = await request(app).get('/api/providers');
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.providers.map((p) => [p.id, p]));
    expect(byId['claude-ollama'].canRefreshModels).toBe(true);
    expect(byId.codex.canRefreshModels).toBe(true);
    expect(byId['kimi-cli'].canRefreshModels).toBe(false);
    expect(byId['claude-ollama'].apiKey).toBeUndefined();
    expect(byId['claude-ollama'].hasApiKey).toBe(true);
  });

  it('derives the flag BEFORE redaction — a secret ANTHROPIC_BASE_URL still counts', async () => {
    // `sanitizeProvider` rewrites the value to '***', which no longer looks like
    // an Ollama endpoint. Sanitizing first would report `false` here and drop
    // the Refresh button for every Claude-Ollama install that marked the var
    // secret — a silent regression with no error anywhere.
    const app = appWith({ getProviderById: vi.fn().mockResolvedValue(CLAUDE_OLLAMA) });

    const res = await request(app).get('/api/providers/claude-ollama');
    expect(res.status).toBe(200);
    expect(res.body.envVars.ANTHROPIC_BASE_URL).toBe('***');
    expect(res.body.canRefreshModels).toBe(true);
  });

  it('decorates GET /active as well', async () => {
    const app = appWith({ getActiveProvider: vi.fn().mockResolvedValue(UNREFRESHABLE) });

    const res = await request(app).get('/api/providers/active');
    expect(res.status).toBe(200);
    expect(res.body.canRefreshModels).toBe(false);
  });

  it('decorates the PUT /:id response without persisting the field', async () => {
    const updateProvider = vi.fn().mockResolvedValue({ ...UNREFRESHABLE, enabled: false });
    const app = appWith({
      getProviderById: vi.fn().mockResolvedValue(UNREFRESHABLE),
      updateProvider,
    });

    const res = await request(app)
      .put('/api/providers/kimi-cli')
      .send({ enabled: false, canRefreshModels: true });
    expect(res.status).toBe(200);
    // Derived, not echoed: the table has no kimi row.
    expect(res.body.canRefreshModels).toBe(false);
    // `providerSchema.partial()` strips the unknown key before it reaches the
    // service, so it can never be written to providers.json.
    expect(updateProvider.mock.calls[0][1]).not.toHaveProperty('canRefreshModels');
  });
});
