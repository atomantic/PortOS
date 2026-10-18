import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { usableAgentPid, runnerAgentLivenessFields } from '../lib/runnerAgentLiveness.js';

// index.js binds a server at module load, so (like shutdown.test.js) it is
// executed in a VM with its imports replaced by injected fakes. Nothing listens,
// spawns or touches runner data.
const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n').replace(/^import (?:.+ from )?['"][^'"]+['"];\n/gm, '');

const SENTINEL_PATH = '/example/workspace/.agent-done-agent-1';

// `sentinel` overrides the fake access object; `watch` captures the handler the
// runner registers so a test can fire the "sentinel appeared" event itself.
async function spawnTui(sentinel = {}, { trackPromptSubmission = true } = {}) {
  const routes = new Map();
  const app = { use: vi.fn(), get: (path, handler) => routes.set(path, handler), post: (path, handler) => routes.set(path, handler) };
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
  const killProcessTree = vi.fn();
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
    armForceKillShared: armForceKill, killProcessTree,
    usableAgentPid, runnerAgentLivenessFields, getProcessStats: vi.fn(async () => ({})),
    spawn: vi.fn(), pty: { spawn: vi.fn(() => child) },
    createAgentSentinelAccess: vi.fn(() => access),
    parseSentinelPayload, SENTINEL_COMPLETION_MARKER,
    buildCliChildEnv: () => ({}), prepareCliSpawn: (command, args) => ({ command, args }),
    commandExists: vi.fn(async () => true), findCommandOnPath: command => command,
    isAllowedCommand: () => true, ALLOWED_COMMANDS: ['example-cli'],
  });
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json: vi.fn() };
  await routes.get('/spawn-tui')({ body: {
    agentId: 'agent-1', taskId: 'task-1', command: 'example-cli', doneSentinelPath: SENTINEL_PATH, trackPromptSubmission,
  } }, res);
  expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  // The runner hands its handler to watch(); firing it returns the tracked work.
  const fireSentinel = () => access.watch.mock.calls.at(-1)[0]();
  const socket = new EventEmitter();
  socket.use = vi.fn();
  io.emit('connection', socket);
  const listing = async () => {
    const response = { json: vi.fn() };
    await routes.get('/agents')({}, response);
    return response.json.mock.calls[0][0][0];
  };
  const stopStartup = async () => {
    const response = { json: vi.fn() };
    await routes.get('/terminate/:agentId')({ params: { agentId: 'agent-1' }, body: { onlyIfPromptUnsubmitted: true } }, response);
    return response.json.mock.calls[0][0];
  };
  return { access, child, stopWatching, fireSentinel, socket, listing, stopStartup, killProcessTree };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('cos-runner TUI startup recovery receipt', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

  it('counts only a successful task-submit Enter, preserving it across a server reconnect', async () => {
    const run = await spawnTui();
    const input = data => run.socket.emit('tui:input', { sessionId: 'agent-1', ...data });
    input({ data: '\r' }); // startup dialog, not the task
    input({ data: '\x1b[200~task body\x1b[201~' });
    expect((await run.listing()).promptSubmitted).toBe(false);
    run.child.write.mockImplementationOnce(() => { throw new Error('PTY write failed'); });
    input({ data: '\r', promptSubmission: true });
    expect((await run.listing()).promptSubmitted).toBe(false);
    input({ data: '\r', promptSubmission: true });
    expect((await run.listing()).promptSubmitted).toBe(true);
    // A stale GET /agents from the old server must not authorize this kill.
    expect(await run.stopStartup()).toMatchObject({ terminated: false });
    expect(run.killProcessTree).not.toHaveBeenCalled();
  });

  it('stops an unsubmitted composer and refuses a late submission after the cancellation decision', async () => {
    const run = await spawnTui();
    expect(await run.stopStartup()).toMatchObject({ terminated: true });
    expect(run.killProcessTree).toHaveBeenCalledWith(run.child, 'SIGTERM');
    run.socket.emit('tui:input', { sessionId: 'agent-1', data: '\r', promptSubmission: true });
    expect(run.child.write).not.toHaveBeenCalled();
    expect((await run.listing()).promptSubmitted).toBe(false);
  });

  it('preserves terminals spawned by an older server without the tracking protocol', async () => {
    const run = await spawnTui({}, { trackPromptSubmission: false });
    expect((await run.listing()).promptSubmitted).toBeNull();
    expect(await run.stopStartup()).toMatchObject({ terminated: false });
    expect(run.killProcessTree).not.toHaveBeenCalled();
  });
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
