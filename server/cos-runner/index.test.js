import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { io as connect } from 'socket.io-client';
import { createCosRunner, shouldStartUnderPm2 } from './index.js';
import { PTY_WORKSPACE_MISSING_PREFIX } from '../lib/ptySpawnDiagnostics.js';

const activeCleanups = [];

function makeFakeChild(pid = 4321) {
  const stdin = Object.assign(new EventEmitter(), {
    write: vi.fn(),
    end: vi.fn(),
    destroyed: false,
  });
  const child = Object.assign(new EventEmitter(), {
    pid,
    stdin,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
  });
  child.onData = (fn) => child.on('data', fn);
  child.onExit = (fn) => child.on('exit', fn);
  return child;
}

function rawHttp(url, { path = '/health', method = 'GET', headers = {}, body = '' } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(`${url}${path}`, { method, headers }, (res) => {
      let text = '';
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

async function bootTestRunner(overrides = {}) {
  const state = { agents: {}, stats: { spawned: 0, completed: 0, failed: 0 } };
  const files = new Map();
  const children = [];
  const ptyChildren = [];

  const deps = {
    rootDir: '/example/root',
    agentsDir: '/example/agents',
    port: 0,
    host: '127.0.0.1',
    orphanCleanupDelayMs: -1,
    assertDatabaseAdmission: vi.fn(),
    withBackupAssetPublication: vi.fn(async fn => fn()),
    persistRunnerCompletion: vi.fn(async () => {}),
    existsSync: vi.fn(() => true),
    ensureDir: vi.fn(async () => {}),
    adoptNpmGlobalBinDir: vi.fn(async () => {}),
    readFile: vi.fn(async (filePath) => {
      if (!files.has(filePath)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return files.get(filePath);
    }),
    writeFile: vi.fn(async (filePath, content) => { files.set(filePath, content); }),
    withState: vi.fn(async fn => fn(state)),
    drainState: vi.fn(async () => {}),
    getProcessStats: vi.fn(async () => ({ cpu: 1.5, memoryKb: 2048, state: 'S' })),
    checkProcessRunning: vi.fn(async () => false),
    spawn: vi.fn(() => {
      const child = makeFakeChild(1000 + children.length);
      children.push(child);
      return child;
    }),
    pty: {
      spawn: vi.fn(() => {
        const child = makeFakeChild(2000 + ptyChildren.length);
        ptyChildren.push(child);
        return child;
      }),
    },
    killProcessTree: vi.fn((child, signal) => child.kill(signal)),
    armForceKill: vi.fn(),
    guardChildStdin: vi.fn(),
    deliverChildStdin: vi.fn(),
    prepareCliPrompt: vi.fn((_cmd, args) => ({ args, useStdin: true, cleanup: vi.fn() })),
    prepareCliSpawn: vi.fn((command, args) => ({ command, args })),
    prepareWindowsAgentLaunch: vi.fn((_agentId, command, args) => ({ command, args })),
    watchWindowsAgentProcess: vi.fn(child => child),
    buildCliChildEnv: vi.fn(({ before = {}, cwd }) => ({ ...before, PWD: cwd, PATH: '/example/bin' })),
    findCommandOnPath: vi.fn(cmd => `/example/bin/${cmd}`),
    commandExists: vi.fn(async () => true),
    createAgentSentinelAccess: vi.fn(() => ({
      path: null,
      resolvedPath: () => null,
      read: vi.fn(async () => ''),
      promote: vi.fn(async () => true),
      cleanup: vi.fn(async () => {}),
      watch: vi.fn(() => () => {}),
    })),
    ...overrides,
  };

  const runner = createCosRunner(deps);
  const { port } = await runner.start(0, '127.0.0.1');
  const baseUrl = `http://127.0.0.1:${port}`;
  const clients = [];

  const connectClient = async (opts = {}) => {
    const client = connect(baseUrl, { transports: ['websocket'], reconnection: false, timeout: 2000, ...opts });
    clients.push(client);
    await new Promise((resolve, reject) => {
      client.once('connect', resolve);
      client.once('connect_error', reject);
    });
    return client;
  };

  activeCleanups.push(async () => {
    for (const client of clients) client.close();
    for (const agent of runner.activeAgents.values()) {
      if (agent.killTimer) clearTimeout(agent.killTimer);
    }
    await new Promise(resolve => runner.io.close(resolve));
    runner.server.closeAllConnections?.();
  });

  const post = async (path, body = {}) => {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() };
  };

  const get = async (path) => {
    const res = await fetch(`${baseUrl}${path}`);
    return { status: res.status, body: await res.json() };
  };

  return { runner, deps, state, files, children, ptyChildren, baseUrl, clients, connectClient, post, get };
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  for (const cleanup of activeCleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
});

describe('cos-runner factory and direct-invocation gate', () => {
  it('creates an unbound runner with the documented surface without binding a port at import', () => {
    const runner = createCosRunner({ orphanCleanupDelayMs: -1 });
    expect(Object.keys(runner).sort()).toEqual([
      'activeAgents',
      'app',
      'cleanupOrphanedAgents',
      'io',
      'lifecycle',
      'securityScans',
      'server',
      'start',
    ]);
    expect(runner.server.listening).toBe(false);
    expect(runner.activeAgents.size).toBe(0);
  });

  it('recognizes PM2 fork-mode execution via pm_exec_path and ignores other scripts', () => {
    const runnerUrl = new URL('./index.js', import.meta.url).href;
    const runnerPath = new URL('./index.js', import.meta.url).pathname;
    expect(shouldStartUnderPm2(runnerUrl, { pm_exec_path: decodeURIComponent(runnerPath) })).toBe(true);
    expect(shouldStartUnderPm2(runnerUrl, { pm_exec_path: '/example/other.js' })).toBe(false);
    expect(shouldStartUnderPm2(runnerUrl, {})).toBe(false);
  });
});

describe('cos-runner HTTP and Socket.IO requestGuard admission', () => {
  it('rejects browser and DNS-rebind HTTP requests before JSON parsing and serves native clients', async () => {
    const { baseUrl } = await bootTestRunner();
    for (const headers of [
      { Origin: 'https://attacker.example', 'Content-Type': 'application/json' },
      { 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json' },
      { Host: 'rebind.attacker.example:5558', 'Content-Type': 'application/json' },
    ]) {
      const res = await rawHttp(baseUrl, { path: '/spawn', method: 'POST', headers, body: '{not-valid-json' });
      expect(res.status).toBe(403);
      expect(JSON.parse(res.text).code).toMatch(/BROWSER_REQUEST_REJECTED|HOST_NOT_ALLOWED/);
    }

    const health = await rawHttp(baseUrl, { path: '/health', method: 'GET' });
    expect(health.status).toBe(200);
    expect(JSON.parse(health.text)).toMatchObject({ status: 'ok', activeAgents: 0 });
  });

  it('rejects browser and rebind Socket.IO handshakes and post-sid polling packets', async () => {
    const { baseUrl, clients, connectClient } = await bootTestRunner();
    for (const extraHeaders of [
      { Origin: 'https://attacker.example' },
      { 'Sec-Fetch-Site': 'same-origin' },
      { Host: 'rebind.attacker.example:5558' },
    ]) {
      const client = connect(baseUrl, { transports: ['websocket'], extraHeaders, reconnection: false, timeout: 2000 });
      clients.push(client);
      const outcome = await new Promise(resolve => {
        client.once('connect', () => resolve('connected'));
        client.once('connect_error', () => resolve('refused'));
      });
      expect(outcome).toBe('refused');
    }

    const nativeClient = await connectClient({ transports: ['polling'] });
    const hijackedSid = await rawHttp(baseUrl, {
      path: `/socket.io/?EIO=4&transport=polling&sid=${nativeClient.io.engine.id}`,
      method: 'GET',
      headers: { Origin: 'https://attacker.example' },
    });
    expect(hijackedSid.status).toBe(403);
  });
});

describe('cos-runner /spawn — CLI shim, prompt delivery, stdin guard, and output pipelines', () => {
  it('composes childEnv -> prepareCliPrompt -> prepareCliSpawn -> prepareWindowsAgentLaunch -> spawn and guards stdin before delivery', async () => {
    const callOrder = [];
    const cleanup = vi.fn();
    const { post, deps, children } = await bootTestRunner({
      buildCliChildEnv: vi.fn((opts) => {
        callOrder.push('buildCliChildEnv');
        return { ...opts.before, PWD: opts.cwd, PATH: '/custom/provider/bin' };
      }),
      prepareCliPrompt: vi.fn((cmd, args, prompt, opts) => {
        callOrder.push('prepareCliPrompt');
        expect(opts).toEqual({ cwd: '/example/workspace' });
        return { args: [...args, '--prepared'], useStdin: true, cleanup };
      }),
      prepareCliSpawn: vi.fn((cmd, args, env) => {
        callOrder.push('prepareCliSpawn');
        expect(env.PATH).toBe('/custom/provider/bin');
        return { command: 'cmd.exe', args: ['/d', '/s', '/c', `${cmd}.cmd`, ...args] };
      }),
      prepareWindowsAgentLaunch: vi.fn((agentId, command, args, opts) => {
        callOrder.push('prepareWindowsAgentLaunch');
        return { command: 'win-wrapper', args: [agentId, command, ...args], opts };
      }),
      spawn: vi.fn((command, args, opts) => {
        callOrder.push('spawn');
        const child = makeFakeChild(5150);
        child.spawnRecord = { command, args, opts };
        children.push(child);
        return child;
      }),
      guardChildStdin: vi.fn(() => { callOrder.push('guardChildStdin'); }),
      deliverChildStdin: vi.fn(() => { callOrder.push('deliverChildStdin'); }),
    });

    const res = await post('/spawn', {
      agentId: 'agent-shim',
      taskId: 'task-shim',
      prompt: 'implement feature',
      workspacePath: '/example/workspace',
      envVars: { CUSTOM_FLAG: '1' },
      providerAuth: { vendor: 'anthropic' },
      cliCommand: 'claude',
      cliArgs: ['--print'],
    });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, agentId: 'agent-shim', pid: 5150 });
    expect(callOrder).toEqual([
      'buildCliChildEnv',
      'prepareCliPrompt',
      'prepareCliSpawn',
      'prepareWindowsAgentLaunch',
      'spawn',
      'guardChildStdin',
      'deliverChildStdin',
    ]);
    expect(deps.buildCliChildEnv).toHaveBeenCalledWith({
      before: { CUSTOM_FLAG: '1' },
      provider: { vendor: 'anthropic' },
      cwd: '/example/workspace',
    });
    expect(deps.prepareCliPrompt).toHaveBeenCalledWith('claude', ['--print'], 'implement feature', { cwd: '/example/workspace' });
    expect(deps.prepareCliSpawn).toHaveBeenCalledWith('claude', ['--print', '--prepared'], expect.objectContaining({
      PATH: '/custom/provider/bin',
      PWD: '/example/workspace',
    }));
    expect(children[0].spawnRecord).toMatchObject({
      command: 'win-wrapper',
      args: ['agent-shim', 'cmd.exe', '/d', '/s', '/c', 'claude.cmd', '--print', '--prepared'],
      opts: expect.objectContaining({
        cwd: '/example/workspace',
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    });
    expect(deps.guardChildStdin).toHaveBeenCalledWith(children[0]);
    expect(deps.deliverChildStdin).toHaveBeenCalledWith(children[0], 'implement feature', 'agent agent-shim');

    children[0].emit('close', 0);
    await vi.waitFor(() => expect(cleanup).toHaveBeenCalledTimes(1));
  });

  it('skips piping stdin when prepareCliPrompt returns useStdin: false and cleans up prompt file on error', async () => {
    const cleanup = vi.fn();
    const { post, deps, children } = await bootTestRunner({
      prepareCliPrompt: vi.fn((_cmd, args, prompt) => ({
        args: [...args, '--print', prompt],
        useStdin: false,
        cleanup,
      })),
    });

    const res = await post('/spawn', {
      agentId: 'agent-agy',
      taskId: 'task-agy',
      prompt: 'argv delivered prompt',
      cliCommand: 'agy',
      cliArgs: ['--yolo'],
    });
    expect(res.status).toBe(200);
    expect(deps.guardChildStdin).toHaveBeenCalledWith(children[0]);
    expect(deps.deliverChildStdin).toHaveBeenCalledWith(children[0], null, 'agent agent-agy');

    children[0].emit('error', new Error('ENOENT'));
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  it('rejects missing fields and disallowed commands on /spawn', async () => {
    const { post, deps } = await bootTestRunner();
    const missing = await post('/spawn', { agentId: 'a1' });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toContain('Missing required fields');

    const disallowed = await post('/spawn', {
      agentId: 'a2',
      taskId: 't2',
      prompt: 'hi',
      cliCommand: 'rm',
    });
    expect(disallowed.status).toBe(400);
    expect(disallowed.body.error).toContain('Command not allowed: rm');
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it('strips split ANSI escapes per agent, drops pure-control/known stderr noise, and tags real stderr', async () => {
    const { post, get, connectClient, children } = await bootTestRunner();
    const client = await connectClient();
    const emitted = [];
    client.on('agent:output', payload => emitted.push(payload));

    await post('/spawn', { agentId: 'a1', taskId: 't1', prompt: 'p1', cliCommand: 'opencode', cliArgs: ['run'] });
    await post('/spawn', { agentId: 'a2', taskId: 't2', prompt: 'p2', cliCommand: 'opencode', cliArgs: ['run'] });
    const [child1, child2] = children;

    // Split ANSI escape across two chunks on agent 1 while agent 2 emits plain text
    // in between — per-agent strippers must not bleed escape state across agents.
    child1.stdout.emit('data', Buffer.from('hello \x1b[3'));
    child2.stdout.emit('data', Buffer.from('plain two\n'));
    child1.stdout.emit('data', Buffer.from('1mworld\x1b[0m\n\n'));

    // Pure-control stderr chunk (bare reset) and known CLI stderr noise must be dropped.
    child1.stderr.emit('data', Buffer.from('\x1b[0m   \n'));
    child1.stderr.emit('data', Buffer.from('[claude-code:unrecognized_model] unrecognized model local-test\n'));
    // Real colored stderr must be decolored BEFORE adding the [stderr] prefix.
    child1.stderr.emit('data', Buffer.from('\x1b[31mreal warning\x1b[0m\n'));

    await vi.waitFor(() => {
      expect(emitted.some(e => e.agentId === 'a1' && e.text === '[stderr] real warning\n')).toBe(true);
    });

    const out1 = await get('/agents/a1/output');
    const out2 = await get('/agents/a2/output');
    expect(out1.body.output).toBe('hello world\n\n[stderr] real warning\n');
    expect(out2.body.output).toBe('plain two\n');
    expect(emitted.filter(e => e.agentId === 'a1' && e.text.includes('unrecognized_model'))).toEqual([]);
  });

  it('parses stream-json NDJSON stdout without ANSI stripping and persists finalResult on close', async () => {
    const { post, connectClient, deps, children } = await bootTestRunner();
    const client = await connectClient();
    const outputs = [];
    const completed = new Promise(resolve => client.once('agent:completed', resolve));
    client.on('agent:output', payload => outputs.push(payload));

    await post('/spawn', {
      agentId: 'a-stream',
      taskId: 't-stream',
      prompt: 'summarize',
      cliCommand: 'claude',
      cliArgs: ['--print', '--output-format', 'stream-json'],
    });
    const child = children[0];
    child.stdout.emit('data', Buffer.from(`${JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'partial line\n' } },
    })}\n`));
    child.stdout.emit('data', Buffer.from(`${JSON.stringify({
      type: 'result',
      result: 'final parsed summary',
    })}\n`));
    child.emit('close', 0);

    const completion = await completed;
    expect(completion).toMatchObject({ agentId: 'a-stream', exitCode: 0, success: true });
    expect(outputs.some(o => o.text.includes('partial line'))).toBe(true);
    expect(deps.persistRunnerCompletion).toHaveBeenCalledWith(
      '/example/agents',
      'a-stream',
      'final parsed summary',
      expect.objectContaining({ taskId: 't-stream', exitCode: 0, success: true }),
    );
  });

  it('routes decolored Codex stderr through createCodexStderrFormatter and flushes on close', async () => {
    const processChunk = vi.fn((text) => [`codex:${text.trim()}`]);
    const flush = vi.fn(() => ['codex:flushed']);
    const createCodexStderrFormatter = vi.fn(() => ({ processChunk, flush }));
    const { post, connectClient, deps, children } = await bootTestRunner({ createCodexStderrFormatter });
    const client = await connectClient();
    const completed = new Promise(resolve => client.once('agent:completed', resolve));

    await post('/spawn', {
      agentId: 'a-codex',
      taskId: 't-codex',
      prompt: 'fix bug',
      cliCommand: 'codex',
      cliArgs: ['exec'],
    });
    expect(createCodexStderrFormatter).toHaveBeenCalledWith('fix bug');
    children[0].stderr.emit('data', Buffer.from('\x1b[32mthinking\x1b[0m\n'));
    expect(processChunk).toHaveBeenCalledWith('thinking\n');
    children[0].emit('close', 0);

    await completed;
    expect(flush).toHaveBeenCalledTimes(1);
    expect(deps.persistRunnerCompletion).toHaveBeenCalledWith(
      '/example/agents',
      'a-codex',
      'codex:thinking\ncodex:flushed\n',
      expect.objectContaining({ taskId: 't-codex', success: true }),
    );
  });
});

describe('cos-runner /spawn-tui — 400/409/422 preflight matrix and durable TUI ownership', () => {
  it('returns 400 for schema errors, missing required fields, and disallowed commands', async () => {
    const { post, deps } = await bootTestRunner();

    const badSchema = await post('/spawn-tui', { agentId: 'a1', taskId: 't1', command: 'claude', cols: 0 });
    expect(badSchema.status).toBe(400);
    expect(badSchema.body.error).toContain('cols');

    const missingFields = await post('/spawn-tui', { command: 'claude' });
    expect(missingFields.status).toBe(400);
    expect(missingFields.body.error).toContain('Missing TUI spawn fields: agentId, taskId, sessionId');

    const disallowed = await post('/spawn-tui', { agentId: 'a1', taskId: 't1', command: 'bash' });
    expect(disallowed.status).toBe(400);
    expect(disallowed.body.error).toContain('Command not allowed: bash');
    expect(deps.pty.spawn).not.toHaveBeenCalled();
  });

  it('returns 409 when the agentId is already active', async () => {
    const { post, runner, deps } = await bootTestRunner();
    runner.activeAgents.set('agent-dup', { kind: 'tui', pid: 99 });

    const res = await post('/spawn-tui', { agentId: 'agent-dup', taskId: 't1', command: 'claude' });
    expect(res.status).toBe(409);
    expect(res.body.error).toContain('agent-dup is already running');
    expect(deps.findCommandOnPath).not.toHaveBeenCalled();
  });

  it('returns 422 for missing workspace before PATH/capability probes', async () => {
    const { post, deps } = await bootTestRunner({
      existsSync: vi.fn((p) => p !== '/example/missing-worktree'),
    });

    const res = await post('/spawn-tui', {
      agentId: 'a-missing-ws',
      taskId: 't1',
      command: 'claude',
      workspacePath: '/example/missing-worktree',
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain(PTY_WORKSPACE_MISSING_PREFIX);
    expect(deps.findCommandOnPath).not.toHaveBeenCalled();
    expect(deps.commandExists).not.toHaveBeenCalled();
  });

  it('returns 422 when command is absent from child PATH without running capability probe', async () => {
    const { post, deps } = await bootTestRunner({
      findCommandOnPath: vi.fn(() => null),
    });

    const res = await post('/spawn-tui', {
      agentId: 'a-no-path',
      taskId: 't1',
      command: 'claude',
      workspacePath: '/example/workspace',
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain('claude is not on the CoS Runner PATH');
    expect(deps.commandExists).not.toHaveBeenCalled();
    expect(deps.pty.spawn).not.toHaveBeenCalled();
  });

  it('returns 422 when capability check fails and passes the 15s heavy-CLI timeout + prepared probe', async () => {
    const { post, deps } = await bootTestRunner({
      prepareCliSpawn: vi.fn((cmd, args) => ({ command: 'wrapped-probe', args: [cmd, ...args] })),
      commandExists: vi.fn(async () => false),
    });

    const res = await post('/spawn-tui', {
      agentId: 'a-bad-cap',
      taskId: 't1',
      command: 'claude',
      workspacePath: '/example/workspace',
    });
    expect(res.status).toBe(422);
    expect(res.body.error).toContain('claude did not pass the CoS Runner capability check');
    expect(deps.prepareCliSpawn).toHaveBeenCalledWith(
      '/example/bin/claude',
      ['--version'],
      expect.objectContaining({ PWD: '/example/workspace' }),
    );
    expect(deps.commandExists).toHaveBeenCalledWith(
      'wrapped-probe',
      ['/example/bin/claude', '--version'],
      expect.objectContaining({ timeoutMs: 15_000, cwd: '/example/workspace' }),
    );
    expect(deps.pty.spawn).not.toHaveBeenCalled();
  });

  it('returns 422 on diagnosed pty.spawn failure and 500 on undiagnosed pty.spawn failure', async () => {
    const diagnosePtySpawnFailure = vi.fn()
      .mockReturnValueOnce({ diagnosed: true, message: 'PTY spawn helper unavailable' })
      .mockReturnValueOnce({ diagnosed: false, message: '' });

    const { post } = await bootTestRunner({
      pty: { spawn: vi.fn(() => { throw new Error('posix_spawn failed'); }) },
      diagnosePtySpawnFailure,
    });

    const diagnosed = await post('/spawn-tui', { agentId: 'a-diag', taskId: 't1', command: 'claude' });
    expect(diagnosed.status).toBe(422);
    expect(diagnosed.body).toEqual({ error: 'PTY spawn helper unavailable' });

    const undiagnosed = await post('/spawn-tui', { agentId: 'a-undiag', taskId: 't2', command: 'claude' });
    expect(undiagnosed.status).toBe(500);
    expect(undiagnosed.body).toEqual({ error: 'posix_spawn failed', code: 'RUNNER_ERROR' });
  });

  it('tracks TUI liveness from onExit (including Windows ConPTY pid 0) and relays tui:output + completion', async () => {
    const { post, get, connectClient, deps, ptyChildren } = await bootTestRunner({
      pty: {
        spawn: vi.fn(() => {
          const child = makeFakeChild(0); // Windows ConPTY reports pid 0
          ptyChildren.push(child);
          return child;
        }),
      },
      prepareCliSpawn: vi.fn((cmd, args) => ({ command: `wrapped:${cmd}`, args })),
      prepareWindowsAgentLaunch: vi.fn((_agentId, command, args, opts) => {
        expect(opts.pty).toBe(true);
        return { command: `job:${command}`, args };
      }),
    });

    const client = await connectClient();
    const tuiOutputs = [];
    client.on('tui:output', payload => tuiOutputs.push(payload));
    const completed = new Promise(resolve => client.once('agent:completed', resolve));

    const spawned = await post('/spawn-tui', {
      agentId: 'a-tui',
      taskId: 't-tui',
      command: 'claude',
      args: ['--resume'],
      workspacePath: '/example/workspace',
    });
    expect(spawned.status).toBe(200);
    expect(deps.pty.spawn).toHaveBeenCalledWith(
      'job:wrapped:/example/bin/claude',
      ['--resume'],
      expect.objectContaining({ cwd: '/example/workspace', name: 'xterm-256color' }),
    );

    ptyChildren[0].emit('data', 'hello from pty');
    await vi.waitFor(() => expect(tuiOutputs).toContainEqual({
      sessionId: 'a-tui',
      agentId: 'a-tui',
      data: 'hello from pty',
    }));

    // pid 0 must still be reported live via onExit bookkeeping rather than pid probe.
    const listBeforeExit = await get('/agents');
    expect(listBeforeExit.body).toHaveLength(1);
    expect(listBeforeExit.body[0]).toMatchObject({
      id: 'a-tui',
      pid: 0,
      kind: 'tui',
      processActive: true,
    });
    expect(deps.getProcessStats).not.toHaveBeenCalled();

    ptyChildren[0].emit('exit', { exitCode: 0, signal: 0 });
    expect(await completed).toMatchObject({
      agentId: 'a-tui',
      taskId: 't-tui',
      exitCode: 0,
      success: false,
      completionReason: 'tui-exit',
    });
    expect((await get('/agents')).body).toEqual([]);
  });
});

describe('cos-runner termination, pause, and tui:kill delegation', () => {
  it('delegates /terminate, /terminate-all, /kill, /pause, and tui:kill through killProcessTree and armForceKill', async () => {
    const { post, runner, deps, children, ptyChildren, connectClient } = await bootTestRunner();
    await post('/spawn', { agentId: 'a1', taskId: 't1', prompt: 'p1', cliCommand: 'claude' });
    await post('/spawn', { agentId: 'a2', taskId: 't2', prompt: 'p2', cliCommand: 'claude' });
    await post('/spawn-tui', { agentId: 'tui-1', taskId: 't3', command: 'claude' });

    const term = await post('/terminate/a1', {});
    expect(term.status).toBe(200);
    expect(deps.killProcessTree).toHaveBeenCalledWith(children[0], 'SIGTERM');
    expect(deps.armForceKill).toHaveBeenCalledWith(runner.activeAgents, 'a1', expect.any(Object), expect.objectContaining({ graceMs: 5000 }));

    const termAll = await post('/terminate-all', {});
    expect(termAll.status).toBe(200);
    expect(termAll.body).toEqual({ success: true, killed: 3 });

    const killed = await post('/kill/a2', {});
    expect(killed.status).toBe(200);
    expect(deps.killProcessTree).toHaveBeenCalledWith(children[1], 'SIGKILL');
    expect(runner.activeAgents.has('a2')).toBe(false);

    // Pause keeps durable state and suppresses agent:completed on close.
    const paused = await post('/pause/a1', { reason: 'operator pause' });
    expect(paused.status).toBe(200);
    expect(runner.activeAgents.get('a1').paused).toBe(true);

    // tui:kill sets dropState: true for active TUI and dropState: false for paused TUI.
    const client = await connectClient();
    deps.armForceKill.mockClear();
    client.emit('tui:kill', { sessionId: 'tui-1', signal: 'SIGTERM' });
    await vi.waitFor(() => expect(deps.armForceKill).toHaveBeenCalledTimes(1));
    expect(deps.killProcessTree).toHaveBeenCalledWith(ptyChildren[0], 'SIGTERM');
    expect(deps.armForceKill).toHaveBeenCalledWith(
      runner.activeAgents,
      'tui-1',
      expect.any(Object),
      expect.objectContaining({ dropState: true }),
    );

    runner.activeAgents.get('tui-1').paused = true;
    deps.armForceKill.mockClear();
    client.emit('tui:kill', { sessionId: 'tui-1', signal: 'SIGTERM' });
    await vi.waitFor(() => expect(deps.armForceKill).toHaveBeenCalledTimes(1));
    expect(deps.armForceKill).toHaveBeenCalledWith(
      runner.activeAgents,
      'tui-1',
      expect.any(Object),
      expect.objectContaining({ dropState: false }),
    );
  });
});

describe('cos-runner /btw/:agentId operational log redaction (#17199)', () => {
  it('writes BTW.md and emits agent:btw while logging only agentId and character count', async () => {
    const { post, connectClient, files } = await bootTestRunner();
    const client = await connectClient();
    const btwEvent = new Promise(resolve => client.once('agent:btw', resolve));

    await post('/spawn', {
      agentId: 'agent-btw',
      taskId: 'task-btw',
      prompt: 'initial prompt',
      workspacePath: '/example/btw-workspace',
      cliCommand: 'claude',
    });

    const secretMessage = 'PRIVATE_USER_GUIDANCE_TOKEN_987654';
    console.log.mockClear();
    const res = await post('/btw/agent-btw', { message: secretMessage });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      agentId: 'agent-btw',
      btwPath: join('/example/btw-workspace', 'BTW.md'),
    });
    expect(files.get(join('/example/btw-workspace', 'BTW.md'))).toContain(secretMessage);
    expect(await btwEvent).toMatchObject({ agentId: 'agent-btw', message: secretMessage });

    const loggedLines = console.log.mock.calls.map(args => args.join(' '));
    expect(loggedLines).toContain(`💬 BTW message delivered to agent agent-btw (${secretMessage.length} chars)`);
    expect(loggedLines.some(line => line.includes(secretMessage) || line.includes('PRIVATE_USER_GUIDANCE'))).toBe(false);
  });

  it('rejects unknown agents, empty messages, and agents without workspacePath', async () => {
    const { post, runner } = await bootTestRunner();
    expect((await post('/btw/missing', { message: 'hello' })).status).toBe(404);

    runner.activeAgents.set('no-ws', { pid: 10, workspacePath: null });
    expect((await post('/btw/no-ws', { message: '' })).status).toBe(400);
    expect((await post('/btw/no-ws', { message: 'hello' })).status).toBe(400);
  });
});

describe('cos-runner cleanupOrphanedAgents', () => {
  it('reaps dead PIDs, preserves running PIDs, recovers security scans, and emits agents:orphaned', async () => {
    const recover = vi.fn(async () => {});
    const { runner, state, connectClient } = await bootTestRunner({
      checkProcessRunning: vi.fn(async (pid) => pid === 222),
      securityScans: {
        register: vi.fn(async () => {}),
        read: vi.fn(async () => null),
        start: vi.fn(async () => ({})),
        stop: vi.fn(async () => null),
        recover,
      },
    });
    state.agents['dead-1'] = { pid: 111, taskId: 'task-dead', securityScanGrant: { id: 'g1' } };
    state.agents['alive-1'] = { pid: 222, taskId: 'task-alive' };

    const client = await connectClient();
    const orphanedEvent = new Promise(resolve => client.once('agents:orphaned', resolve));

    const orphaned = await runner.cleanupOrphanedAgents();
    expect(orphaned).toEqual([{ agentId: 'dead-1', taskId: 'task-dead' }]);
    expect(recover).toHaveBeenCalledWith('dead-1');
    expect(state.agents).toEqual({ 'alive-1': { pid: 222, taskId: 'task-alive' } });
    expect(await orphanedEvent).toMatchObject({
      count: 1,
      agents: [expect.objectContaining({ agentId: 'dead-1', taskId: 'task-dead', orphaned: true, exitCode: -1, success: false })],
    });
  });
});
