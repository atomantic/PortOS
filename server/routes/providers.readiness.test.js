import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

// serve-model takes the MACHINE-WIDE heavy-local-job claim, whose path is
// derived from PATHS.data at module load. Without this redirect the suite wrote
// that claim into the developer's live data/ tree — briefly gating their real
// local renders, and stranding the file whenever a case failed mid-claim
// (#6176).
vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-readiness-') }));
afterAll(cleanupTempDataRoots);
import express, { Router } from 'express';
import { errorMiddleware } from '../lib/errorHandler.js';
import { request } from '../lib/testHelper.js';

const readinessService = vi.hoisted(() => ({
  getProviderReadinessMap: vi.fn(),
  resetProviderReadinessCache: vi.fn(),
}));
// PARTIAL mock, same reasoning as the setup service below: the route derives the
// model id it will serve through the REAL `servedModelId`, so a fully-stubbed
// module would hand it `undefined` and the route would throw before it ever
// reached the daemon.
vi.mock('../services/providerReadiness.js', async (importOriginal) => ({ ...(await importOriginal()), ...readinessService }));
const llamaService = vi.hoisted(() => ({
  relaunchLlamaServerWithAlias: vi.fn(),
  // The route checks that the provider points at the daemon PortOS actually
  // manages before relaunching it, so the suite has to say where that is.
  getLlamaServerEndpoint: vi.fn(),
}));
vi.mock('../services/llamaServerManager.js', async (importOriginal) => ({ ...(await importOriginal()), ...llamaService }));
const setupService = vi.hoisted(() => ({ runLocalRuntimeSetup: vi.fn() }));
// PARTIAL mock: `SETUP_ACTIONS` is the closed set the route validates against,
// and a stubbed copy would let a route accepting an action the service cannot
// run still pass here.
vi.mock('../services/localRuntimeSetup.js', async (importOriginal) => ({ ...(await importOriginal()), ...setupService }));
import { createPortOSProviderRoutes } from './providers.js';

// A provider whose real base URL lives in an env var the user marked secret —
// the shape that would be redacted to `***` by the client-facing sanitizer.
const CLAUDE_OLLAMA = {
  id: 'claude-ollama',
  name: 'Claude Ollama (local model)',
  command: 'claude',
  ollamaBacked: true,
  envVars: { ANTHROPIC_BASE_URL: 'http://localhost:11500', ANTHROPIC_AUTH_TOKEN: 'ollama' },
  secretEnvVars: ['ANTHROPIC_AUTH_TOKEN'],
};

const app = (providers) => {
  const toolkit = {
    services: { providers: { getAllProviders: vi.fn().mockResolvedValue({ providers, activeProvider: null }) } },
    routes: { providers: Router() },
  };
  const server = express();
  server.use(express.json());
  server.use('/api/providers', createPortOSProviderRoutes(toolkit));
  server.use(errorMiddleware);
  return server;
};

describe('GET /api/providers/readiness', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readinessService.getProviderReadinessMap.mockResolvedValue({});
  });

  it('publishes the readiness map keyed by provider id', async () => {
    readinessService.getProviderReadinessMap.mockResolvedValueOnce({
      'claude-ollama': { kind: 'ollama', label: 'Ollama', ready: false, checks: [{ id: 'server', ok: false }] },
    });

    const response = await request(app([CLAUDE_OLLAMA])).get('/api/providers/readiness');

    expect(response.status).toBe(200);
    expect(response.body.readiness['claude-ollama'].ready).toBe(false);
  });

  it('checks the RAW providers, so a base URL stored as a secret env var still resolves', async () => {
    await request(app([CLAUDE_OLLAMA])).get('/api/providers/readiness');

    const [providers] = readinessService.getProviderReadinessMap.mock.calls[0];
    expect(providers[0].envVars.ANTHROPIC_BASE_URL).toBe('http://localhost:11500');
    expect(providers[0].envVars.ANTHROPIC_AUTH_TOKEN).not.toBe('***');
  });
});

