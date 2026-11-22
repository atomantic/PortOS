#!/usr/bin/env node
/**
 * portos-acp — an Agent Client Protocol (ACP) stdio adapter that lets ACP
 * editors (Zed, VS Code, JetBrains, Neovim) talk to this machine's PortOS:
 * Ask Yourself (`--mode ask`, the default) or the resident Persistent Mind
 * (`--mode mind`). Setup and editor snippets: docs/ACP.md.
 *
 *   node scripts/portos-acp.js                 # serve ACP on stdin/stdout
 *   node scripts/portos-acp.js --mode mind     # new sessions start in mind mode
 *   node scripts/portos-acp.js --check         # is PortOS reachable and are we authorized?
 *   node scripts/portos-acp.js --version
 *
 * The adapter is a thin client of the running server. It holds no provider
 * keys and runs no model itself: every answer, tool call and capability check
 * happens inside PortOS under the user's existing settings. It reaches PortOS
 * over loopback with the same credential resolution as `portos-api.js`
 * (`PORTOS_API_TOKEN`, else the Agent API key file; `PORTOS_URL` overrides
 * the base URL), so it widens no authority.
 *
 * Invariants:
 * - stdout carries ACP JSON-RPC lines and nothing else; every diagnostic goes
 *   to stderr (console.log is redirected there while serving).
 * - `initialize`, `session/new`, `--check` and `--version` make no model call,
 *   and `session/new` writes nothing: a session record is saved only once its
 *   first prompt reaches PortOS, so an editor probing for capabilities leaves
 *   no empty conversation behind.
 * - `session/cancel` aborts the upstream request. In ask mode the server stops
 *   the provider when the stream closes; in mind mode the adapter stops
 *   waiting, but the resident mind finishes the turn it already took (it is
 *   one shared mind, not a per-editor process).
 *
 * Session records (`~/.portos/acp-sessions.json`, or `$PORTOS_ACP_SESSIONS_FILE`)
 * map an ACP session id to its mode, editor cwd and PortOS conversation so
 * `session/list` and `session/load` work across editor restarts. They hold no
 * message text: history is replayed from PortOS itself.
 *
 * Builtins only, so an editor can launch it from any checkout without `npm install`.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { resolveCredentials } from './portos-api.js';
import { isDirectlyInvoked } from './lib/directInvocation.js';
import {
  ACP_MODE_IDS,
  DEFAULT_ACP_MODE,
  JSON_RPC_ERRORS,
  MAX_ACP_SESSION_MESSAGE_IDS,
  agentThoughtChunk,
  askConversationUpdates,
  buildConfigOptions,
  buildInitializeResult,
  buildSessionModePayload,
  createLineDecoder,
  createSseParser,
  encodeAcpMessage,
  isAcpMode,
  listSessionPage,
  mindHistoryUpdates,
  normalizeSessionRecords,
  parseAcpLine,
  promptToText,
  rpcError,
  rpcResult,
  sessionTitle,
  sessionUpdate,
  translateAskEvent,
  translateMindEvent,
  upsertSessionRecord,
} from '../server/lib/acp/acpProtocol.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export const ACP_SESSIONS_FILE_ENV = 'PORTOS_ACP_SESSIONS_FILE';
// The newest trajectory page GET /api/cos/mind serves; a mind session replays
// the exchanges still inside it.
const MIND_HISTORY_PAGE = 500;

export const USAGE = `Usage:
  portos-acp [--mode ask|mind]   serve the Agent Client Protocol on stdin/stdout
  portos-acp --check             verify PortOS is reachable and this credential is accepted
  portos-acp --version

Modes: ask = Ask Yourself (read-only Digital Twin answers); mind = the resident Persistent Mind.
Credentials and URL resolve like portos-api: PORTOS_API_TOKEN, else the Agent API key file; PORTOS_URL overrides.
Setup and editor snippets: docs/ACP.md`;

/** argv (after `node script`) → `{ command: 'serve'|'check'|'version'|'help', mode }`. Throws on anything it cannot read. */
export const parseCliArgs = (argv) => {
  let command = 'serve';
  let mode = DEFAULT_ACP_MODE;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--version' || arg === '-v') command = 'version';
    else if (arg === '--check') command = 'check';
    else if (arg === '--help' || arg === '-h') command = 'help';
    else if (arg === '--mode' || arg.startsWith('--mode=')) {
      const value = arg === '--mode' ? argv[++i] : arg.slice('--mode='.length);
      if (!isAcpMode(value)) throw new Error(`--mode must be one of ${ACP_MODE_IDS.join(', ')}`);
      mode = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return { command, mode };
};

export const readAdapterVersion = async () => {
  const pkg = await readFile(join(ROOT, 'package.json'), 'utf8').then(JSON.parse).catch(() => null);
  return typeof pkg?.version === 'string' ? pkg.version : '0.0.0';
};

// ---------------------------------------------------------------------------
// Session record store
// ---------------------------------------------------------------------------

export const resolveSessionsFile = (env = process.env) => env[ACP_SESSIONS_FILE_ENV] || join(homedir(), '.portos', 'acp-sessions.json');

/**
 * The on-disk session index. Writes are serialized in-process and land by
 * rename, so a crash leaves the previous file intact. Two editors running two
 * adapters can still interleave a read-modify-write and drop one record; that
 * costs only a `session/list` entry, never a PortOS conversation.
 */
export const createSessionStore = (file, { log = () => {} } = {}) => {
  let tail = Promise.resolve();
  const read = async () => {
    const raw = await readFile(file, 'utf8').catch((error) => (error.code === 'ENOENT' ? null : Promise.reject(error)));
    if (raw === null) return [];
    try {
      return normalizeSessionRecords(JSON.parse(raw));
    } catch (error) {
      log(`⚠️ Ignoring unreadable ACP session index ${file}: ${error.message}`);
      return [];
    }
  };
  const save = (record) => {
    const run = tail.then(async () => {
      const records = upsertSessionRecord(await read(), record);
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const temp = `${file}.${process.pid}.tmp`;
      await writeFile(temp, `${JSON.stringify({ version: 1, sessions: records }, null, 2)}\n`, { mode: 0o600 });
      await rename(temp, file);
    });
    tail = run.catch(() => {});
    return run;
  };
  return {
    list: read,
    get: async (sessionId) => (await read()).find((record) => record.sessionId === sessionId) || null,
    save,
  };
};

// ---------------------------------------------------------------------------
// PortOS HTTP client
// ---------------------------------------------------------------------------

const httpError = (method, path, status, body) => {
  let data = null;
  try { data = JSON.parse(body); } catch { /* not JSON */ }
  const detail = typeof data?.error === 'string' ? data.error : (typeof data?.message === 'string' ? data.message : body.trim());
  const error = new Error(`PortOS ${method} ${path} returned ${status}${detail ? `: ${detail}` : ''}`);
  error.status = status;
  error.code = typeof data?.code === 'string' ? data.code : undefined;
  return error;
};

const readText = (response) => new Promise((resolve, reject) => {
  const chunks = [];
  response.on('data', (chunk) => chunks.push(chunk));
  response.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  response.on('error', reject);
});

/** A loopback client for the PortOS routes the adapter uses: buffered JSON calls and SSE streams, both abortable. */
export const createPortosClient = ({ url, token }) => {
  const base = url.replace(/\/+$/, '');
  const open = ({ method, path, body, signal, accept = 'application/json' }) => new Promise((resolve, reject) => {
    const target = new URL(`${base}${path}`);
    if (!['http:', 'https:'].includes(target.protocol)) {
      reject(new Error('PORTOS_URL must use HTTP or HTTPS'));
      return;
    }
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = { Accept: accept };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (payload !== null) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(payload);
    }
    const request = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, { method, headers, signal }, resolve);
    request.on('error', reject);
    request.end(payload ?? undefined);
  });

  const json = async (method, path, { body, signal } = {}) => {
    const response = await open({ method, path, body, signal });
    const text = await readText(response);
    if (response.statusCode < 200 || response.statusCode >= 300) throw httpError(method, path, response.statusCode, text);
    return text ? JSON.parse(text) : null;
  };

  /**
   * Open an SSE stream. Resolves once the response headers arrive (the
   * subscription is live) with `done`, which settles when the stream ends:
   * resolved on a clean end, rejected on an abort or a dropped connection.
   */
  const stream = async ({ method, path, body, signal, onEvent }) => {
    const response = await open({ method, path, body, signal, accept: 'text/event-stream' });
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw httpError(method, path, response.statusCode, await readText(response));
    }
    const parser = createSseParser(onEvent);
    const done = new Promise((resolve, reject) => {
      let ended = false;
      response.on('data', (chunk) => parser.push(chunk));
      response.on('end', () => {
        ended = true;
        parser.end();
        resolve();
      });
      response.on('error', reject);
      response.on('close', () => {
        if (!ended) reject(signal?.aborted ? new Error('aborted') : new Error(`PortOS closed ${path} mid-stream`));
      });
    });
    return { done };
  };

  return { url: base, json, stream };
};

