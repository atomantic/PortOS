/**
 * The ACP adapter end to end: real stdio framing in-process (and one real
 * spawn), real HTTP against a fake PortOS that speaks the same SSE routes the
 * server does. Nothing here touches the live install: the URL, credential and
 * session index all come from the per-test env.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseCliArgs, serve } from './portos-acp.js';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'portos-acp.js');
const TOKEN = 'test-token';

const sse = (res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write(': open\n\n');
};
const frame = (res, event, data) => res.write(`${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`);
const readJson = (req) => new Promise((resolve) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null));
});

/** A fake PortOS: auth gate, Ask Yourself SSE, the mind stream and message queue. */
const startFakePortos = async () => {
  const state = {
    authRequired: true,
    askBodies: [],
    askHold: false,
    askClosed: false,
    askConversations: new Map(),
    mindMessages: [],
    mindSubscribers: new Set(),
    mindEvents: [],
    requests: [],
  };
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    state.requests.push(`${req.method} ${url.pathname}`);
    const authorized = !state.authRequired || req.headers.authorization === `Bearer ${TOKEN}`;
    if (url.pathname === '/api/system/health') return res.end('{"ok":true}');
    if (url.pathname === '/api/auth/whoami') return res.end(JSON.stringify({ required: state.authRequired, authenticated: authorized }));
    if (!authorized) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end('{"error":"Authentication required","code":"AUTH_REQUIRED"}');
    }
    if (req.method === 'POST' && url.pathname === '/api/ask') {
      const body = await readJson(req);
      state.askBodies.push(body);
      const conversationId = body.conversationId || `ask_${state.askBodies.length}`;
      const turns = state.askConversations.get(conversationId) || [];
      turns.push({ role: 'user', content: body.question });
      state.askConversations.set(conversationId, turns);
      sse(res);
      frame(res, 'open', { conversationId, mode: body.mode });
      frame(res, 'sources', { sources: [{ kind: 'goal', title: 'Ship it' }] });
      frame(res, 'delta', { text: 'Hello ' });
      if (state.askHold) {
        res.on('close', () => { state.askClosed = true; });
        return undefined;
      }
      frame(res, 'delta', { text: 'there.' });
      turns.push({ role: 'assistant', content: 'Hello there.' });
      frame(res, 'done', { conversationId });
      return res.end();
    }
    const conversation = url.pathname.match(/^\/api\/ask\/([^/]+)$/);
    if (req.method === 'GET' && conversation) {
      const turns = state.askConversations.get(conversation[1]);
      if (!turns) {
        res.writeHead(404);
        return res.end('{"error":"Conversation not found"}');
      }
      return res.end(JSON.stringify({ conversation: { id: conversation[1], turns } }));
    }
    if (req.method === 'GET' && url.pathname === '/api/cos/mind/stream') {
      sse(res);
      state.mindSubscribers.add(res);
      res.on('close', () => state.mindSubscribers.delete(res));
      return undefined;
    }
    if (req.method === 'POST' && url.pathname === '/api/cos/mind/messages') {
      const body = await readJson(req);
      state.mindMessages.push(body);
      res.writeHead(202);
      res.end(JSON.stringify({ success: true, duplicate: false, messageId: body.id }));
      const emit = (event) => {
        state.mindEvents.push(event);
        for (const subscriber of state.mindSubscribers) frame(subscriber, null, event);
      };
      // Another turn's traffic interleaves; only the wake for our message binds.
      emit({ kind: 'mind.message.accepted', turnId: null, data: { messageId: body.id, displayText: body.text } });
      emit({ kind: 'mind.reply', turnId: 'turn-other', data: { displayText: 'unrelated', replyToMessageId: 'x' } });
      emit({ kind: 'mind.wake', turnId: 'turn-1', data: { messageId: body.id } });
      emit({ kind: 'mind.thought', turnId: 'turn-1', data: { displayText: 'Looking at the queue' } });
      emit({ kind: 'mind.capability.request', turnId: 'turn-1', data: { capabilityId: 'tool-request:r1', tool: 'cos.list-tasks', displayText: 'Requested PortOS tool cos.list-tasks' } });
      emit({ kind: 'mind.capability.result', turnId: 'turn-1', data: { capabilityId: 'tool-result:r1', tool: 'cos.list-tasks', success: true, displayText: 'cos.list-tasks completed' } });
      emit({ kind: 'mind.reply', turnId: 'turn-1', data: { displayText: 'Three tasks are open.', replyToMessageId: body.id } });
      emit({ kind: 'mind.turn.completed', turnId: 'turn-1', data: { status: 'idle' } });
      return undefined;
    }
    if (req.method === 'GET' && url.pathname === '/api/cos/mind') {
      return res.end(JSON.stringify({ events: state.mindEvents }));
    }
    res.writeHead(404);
    return res.end('{"error":"no route"}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  return {
    state,
    url,
    close: () => new Promise((resolve) => {
      for (const subscriber of state.mindSubscribers) subscriber.destroy();
      server.closeAllConnections?.();
      server.close(resolve);
    }),
  };
};

