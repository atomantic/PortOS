import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { Router } from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { staticImportClosure, specifierMatchesPackage } from '../lib/staticImportGraph.js';
import { createPortOSProviderRoutes } from './providers.js';

const SERVER_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const abs = (relative) => join(SERVER_DIR, ...relative.split('/'));

// Synthetic fixtures — never a record read out of a running install.
const CLAUDE_OLLAMA = {
  id: 'claude-ollama',
  name: 'Claude Ollama',
  type: 'cli',
  command: 'claude',
  ollamaBacked: true,
  models: ['example-model:8b'],
  enabled: true,
  envVars: { ANTHROPIC_BASE_URL: 'http://localhost:11434', ANTHROPIC_AUTH_TOKEN: 'example-token' },
  secretEnvVars: ['ANTHROPIC_AUTH_TOKEN'],
};
const CLAUDE_OLLAMA_TUI = { ...CLAUDE_OLLAMA, id: 'claude-ollama-tui', type: 'tui', enabled: false };
const REMOTE_API = {
  id: 'remote-ollama',
  name: 'Remote Ollama',
  type: 'api',
  endpoint: 'https://ollama.example.com/v1',
  apiKey: 'example-remote-key',
  models: [],
  enabled: true,
};

function appWith(providerService) {
  const toolkit = { services: { providers: providerService }, routes: { providers: Router() } };
  const app = express();
  app.use(express.json());
  app.use('/api/providers', createPortOSProviderRoutes(toolkit));
  app.use(errorMiddleware);
  return app;
}

const providersFixture = () => ({
  activeProvider: 'claude-ollama',
  providers: [CLAUDE_OLLAMA, CLAUDE_OLLAMA_TUI, REMOTE_API],
});

describe('GET /api/providers/management/preview', () => {
  it('returns the version-1 graph preview without touching the flat provider API', async () => {
    const getAllProviders = vi.fn().mockResolvedValue(providersFixture());
    const res = await request(appWith({ getAllProviders })).get('/api/providers/management/preview');

    expect(res.status).toBe(200);
    expect(res.body.schemaVersion).toBe(1);
    // Same executable provider id string the flat API publishes.
    expect(res.body.activeProvider).toBe('claude-ollama');
    expect(res.body.routes.map((route) => route.providerId).sort())
      .toEqual(['claude-ollama', 'claude-ollama-tui', 'remote-ollama']);
    // The graph is read-only: nothing was written back.
    expect(getAllProviders).toHaveBeenCalledTimes(1);
  });

  it('publishes credential PRESENCE, never a credential or a redacted stand-in', async () => {
    const res = await request(appWith({ getAllProviders: vi.fn().mockResolvedValue(providersFixture()) }))
      .get('/api/providers/management/preview');

    const serialized = JSON.stringify(res.body);
    expect(serialized).not.toContain('example-token');
    expect(serialized).not.toContain('example-remote-key');
    expect(res.body.connections.every((connection) => connection.hasCredentials)).toBe(true);
  });

  it('leaves GET /api/providers byte-compatible for existing clients', async () => {
    // A new endpoint must not become a reason for an old client to change.
    const res = await request(appWith({ getAllProviders: vi.fn().mockResolvedValue(providersFixture()) }))
      .get('/api/providers');

    expect(res.status).toBe(200);
    expect(res.body.activeProvider).toBe('claude-ollama');
    expect(res.body.providers.map((p) => p.id))
      .toEqual(['claude-ollama', 'claude-ollama-tui', 'remote-ollama']);
    expect(res.body.providers[0].hasApiKey).toBe(false);
    expect(res.body.providers[0].executionModes).toBeDefined();
  });
});

