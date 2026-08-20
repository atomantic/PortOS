import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { Router } from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// The probe is the host's PATH; stub it so this suite asserts the PAYLOAD shape
// rather than which CLIs happen to be installed on the machine running it.
vi.mock('../services/providerRuntimeInstaller.js', async (importOriginal) => ({
  ...(await importOriginal()),
  peekProviderRuntimeStatuses: vi.fn(() => ({
    codex: { id: 'codex', label: 'Codex CLI', installed: false },
    claude: { id: 'claude', label: 'Claude Code CLI', installed: true },
  })),
}));

const { createPortOSProviderRoutes } = await import('./providers.js');

const CODEX = { id: 'codex', name: 'Codex CLI', type: 'cli', command: 'codex', envVars: {} };
const CLAUDE = { id: 'claude-code', name: 'Claude Code', type: 'cli', command: 'claude', envVars: {} };
const KEYLESS_CLOUD = { id: 'openai', name: 'OpenAI', type: 'api', endpoint: 'https://api.example.com/v1', envVars: {} };
const LOCAL_API = { id: 'lmstudio', name: 'LM Studio', type: 'api', endpoint: 'http://localhost:1234/v1', envVars: {} };

const appWith = (providers) => {
  const providerService = {
    getAllProviders: vi.fn().mockResolvedValue({ activeProvider: 'codex', providers }),
  };
  const toolkit = { services: { providers: providerService }, routes: { providers: Router() } };
  const app = express();
  app.use(express.json());
  app.use('/api/providers', createPortOSProviderRoutes(toolkit));
  app.use(errorMiddleware);
  return app;
};

const providersById = (res) => Object.fromEntries(res.body.providers.map((p) => [p.id, p]));

beforeEach(() => vi.clearAllMocks());

describe('#4611: GET /api/providers publishes each provider\'s prerequisites', () => {
  it('flags a CLI provider whose binary is absent, and names it', async () => {
    const byId = providersById(await request(appWith([CODEX, CLAUDE])).get('/api/providers'));

    expect(byId.codex.prerequisitesMet).toBe(false);
    expect(byId.codex.missingPrerequisites).toEqual([{ code: 'runtime', label: 'Codex CLI is not installed' }]);
    expect(byId['claude-code'].prerequisitesMet).toBe(true);
    expect(byId['claude-code'].missingPrerequisites).toEqual([]);
  });

  it('flags a keyless API provider on a public endpoint but not one on loopback', async () => {
    const byId = providersById(await request(appWith([KEYLESS_CLOUD, LOCAL_API])).get('/api/providers'));

    expect(byId.openai.missingPrerequisites).toEqual([{ code: 'apiKey', label: 'API key is not set' }]);
    expect(byId.lmstudio.prerequisitesMet).toBe(true);
  });

  it('derives the API-key check BEFORE sanitization, which replaces the key with a boolean', async () => {
    const byId = providersById(await request(appWith([{ ...KEYLESS_CLOUD, apiKey: 'sk-example' }])).get('/api/providers'));

    expect(byId.openai.prerequisitesMet).toBe(true);
    expect(byId.openai.apiKey).toBeUndefined();
    expect(byId.openai.hasApiKey).toBe(true);
  });

  it('still strips secrets and keeps the existing decorations', async () => {
    const byId = providersById(await request(appWith([CODEX])).get('/api/providers'));

    expect(byId.codex).toHaveProperty('canRefreshModels');
    expect(byId.codex).not.toHaveProperty('apiKey');
  });
});