/** The SSE frames a streamed response carries, in order. */
const frames = (text) => text
  .split(/\r?\n\r?\n/)
  .map((frame) => frame.split(/\r?\n/).find((line) => line.startsWith('data:')))
  .filter(Boolean)
  .map((line) => JSON.parse(line.slice('data:'.length).trim()));

describe('POST /api/providers/readiness/setup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    readinessService.getProviderReadinessMap.mockResolvedValue({});
    setupService.runLocalRuntimeSetup.mockResolvedValue({ success: true, message: 'Ollama is running.' });
  });

  it('resolves the runtime and endpoint from the stored provider, never from the query', async () => {
    const response = await request(app([CLAUDE_OLLAMA]))
      .post('/api/providers/readiness/setup?provider=claude-ollama&runtime=ollama');

    expect(response.status).toBe(200);
    const [kind, ctx] = setupService.runLocalRuntimeSetup.mock.calls[0];
    expect(kind).toBe('ollama');
    // The base URL comes from the RAW provider record — a query string cannot
    // point the setup at a different port.
    expect(ctx.endpoint).toBe('http://localhost:11500/v1');
    expect(frames(response.text).at(-1)).toEqual({ type: 'complete', message: 'Ollama is running.' });
  });

  it('forwards the action the checklist button named, and null when it names none', async () => {
    // `pull-start` is the only action that downloads model weights, so it has
    // to survive the trip from the button to the service.
    await request(app([CLAUDE_OLLAMA])).post('/api/providers/readiness/setup?provider=claude-ollama&action=pull-start');
    expect(setupService.runLocalRuntimeSetup.mock.calls[0][1]).toMatchObject({ action: 'pull-start' });

    // An absent action stays absent rather than becoming a default HERE: a
    // client built before this parameter still renders this server's button
    // label, so the service resolves what the checklist is offering. Defaulting
    // to a start in the route would hide that from it.
    await request(app([CLAUDE_OLLAMA])).post('/api/providers/readiness/setup?provider=claude-ollama');
    expect(setupService.runLocalRuntimeSetup.mock.calls[1][1]).toMatchObject({ action: null });
  });

  it('rejects an action outside the fixed set rather than passing it through', async () => {
    const response = await request(app([CLAUDE_OLLAMA]))
      .post('/api/providers/readiness/setup?provider=claude-ollama&action=rm-rf');
    expect(response.status).toBe(400);
    expect(setupService.runLocalRuntimeSetup).not.toHaveBeenCalled();
  });

  it('drops the probe caches so the next poll sees the daemon that just came up', async () => {
    await request(app([CLAUDE_OLLAMA])).post('/api/providers/readiness/setup?provider=claude-ollama');
    expect(readinessService.resetProviderReadinessCache).toHaveBeenCalled();
  });

  it('reports a failed setup as a terminal error frame, not a 500', async () => {
    setupService.runLocalRuntimeSetup.mockResolvedValueOnce({ success: false, error: 'brew exploded' });

    const response = await request(app([CLAUDE_OLLAMA])).post('/api/providers/readiness/setup?provider=claude-ollama');

    expect(response.status).toBe(200);
    expect(frames(response.text).at(-1)).toEqual({ type: 'error', message: 'brew exploded' });
  });

  it('refuses a second concurrent setup rather than racing two installers', async () => {
    let release;
    setupService.runLocalRuntimeSetup.mockImplementationOnce(() => new Promise((resolve) => {
      release = () => resolve({ success: true, message: 'done' });
    }));
    const server = app([CLAUDE_OLLAMA]);

    // `.then()` is what starts the request — the builder is lazy, so a bare
    // call would never take the lock and the race under test wouldn't happen.
    const first = request(server).post('/api/providers/readiness/setup?provider=claude-ollama').then((r) => r);
    // Let the first request take the lock before the second one asks for it.
    await vi.waitFor(() => expect(setupService.runLocalRuntimeSetup).toHaveBeenCalled());
    const second = await request(server).post('/api/providers/readiness/setup?provider=claude-ollama');

    expect(frames(second.text).at(-1).type).toBe('error');
    expect(frames(second.text).at(-1).message).toMatch(/already running/);
    release();
    expect(frames((await first).text).at(-1)).toEqual({ type: 'complete', message: 'done' });
  });

  it('rejects a stale page whose card named a different runtime', async () => {
    const response = await request(app([CLAUDE_OLLAMA]))
      .post('/api/providers/readiness/setup?provider=claude-ollama&runtime=mtplx');

    expect(response.status).toBe(409);
    expect(setupService.runLocalRuntimeSetup).not.toHaveBeenCalled();
  });

  it('404s an unknown provider before opening a stream', async () => {
    const response = await request(app([CLAUDE_OLLAMA])).post('/api/providers/readiness/setup?provider=nope');
    expect(response.status).toBe(404);
    expect(setupService.runLocalRuntimeSetup).not.toHaveBeenCalled();
  });

  it('400s a provider with no local daemon to set up', async () => {
    const response = await request(app([{ id: 'claude', command: 'claude', type: 'cli' }]))
      .post('/api/providers/readiness/setup?provider=claude');
    expect(response.status).toBe(400);
  });
});