/** Drive `serve` over in-memory pipes and collect every stdout line. */
const startAdapter = (env, { mode } = {}) => {
  const input = new PassThrough();
  const output = new PassThrough();
  const stdoutLines = [];
  const stderrLines = [];
  const waiters = [];
  let buffer = '';
  output.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      stdoutLines.push(line);
      const message = JSON.parse(line);
      for (const waiter of [...waiters]) {
        if (waiter.match(message)) {
          waiters.splice(waiters.indexOf(waiter), 1);
          waiter.resolve(message);
        }
      }
      newline = buffer.indexOf('\n');
    }
  });
  const exited = serve({ input, output, env, mode, log: (line) => stderrLines.push(line) });
  const waitFor = (match) => new Promise((resolve) => {
    const seen = stdoutLines.map((line) => JSON.parse(line)).find(match);
    if (seen) resolve(seen);
    else waiters.push({ match, resolve });
  });
  let nextId = 0;
  const request = (method, params = {}) => {
    nextId += 1;
    const id = nextId;
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return waitFor((message) => message.id === id && !message.method);
  };
  const notify = (method, params) => input.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  const updates = (sessionId) => stdoutLines.map((line) => JSON.parse(line))
    .filter((message) => message.method === 'session/update' && message.params.sessionId === sessionId)
    .map((message) => message.params.update);
  const stop = async () => {
    input.end();
    return exited;
  };
  return { input, request, notify, waitFor, updates, stdoutLines, stderrLines, stop };
};

let fake;
let dir;
let env;
let adapter;

beforeEach(async () => {
  fake = await startFakePortos();
  dir = await mkdtemp(join(tmpdir(), 'portos-acp-'));
  env = {
    PORTOS_URL: fake.url,
    PORTOS_API_TOKEN: TOKEN,
    PORTOS_AGENT_KEY_FILE: join(dir, 'no-agent-key.json'),
    PORTOS_ACP_SESSIONS_FILE: join(dir, 'acp-sessions.json'),
  };
});

afterEach(async () => {
  await adapter?.stop();
  adapter = null;
  await fake.close();
  await rm(dir, { recursive: true, force: true });
});

const readIndex = async () => JSON.parse(await readFile(env.PORTOS_ACP_SESSIONS_FILE, 'utf8')).sessions;

