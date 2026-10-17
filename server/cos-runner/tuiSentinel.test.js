import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { runInNewContext } from 'node:vm';
import { maintenance } from '../lib/maintenanceAdmission.js';
import { createHttpDrain } from '../lib/httpDrain.js';
import { parseSentinelPayload } from '../lib/agentSentinel.js';
import { SENTINEL_COMPLETION_MARKER } from '../lib/agentOutputMarkers.js';
import { createSecurityScanManager } from './securityScan.js';
import { securityScanRequestSchema } from '../lib/securityScanEvidence.js';
import { createTuiExitHandler } from './tuiExit.js';
import { armForceKill } from './forceKill.js';
import { createRunnerShutdown, registerRunnerShutdownSignals } from './shutdown.js';
import * as requestSchemas from './requestSchemas.js';

// index.js binds a server at module load, so (like shutdown.test.js) it is
// executed in a VM with its imports replaced by injected fakes. Nothing listens,
// spawns or touches runner data.
const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n').replace(/^import (?:.+ from )?['"][^'"]+['"];\n/gm, '');

const SENTINEL_PATH = '/example/workspace/.agent-done-agent-1';

// `sentinel` overrides the fake access object; `watch` captures the handler the
// runner registers so a test can fire the "sentinel appeared" event itself.
async function spawnTui(sentinel = {}) {
  const routes = new Map();
  const app = { use: vi.fn(), get: vi.fn(), post: (path, handler) => routes.set(path, handler) };
  const server = Object.assign(new EventEmitter(), {
    listen: vi.fn(), close: vi.fn(cb => cb?.()), closeAllConnections: vi.fn(),
  });
  const io = Object.assign(new EventEmitter(), { use: vi.fn(), close: vi.fn(cb => cb?.()) });
  const child = Object.assign(new EventEmitter(), {
    pid: 123, kill: vi.fn(), write: vi.fn(), resize: vi.fn(),
    onData: fn => child.on('data', fn),
    onExit: fn => child.on('exit', fn),
  });
  const stopWatching = vi.fn();
  const access = {
    path: SENTINEL_PATH,
    resolvedPath: () => SENTINEL_PATH,
    read: vi.fn(async () => 'all done'),
    promote: vi.fn(async () => true),
    cleanup: vi.fn(async () => {}),
    watch: vi.fn(() => stopWatching),
    ...sentinel,
  };
  const state = { agents: {}, stats: { spawned: 0, completed: 0, failed: 0 } };
  runInNewContext(source, {
    assertDatabaseAdmission: vi.fn(), maintenance,
    withBackupAssetPublication: vi.fn(), persistRunnerCompletion: vi.fn(),
    express: Object.assign(() => app, { json: vi.fn() }),
    http: { createServer: () => server }, SocketServer: function () { return io; },
    process: Object.assign(new EventEmitter(), { env: {}, exit: vi.fn() }),
    console, Buffer, Date, setTimeout, clearTimeout, join, basename,
    PATHS: { root: '/example', cosAgents: '/example/agents' }, PORTS: { COS: 0 },
    setupProcessErrorHandlers: vi.fn(), existsSync: () => true, ensureDir: async () => {},
    readFile: vi.fn(), writeFile: vi.fn(),
    withState: async fn => fn(state), drainState: async () => {},
    ...requestSchemas,
    createRunnerShutdown, registerRunnerShutdownSignals, createTuiExitHandler, createHttpDrain,
    createSecurityScanManager, securityScanRequestSchema,
    armForceKillShared: armForceKill, killProcessTree: vi.fn(),
    spawn: vi.fn(), pty: { spawn: vi.fn(() => child) },
    createAgentSentinelAccess: vi.fn(() => access),
    parseSentinelPayload, SENTINEL_COMPLETION_MARKER,
    buildCliChildEnv: () => ({}), prepareCliSpawn: (command, args) => ({ command, args }),
    commandExists: vi.fn(async () => true), findCommandOnPath: command => command,
    isAllowedCommand: () => true, ALLOWED_COMMANDS: ['example-cli'],
  });
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json: vi.fn() };
  await routes.get('/spawn-tui')({ body: {
    agentId: 'agent-1', taskId: 'task-1', command: 'example-cli', doneSentinelPath: SENTINEL_PATH,
  } }, res);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  // The runner hands its handler to watch(); firing it returns the tracked work.
  const fireSentinel = () => access.watch.mock.calls.at(-1)[0]();
  return { access, child, stopWatching, fireSentinel };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('cos-runner TUI completion sentinel (#3202)', () => {
  it('completes the agent and kills the PTY once the sentinel validates', async () => {
    const run = await spawnTui();
    expect(run.access.watch).toHaveBeenCalledTimes(1);
    await run.fireSentinel();
    expect(run.access.promote).toHaveBeenCalledWith('all done');
    expect(run.child.kill).toHaveBeenCalledTimes(1);
    expect(run.access.cleanup).toHaveBeenCalledTimes(1);
    expect(run.access.watch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['the sentinel read rejects', { read: vi.fn(async () => { throw new Error('truncated read'); }) }],
    ['recovery promotion returns false', { promote: vi.fn(async () => false) }],
    ['recovery promotion rejects', { promote: vi.fn(async () => { throw new Error('promote failed'); }) }],
    ['the canonical copy cannot be re-read after promotion', {
      resolvedPath: () => '/example/recovery/.agent-done-agent-1',
      read: vi.fn().mockResolvedValueOnce('all done').mockRejectedValueOnce(new Error('canonical read failed')),
    }],
  ])('keeps the agent running and re-arms the watcher when %s', async (_name, sentinel) => {
    const run = await spawnTui(sentinel);
    await run.fireSentinel();
    expect(run.child.kill).not.toHaveBeenCalled();
    expect(run.access.cleanup).not.toHaveBeenCalled();
    expect(run.stopWatching).toHaveBeenCalledTimes(1);
    expect(run.access.watch).toHaveBeenCalledTimes(2);
  });
});
