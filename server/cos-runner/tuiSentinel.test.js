import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { io as connect } from 'socket.io-client';
import { createCosRunner } from './index.js';

const SENTINEL_PATH = '/example/workspace/.agent-done-agent-1';

const activeCleanups = [];

// Spawn a real runner over loopback HTTP + Socket.IO with injectable PTY and
// sentinel access; no real CLI binary, listening well-known port, or data/ tree
// is touched.
async function spawnTui(sentinel = {}, { trackPromptSubmission = true } = {}) {
  const child = Object.assign(new EventEmitter(), {
    pid: 123,
    kill: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
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
  const armForceKill = vi.fn();

  const runner = createCosRunner({
    rootDir: '/example',
    agentsDir: '/example/agents',
    port: 0,
    host: '127.0.0.1',
    orphanCleanupDelayMs: -1,
    assertDatabaseAdmission: vi.fn(),
    withBackupAssetPublication: vi.fn(),
    persistRunnerCompletion: vi.fn(),
    existsSync: () => true,
    ensureDir: async () => {},
    adoptNpmGlobalBinDir: vi.fn(async () => {}),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    withState: async fn => fn(state),
    drainState: async () => {},
    killProcessTree,
    armForceKill,
    getProcessStats: vi.fn(async () => ({})),
    spawn: vi.fn(),
    pty: { spawn: vi.fn(() => child) },
    createAgentSentinelAccess: vi.fn(() => access),
    buildCliChildEnv: () => ({}),
    prepareCliSpawn: (command, args) => ({ command, args }),
    prepareWindowsAgentLaunch: (_agentId, command, args) => ({ command, args }),
    watchWindowsAgentProcess: c => c,
    commandExists: vi.fn(async () => true),
    findCommandOnPath: command => command,
    isAllowedCommand: () => true,
    allowedCommands: new Set(['example-cli']),
  });

  const { port } = await runner.start(0, '127.0.0.1');
  const baseUrl = `http://127.0.0.1:${port}`;

  const serverSocketReady = new Promise(resolve => runner.io.once('connection', resolve));
  const client = connect(baseUrl, { transports: ['websocket'], reconnection: false });
  await new Promise((resolve, reject) => {
    client.once('connect', resolve);
    client.once('connect_error', reject);
  });
  const serverSocket = await serverSocketReady;

  activeCleanups.push(async () => {
    client.close();
    for (const agent of runner.activeAgents.values()) {
      if (agent.killTimer) clearTimeout(agent.killTimer);
    }
    await new Promise(resolve => runner.io.close(resolve));
    runner.server.closeAllConnections?.();
  });

  const spawnRes = await fetch(`${baseUrl}/spawn-tui`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      agentId: 'agent-1',
      taskId: 'task-1',
      command: 'example-cli',
      doneSentinelPath: SENTINEL_PATH,
      trackPromptSubmission,
    }),
  });
  expect(spawnRes.status).toBe(200);
  expect(await spawnRes.json()).toEqual(expect.objectContaining({ success: true }));

  // The runner hands its handler to watch(); firing it returns the tracked work.
  const fireSentinel = () => access.watch.mock.calls.at(-1)[0]();

  const sendInput = (payload) => new Promise((resolve) => {
    serverSocket.once('tui:input', () => queueMicrotask(resolve));
    client.emit('tui:input', { sessionId: 'agent-1', ...payload });
  });

  const listing = async () => {
    const res = await fetch(`${baseUrl}/agents`);
    const rows = await res.json();
    return rows[0];
  };

  const stopStartup = async (onlyIfPromptUnsubmitted = true) => {
    const res = await fetch(`${baseUrl}/terminate/agent-1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ onlyIfPromptUnsubmitted }),
    });
    return { status: res.status, body: await res.json() };
  };

  return { access, child, stopWatching, fireSentinel, sendInput, listing, stopStartup, killProcessTree };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  for (const cleanup of activeCleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
});

describe('cos-runner TUI startup recovery receipt', () => {
  it('counts only a successful task-submit Enter, preserving it across a server reconnect', async () => {
    const run = await spawnTui();
    await run.sendInput({ data: '\r' }); // startup dialog, not the task
    await run.sendInput({ data: '\x1b[200~task body\x1b[201~' });
    expect((await run.listing()).promptSubmitted).toBe(false);
    run.child.write.mockImplementationOnce(() => { throw new Error('PTY write failed'); });
    await run.sendInput({ data: '\r', promptSubmission: true });
    expect((await run.listing()).promptSubmitted).toBe(false);
    await run.sendInput({ data: '\r', promptSubmission: true });
    expect((await run.listing()).promptSubmitted).toBe(true);
    // A stale GET /agents from the old server must not authorize this kill.
    expect((await run.stopStartup()).body).toMatchObject({ terminated: false });
    expect(run.killProcessTree).not.toHaveBeenCalled();
  });

  it('stops an unsubmitted composer and refuses a late submission after the cancellation decision', async () => {
    const run = await spawnTui();
    expect((await run.stopStartup()).body).toMatchObject({ terminated: true });
    expect(run.killProcessTree).toHaveBeenCalledWith(run.child, 'SIGTERM');
    await run.sendInput({ data: '\r', promptSubmission: true });
    expect(run.child.write).not.toHaveBeenCalled();
    expect((await run.listing()).promptSubmitted).toBe(false);
  });

  it('preserves terminals spawned by an older server without the tracking protocol', async () => {
    const run = await spawnTui({}, { trackPromptSubmission: false });
    expect((await run.listing()).promptSubmitted).toBeNull();
    expect((await run.stopStartup()).body).toMatchObject({ terminated: false });
    expect(run.killProcessTree).not.toHaveBeenCalled();
  });

  it('rejects a malformed guard instead of falling through to unconditional termination', async () => {
    const run = await spawnTui();
    const res = await run.stopStartup('true');
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining('onlyIfPromptUnsubmitted') });
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
