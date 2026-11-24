import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { io as connect } from 'socket.io-client';
import { z } from 'zod';
import { createDatabaseMaintenanceJournal } from '../lib/databaseMaintenanceJournal.js';

// Keep persistRunnerCompletion and withBackupAssetPublication real while
// redirecting /example/agents reads/writes to an in-memory map so shutdown
// drain tests can pause/fail writes deterministically under fake timers.
const storage = vi.hoisted(() => ({ current: null }));
const virtualPath = vi.hoisted(() => path => {
  if (typeof path !== 'string') return false;
  const normalized = path.replaceAll('\\', '/');
  return normalized === '/example/agents' || normalized.startsWith('/example/agents/');
});
vi.mock('fs/promises', async importOriginal => {
  const actual = await importOriginal();
  return {
    ...actual,
    readFile: (path, ...args) => (virtualPath(path)
      ? storage.current.readFile(path, ...args)
      : actual.readFile(path, ...args)),
  };
});
vi.mock('../lib/fileUtils.js', async importOriginal => {
  const actual = await importOriginal();
  return {
    ...actual,
    ensureDir: (path, ...args) => (virtualPath(path) ? Promise.resolve() : actual.ensureDir(path, ...args)),
    atomicWrite: (path, data, ...args) => (virtualPath(path)
      ? storage.current.atomicWrite(path, data)
      : actual.atomicWrite(path, data, ...args)),
    unlinkGuarded: (path, ...args) => (virtualPath(path)
      ? storage.current.unlink(path)
      : actual.unlinkGuarded(path, ...args)),
  };
});
vi.mock('../lib/bufferedSpawn.js', async importOriginal => {
  const actual = await importOriginal();
  return {
    ...actual,
    killProcessTree: vi.fn((child, signal) => child.kill(signal)),
  };
});

import { createCosRunner, runnerErrorHandler } from './index.js';
import { registerRunnerShutdownSignals } from './shutdown.js';

const FAKE_TIMERS_OPTS = { toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] };

const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};