describe('the preview contacts no AI provider and launches no runtime', () => {
  // The AI Provider Usage Policy in AGENTS.md: rendering a configuration screen
  // must never be what starts a generation call or a CLI/TUI process. The
  // preview is designed to be safe to open, so the absence of those calls is a
  // product contract and gets an assertion rather than a comment.
  // `request()` is itself fetch-based against a loopback server, so the spy
  // passes through and the assertion is about the DESTINATION: anything the
  // handler reached for would show up as a non-loopback URL.
  let fetchSpy;

  beforeEach(() => {
    const real = globalThis.fetch;
    fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation((...args) => real(...args));
  });
  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('makes no outbound request while serving the preview', async () => {
    const res = await request(appWith({ getAllProviders: vi.fn().mockResolvedValue(providersFixture()) }))
      .get('/api/providers/management/preview');

    expect(res.status).toBe(200);
    const destinations = fetchSpy.mock.calls.map(([input]) => String(input?.url ?? input));
    expect(destinations.filter((url) => !url.startsWith('http://127.0.0.1:'))).toEqual([]);
  });

  it('builds the graph from modules that cannot spawn a process or open a socket', () => {
    // The runtime assertion above only proves this request did not call out.
    // This proves the preview modules have no way to: nothing in their static
    // import closure can spawn, pty, or reach an AI provider service.
    const closure = staticImportClosure(abs('lib/providerGraphPreview.js'));
    const forbidden = ['child_process', 'node:child_process', 'node-pty', 'node:net', 'node:dgram'];
    for (const pkg of closure.packages) {
      expect(forbidden.some((banned) => specifierMatchesPackage(pkg, banned))).toBe(false);
    }
    expect([...closure.files].filter((file) => file.includes('/services/'))).toEqual([]);

    // Positive control: the walk really does see packages, so a resolver gap
    // cannot make the negative assertions above pass vacuously.
    expect(closure.packages.has('zod')).toBe(true);
    expect(closure.files.has(abs('lib/providerConnections.js'))).toBe(true);
  });
});

// A harness that runs both headlessly and interactively is ONE program on one
// backend, but `providers.json` stores one execution mode per record — so
// configuring both used to mean adding the same command twice from /ai/new and
// hoping the two records matched closely enough for `providerModeGroups` to
// pair them. `modes` on the create body mints the pair from one submit; what
// the ROUTE owns is dispatching on it, the response envelope, and sanitizing
// every record in it. The ids, names and per-mode fields the split produces are
// pinned where they are decided, in `lib/aiToolkit/providers.test.js`.
describe('POST /api/providers — creating both execution modes at once', () => {
  const PAIR = [
    { id: 'example-agent', name: 'Example Agent', type: 'cli', command: 'example', apiKey: 'sk-secret' },
    { id: 'example-agent-tui', name: 'Example Agent TUI', type: 'tui', command: 'example', apiKey: 'sk-secret' },
  ];
  const BODY = {
    name: 'Example Agent',
    type: 'cli',
    command: 'example',
    args: ['--print'],
    modes: { cli: {}, tui: { args: ['--interactive'], tuiPromptDelayMs: 3000 } },
  };
  const pairService = () => ({
    createProvider: vi.fn().mockResolvedValue(PAIR[0]),
    createProviderModes: vi.fn().mockResolvedValue(PAIR),
  });

  it('answers with every created record, sanitized', async () => {
    const service = pairService();
    const res = await request(appWith(service)).post('/api/providers').send(BODY);

    expect(res.status).toBe(201);
    expect(service.createProviderModes).toHaveBeenCalledWith(expect.objectContaining({ modes: BODY.modes }));
    expect(service.createProvider).not.toHaveBeenCalled();
    expect(res.body.providers.map((provider) => provider.id)).toEqual(['example-agent', 'example-agent-tui']);
    // Redaction has to cover the SECOND record too — it carries the same key.
    expect(res.body.providers.every((provider) => provider.apiKey === undefined)).toBe(true);
    expect(res.body.providers.every((provider) => provider.hasApiKey === true)).toBe(true);
  });

  it('leaves the single-mode response a bare provider object', async () => {
    // A caller reading `.id` off a create must not have to know about `modes`,
    // which is why the pair answer is a distinct shape rather than always-array.
    const service = pairService();
    const { modes: _modes, ...single } = BODY;
    const res = await request(appWith(service)).post('/api/providers').send(single);

    expect(res.status).toBe(201);
    expect(res.body.providers).toBeUndefined();
    expect(res.body.id).toBe('example-agent');
    expect(service.createProviderModes).not.toHaveBeenCalled();
  });

  it('never lets `modes` reach the service through an update', async () => {
    // Pairing describes two records being MINTED together, which a PATCH
    // against one existing record cannot mean — so the key is dropped rather
    // than half-acted on.
    const updateProvider = vi.fn().mockResolvedValue(PAIR[0]);
    const app = appWith({ getProviderById: vi.fn().mockResolvedValue(PAIR[0]), updateProvider });

    const res = await request(app).put('/api/providers/example-agent').send({ enabled: true, modes: BODY.modes });
    expect(res.status).toBe(200);
    expect(updateProvider.mock.calls[0][1]).not.toHaveProperty('modes');
  });
});
