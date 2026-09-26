import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { runInNewContext } from 'node:vm';

vi.mock('../lib/bufferedSpawn.js', () => ({
  killProcessTree: vi.fn((child, signal) => child.kill(signal)),
}));
import { killProcessTree } from '../lib/bufferedSpawn.js';
import { createRunnerShutdown, registerRunnerShutdownSignals } from './shutdown.js';
import { createTuiExitHandler } from './tuiExit.js';
import { armForceKill } from './forceKill.js';
import { createHttpDrain } from '../lib/httpDrain.js';

const deferred = () => {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
};

// Execute the real route/signal wiring with isolated transports, children and
// storage. No listening port, real child, live PATHS or runner data is touched.
const source = readFileSync(new URL('./index.js', import.meta.url), 'utf8')
  .replace(/\r\n/g, '\n').replace(/^import .+ from .+;\n/gm, '');

function runner() {
  const routes = new Map();
  const app = { use: vi.fn(), get: vi.fn(), post: (path, handler) => routes.set(path, handler) };
  const express = Object.assign(() => app, { json: vi.fn() });
  const server = Object.assign(new EventEmitter(), {
    listen: vi.fn(), close: vi.fn(cb => cb?.()), closeAllConnections: vi.fn(),
  });
  const io = Object.assign(new EventEmitter(), {
    use: vi.fn(), close: vi.fn(cb => cb?.()),
  });
  const process = Object.assign(new EventEmitter(), { env: {}, exit: vi.fn() });
  const state = { agents: {}, stats: { spawned: 0, completed: 0, failed: 0 } };
  const files = new Map();
  const writeFile = vi.fn(async (path, content) => { files.set(path, content); });
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
  runInNewContext(source, {
    express, http: { createServer: () => server }, SocketServer: function () { return io; },
    process, console, Buffer, Date, setTimeout, clearTimeout, join, basename,
    PATHS: { root: '/example', cosAgents: '/example/agents' }, PORTS: { COS: 0 },
    setupProcessErrorHandlers: vi.fn(), existsSync: () => true, ensureDir: async () => {},
    readFile: async path => files.get(path) ?? '{}', writeFile, withState, drainState,
    createRunnerShutdown, registerRunnerShutdownSignals, createTuiExitHandler, createHttpDrain,
    armForceKillShared: armForceKill, killProcessTree, spawn, pty,
    buildCliChildEnv: () => ({}), prepareCliSpawn: (command, args) => ({ command, args }),
    prepareCliPrompt: (command, args) => ({ args, useStdin: false, cleanup: vi.fn() }),
    commandExists, findCommandOnPath: command => command,
    isAllowedCommand: () => true, ALLOWED_COMMANDS: ['example-cli'],
    guardChildStdin: vi.fn(), deliverChildStdin: vi.fn(),
    createStreamingAnsiStripper: () => text => text, isKnownCliStderrNoise: () => false,
  });
  const request = (path, extra = {}) => {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json: vi.fn() };
    const done = routes.get(path)({ body: {
      agentId: 'agent-1', taskId: 'task-1', prompt: 'example', cliCommand: 'example-cli',
      command: 'example-cli', ...extra,
    } }, res);
    return { res, done };
  };
  return { request, process, server, io, state, files, children, spawn, pty, commandExists, writeFile, withState, drainState };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('runner shutdown through its real spawn and signal handlers', () => {
  it.each(['SIGINT', 'SIGTERM'])('%s drains CLI output, completion and state exactly once', async signal => {
    const run = runner();
    await run.request('/spawn').done;
    const child = run.children[0];
    child.stdout.emit('data', Buffer.from('final output'));
    const write = deferred();
    run.writeFile.mockImplementationOnce(async (path, output) => {
      await write.promise;
      run.files.set(path, output);
    });
    run.process.emit(signal);
    run.process.emit(signal === 'SIGINT' ? 'SIGTERM' : 'SIGINT');
    expect(run.server.close).toHaveBeenCalledTimes(1);
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    child.emit('close', 0);
    child.emit('close', 0);
    await vi.advanceTimersByTimeAsync(6000);
    expect(run.process.exit).not.toHaveBeenCalled();
    expect(run.io.close).not.toHaveBeenCalled();
    write.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(run.files.get(join('/example/agents', 'agent-1', 'output.txt'))).toBe('final output');
    expect(JSON.parse(run.files.get(join('/example/agents', 'agent-1', 'metadata.json')))).toMatchObject({ success: true, exitCode: 0 });
    expect(run.state).toEqual({ agents: {}, stats: { spawned: 1, completed: 1, failed: 0 } });
    expect(run.process.exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(run.io.close).toHaveBeenCalledTimes(1);
  });

  it('rejects both new spawn routes and a TUI whose preparation resumes after shutdown', async () => {
    const run = runner();
    const probe = deferred();
    run.commandExists.mockReturnValueOnce(probe.promise);
    const preparing = run.request('/spawn-tui');
    run.process.emit('SIGINT');
    for (const route of ['/spawn', '/spawn-tui']) {
      const refused = run.request(route);
      await refused.done;
      expect(refused.res.statusCode).toBe(503);
    }
    await vi.advanceTimersByTimeAsync(1000);
    expect(run.process.exit).not.toHaveBeenCalled();
    probe.resolve(true);
    await preparing.done;
    await vi.advanceTimersByTimeAsync(0);
    expect(preparing.res.statusCode).toBe(503);
    expect(run.spawn).not.toHaveBeenCalled();
    expect(run.pty.spawn).not.toHaveBeenCalled();
    expect(run.process.exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('escalates a resistant TUI and waits for its terminal evidence and final state write', async () => {
    const run = runner();
    await run.request('/spawn-tui').done;
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
    const run = runner();
    await run.request('/spawn').done;
    if (stalled === 'write') run.writeFile.mockReturnValueOnce(new Promise(() => {}));
    if (stalled === 'socket') run.io.close.mockImplementation(() => {});
    run.process.exit.mockImplementation(() => { expect(run.io.close).toHaveBeenCalled(); });
    run.process.emit('SIGTERM');
    if (stalled !== 'child') run.children[0].emit('close', 0);
    await vi.advanceTimersByTimeAsync(24_999);
    expect(run.process.exit).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(run.process.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(run.io.close).toHaveBeenCalledTimes(1);
    if (stalled !== 'socket') {
      expect(run.state.agents['agent-1']).toBeDefined();
      expect(run.state.stats.completed).toBe(0);
      expect(run.files.has(join('/example/agents', 'agent-1', 'metadata.json'))).toBe(false);
    }
  });

  it('reports a persistence failure without deleting the durable agent record', async () => {
    const run = runner();
    await run.request('/spawn').done;
    run.writeFile.mockRejectedValueOnce(new Error('disk unavailable'));
    run.process.emit('SIGTERM');
    run.children[0].emit('close', 0);
    await vi.advanceTimersByTimeAsync(0);
    expect(run.process.exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(run.state.agents['agent-1']).toBeDefined();
    expect(run.state.stats.completed).toBe(0);
  });

  it('does not stop children when only the main-server socket disconnects', async () => {
    const run = runner();
    await run.request('/spawn-tui').done;
    const socket = Object.assign(new EventEmitter(), { use: vi.fn(), id: 'example-client' });
    run.io.emit('connection', socket);
    socket.emit('disconnect');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(run.children[0].kill).not.toHaveBeenCalled();
    expect(run.process.exit).not.toHaveBeenCalled();
    expect(run.state.agents['agent-1']).toBeDefined();
  });
});