describe('portos-acp ask mode', () => {
  it('initializes and opens a session with no PortOS call and nothing persisted', async () => {
    adapter = startAdapter(env);
    const init = await adapter.request('initialize', { protocolVersion: 1, clientCapabilities: {} });
    expect(init.result).toMatchObject({ protocolVersion: 1, authMethods: [], agentCapabilities: { loadSession: true } });
    const created = await adapter.request('session/new', { cwd: '/work/project', mcpServers: [] });
    expect(created.result.sessionId).toMatch(/^portos-/);
    expect(created.result.modes.currentModeId).toBe('ask');
    expect(created.result.configOptions[0]).toMatchObject({ id: 'mode', currentValue: 'ask' });
    expect(fake.state.requests).toEqual([]);
    expect(existsSync(env.PORTOS_ACP_SESSIONS_FILE)).toBe(false);
  });

  it('streams a prompt as session/update chunks, keeping stdout pure JSON-RPC', async () => {
    adapter = startAdapter(env);
    const { result: { sessionId } } = await adapter.request('session/new', { cwd: '/work/project', mcpServers: [] });
    const reply = await adapter.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'How is my week?' }] });
    expect(reply.result).toEqual({ stopReason: 'end_turn' });
    expect(fake.state.askBodies).toEqual([{ question: 'How is my week?', mode: 'ask' }]);
    const updates = adapter.updates(sessionId);
    expect(updates.map((update) => update.sessionUpdate)).toEqual(['tool_call', 'agent_message_chunk', 'agent_message_chunk']);
    expect(updates.filter((u) => u.sessionUpdate === 'agent_message_chunk').map((u) => u.content.text).join('')).toBe('Hello there.');
    for (const line of adapter.stdoutLines) expect(JSON.parse(line).jsonrpc).toBe('2.0');

    expect(await readIndex()).toEqual([expect.objectContaining({ sessionId, mode: 'ask', cwd: '/work/project', conversationId: 'ask_1', title: 'How is my week?' })]);

    await adapter.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'And next week?' }] });
    expect(fake.state.askBodies[1]).toEqual({ question: 'And next week?', mode: 'ask', conversationId: 'ask_1' });
  });

  it('session/cancel aborts the upstream stream and the prompt ends cancelled', async () => {
    fake.state.askHold = true;
    adapter = startAdapter(env);
    const { result: { sessionId } } = await adapter.request('session/new', { cwd: '/w', mcpServers: [] });
    const pending = adapter.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Long answer please' }] });
    await adapter.waitFor((message) => message.params?.update?.sessionUpdate === 'agent_message_chunk');
    adapter.notify('session/cancel', { sessionId });
    expect((await pending).result).toEqual({ stopReason: 'cancelled' });
    await expect.poll(() => fake.state.askClosed).toBe(true);
    // The server kept the question, so the session is still reachable later.
    expect(await readIndex()).toEqual([expect.objectContaining({ sessionId, conversationId: 'ask_1' })]);
  });

  it('refuses with the ACP auth error when PortOS rejects the credential', async () => {
    adapter = startAdapter({ ...env, PORTOS_API_TOKEN: 'wrong' });
    const { result: { sessionId } } = await adapter.request('session/new', { cwd: '/w', mcpServers: [] });
    const reply = await adapter.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] });
    expect(reply.error).toMatchObject({ code: -32000, data: { status: 401 } });
    expect(reply.error.message).toContain('PORTOS_API_TOKEN');
    expect(fake.state.askBodies).toEqual([]);
    expect(existsSync(env.PORTOS_ACP_SESSIONS_FILE)).toBe(false);
  });

  it('lists sessions by cwd and replays a loaded session in a fresh adapter', async () => {
    adapter = startAdapter(env);
    const { result: { sessionId } } = await adapter.request('session/new', { cwd: '/work/a', mcpServers: [] });
    await adapter.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Remember the roof' }] });
    await adapter.stop();

    adapter = startAdapter(env);
    expect((await adapter.request('session/list', { cwd: '/work/b' })).result).toEqual({ sessions: [] });
    const listed = await adapter.request('session/list', { cwd: '/work/a' });
    expect(listed.result.sessions).toEqual([expect.objectContaining({ sessionId, cwd: '/work/a', title: 'Remember the roof' })]);
    const loaded = await adapter.request('session/load', { sessionId, cwd: '/work/a', mcpServers: [] });
    expect(loaded.result.modes.currentModeId).toBe('ask');
    expect(adapter.updates(sessionId).map((u) => [u.sessionUpdate, u.content.text])).toEqual([
      ['user_message_chunk', 'Remember the roof'],
      ['agent_message_chunk', 'Hello there.'],
    ]);
    expect((await adapter.request('session/load', { sessionId: 'portos-missing', cwd: '/w', mcpServers: [] })).error.code).toBe(-32002);
  });

  it('pins the mode once a session has a conversation', async () => {
    adapter = startAdapter(env);
    const { result: { sessionId } } = await adapter.request('session/new', { cwd: '/w', mcpServers: [] });
    await adapter.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hi' }] });
    const refused = await adapter.request('session/set_config_option', { sessionId, configId: 'mode', value: 'mind' });
    expect(refused.error.code).toBe(-32602);
  });

  it('answers malformed lines and unknown methods with JSON-RPC errors', async () => {
    adapter = startAdapter(env);
    adapter.input.write('{oops\n');
    expect((await adapter.waitFor((message) => message.error?.code === -32700)).id).toBeNull();
    expect((await adapter.request('session/fork', {})).error.code).toBe(-32601);
    const { result: { sessionId } } = await adapter.request('session/new', { cwd: '/w', mcpServers: [] });
    const image = await adapter.request('session/prompt', { sessionId, prompt: [{ type: 'image', data: 'x', mimeType: 'image/png' }] });
    expect(image.error).toMatchObject({ code: -32602 });
  });
});