// ---------------------------------------------------------------------------
// ACP agent
// ---------------------------------------------------------------------------

const acpError = (code, message, data) => Object.assign(new Error(message), { rpcCode: code, rpcData: data });

const authHint = (credentialSource) => (credentialSource
  ? `PortOS rejected the ${credentialSource} credential. Refresh it (Settings > Security > Agent API key) or check PORTOS_URL.`
  : 'PortOS requires authentication. Turn on Settings > Security > Agent API key, or set PORTOS_API_TOKEN.');

/** Map a thrown error onto a JSON-RPC error response. */
const toRpcError = (id, error, { url, credentialSource }) => {
  if (Number.isInteger(error?.rpcCode)) return rpcError(id, error.rpcCode, error.message, error.rpcData);
  if (error?.status === 401) return rpcError(id, JSON_RPC_ERRORS.AUTH_REQUIRED, authHint(credentialSource), { status: 401 });
  if (Number.isInteger(error?.status)) {
    return rpcError(id, JSON_RPC_ERRORS.INTERNAL_ERROR, error.message, { status: error.status, ...(error.code ? { code: error.code } : {}) });
  }
  if (['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EHOSTUNREACH'].includes(error?.code)) {
    return rpcError(id, JSON_RPC_ERRORS.INTERNAL_ERROR, `PortOS is not reachable at ${url} (${error.code}). Is the server running?`);
  }
  return rpcError(id, JSON_RPC_ERRORS.INTERNAL_ERROR, error?.message || 'Internal error');
};

