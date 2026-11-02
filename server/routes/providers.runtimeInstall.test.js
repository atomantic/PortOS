import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express, { Router } from 'express';
import { errorMiddleware } from '../lib/errorHandler.js';
import { request } from '../lib/testHelper.js';

const RUNTIMES = {
  opencode: { id: 'opencode', label: 'OpenCode CLI', command: 'opencode', install: { kind: 'npm', package: 'opencode-ai@latest' } },
  codex: { id: 'codex', label: 'Codex CLI', command: 'codex', install: { kind: 'npm', package: '@openai/codex@latest' } },
};

const statusOf = (id, overrides) => ({ ...RUNTIMES[id], installed: false, method: 'npm', installable: true, blockedReason: null, ...overrides });

// The SSE loop these routes drive lives in `services/harnessActionStream.js`
// (shared with Models → Harnesses); it reads the same registry, so mocking the
// registry still drives every branch through the real `/api/providers` route.
const installer = vi.hoisted(() => ({
  getProviderRuntime: vi.fn(),
  getProviderRuntimeStatus: vi.fn(),
  getProviderRuntimeStatuses: vi.fn(),
  spawnRuntimeInstaller: vi.fn(),
  stopRuntimeInstaller: vi.fn(),
  describeRuntimeInstall: vi.fn(),
  buildRuntimeActionCommand: vi.fn(),
  RUNTIME_ACTIONS: ['install', 'update', 'uninstall'],
}));

vi.mock('../services/providerRuntimeInstaller.js', () => installer);
const fixture = vi.hoisted(() => ({ root: null, admission: null }));
vi.mock('../lib/maintenanceAdmission.js', async () => {
  const actual = await vi.importActual('../lib/maintenanceAdmission.js');
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  fixture.root = mkdtempSync(join(tmpdir(), 'provider-harness-admission-'));
  fixture.admission = actual.createMaintenanceAdmission(fixture.root, { harnessAbsent: pid => pid < 0 });
  return { ...actual, maintenance: fixture.admission };
});
vi.mock('../lib/maintenanceDeferredUpdate.js', async () => {
  const actual = await vi.importActual('../lib/maintenanceDeferredUpdate.js');
  return { ...actual, processAbsent: pid => pid < 0 };
});
const supervisor = vi.hoisted(() => ({ spawnHarnessActionSupervisor: vi.fn() }));
vi.mock('../services/harnessActionSupervisor.js', () => supervisor);

import { createPortOSProviderRoutes } from './providers.js';
import { __resetHarnessActionGuard } from '../services/harnessActionStream.js';
const supervised = ['darwin', 'linux'].includes(process.platform);
const launch = supervised ? supervisor.spawnHarnessActionSupervisor : installer.spawnRuntimeInstaller;
const expectLaunch = (id) => supervised
  ? expect(launch).toHaveBeenCalledWith(expect.objectContaining({ runtime: id, action: 'install' }))
  : expect(launch).toHaveBeenCalledWith(id, { action: 'install' });
afterAll(async () => {
  const { rmSync } = await import('node:fs');
  if (fixture.root) rmSync(fixture.root, { recursive: true, force: true });
});

const app = () => {
  const toolkit = { services: { providers: {} }, routes: { providers: Router() } };
  const server = express();
  server.use(express.json());
  server.use('/api/providers', createPortOSProviderRoutes(toolkit));
  server.use(errorMiddleware);
  return server;
};

const makeChild = () => {
  const child = new EventEmitter();
  child.pid = 123;
  child.killed = false;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  return child;
};