describe('portos-acp mind mode', () => {
  it('queues the message and streams only its own turn back', async () => {
    adapter = startAdapter(env);
    const { result: { sessionId } } = await adapter.request('session/new', { cwd: '/w', mcpServers: [] });
    const switched = await adapter.request('session/set_config_option', { sessionId, configId: 'mode', value: 'mind' });
    expect(switched.result.configOptions[0].currentValue).toBe('mind');
    const reply = await adapter.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'What is open?' }] });
    expect(reply.result).toEqual({ stopReason: 'end_turn' });
    expect(fake.state.mindMessages).toEqual([{ id: expect.stringMatching(/^acp-/), text: 'What is open?' }]);
    const updates = adapter.updates(sessionId);
    expect(updates.filter((u) => u.sessionUpdate === 'agent_message_chunk').map((u) => u.content.text)).toEqual(['Three tasks are open.']);
    expect(updates.find((u) => u.sessionUpdate === 'tool_call')).toMatchObject({ toolCallId: 'r1', status: 'in_progress' });
    expect(updates.find((u) => u.sessionUpdate === 'tool_call_update')).toMatchObject({ toolCallId: 'r1', status: 'completed' });
    expect(updates.some((u) => u.sessionUpdate === 'agent_thought_chunk' && u.content.text.includes('Looking at the queue'))).toBe(true);
    // The subscription closes with the turn.
    await expect.poll(() => fake.state.mindSubscribers.size).toBe(0);

    const [record] = await readIndex();
    expect(record).toMatchObject({ sessionId, mode: 'mind', messageIds: [fake.state.mindMessages[0].id] });
    await adapter.stop();
    adapter = startAdapter(env);
    await adapter.request('session/load', { sessionId, cwd: '/w', mcpServers: [] });
    expect(adapter.updates(sessionId).map((u) => u.content.text)).toEqual(['What is open?', 'Three tasks are open.']);
  });

  it('starts new sessions in the --mode default', async () => {
    adapter = startAdapter(env, { mode: 'mind' });
    expect((await adapter.request('session/new', { cwd: '/w', mcpServers: [] })).result.modes.currentModeId).toBe('mind');
  });
});

describe('portos-acp CLI', () => {
  const run = (args, childEnv, stdin = '') => new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { env: { PATH: process.env.PATH, ...childEnv }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });

  it('parses its flags', () => {
    expect(parseCliArgs([])).toEqual({ command: 'serve', mode: 'ask' });
    expect(parseCliArgs(['--mode', 'mind'])).toEqual({ command: 'serve', mode: 'mind' });
    expect(parseCliArgs(['--mode=ask', '--check'])).toEqual({ command: 'check', mode: 'ask' });
    expect(() => parseCliArgs(['--mode', 'shell'])).toThrow(/--mode must be one of/);
    expect(() => parseCliArgs(['--nope'])).toThrow(/Unknown argument/);
  });

  it('--check passes against a reachable, authorized PortOS and reports on stderr only', async () => {
    const result = await run(['--check'], env);
    expect(result).toMatchObject({ code: 0, stdout: '' });
    expect(result.stderr).toContain('reachable');
  });

  it('--check fails clearly when unauthorized or unreachable', async () => {
    const unauthorized = await run(['--check'], { ...env, PORTOS_API_TOKEN: '' });
    expect(unauthorized.code).toBe(1);
    expect(unauthorized.stderr).toContain('requires authentication');
    const unreachable = await run(['--check'], { ...env, PORTOS_URL: 'http://127.0.0.1:9' });
    expect(unreachable.code).toBe(1);
    expect(unreachable.stderr).toContain('not reachable');
    expect(unreachable.stdout).toBe('');
  });

  it('serves ACP over real stdio with nothing but protocol lines on stdout', async () => {
    const result = await run([], env, `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1 } })}\n`);
    expect(result.code).toBe(0);
    const lines = result.stdout.trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ id: 1, result: { protocolVersion: 1 } });
  });

  it('--version prints the adapter version', async () => {
    const result = await run(['--version'], env);
    expect(result.code).toBe(0);
    expect(result.stdout).toMatch(/^portos-acp \d+\.\d+\.\d+/);
  });
});