const requireString = (value, name) => {
  if (typeof value !== 'string' || !value) throw acpError(JSON_RPC_ERRORS.INVALID_PARAMS, `${name} is required`);
  return value;
};

/**
 * The protocol state machine. `receive(line)` handles one stdin line; every
 * outgoing message goes through `send`. Requests run concurrently so a
 * `session/cancel` is seen while its prompt is still streaming.
 */
export const createAcpAgent = ({ client, store, send, log = () => {}, defaultMode = DEFAULT_ACP_MODE, version, credentialSource = null }) => {
  const sessions = new Map();
  const now = () => new Date().toISOString();
  const notify = (sessionId, update) => send(sessionUpdate(sessionId, update));
  const hasBackend = (session) => Boolean(session.conversationId) || session.messageIds.length > 0;

  const persist = async (session) => {
    if (!hasBackend(session)) return;
    session.updatedAt = now();
    await store.save({
      sessionId: session.sessionId,
      mode: session.mode,
      cwd: session.cwd,
      title: session.title,
      conversationId: session.conversationId,
      messageIds: session.messageIds.slice(-MAX_ACP_SESSION_MESSAGE_IDS),
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
    }).catch((error) => log(`⚠️ Could not save ACP session ${session.sessionId}: ${error.message}`));
  };

  const requireSession = (sessionId) => {
    const session = sessions.get(requireString(sessionId, 'sessionId'));
    if (!session) throw acpError(JSON_RPC_ERRORS.RESOURCE_NOT_FOUND, `Unknown session ${sessionId}; call session/new or session/load first`);
    return session;
  };

  const setMode = (session, mode) => {
    if (!isAcpMode(mode)) throw acpError(JSON_RPC_ERRORS.INVALID_PARAMS, `mode must be one of ${ACP_MODE_IDS.join(', ')}`);
    if (mode !== session.mode && hasBackend(session)) {
      throw acpError(JSON_RPC_ERRORS.INVALID_PARAMS, `This session already talks to ${session.mode}; start a new session to use ${mode}`);
    }
    session.mode = mode;
  };

  const promptAsk = async (session, text, signal) => {
    let terminal = null;
    try {
      const { done } = await client.stream({
        method: 'POST',
        path: '/api/ask',
        body: { question: text, mode: 'ask', ...(session.conversationId ? { conversationId: session.conversationId } : {}) },
        signal,
        onEvent: (frame) => {
          const out = translateAskEvent(frame, { toolCallId: `ask-sources-${randomUUID()}` });
          if (out.conversationId && !session.conversationId) {
            session.conversationId = out.conversationId;
            session.title = session.title || sessionTitle(text);
          }
          for (const update of out.updates) notify(session.sessionId, update);
          if (out.terminal) terminal = out.terminal;
        },
      });
      await done;
    } finally {
      // The server keeps the question (and any partial answer) even when the
      // stream was cancelled, so the record is saved on every exit.
      await persist(session);
    }
    if (terminal?.error) throw acpError(JSON_RPC_ERRORS.INTERNAL_ERROR, terminal.error);
    if (!terminal) throw acpError(JSON_RPC_ERRORS.INTERNAL_ERROR, 'Ask Yourself ended the stream before finishing the answer');
    return { stopReason: terminal.stopReason };
  };

  const promptMind = async (session, text, signal) => {
    const messageId = `acp-${randomUUID()}`;
    const binding = { messageId, turnId: null };
    // One controller owns the subscription: the editor's cancel aborts it,
    // and so does reaching this turn's terminal event.
    const subscription = new AbortController();
    const onCancel = () => subscription.abort();
    signal.addEventListener('abort', onCancel, { once: true });
    let finish;
    const finished = new Promise((resolve) => { finish = resolve; });
    try {
      // Subscribe BEFORE posting, so the turn's first events cannot slip past.
      const { done } = await client.stream({
        method: 'GET',
        path: '/api/cos/mind/stream',
        signal: subscription.signal,
        onEvent: ({ data }) => {
          const out = translateMindEvent(data, binding);
          if (out.turnId) binding.turnId = out.turnId;
          for (const update of out.updates) notify(session.sessionId, update);
          if (out.terminal) finish(out.terminal);
        },
      });
      const closed = done.then(
        () => ({ error: 'PortOS closed the Persistent Mind stream before the turn finished' }),
        (error) => (signal.aborted ? null : { error: error.message }),
      );
      await client.json('POST', '/api/cos/mind/messages', { body: { id: messageId, text }, signal });
      session.messageIds = [...session.messageIds, messageId].slice(-MAX_ACP_SESSION_MESSAGE_IDS);
      session.title = session.title || sessionTitle(text);
      await persist(session);
      notify(session.sessionId, agentThoughtChunk('Queued for the Persistent Mind.\n'));
      const terminal = await Promise.race([finished, closed]);
      if (signal.aborted || terminal === null) return { stopReason: 'cancelled' };
      if (terminal.error) throw acpError(JSON_RPC_ERRORS.INTERNAL_ERROR, terminal.error);
      return { stopReason: terminal.stopReason };
    } finally {
      signal.removeEventListener('abort', onCancel);
      subscription.abort();
    }
  };

  const handlers = {
    initialize: async () => buildInitializeResult({ version }),
    // No auth methods are advertised: the adapter authenticates to PortOS
    // with the host's own loopback credential, never one the editor supplies.
    authenticate: async () => ({}),
    'session/new': async ({ cwd }) => {
      const sessionId = `portos-${randomUUID()}`;
      const createdAt = now();
      sessions.set(sessionId, {
        sessionId,
        mode: defaultMode,
        cwd: typeof cwd === 'string' && cwd ? cwd : null,
        title: '',
        conversationId: null,
        messageIds: [],
        createdAt,
        updatedAt: createdAt,
        active: null,
      });
      return { sessionId, ...buildSessionModePayload(defaultMode) };
    },
    'session/load': async ({ sessionId, cwd }) => {
      requireString(sessionId, 'sessionId');
      let session = sessions.get(sessionId);
      if (!session) {
        const record = await store.get(sessionId);
        if (!record) throw acpError(JSON_RPC_ERRORS.RESOURCE_NOT_FOUND, `No PortOS ACP session ${sessionId}`);
        session = { ...record, active: null };
      }
      if (session.mode === 'ask' && session.conversationId) {
        const data = await client.json('GET', `/api/ask/${encodeURIComponent(session.conversationId)}`).catch((error) => {
          if (error.status === 404) throw acpError(JSON_RPC_ERRORS.RESOURCE_NOT_FOUND, 'The Ask Yourself conversation behind this session no longer exists (it may have expired)');
          throw error;
        });
        for (const update of askConversationUpdates(data?.conversation)) notify(sessionId, update);
      } else if (session.mode === 'mind' && session.messageIds.length) {
        const page = await client.json('GET', `/api/cos/mind?limit=${MIND_HISTORY_PAGE}`);
        for (const update of mindHistoryUpdates(page?.events, session.messageIds)) notify(sessionId, update);
      }
      sessions.set(sessionId, session);
      if (typeof cwd === 'string' && cwd && cwd !== session.cwd) {
        session.cwd = cwd;
        await persist(session);
      }
      return buildSessionModePayload(session.mode);
    },
    'session/list': async ({ cwd, cursor }) => listSessionPage(await store.list(), { cwd, cursor }),
    'session/set_mode': async ({ sessionId, modeId }) => {
      setMode(requireSession(sessionId), modeId);
      return {};
    },
    'session/set_config_option': async ({ sessionId, configId, value }) => {
      const session = requireSession(sessionId);
      if (configId !== 'mode') throw acpError(JSON_RPC_ERRORS.INVALID_PARAMS, `Unknown config option ${configId}`);
      setMode(session, value);
      return { configOptions: buildConfigOptions(session.mode) };
    },
    'session/prompt': async ({ sessionId, prompt }) => {
      const session = requireSession(sessionId);
      if (session.active) throw acpError(JSON_RPC_ERRORS.INVALID_REQUEST, 'A prompt is already running in this session');
      const { text, unsupported } = promptToText(prompt);
      if (unsupported.length) {
        throw acpError(JSON_RPC_ERRORS.INVALID_PARAMS, `PortOS accepts text prompts only; unsupported content: ${[...new Set(unsupported)].join(', ')}`);
      }
      if (!text) throw acpError(JSON_RPC_ERRORS.INVALID_PARAMS, 'The prompt has no text');
      const controller = new AbortController();
      session.active = controller;
      try {
        return session.mode === 'mind'
          ? await promptMind(session, text, controller.signal)
          : await promptAsk(session, text, controller.signal);
      } catch (error) {
        if (controller.signal.aborted) return { stopReason: 'cancelled' };
        throw error;
      } finally {
        session.active = null;
      }
    },
    'session/cancel': async ({ sessionId }) => {
      sessions.get(sessionId)?.active?.abort();
      return null;
    },
  };

  const handle = async (parsed) => {
    if (parsed.kind === 'invalid') {
      send(rpcError(parsed.id, parsed.error.code, parsed.error.message));
      return;
    }
    if (parsed.kind === 'notification') {
      if (parsed.method === 'session/cancel') await handlers['session/cancel'](parsed.params);
      return;
    }
    if (parsed.kind !== 'request') return;
    const handler = Object.hasOwn(handlers, parsed.method) ? handlers[parsed.method] : null;
    if (!handler) {
      send(rpcError(parsed.id, JSON_RPC_ERRORS.METHOD_NOT_FOUND, `Method not found: ${parsed.method}`));
      return;
    }
    try {
      send(rpcResult(parsed.id, await handler(parsed.params)));
    } catch (error) {
      send(toRpcError(parsed.id, error, { url: client.url, credentialSource }));
    }
  };

  return {
    receive: (line) => handle(parseAcpLine(line)).catch((error) => log(`❌ ACP handler failed: ${error.message}`)),
    /** Abort every running prompt (the editor went away). */
    close: () => {
      for (const session of sessions.values()) session.active?.abort();
    },
  };
};

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