describe('Provider runtime installer routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The single-flight guard is module state shared with Models → Harnesses; a
    // case that ends mid-stream would otherwise fail every later one with
    // "another harness install is already running".
    __resetHarnessActionGuard();
    installer.getProviderRuntime.mockImplementation((id) => RUNTIMES[id] || null);
    installer.describeRuntimeInstall.mockImplementation((id) => `npm install --global ${RUNTIMES[id]?.install?.package}`);
    installer.buildRuntimeActionCommand.mockImplementation((id) => (RUNTIMES[id]
      ? { command: 'npm', args: ['install', '--global', RUNTIMES[id].install.package] }
      : null));
  });

  it('publishes every runtime status in one payload', async () => {
    installer.getProviderRuntimeStatuses.mockResolvedValueOnce({ codex: statusOf('codex', { installed: true }) });

    const response = await request(app()).get('/api/providers/runtimes');

    expect(response.status).toBe(200);
    expect(response.body.runtimes.codex.installed).toBe(true);
  });

  it('streams a verified completion after the fixed installer exits', async () => {
    const child = makeChild();
    installer.getProviderRuntimeStatus
      .mockResolvedValueOnce(statusOf('codex'))
      .mockResolvedValueOnce(statusOf('codex', { installed: true }));
    launch.mockReturnValueOnce(child);

    const responsePromise = request(app()).post('/api/providers/runtimes/install?runtime=codex').then((response) => response);
    await vi.waitFor(() => expectLaunch('codex'));
    child.stdout.end('added Codex\n');
    child.stderr.end();
    child.emit('close', 0);
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.text).toContain('Running npm install --global @openai/codex@latest.');
    expect(response.text).toContain('added Codex');
    expect(response.text).toContain('Codex CLI is installed and available to PortOS.');
    // Both probes bypass the TTL cache: a stale "installed" would skip a needed
    // install, and a stale "missing" would fail a CLI that now works.
    for (const call of installer.getProviderRuntimeStatus.mock.calls) {
      expect(call[1]).toEqual(expect.objectContaining({ fresh: true }));
    }
  });

  it('reports an unusable CLI after the installer exits successfully', async () => {
    const child = makeChild();
    installer.getProviderRuntimeStatus
      .mockResolvedValueOnce(statusOf('codex'))
      .mockResolvedValueOnce(statusOf('codex'));
    launch.mockReturnValueOnce(child);

    const responsePromise = request(app()).post('/api/providers/runtimes/install?runtime=codex').then((response) => response);
    await vi.waitFor(() => expect(launch).toHaveBeenCalledOnce());
    child.stdout.end();
    child.stderr.end();
    child.emit('close', 0);
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(response.text).toContain('PortOS still cannot run');
  });

  it('fails the stream without spawning when the host cannot install', async () => {
    installer.getProviderRuntimeStatus.mockResolvedValueOnce(statusOf('codex', {
      installable: false,
      blockedReason: "npm is not available on PortOS's PATH, so this host cannot install Codex CLI from this page.",
    }));

    const response = await request(app()).post('/api/providers/runtimes/install?runtime=codex');

    expect(response.status).toBe(200);
    expect(response.text).toContain('npm is not available');
    expect(launch).not.toHaveBeenCalled();
  });

  // A synchronous spawn failure must report through the already-open stream and
  // release the one-install-at-a-time lock — otherwise the client sees a
  // truncated stream and every later install answers "another install is
  // already running" until the server restarts.
  it('reports a spawn failure as a stream error and releases the install lock', async () => {
    installer.getProviderRuntimeStatus.mockResolvedValue(statusOf('codex'));
    launch.mockImplementationOnce(() => { throw new Error('spawn EAGAIN'); });

    const failed = await request(app()).post('/api/providers/runtimes/install?runtime=codex');
    expect(failed.status).toBe(200);
    expect(failed.text).toContain('Codex CLI installer failed to start: spawn EAGAIN');

    // A second attempt must reach the spawn again rather than being refused.
    const child = makeChild();
    launch.mockReturnValueOnce(child);
    const responsePromise = request(app()).post('/api/providers/runtimes/install?runtime=codex').then((response) => response);
    await vi.waitFor(() => expect(launch).toHaveBeenCalledTimes(2));
    child.stdout.end();
    child.stderr.end();
    child.emit('close', 1);
    const response = await responsePromise;

    expect(response.text).not.toContain('Another runtime install is already running');
  });

  // The runtime is a request value, so an unknown id must be rejected before a
  // child is spawned — the installer table is the only source of commands.
  it('rejects an unknown runtime without probing or spawning', async () => {
    const response = await request(app()).post('/api/providers/runtimes/install?runtime=rm-rf');

    expect(response.status).toBe(400);
    expect(installer.getProviderRuntimeStatus).not.toHaveBeenCalled();
    expect(launch).not.toHaveBeenCalled();
  });

  // A deployed client/dist can lag the server across an upgrade, so the
  // OpenCode-only endpoints keep answering in their original shape.
  it('keeps the legacy OpenCode status endpoint answering', async () => {
    installer.getProviderRuntimeStatus.mockResolvedValueOnce(statusOf('opencode'));

    const response = await request(app()).get('/api/providers/opencode/installation');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ installed: false, npmAvailable: true });
  });

  it('routes the legacy OpenCode install POST through the shared installer', async () => {
    const child = makeChild();
    installer.getProviderRuntimeStatus
      .mockResolvedValueOnce(statusOf('opencode'))
      .mockResolvedValueOnce(statusOf('opencode', { installed: true }));
    launch.mockReturnValueOnce(child);

    const responsePromise = request(app()).post('/api/providers/opencode/install').then((response) => response);
    await vi.waitFor(() => expectLaunch('opencode'));
    child.stdout.end();
    child.stderr.end();
    child.emit('close', 0);
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(response.text).toContain('OpenCode CLI is installed and available to PortOS.');
  });
});