// Dispatch a real HTTP JSON POST through the runner's Express app (including
// runnerRequestGuard, express.json, route handlers, and runnerErrorHandler)
// using node:http so fake setTimeout never interferes with client delivery.
function postJson(app, path, payload) {
  return new Promise((resolve, reject) => {
    const tmpServer = createServer(app);
    tmpServer.once('error', reject);
    tmpServer.listen(0, '127.0.0.1', () => {
      const { port } = tmpServer.address();
      const raw = JSON.stringify(payload);
      const req = httpRequest({
        hostname: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          host: `127.0.0.1:${port}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(raw),
        },
      }, (res) => {
        let text = '';
        res.on('data', chunk => { text += chunk; });
        res.on('end', () => {
          tmpServer.close(() => {
            let body = text;
            try { body = JSON.parse(text); } catch { /* leave as text */ }
            resolve({ status: res.statusCode, body });
          });
        });
      });
      req.on('error', err => tmpServer.close(() => reject(err)));
      req.end(raw);
    });
  });
}

const activeRunners = [];

function createTestRunner(assertDatabaseAdmission = vi.fn()) {
  const proc = Object.assign(new EventEmitter(), { env: {}, exit: vi.fn(), uptime: () => 1 });
  const state = { agents: {}, stats: { spawned: 0, completed: 0, failed: 0 } };
  const files = new Map();
  const writeFile = vi.fn(async (path, content) => { files.set(path, content); });
  const readFile = async path => {
    if (!files.has(path)) throw Object.assign(new Error('Fixture file absent'), { code: 'ENOENT' });
    return files.get(path);
  };
  const atomicWrite = (path, data) => writeFile(
    path,
    typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data, null, 2),
  );
  storage.current = { readFile, atomicWrite, unlink: async path => { files.delete(path); } };
  const withState = vi.fn(async fn => fn(state));
  const drainState = vi.fn(async () => {});
  const children = [];
  const makeChild = () => {
    const child = Object.assign(new EventEmitter(), {
      pid: 123, stdout: new EventEmitter(), stderr: new EventEmitter(),
      kill: vi.fn(), write: vi.fn(), resize: vi.fn(),
    });
    child.onData = fn => child.on('data', fn);
    child.onExit = fn => child.on('exit', fn);
    children.push(child);
    return child;
  };
  const spawn = vi.fn(makeChild);
  const pty = { spawn: vi.fn(makeChild) };
  const commandExists = vi.fn(async () => true);
  const createAgentSentinelAccess = vi.fn(() => ({
    path: null,
    exists: () => false,
    resolvedPath: () => null,
    read: async () => '',
    remove: async () => {},
    promote: async () => true,
    cleanup: async () => {},
    watch: vi.fn(() => () => {}),
  }));

  const instance = createCosRunner({
    process: proc,
    rootDir: '/example',
    agentsDir: '/example/agents',
    port: 0,
    host: '127.0.0.1',
    orphanCleanupDelayMs: -1,
    assertDatabaseAdmission,
    existsSync: () => true,
    ensureDir: async () => {},
    adoptNpmGlobalBinDir: vi.fn(async () => {}),
    readFile,
    writeFile,
    withState,
    drainState,
    spawn,
    pty,
    createAgentSentinelAccess,
    buildCliChildEnv: () => ({}),
    prepareCliSpawn: (command, args) => ({ command, args }),
    prepareWindowsAgentLaunch: (_agentId, command, args) => ({ command, args }),
    watchWindowsAgentProcess: child => child,
    prepareCliPrompt: (_command, args) => ({ args, useStdin: false, cleanup: vi.fn() }),
    commandExists,
    findCommandOnPath: command => command,
    isAllowedCommand: () => true,
    allowedCommands: new Set(['example-cli']),
    guardChildStdin: vi.fn(),
    deliverChildStdin: vi.fn(),
    createStreamingAnsiStripper: () => text => text,
    isKnownCliStderrNoise: () => false,
  });

  registerRunnerShutdownSignals(proc, instance.lifecycle);
  const serverCloseSpy = vi.spyOn(instance.server, 'close');
  const ioCloseSpy = vi.spyOn(instance.io, 'close');
  activeRunners.push(instance);

  const post = (path, extra = {}) => postJson(instance.app, path, {
    agentId: 'agent-1',
    taskId: 'task-1',
    prompt: 'example',
    cliCommand: 'example-cli',
    command: 'example-cli',
    ...extra,
  });

  return {
    ...instance,
    process: proc,
    serverCloseSpy,
    ioCloseSpy,
    post,
    state,
    files,
    children,
    spawn,
    pty,
    commandExists,
    writeFile,
    withState,
    drainState,
  };
}

beforeEach(() => {
  vi.useFakeTimers(FAKE_TIMERS_OPTS);
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  vi.useRealTimers();
  for (const instance of activeRunners.splice(0)) {
    for (const agent of instance.activeAgents.values()) {
      if (agent.killTimer) clearTimeout(agent.killTimer);
    }
    // Restore close spy if a test replaced it with a no-op before closing.
    if (vi.isMockFunction(instance.io.close)) instance.io.close.mockRestore();
    if (instance.server.listening) {
      await new Promise(resolve => instance.io.close(resolve));
      instance.server.closeAllConnections?.();
    }
  }
  vi.restoreAllMocks();
});

describe('runner shutdown through its real spawn and signal handlers', () => {
  it.each(['SIGINT', 'SIGTERM'])('%s drains CLI output, completion and state exactly once', async signal => {
    const run = createTestRunner();
    const spawned = await run.post('/spawn');
    expect(spawned.status).toBe(200);
    const child = run.children[0];
    child.stdout.emit('data', Buffer.from('final output'));
    const write = deferred();
    run.writeFile.mockImplementationOnce(async (path, output) => {
      await write.promise;
      run.files.set(path, output);
    });
    run.process.emit(signal);
    run.process.emit(signal === 'SIGINT' ? 'SIGTERM' : 'SIGINT');
    expect(run.serverCloseSpy).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    child.emit('close', 0);
    child.emit('close', 0);
    await vi.advanceTimersByTimeAsync(6000);
    expect(run.process.exit).not.toHaveBeenCalled();
    expect(run.ioCloseSpy).not.toHaveBeenCalled();
    write.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(run.files.get(join('/example/agents', 'agent-1', 'output.txt'))).toBe('final output');
    expect(JSON.parse(run.files.get(join('/example/agents', 'agent-1', 'metadata.json')))).toMatchObject({ success: true, exitCode: 0 });
    expect(run.state).toEqual({ agents: {}, stats: { spawned: 1, completed: 1, failed: 0 } });
    expect(run.process.exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(run.ioCloseSpy).toHaveBeenCalledTimes(1);
  });

  it('rejects both new spawn routes and a TUI whose preparation resumes after shutdown', async () => {
    const run = createTestRunner();
    const probe = deferred();
    const probeStarted = deferred();
    run.commandExists.mockImplementationOnce(() => {
      probeStarted.resolve();
      return probe.promise;
    });
    const preparing = run.post('/spawn-tui');
    await probeStarted.promise;
    run.process.emit('SIGINT');
    for (const route of ['/spawn', '/spawn-tui']) {
      const refused = await run.post(route);
      expect(refused.status).toBe(503);
      expect(refused.body).toMatchObject({ code: 'SHUTTING_DOWN' });
    }
    await vi.advanceTimersByTimeAsync(1000);
    expect(run.process.exit).not.toHaveBeenCalled();
    probe.resolve(true);
    const preparedRes = await preparing;
    await vi.advanceTimersByTimeAsync(0);
    expect(preparedRes.status).toBe(503);
    expect(preparedRes.body).toMatchObject({ code: 'SHUTTING_DOWN' });
    expect(run.spawn).not.toHaveBeenCalled();
    expect(run.pty.spawn).not.toHaveBeenCalled();
    expect(run.process.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('refuses headless and TUI work when maintenance starts during spawn preparation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'runner-maintenance-'));
    const journal = createDatabaseMaintenanceJournal(root);
    try {
      const run = createTestRunner(journal.assertAdmission);
      const probe = deferred();
      const probeStarted = deferred();
      run.commandExists.mockImplementationOnce(() => {
        probeStarted.resolve();
        return probe.promise;
      });
      const preparing = run.post('/spawn-tui');
      await probeStarted.promise;
      const source = { mode: 'native', host: 'localhost', port: 5432, database: 'example_test', user: 'example' };
      journal.begin({ source, target: { ...source, mode: 'docker', port: 5561 } });
      for (const path of ['/spawn', '/spawn-tui']) {
        const res = await run.post(path);
        expect(res.status).toBe(503);
        expect(res.body).toMatchObject({ code: 'DATABASE_MAINTENANCE' });
      }
      probe.resolve(true);
      const preparedRes = await preparing;
      expect(preparedRes.status).toBe(503);
      expect(preparedRes.body).toMatchObject({ code: 'DATABASE_MAINTENANCE' });
      expect(run.spawn).not.toHaveBeenCalled();
      expect(run.pty.spawn).not.toHaveBeenCalled();
      expect(run.state.stats.spawned).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('escalates a resistant TUI and waits for its terminal evidence and final state write', async () => {
    const run = createTestRunner();
    const spawned = await run.post('/spawn-tui');
    expect(spawned.status).toBe(200);
    const child = run.children[0];
    child.emit('data', 'terminal tail');
    const write = deferred();
    run.withState.mockImplementationOnce(async fn => { await write.promise; fn(run.state); });
    run.process.emit('SIGTERM');
    await vi.advanceTimersByTimeAsync(5000);
    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
    child.emit('exit', { exitCode: 1, signal: 9 });
    await vi.advanceTimersByTimeAsync(0);
    expect(run.files.get(join('/example/agents', 'agent-1', 'output.txt'))).toBe('terminal tail');
    expect(JSON.parse(run.files.get(join('/example/agents', 'agent-1', 'metadata.json')))).toMatchObject({ success: false, signal: 9 });
    expect(run.process.exit).not.toHaveBeenCalled();
    write.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(run.state.stats).toEqual({ spawned: 1, completed: 1, failed: 1 });
    expect(run.process.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it.each(['child', 'write', 'socket'])('bounds stalled %s completion and preserves unfinished evidence', async stalled => {
    const run = createTestRunner();
    const spawned = await run.post('/spawn');
    expect(spawned.status).toBe(200);
    const pendingWrite = deferred();
    if (stalled === 'write') run.writeFile.mockImplementationOnce(async (path, output) => {
      await pendingWrite.promise;
      run.files.set(path, output);
    });
    if (stalled === 'socket') run.ioCloseSpy.mockImplementation(() => {});
    run.process.exit.mockImplementation(() => { expect(run.ioCloseSpy).toHaveBeenCalled(); });
    run.process.emit('SIGTERM');
    if (stalled !== 'child') run.children[0].emit('close', 0);
    await vi.advanceTimersByTimeAsync(24_999);
    expect(run.process.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run.process.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(run.ioCloseSpy).toHaveBeenCalledTimes(1);
    if (stalled !== 'socket') {
      expect(run.state.agents['agent-1']).toBeDefined();
      expect(run.state.stats.completed).toBe(0);
      expect(run.files.has(join('/example/agents', 'agent-1', 'metadata.json'))).toBe(false);
    }
    // process.exit is a spy: retire the synthetic stalled write after proving
    // the timeout so the real per-path publication queue cannot leak to a case.
    pendingWrite.resolve();
    await vi.advanceTimersByTimeAsync(0);
  });

  it('reports a persistence failure without deleting the durable agent record', async () => {
    const run = createTestRunner();
    const spawned = await run.post('/spawn');
    expect(spawned.status).toBe(200);
    run.writeFile.mockRejectedValueOnce(new Error('disk unavailable'));
    run.process.emit('SIGTERM');
    run.children[0].emit('close', 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(run.process.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(run.state.agents['agent-1']).toBeDefined();
    expect(run.state.stats.completed).toBe(0);
  });

  it('does not stop children when only the main-server socket disconnects', async () => {
    vi.useRealTimers();
    const run = createTestRunner();
    const { port } = await run.start(0, '127.0.0.1');
    const spawned = await run.post('/spawn-tui');
    expect(spawned.status).toBe(200);

    const serverDisconnected = deferred();
    run.io.once('connection', (socket) => {
      socket.once('disconnect', () => serverDisconnected.resolve());
    });
    const client = connect(`http://127.0.0.1:${port}`, { transports: ['websocket'], reconnection: false });
    await new Promise((resolve, reject) => {
      client.once('connect', resolve);
      client.once('connect_error', reject);
    });
    client.disconnect();
    await serverDisconnected.promise;

    vi.useFakeTimers(FAKE_TIMERS_OPTS);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(run.children[0].kill).not.toHaveBeenCalled();
    expect(run.process.exit).not.toHaveBeenCalled();
    expect(run.state.agents['agent-1']).toBeDefined();
  });

  it('answers rejected spawns with JSON error bodies and keeps a clean shutdown exit', async () => {
    const maintenanceErr = Object.assign(new Error('Database maintenance in progress'), {
      status: 503,
      code: 'DATABASE_MAINTENANCE',
    });
    const assertAdmission = vi.fn(() => { throw maintenanceErr; });
    const run = createTestRunner(assertAdmission);

    for (const path of ['/spawn', '/spawn-tui']) {
      const res = await run.post(path);
      expect(res.status).toBe(503);
      expect(res.body).toEqual({ error: 'Database maintenance in progress', code: 'DATABASE_MAINTENANCE' });
    }

    const zodErr = z.object({ agentId: z.string() }).safeParse({}).error;
    assertAdmission.mockImplementationOnce(() => { throw zodErr; });
    const validationRes = await run.post('/spawn');
    expect(validationRes.status).toBe(400);
    expect(validationRes.body).toMatchObject({ code: 'VALIDATION_ERROR', error: expect.stringContaining('agentId') });

    assertAdmission.mockImplementationOnce(() => { throw new Error('boom'); });
    const genericRes = await run.post('/spawn');
    expect(genericRes.status).toBe(500);
    expect(genericRes.body).toEqual({ error: 'boom', code: 'RUNNER_ERROR' });

    const next = vi.fn();
    runnerErrorHandler(maintenanceErr, {}, { headersSent: true }, next);
    expect(next).toHaveBeenCalledWith(maintenanceErr);

    run.process.emit('SIGTERM');
    await vi.advanceTimersByTimeAsync(0);
    expect(run.process.exit).toHaveBeenCalledExactlyOnceWith(0);
  });
});
