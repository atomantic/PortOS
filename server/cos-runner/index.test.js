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

  it('rejects invalid schema types, missing fields, and disallowed commands on /spawn', async () => {
    const { post, deps } = await bootTestRunner();
    const badSchema = await post('/spawn', { agentId: 'a1', taskId: 't1', prompt: 'hi', cliArgs: 123 });
    expect(badSchema.status).toBe(400);
    expect(badSchema.body.error).toContain('Invalid request body');

    const missing = await post('/spawn', { agentId: 'a1' });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toContain('Invalid request body');

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

  it('rejects duplicate active agentId on /spawn with 409 without invoking prepareCliPrompt, securityScans.register, or spawn', async () => {
    const register = vi.fn(async () => {});
    const { post, runner, deps, children } = await bootTestRunner({
      securityScans: {
        register,
        read: vi.fn(async () => null),
        start: vi.fn(async () => ({})),
        stop: vi.fn(async () => null),
        recover: vi.fn(async () => {}),
      },
    });

    const first = await post('/spawn', {
      agentId: 'agent-dup',
      taskId: 't-first',
      prompt: 'first',
      cliCommand: 'claude',
      cliArgs: ['--print'],
    });
    expect(first.status).toBe(200);
    const originalEntry = runner.activeAgents.get('agent-dup');

    deps.prepareCliPrompt.mockClear();
    deps.spawn.mockClear();
    register.mockClear();

    const duplicate = await post('/spawn', {
      agentId: 'agent-dup',
      taskId: 't-second',
      prompt: 'second',
      cliCommand: 'claude',
      cliArgs: ['--print'],
    });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error).toContain('Agent agent-dup is already running');
    expect(deps.prepareCliPrompt).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
    expect(deps.spawn).not.toHaveBeenCalled();
    expect(runner.activeAgents.get('agent-dup')).toBe(originalEntry);
    expect(children).toHaveLength(1);
  });

  it('refuses the retired legacy shape: no cliCommand, or an unlisted claudePath, never spawns', async () => {
    const { post, deps } = await bootTestRunner();

    const noCommand = await post('/spawn', { agentId: 'a-legacy-1', taskId: 't-legacy-1', prompt: 'legacy run' });
    expect(noCommand.status).toBe(400);
    expect(noCommand.body.error).toContain('cliCommand');

    const smuggled = await post('/spawn', {
      agentId: 'a-legacy-2', taskId: 't-legacy-2', prompt: 'p', claudePath: '/bin/sh',
    });
    expect(smuggled.status).toBe(400);

    const ignoredPath = await post('/spawn', {
      agentId: 'a-legacy-3', taskId: 't-legacy-3', prompt: 'p', cliCommand: 'rm', claudePath: 'claude',
    });
    expect(ignoredPath.status).toBe(400);
    expect(ignoredPath.body.error).toContain('Command not allowed: rm');
    expect(deps.spawn).not.toHaveBeenCalled();
  });

  it('cleans up prompt temp file when shutdown starts before spawn commits', async () => {
    const cleanup = vi.fn();
    const register = vi.fn(async () => {});
    let runnerRef;
    const { runner, post, deps } = await bootTestRunner({
      exit: vi.fn(),
      shutdownDeadlineMs: 200,
      securityScans: {
        register,
        read: vi.fn(async () => null),
        start: vi.fn(async () => ({})),
        stop: vi.fn(async () => null),
        recover: vi.fn(async () => {}),
      },
      prepareCliPrompt: vi.fn((_cmd, args) => {
        void runnerRef.lifecycle.shutdown();
        return { args, useStdin: true, cleanup };
      }),
    });
    runnerRef = runner;

    const res = await post('/spawn', {
      agentId: 'a-shutting-down',
      taskId: 't-sd',
      prompt: 'abort me',
      cliCommand: 'claude',
    });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'Runner is shutting down', code: 'SHUTTING_DOWN' });
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(register).not.toHaveBeenCalled();
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

  it('handles split stream-json NDJSON chunks, caps rawStreamBuffer at 512 KiB, and flushes trailing text on close', async () => {
    const { post, connectClient, runner, deps, children } = await bootTestRunner();
    const client = await connectClient();
    const outputs = [];
    const completed = new Promise(resolve => client.once('agent:completed', resolve));
    client.on('agent:output', payload => outputs.push(payload));

    await post('/spawn', {
      agentId: 'a-stream-chunk',
      taskId: 't-stream-chunk',
      prompt: 'stream chunks',
      cliCommand: 'claude',
      cliArgs: ['--print', '--output-format', 'stream-json'],
    });

    const child = children[0];
    const line1 = `${JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'split line\n' } },
    })}\n`;
    const splitAt = Math.floor(line1.length / 2);
    child.stdout.emit('data', Buffer.from(line1.slice(0, splitAt)));
    child.stdout.emit('data', Buffer.from(line1.slice(splitAt)));

    // Exceed 512 KiB with ignored non-JSON filler to verify sliding-window cap.
    const filler = `${'x'.repeat(300 * 1024)}\n`;
    child.stdout.emit('data', Buffer.from(filler));
    child.stdout.emit('data', Buffer.from(filler));

    const tailLine = `${JSON.stringify({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'trailing without newline' } },
    })}\n`;
    child.stdout.emit('data', Buffer.from(tailLine));

    const agent = runner.activeAgents.get('a-stream-chunk');
    expect(agent.parser.rawStream().length).toBe(512 * 1024);
    expect(agent.parser.rawStream().endsWith(tailLine)).toBe(true);

    child.emit('close', 0);
    await completed;

    expect(outputs).toContainEqual({ agentId: 'a-stream-chunk', text: 'split line\n' });
    expect(outputs).toContainEqual({ agentId: 'a-stream-chunk', text: 'trailing without newline\n' });
    expect(deps.persistRunnerCompletion).toHaveBeenCalledWith(
      '/example/agents',
      'a-stream-chunk',
      'split line\ntrailing without newline\n',
      expect.objectContaining({ taskId: 't-stream-chunk', exitCode: 0, success: true }),
    );
  });

  it('formats Codex stderr by binary, hiding the config dump and echoed prompt, and flushes on close', async () => {
    const { post, connectClient, deps, children } = await bootTestRunner();
    const client = await connectClient();
    const completed = new Promise(resolve => client.once('agent:completed', resolve));

    await post('/spawn', {
      agentId: 'a-codex',
      taskId: 't-codex',
      prompt: 'fix bug',
      cliCommand: 'codex',
      cliArgs: ['exec'],
    });
    const feed = '\x1b[32mOpenAI Codex v0.125.0\x1b[0m\n--------\nworkdir: /repo\n--------\nuser\nfix bug\nERROR: boom\n--------\nERROR: tail';
    for (let i = 0; i < feed.length; i += 10) children[0].stderr.emit('data', Buffer.from(feed.slice(i, i + 10)));
    children[0].emit('close', 0);

    await completed;
    expect(deps.persistRunnerCompletion).toHaveBeenCalledWith(
      '/example/agents',
      'a-codex',
      'ERROR: boom\nERROR: tail\n',
      expect.objectContaining({ taskId: 't-codex', success: true }),
    );
  });

  it('stops a headless run on a usage-limit banner and reports it failed even though the child exits 0', async () => {
    const { post, connectClient, deps, children } = await bootTestRunner();
    const client = await connectClient();
    const completed = new Promise(resolve => client.once('agent:completed', resolve));

    await post('/spawn', {
      agentId: 'a-limit',
      taskId: 't-limit',
      prompt: 'work',
      cliCommand: 'opencode',
      cliArgs: ['run'],
    });
    // Split mid-banner: the detector buffers across chunks.
    children[0].stdout.emit('data', Buffer.from('working\nNow using ex'));
    children[0].stdout.emit('data', Buffer.from('tra usage\n'));
    expect(deps.killProcessTree).toHaveBeenCalledWith(children[0], 'SIGTERM');
    children[0].emit('close', 0);

    const completion = await completed;
    expect(completion).toMatchObject({
      agentId: 'a-limit', exitCode: 0, success: false,
      fallbackAnalysis: expect.objectContaining({ requiresFallback: true, category: expect.any(String) }),
    });
    expect(deps.persistRunnerCompletion).toHaveBeenCalledWith(
      '/example/agents', 'a-limit', expect.any(String),
      expect.objectContaining({ success: false, fallbackAnalysis: completion.fallbackAnalysis }),
    );
  });

  it('does not stop a codex run whose prompt quotes a usage-limit banner', async () => {
    const { post, connectClient, deps, children } = await bootTestRunner();
    const client = await connectClient();
    const completed = new Promise(resolve => client.once('agent:completed', resolve));
    const prompt = 'Investigate this.\nNow using extra usage\nThen report.';

    await post('/spawn', { agentId: 'a-echo', taskId: 't-echo', prompt, cliCommand: 'codex', cliArgs: ['exec'] });
    children[0].stderr.emit('data', Buffer.from(`--------\nworkdir: /repo\n--------\nuser\n${prompt}\n`));
    expect(deps.killProcessTree).not.toHaveBeenCalled();
    children[0].emit('close', 0);

    const completion = await completed;
    expect(completion).toMatchObject({ success: true });
    expect(completion).not.toHaveProperty('fallbackAnalysis');
  });

  it('carries the stream-json result as finalSummary, and the raw stream only for a failed run', async () => {
    const { post, connectClient, deps, children } = await bootTestRunner();
    const client = await connectClient();
    const result = `${JSON.stringify({ type: 'result', result: 'The summary.' })}\n`;

    const okCompleted = new Promise(resolve => client.once('agent:completed', resolve));
    await post('/spawn', { agentId: 'a-ok', taskId: 't-ok', prompt: 'p', cliCommand: 'claude', cliArgs: ['--output-format', 'stream-json'] });
    children[0].stdout.emit('data', Buffer.from(result.slice(0, 9)));
    children[0].stdout.emit('data', Buffer.from(result.slice(9)));
    children[0].emit('close', 0);
    const ok = await okCompleted;
    expect(ok).toMatchObject({ success: true, finalSummary: 'The summary.' });
    expect(ok).not.toHaveProperty('rawStreamTail');
    expect(ok).not.toHaveProperty('fallbackAnalysis');

    const failCompleted = new Promise(resolve => client.once('agent:completed', resolve));
    await post('/spawn', { agentId: 'a-fail', taskId: 't-fail', prompt: 'p', cliCommand: 'claude', cliArgs: ['--output-format', 'stream-json'] });
    children[1].stdout.emit('data', Buffer.from(result));
    children[1].emit('close', 1);
    const failed = await failCompleted;
    expect(failed).toMatchObject({ success: false, finalSummary: 'The summary.', rawStreamTail: result });
    expect(deps.persistRunnerCompletion).toHaveBeenCalledWith(
      '/example/agents', 'a-fail', 'The summary.',
      expect.objectContaining({ success: false, rawStreamTail: result }),
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

  it('handles POST /pause/:agentId 400/404, SIGKILL escalation, repeated-pause timer replacement, and throwing killProcessTree survival', async () => {
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    let throwOnSigkill = false;
    const { post, get, runner, deps, children } = await bootTestRunner({
      sigkillGraceMs: 40,
      killProcessTree: vi.fn((child, signal) => {
        if (throwOnSigkill && signal === 'SIGKILL') throw new Error('handle already disposed');
        child.kill(signal);
      }),
    });

    expect((await post('/pause/missing', {})).status).toBe(404);
    await post('/spawn', { agentId: 'a-pause', taskId: 't-pause', prompt: 'work', cliCommand: 'claude' });
    expect((await post('/pause/a-pause', { reason: 123 })).status).toBe(400);

    const firstPause = await post('/pause/a-pause', { reason: 'pause 1' });
    expect(firstPause.status).toBe(200);
    expect(firstPause.body).toMatchObject({ success: true, agentId: 'a-pause', pid: 1000, pausedAt: expect.any(String) });
    expect(deps.killProcessTree).toHaveBeenCalledWith(children[0], 'SIGTERM');
    const firstTimer = runner.activeAgents.get('a-pause').killTimer;
    expect(firstTimer).toBeTruthy();

    clearSpy.mockClear();
    const secondPause = await post('/pause/a-pause', { reason: 'pause 2' });
    expect(secondPause.status).toBe(200);
    expect(clearSpy).toHaveBeenCalledWith(firstTimer);
    expect(runner.activeAgents.get('a-pause').killTimer).not.toBe(firstTimer);

    await vi.waitFor(() => {
      expect(deps.killProcessTree).toHaveBeenCalledWith(children[0], 'SIGKILL');
    });
    // Wait long enough that a leaked first timer would have fired a second SIGKILL.
    await new Promise(resolve => setTimeout(resolve, 60));
    const sigkillCalls = deps.killProcessTree.mock.calls.filter(([c, sig]) => c === children[0] && sig === 'SIGKILL');
    expect(sigkillCalls).toHaveLength(1);
    expect(runner.activeAgents.has('a-pause')).toBe(true);

    // A throwing killProcessTree inside the pause timer must log and keep portos-cos alive.
    await post('/spawn', { agentId: 'a-pause-throw', taskId: 't-throw', prompt: 'work', cliCommand: 'claude' });
    throwOnSigkill = true;
    console.error.mockClear();
    expect((await post('/pause/a-pause-throw', {})).status).toBe(200);

    await vi.waitFor(() => {
      expect(console.error).toHaveBeenCalledWith('❌ Pause force kill failed for a-pause-throw: handle already disposed');
    });
    expect(runner.activeAgents.get('a-pause-throw').killTimer).toBeNull();
    expect((await get('/health')).status).toBe(200);
  });

  it('persists paused CLI output without metadata.json or agent:completed and preserves state.agents on close', async () => {
    const { post, runner, state, deps, children, connectClient } = await bootTestRunner({ sigkillGraceMs: 5000 });
    const client = await connectClient();
    const completed = [];
    client.on('agent:completed', payload => completed.push(payload));

    await post('/spawn', { agentId: 'a-pause-close', taskId: 't-pause-close', prompt: 'work', cliCommand: 'claude' });
    children[0].stdout.emit('data', Buffer.from('paused partial work\n'));
    await post('/pause/a-pause-close', { reason: 'user paused' });

    console.log.mockClear();
    console.error.mockClear();
    children[0].emit('close', 143);

    await vi.waitFor(() => expect(runner.activeAgents.has('a-pause-close')).toBe(false));
    expect(deps.persistRunnerCompletion).toHaveBeenCalledWith(
      '/example/agents',
      'a-pause-close',
      'paused partial work\n',
      null,
    );
    expect(completed).toEqual([]);
    expect(state.agents['a-pause-close']).toBeDefined();
    expect(state.stats.completed).toBe(0);
    expect(console.error).not.toHaveBeenCalled();
    expect(console.log).toHaveBeenCalledWith('⏸️ Agent a-pause-close exited with code 143 after pause');
  });

  it('handles POST /kill/:agentId 404, immediate SIGKILL, and removes both activeAgents and state.agents', async () => {
    const stop = vi.fn(async () => null);
    const { post, runner, state, deps, children } = await bootTestRunner({
      securityScans: {
        register: vi.fn(async () => {}),
        read: vi.fn(async () => null),
        start: vi.fn(async () => ({})),
        stop,
        recover: vi.fn(async () => {}),
      },
    });

    expect((await post('/kill/missing', {})).status).toBe(404);
    await post('/spawn', { agentId: 'a-kill', taskId: 't-kill', prompt: 'work', cliCommand: 'claude' });
    expect(state.agents['a-kill']).toBeDefined();

    const res = await post('/kill/a-kill', {});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, agentId: 'a-kill', pid: 1000, signal: 'SIGKILL' });
    expect(stop).toHaveBeenCalledWith('a-kill');
    expect(deps.killProcessTree).toHaveBeenCalledWith(children[0], 'SIGKILL');
    expect(runner.activeAgents.has('a-kill')).toBe(false);
    expect(state.agents['a-kill']).toBeUndefined();
  });

  it('covers POST /terminate/:agentId 400/404, onlyIfPromptUnsubmitted gating, and real force-kill escalation', async () => {
    const { post, runner, deps, ptyChildren, connectClient } = await bootTestRunner({
      armForceKill: undefined,
      sigkillGraceMs: 40,
    });

    expect((await post('/terminate/missing', {})).status).toBe(404);
    await post('/spawn', { agentId: 'a-cli', taskId: 't-cli', prompt: 'p', cliCommand: 'claude' });
    expect((await post('/terminate/a-cli', { onlyIfPromptUnsubmitted: 'nope' })).status).toBe(400);

    // Non-TUI agent is ignored when onlyIfPromptUnsubmitted is true.
    expect((await post('/terminate/a-cli', { onlyIfPromptUnsubmitted: true })).body).toEqual({
      success: true,
      agentId: 'a-cli',
      terminated: false,
    });
    expect(deps.killProcessTree).not.toHaveBeenCalled();

    // Submitted TUI is ignored when onlyIfPromptUnsubmitted is true.
    await post('/spawn-tui', { agentId: 'tui-sub', taskId: 't-sub', command: 'claude', trackPromptSubmission: true });
    const client = await connectClient();
    client.emit('tui:input', { sessionId: 'tui-sub', data: '\r', promptSubmission: true });
    await vi.waitFor(() => expect(runner.activeAgents.get('tui-sub').promptSubmitted).toBe(true));
    expect((await post('/terminate/tui-sub', { onlyIfPromptUnsubmitted: true })).body).toEqual({
      success: true,
      agentId: 'tui-sub',
      terminated: false,
    });

    // Unsubmitted TUI is terminated, flagged startupInterrupted, and force-killed after grace.
    await post('/spawn-tui', { agentId: 'tui-unsub', taskId: 't-unsub', command: 'claude', trackPromptSubmission: true });
    const termRes = await post('/terminate/tui-unsub', { onlyIfPromptUnsubmitted: true });
    expect(termRes.body).toEqual({ success: true, agentId: 'tui-unsub', terminated: true });
    expect(runner.activeAgents.get('tui-unsub').startupInterrupted).toBe(true);
    expect(deps.killProcessTree).toHaveBeenCalledWith(ptyChildren[1], 'SIGTERM');

    await vi.waitFor(() => {
      expect(ptyChildren[1].kill).toHaveBeenCalledWith('SIGKILL');
    });
    expect(runner.activeAgents.has('tui-unsub')).toBe(false);
  });

  it('arms independent per-agent SIGKILL escalation timers in POST /terminate-all', async () => {
    const { post, runner, children } = await bootTestRunner({
      armForceKill: undefined,
      sigkillGraceMs: 45,
    });

    await post('/spawn', { agentId: 'a-fast', taskId: 't-fast', prompt: 'p1', cliCommand: 'claude' });
    await post('/spawn', { agentId: 'a-stuck', taskId: 't-stuck', prompt: 'p2', cliCommand: 'claude' });

    const res = await post('/terminate-all', {});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true, killed: 2 });

    // First agent exits cleanly before grace expires; second agent ignores SIGTERM.
    children[0].emit('close', 0);
    await vi.waitFor(() => expect(runner.activeAgents.has('a-fast')).toBe(false));

    await vi.waitFor(() => {
      expect(children[1].kill).toHaveBeenCalledWith('SIGKILL');
    });
    expect(children[0].kill).not.toHaveBeenCalledWith('SIGKILL');
    expect(runner.activeAgents.has('a-stuck')).toBe(false);
  });

  it('enforces TUI_SIGNALS allowlist and non-TUI refusal on tui:kill and validates tui:resize', async () => {
    const { post, deps, ptyChildren, connectClient } = await bootTestRunner();
    await post('/spawn', { agentId: 'cli-1', taskId: 't1', prompt: 'p1', cliCommand: 'claude' });
    await post('/spawn-tui', { agentId: 'tui-1', taskId: 't2', command: 'claude' });
    const client = await connectClient();

    // Disallowed signal and non-TUI / unknown sessionIds are ignored.
    client.emit('tui:kill', { sessionId: 'tui-1', signal: 'SIGHUP' });
    client.emit('tui:kill', { sessionId: 'cli-1', signal: 'SIGTERM' });
    client.emit('tui:kill', { sessionId: 'unknown', signal: 'SIGTERM' });
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(deps.killProcessTree).not.toHaveBeenCalled();
    expect(deps.armForceKill).not.toHaveBeenCalled();

    // Valid TUI_SIGNALS entry (SIGINT) is relayed.
    client.emit('tui:kill', { sessionId: 'tui-1', signal: 'SIGINT' });
    await vi.waitFor(() => expect(deps.killProcessTree).toHaveBeenCalledWith(ptyChildren[0], 'SIGINT'));

    // tui:resize accepts positive integers for TUI agents and rejects invalid dimensions or non-TUI targets.
    client.emit('tui:resize', { sessionId: 'tui-1', cols: 120, rows: 40 });
    await vi.waitFor(() => expect(ptyChildren[0].resize).toHaveBeenCalledWith(120, 40));

    ptyChildren[0].resize.mockClear();
    for (const invalid of [
      { sessionId: 'tui-1', cols: 0, rows: 24 },
      { sessionId: 'tui-1', cols: 80, rows: -1 },
      { sessionId: 'tui-1', cols: 80.5, rows: 24 },
      { sessionId: 'tui-1', cols: 80, rows: '24' },
      { sessionId: 'cli-1', cols: 80, rows: 24 },
      { sessionId: 'missing', cols: 80, rows: 24 },
    ]) {
      client.emit('tui:resize', invalid);
    }
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(ptyChildren[0].resize).not.toHaveBeenCalled();
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
    const btwFile = join('/example/btw-workspace', 'BTW.md');
    expect(files.get(btwFile)).toContain('# Additional Context from User');
    expect(files.get(btwFile)).toContain(secretMessage);
    expect(await btwEvent).toMatchObject({ agentId: 'agent-btw', message: secretMessage });

    // Second write appends without duplicating the header and ignores any body workspacePath.
    const secondRes = await post('/btw/agent-btw', { message: 'follow-up note', workspacePath: '/attacker/override' });
    expect(secondRes.status).toBe(200);
    expect(secondRes.body.btwPath).toBe(btwFile);
    const updated = files.get(btwFile);
    expect(updated.match(/# Additional Context from User/g)).toHaveLength(1);
    expect(updated).toContain(secretMessage);
    expect(updated).toContain('follow-up note');

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
  it('reaps dead PIDs, preserves running PIDs, recovers granted security scans only, and emits single agents:orphaned batch', async () => {
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
    state.agents['dead-1'] = { pid: 111, taskId: 'task-dead-1', securityScanGrant: { id: 'g1' } };
    state.agents['dead-2'] = { pid: 333, taskId: 'task-dead-2' };
    state.agents['alive-1'] = { pid: 222, taskId: 'task-alive' };

    const client = await connectClient();
    const orphanedEvents = [];
    client.on('agents:orphaned', payload => orphanedEvents.push(payload));

    const orphaned = await runner.cleanupOrphanedAgents();
    expect(orphaned).toEqual([
      { agentId: 'dead-1', taskId: 'task-dead-1' },
      { agentId: 'dead-2', taskId: 'task-dead-2' },
    ]);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(recover).toHaveBeenCalledWith('dead-1');
    expect(state.agents).toEqual({ 'alive-1': { pid: 222, taskId: 'task-alive' } });

    await vi.waitFor(() => expect(orphanedEvents).toHaveLength(1));
    expect(orphanedEvents[0]).toMatchObject({
      count: 2,
      agents: [
        expect.objectContaining({ agentId: 'dead-1', taskId: 'task-dead-1', orphaned: true, exitCode: -1, success: false }),
        expect.objectContaining({ agentId: 'dead-2', taskId: 'task-dead-2', orphaned: true, exitCode: -1, success: false }),
      ],
    });
  });

  it('does not emit agents:orphaned or prune state when all persisted PIDs are alive', async () => {
    const { runner, state, connectClient } = await bootTestRunner({
      checkProcessRunning: vi.fn(async () => true),
    });
    state.agents['alive-1'] = { pid: 222, taskId: 'task-alive-1' };
    state.agents['alive-2'] = { pid: 444, taskId: 'task-alive-2' };

    const client = await connectClient();
    const orphanedEvents = [];
    client.on('agents:orphaned', payload => orphanedEvents.push(payload));

    const orphaned = await runner.cleanupOrphanedAgents();
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(orphaned).toEqual([]);
    expect(orphanedEvents).toEqual([]);
    expect(state.agents).toEqual({
      'alive-1': { pid: 222, taskId: 'task-alive-1' },
      'alive-2': { pid: 444, taskId: 'task-alive-2' },
    });
  });
});

describe('cos-runner /agents/:agentId stats, output, and security-scan routes', () => {
  it('returns stats and output for active agents and 404 for unknown agents', async () => {
    const { post, get, deps, children } = await bootTestRunner({
      getProcessStats: vi.fn(async () => ({ active: true, cpu: 1.5, memoryKb: 2048, memoryMb: 2, state: 'S' })),
      pty: {
        spawn: vi.fn(() => makeFakeChild(0)),
      },
    });

    expect((await get('/agents/missing/stats')).status).toBe(404);
    expect((await get('/agents/missing/output')).status).toBe(404);

    await post('/spawn', { agentId: 'a-stats', taskId: 't-stats', prompt: 'hi', cliCommand: 'opencode' });
    children[0].stdout.emit('data', Buffer.from('stats output\n'));

    const stats = await get('/agents/a-stats/stats');
    expect(stats.status).toBe(200);
    expect(stats.body).toEqual({
      agentId: 'a-stats',
      pid: 1000,
      active: true,
      cpu: 1.5,
      memoryKb: 2048,
      memoryMb: 2,
      state: 'S',
      liveness: 'pid',
    });

    const out = await get('/agents/a-stats/output');
    expect(out.status).toBe(200);
    expect(out.body).toEqual({ agentId: 'a-stats', output: 'stats output\n' });

    // Pid 0 TUI agent reports memoryKb: 0 without invoking getProcessStats.
    deps.getProcessStats.mockClear();
    await post('/spawn-tui', { agentId: 'tui-pid0', taskId: 't-pid0', command: 'claude' });
    const tuiStats = await get('/agents/tui-pid0/stats');
    expect(tuiStats.status).toBe(200);
    expect(tuiStats.body).toMatchObject({ agentId: 'tui-pid0', pid: 0, memoryKb: 0, active: true, liveness: 'pty' });
    expect(deps.getProcessStats).not.toHaveBeenCalled();
  });

  it('validates /agents/:agentId/security-scan* routes, enforces admission, and maps err.status', async () => {
    const start = vi.fn();
    const stop = vi.fn();
    const read = vi.fn();
    let admissionError = null;
    let releaseDrain;
    const drainHold = new Promise(resolve => { releaseDrain = resolve; });

    const { post, get, runner } = await bootTestRunner({
      exit: vi.fn(),
      shutdownDeadlineMs: 2000,
      drainState: vi.fn(() => drainHold),
      assertDatabaseAdmission: vi.fn(() => { if (admissionError) throw admissionError; }),
      securityScans: { register: vi.fn(async () => {}), start, stop, read, recover: vi.fn(async () => {}) },
    });

    // Schema 400 on POST /security-scan
    const badSchema = await post('/agents/a1/security-scan', { prompt: '', paths: [] });
    expect(badSchema.status).toBe(400);
    expect(badSchema.body.error).toContain('Invalid request body');
    expect(start).not.toHaveBeenCalled();

    // Database admission failure maps err.status (503)
    admissionError = Object.assign(new Error('Database maintenance active'), { status: 503 });
    const blocked = await post('/agents/a1/security-scan', { prompt: 'audit diff', paths: ['server'] });
    expect(blocked.status).toBe(503);
    expect(blocked.body).toEqual({ error: 'Database maintenance active' });
    expect(start).not.toHaveBeenCalled();
    admissionError = null;

    // Success and err.status / 500 fallback across start, stop, and read
    start.mockResolvedValueOnce({ evidence: { status: 'completed' }, artifactDirectory: null });
    const okStart = await post('/agents/a1/security-scan', { prompt: 'audit diff', paths: ['server'] });
    expect(okStart.status).toBe(200);
    expect(okStart.body).toEqual({ evidence: { status: 'completed' }, artifactDirectory: null });
    expect(start).toHaveBeenCalledWith('a1', { prompt: 'audit diff', paths: ['server'], knowledgeBase: [] });

    start.mockRejectedValueOnce(Object.assign(new Error('No active grant'), { status: 409 }));
    expect(await post('/agents/a1/security-scan', { prompt: 'audit', paths: ['server'] })).toEqual({
      status: 409,
      body: { error: 'No active grant' },
    });

    start.mockRejectedValueOnce(new Error('unexpected failure'));
    expect(await post('/agents/a1/security-scan', { prompt: 'audit', paths: ['server'] })).toEqual({
      status: 500,
      body: { error: 'unexpected failure' },
    });

    stop.mockResolvedValueOnce({ status: 'interrupted' });
    expect(await post('/agents/a1/security-scan/stop', {})).toEqual({
      status: 200,
      body: { evidence: { status: 'interrupted' } },
    });
    stop.mockRejectedValueOnce(Object.assign(new Error('Invalid agent id'), { status: 400 }));
    expect(await post('/agents/bad/security-scan/stop', {})).toEqual({
      status: 400,
      body: { error: 'Invalid agent id' },
    });

    read.mockResolvedValueOnce({ status: 'not-run' });
    expect(await get('/agents/a1/security-scan')).toEqual({
      status: 200,
      body: { evidence: { status: 'not-run' } },
    });
    read.mockRejectedValueOnce(Object.assign(new Error('Invalid agent id'), { status: 400 }));
    expect(await get('/agents/bad/security-scan')).toEqual({
      status: 400,
      body: { error: 'Invalid agent id' },
    });

    // Shutdown 503 on POST /security-scan via an in-flight chunked request entering express.json before shutdown()
    const addr = runner.server.address();
    const shutdownPromise = new Promise((resolve, reject) => {
      const payload = JSON.stringify({ prompt: 'audit', paths: ['server'] });
      const req = httpRequest(`http://127.0.0.1:${addr.port}/agents/a1/security-scan`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) },
      }, (res) => {
        let text = '';
        res.on('data', chunk => { text += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
      });
      req.on('error', reject);
      req.write(payload.slice(0, 5));
      setTimeout(() => {
        void runner.lifecycle.shutdown();
        req.end(payload.slice(5));
      }, 20);
    });
    const shutdownRes = await shutdownPromise;
    releaseDrain();
    expect(shutdownRes).toEqual({
      status: 503,
      body: { error: 'Runner is shutting down', code: 'SHUTTING_DOWN' },
    });
  });
});