// The mismatch the serve-model route exists for: llama.cpp serves one model per
// process under the `--alias` on its launch line, so a provider pinned to
// another id is fixed by renaming the SERVER, not by downloading anything.
const LLAMA_TUI = {
  id: 'opencode-llama-tui',
  name: 'OpenCode llama TUI',
  type: 'tui',
  command: 'opencode',
  llamaBacked: true,
  endpoint: 'http://127.0.0.1:5568/v1',
  models: ['dflash', 'qwen3.8-27b-dflash2'],
  defaultModel: 'qwen3.8-27b-dflash2',
};

describe('POST /api/providers/readiness/serve-model', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    llamaService.relaunchLlamaServerWithAlias.mockResolvedValue({ applied: true, reason: null, config: null });
    llamaService.getLlamaServerEndpoint.mockResolvedValue('http://127.0.0.1:5568/v1');
  });

  it('relaunches under the id the provider sends, re-derived from the stored record', async () => {
    const response = await request(app([LLAMA_TUI]))
      .post('/api/providers/readiness/serve-model?provider=opencode-llama-tui');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ success: true, model: 'qwen3.8-27b-dflash2', relaunched: true });
    // The id comes from the record, never from the query string.
    expect(llamaService.relaunchLlamaServerWithAlias).toHaveBeenCalledWith('qwen3.8-27b-dflash2');
    // The readiness caches remember the OLD served id, and the page polls them
    // within seconds.
    expect(readinessService.resetProviderReadinessCache).toHaveBeenCalled();
  });

  it('strips the OpenCode namespace before naming the alias', async () => {
    // `llama/dflash` addresses the OpenCode provider entry; the daemon only ever
    // answers under the bare alias, so relaunching under the prefixed form would
    // leave the check failing exactly as before.
    await request(app([{ ...LLAMA_TUI, defaultModel: 'llama/qwen3.8-27b-dflash2' }]))
      .post('/api/providers/readiness/serve-model?provider=opencode-llama-tui');

    expect(llamaService.relaunchLlamaServerWithAlias).toHaveBeenCalledWith('qwen3.8-27b-dflash2');
  });

  // `applied: null` = the daemon already answered under that id. Reporting a
  // restart would have the user waiting for a reload that never happened.
  it('reports relaunched: false when the daemon already serves that id', async () => {
    llamaService.relaunchLlamaServerWithAlias.mockResolvedValueOnce({ applied: null, reason: null, config: null });

    const response = await request(app([LLAMA_TUI]))
      .post('/api/providers/readiness/serve-model?provider=opencode-llama-tui');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ success: true, relaunched: false });
  });

  it('surfaces the refusal — with its fix — when PortOS did not start the daemon', async () => {
    llamaService.relaunchLlamaServerWithAlias.mockResolvedValueOnce({
      applied: false,
      reason: 'llama-server is not running under PortOS, so its launch line is not PortOS\'s to change.',
      config: null,
    });

    const response = await request(app([LLAMA_TUI]))
      .post('/api/providers/readiness/serve-model?provider=opencode-llama-tui');

    expect(response.status).toBe(409);
    expect(response.body.error).toMatch(/not running under PortOS/);
  });

  // Ollama names a model after the weights it loaded — there is no launch-line
  // label to change, so the route must refuse rather than relaunch something.
  it('refuses a runtime that has no model id to rename', async () => {
    const response = await request(app([CLAUDE_OLLAMA]))
      .post('/api/providers/readiness/serve-model?provider=claude-ollama');

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('NO_MODEL_ALIAS');
    expect(llamaService.relaunchLlamaServerWithAlias).not.toHaveBeenCalled();
  });

  it('refuses a provider that selects no specific model', async () => {
    const response = await request(app([{ ...LLAMA_TUI, defaultModel: '' }]))
      .post('/api/providers/readiness/serve-model?provider=opencode-llama-tui');

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('NO_DEFAULT_MODEL');
    expect(llamaService.relaunchLlamaServerWithAlias).not.toHaveBeenCalled();
  });

  it('404s an unknown provider', async () => {
    const response = await request(app([LLAMA_TUI]))
      .post('/api/providers/readiness/serve-model?provider=nope');

    expect(response.status).toBe(404);
    expect(llamaService.relaunchLlamaServerWithAlias).not.toHaveBeenCalled();
  });

  // The manager renders its host as `127.0.0.1` while a provider may spell the
  // same daemon `localhost`. A string compare would refuse a working setup.
  it('accepts a differently-spelled host for the same daemon', async () => {
    const response = await request(app([{ ...LLAMA_TUI, endpoint: 'http://localhost:5568/v1' }]))
      .post('/api/providers/readiness/serve-model?provider=opencode-llama-tui');

    expect(response.status).toBe(200);
    expect(llamaService.relaunchLlamaServerWithAlias).toHaveBeenCalledWith('qwen3.8-27b-dflash2');
  });

  // PortOS manages exactly one llama-server. A provider pointed at a SECOND one
  // on another loopback port must not restart the managed daemon under the
  // second one's model id — that breaks the provider that was working and
  // leaves the clicked one mismatched exactly as before.
  it('refuses a provider pointed at a llama-server PortOS does not manage', async () => {
    const response = await request(app([{ ...LLAMA_TUI, endpoint: 'http://127.0.0.1:5569/v1' }]))
      .post('/api/providers/readiness/serve-model?provider=opencode-llama-tui');

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('LLAMA_ENDPOINT_MISMATCH');
    expect(response.body.error).toMatch(/--alias qwen3\.8-27b-dflash2/);
    expect(llamaService.relaunchLlamaServerWithAlias).not.toHaveBeenCalled();
  });

  // A PM2 read that failed says nothing about the daemon — the fix is to retry,
  // not to go edit a launch line, so it must not share the 409 refusal.
  it('reports a PM2 read failure as retryable, not as an external daemon', async () => {
    llamaService.relaunchLlamaServerWithAlias.mockResolvedValueOnce({
      applied: false,
      retryable: true,
      reason: 'PortOS could not read PM2 to find out what llama-server is running. Try again in a moment.',
      config: null,
    });

    const response = await request(app([LLAMA_TUI]))
      .post('/api/providers/readiness/serve-model?provider=opencode-llama-tui');

    expect(response.status).toBe(503);
    expect(response.body.code).toBe('SERVE_MODEL_UNAVAILABLE');
  });
});