const credentialSourceOf = (env, token) => {
  if (!token) return null;
  return env.PORTOS_API_TOKEN ? 'PORTOS_API_TOKEN' : 'Agent API key';
};

/** Serve ACP over `input`/`output` until `input` ends. Resolves with the exit code. */
export const serve = async ({ input, output, env = process.env, mode = DEFAULT_ACP_MODE, log = (line) => process.stderr.write(`${line}\n`) }) => {
  const { url, token } = await resolveCredentials(env);
  const client = createPortosClient({ url, token });
  const store = createSessionStore(resolveSessionsFile(env), { log });
  const send = (message) => {
    if (!output.destroyed && !output.writableEnded) output.write(encodeAcpMessage(message));
  };
  const agent = createAcpAgent({
    client,
    store,
    send,
    log,
    defaultMode: mode,
    version: await readAdapterVersion(),
    credentialSource: credentialSourceOf(env, token),
  });
  const decoder = createLineDecoder({
    onLine: (line) => { void agent.receive(line); },
    onOverflow: () => send(rpcError(null, JSON_RPC_ERRORS.INVALID_REQUEST, 'Message exceeds the maximum line length')),
  });
  return new Promise((resolve) => {
    input.on('data', (chunk) => decoder.push(chunk));
    input.on('end', () => {
      decoder.end();
      agent.close();
      resolve(0);
    });
    input.on('error', (error) => {
      log(`❌ ACP input failed: ${error.message}`);
      agent.close();
      resolve(1);
    });
  });
};

