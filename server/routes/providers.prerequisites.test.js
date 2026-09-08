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

const { peekProviderRuntimeStatuses } = await import('../services/providerRuntimeInstaller.js');
const { createPortOSProviderRoutes } = await import('./providers.js');

const CODEX = { id: 'codex', name: 'Codex CLI', type: 'cli', command: 'codex', envVars: {} };
const CLAUDE = { id: 'claude-code', name: 'Claude Code', type: 'cli', command: 'claude', envVars: {} };
const BEDROCK = {
  id: 'claude-code-bedrock', name: 'Claude Code Bedrock', type: 'cli', command: 'claude',
  envVars: { AWS_BEARER_TOKEN_BEDROCK: '' }, secretEnvVars: ['AWS_BEARER_TOKEN_BEDROCK'],
};
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
  it('retains separate selectable execution records while describing one card per matching connection', async () => {
    const tui = { ...CODEX, id: 'codex-tui', name: 'Codex TUI', type: 'tui' };
    const response = await request(appWith([CODEX, tui, LOCAL_API])).get('/api/providers');
    const byId = providersById(response);
    expect(response.body.providers).toHaveLength(3);
    expect(byId.codex.executionModes).toEqual([{ id: 'codex', type: 'cli' }, { id: 'codex-tui', type: 'tui' }]);
    expect(byId['codex-tui'].executionModes).toEqual(byId.codex.executionModes);
    expect(byId.lmstudio.executionModes).toEqual([{ id: 'lmstudio', type: 'api' }]);
    const separate = providersById(await request(appWith([CODEX, { ...tui, envVars: { EXAMPLE_BACKEND: 'remote' } }])).get('/api/providers'));
    expect(separate.codex.executionModes).toHaveLength(1);
  });

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

  // The route never awaits the probe — a cold cache must publish NO runtime
  // finding rather than an accusation, and the page's own /runtimes fetch fills
  // that gap on the card.
  it('publishes an empty finding list on a cold runtime cache', async () => {
    peekProviderRuntimeStatuses.mockReturnValueOnce({});

    const byId = providersById(await request(appWith([CODEX])).get('/api/providers'));

    expect(byId.codex.prerequisitesMet).toBe(true);
    expect(byId.codex.missingPrerequisites).toEqual([]);
  });

  it('still strips secrets and keeps the existing decorations', async () => {
    const byId = providersById(await request(appWith([CODEX])).get('/api/providers'));

    expect(byId.codex).toHaveProperty('canRefreshModels');
    expect(byId.codex).not.toHaveProperty('apiKey');
  });

  it('preserves an explicitly empty secret env value for readiness to classify', async () => {
    const byId = providersById(await request(appWith([BEDROCK])).get('/api/providers'));

    expect(byId['claude-code-bedrock'].envVars.AWS_BEARER_TOKEN_BEDROCK).toBe('');
    expect(byId['claude-code-bedrock'].secretEnvVars).toEqual(['AWS_BEARER_TOKEN_BEDROCK']);
  });

  it('continues redacting a configured secret env value', async () => {
    const configured = {
      ...BEDROCK,
      envVars: { ...BEDROCK.envVars, AWS_BEARER_TOKEN_BEDROCK: 'token-example' },
    };
    const byId = providersById(await request(appWith([configured])).get('/api/providers'));

    expect(byId['claude-code-bedrock'].envVars.AWS_BEARER_TOKEN_BEDROCK).toBe('***');
  });
});