/** `--check`: reachability plus auth readiness, with no model call. Resolves with the exit code. */
export const check = async ({ env = process.env, log = (line) => process.stderr.write(`${line}\n`) } = {}) => {
  const { url, token } = await resolveCredentials(env);
  const client = createPortosClient({ url, token });
  try {
    await client.json('GET', '/api/system/health');
  } catch (error) {
    log(`❌ PortOS is not reachable at ${client.url}: ${error.code || error.message}`);
    return 1;
  }
  let who;
  try {
    who = await client.json('GET', '/api/auth/whoami');
  } catch (error) {
    log(`❌ Could not read PortOS auth status: ${error.message}`);
    return 1;
  }
  if (who?.required && !who.authenticated) {
    log(`❌ ${authHint(credentialSourceOf(env, token))}`);
    return 1;
  }
  log(`✅ PortOS is reachable at ${client.url}; ${who?.required ? 'its password gate accepted this credential' : 'no password is set'}.`);
  return 0;
};

export const main = async (argv = process.argv.slice(2), env = process.env) => {
  const { command, mode } = parseCliArgs(argv);
  if (command === 'help') {
    process.stderr.write(`${USAGE}\n`);
    return 0;
  }
  if (command === 'version') {
    process.stdout.write(`portos-acp ${await readAdapterVersion()}\n`);
    return 0;
  }
  if (command === 'check') return check({ env });
  // From here on stdout belongs to the protocol. Anything an imported module
  // logs is diverted to stderr instead of corrupting a JSON-RPC frame.
  for (const method of ['log', 'info', 'debug', 'warn']) console[method] = (...args) => console.error(...args);
  process.stdout.on('error', () => process.exit(0));
  return serve({ input: process.stdin, output: process.stdout, env, mode });
};

if (isDirectlyInvoked(import.meta.url)) {
  main()
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      process.stderr.write(`❌ ${error.message}\n`);
      if (/Unknown argument|must be one of/.test(error.message)) process.stderr.write(`${USAGE}\n`);
      process.exitCode = 1;
    });
}
