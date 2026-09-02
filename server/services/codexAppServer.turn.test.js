import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// The inference half of the app-server client (#5590). Like its account-side
// sibling, a fake child speaks the protocol back — so this suite asserts the
// TRANSPORT contract (safety envelope, event projection, cancellation, quota
// and auth handling, catalog sentinels, process loss) without a real Codex, a
// real ChatGPT account, or a single provider call.
vi.mock('../lib/childProcess.js', async (importOriginal) => ({
  ...(await importOriginal()),
  spawn: vi.fn(),
}));
vi.mock('../lib/processEnv.js', async (importOriginal) => ({
  ...(await importOriginal()),
  findCommandOnPath: vi.fn(() => '/usr/local/bin/codex'),
}));

const { spawn } = await import('../lib/childProcess.js');
const { findCommandOnPath } = await import('../lib/processEnv.js');
const { ERROR_CATEGORIES } = await import('../lib/aiToolkit/errorDetection.js');
const { CODEX_ERROR_CODES } = await import('../lib/codexAccount.js');
const { CODEX_TURN_ERROR_CODES } = await import('../lib/codexTurn.js');
const {
  __resetCodexAppServer,
  benchCodexTextTransport,
  getCodexAccountReadiness,
  getCodexTextTransportBench,
  listCodexModels,
  codexLogout,
  peekCodexModels,
  runCodexTextTurn,
  stopCodexAppServer,
} = await import('./codexAppServer.js');

const makeChild = () => {
  const child = new EventEmitter();
  child.written = [];
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = Object.assign(new EventEmitter(), {
    destroyed: false,
    write: (line, cb) => { child.written.push(JSON.parse(line)); cb?.(); return true; },
  });
  child.kill = vi.fn(() => { child.emit('exit', null, 'SIGTERM'); });
  child.emitFrame = (frame) => child.stdout.emit('data', `${JSON.stringify(frame)}\n`);
  child.notify = (method, params) => child.emitFrame({ jsonrpc: '2.0', method, params });
  child.cursor = 0;
  child.take = (method) => {
    const index = child.written.findIndex((f, i) => i >= child.cursor && f.method === method);
    if (index === -1) return null;
    child.cursor = index + 1;
    return child.written[index];
  };
  child.lastRequest = (method) => [...child.written].reverse().find((f) => f.method === method);
  child.reply = (frame, result) => child.emitFrame({ jsonrpc: '2.0', id: frame.id, result });
  child.replyError = (frame, error) => child.emitFrame({ jsonrpc: '2.0', id: frame.id, error });
  return child;
};

/** Wait for PortOS to write `method`, then run `answer` against that frame. */
const awaitRequest = async (child, method, answer) => {
  let frame = null;
  await vi.waitFor(() => { frame = child.take(method); expect(frame).toBeTruthy(); });
  if (typeof answer === 'function') answer(frame);
  else child.reply(frame, answer);
  return frame;
};

/** Drive a text turn to a `turn/completed` with `status`, streaming `deltas`. */
const driveTurn = async (child, { deltas = [], status = 'completed', item = null, error = null, usage = null } = {}) => {
  await awaitRequest(child, 'thread/start', { thread: { id: 'thread-1' }, model: 'model-alpha' });
  await awaitRequest(child, 'turn/start', { turn: { id: 'turn-1', items: [], status: 'inProgress' } });
  for (const delta of deltas) {
    child.notify('item/agentMessage/delta', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'i1', delta });
  }
  if (item) child.notify('item/completed', { threadId: 'thread-1', turnId: 'turn-1', completedAtMs: 1, item });
  if (usage) child.notify('thread/tokenUsage/updated', { threadId: 'thread-1', turnId: 'turn-1', tokenUsage: usage });
  child.notify('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', items: [], status, error } });
};

let child = null;

beforeEach(() => {
  vi.clearAllMocks();
  __resetCodexAppServer();
  child = makeChild();
  spawn.mockReturnValue(child);
  findCommandOnPath.mockReturnValue('/usr/local/bin/codex');
});

afterEach(async () => {
  await stopCodexAppServer().catch(() => {});
  __resetCodexAppServer();
});

const handshake = async () => awaitRequest(child, 'initialize', {});

describe('running a text turn', () => {
  it('confines the turn to an empty directory with no tools, no network, and no writes', async () => {
    // This is the boundary that lets a Brain/JIRA summary use the same record
    // as the coding harness without writes or network access. Local reads stay
    // possible and are gated by the provider acknowledgement in codexTurn.js.
    const promise = runCodexTextTurn({ prompt: 'Summarize this.' });
    await handshake();
    await driveTurn(child, { deltas: ['ok'] });
    await promise;

    const start = child.lastRequest('thread/start').params;
    expect(start.sandbox).toBe('read-only');
    expect(start.approvalPolicy).toBe('never');
    expect(start.ephemeral).toBe(true);
    expect(start.config).toEqual({
      mcp_servers: {}, tools: { web_search: false }, sandbox_permissions: [],
    });
    expect(start.cwd).toEqual(expect.stringContaining('portos-codex-text-'));
    expect(start.cwd.includes('PortOS')).toBe(false);

    const turn = child.lastRequest('turn/start').params;
    expect(turn.sandboxPolicy).toEqual({ type: 'readOnly', networkAccess: false });
    expect(turn.approvalPolicy).toBe('never');
    expect(turn.input).toEqual([{ type: 'text', text: 'Summarize this.' }]);
  });

  it('returns the assembled text plus subscription-attributed usage', async () => {
    const promise = runCodexTextTurn({ prompt: 'hi', model: 'model-alpha' });
    await handshake();
    await driveTurn(child, {
      deltas: ['Hello, ', 'world'],
      usage: { last: { inputTokens: 9, outputTokens: 3, cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 12 } },
    });

    await expect(promise).resolves.toMatchObject({
      text: 'Hello, world',
      usage: { outputTokens: 3, totalTokens: 12, source: 'chatgpt-subscription' },
      model: 'model-alpha',
    });
  });

  it('passes a response schema through so structured output is constrained', async () => {
    const schema = { type: 'object', properties: { verdict: { type: 'string' } } };
    const promise = runCodexTextTurn({ prompt: 'classify', responseSchema: schema });
    await handshake();
    await driveTurn(child, { item: { type: 'agentMessage', id: 'i1', text: '{"verdict":"ok"}' } });

    await expect(promise).resolves.toMatchObject({ text: '{"verdict":"ok"}' });
    expect(child.lastRequest('turn/start').params.outputSchema).toEqual(schema);
  });

  it('rejects rather than returning the partial text of an interrupted turn', async () => {
    const promise = runCodexTextTurn({ prompt: 'long one' });
    await handshake();
    await driveTurn(child, { deltas: ['{"answer":"hal'], status: 'interrupted' });

    await expect(promise).rejects.toMatchObject({ code: CODEX_TURN_ERROR_CODES.turnInterrupted });
  });

  it('interrupts the live turn when the caller aborts, instead of leaving it to burn quota', async () => {
    const controller = new AbortController();
    const promise = runCodexTextTurn({ prompt: 'long one', signal: controller.signal });
    await handshake();
    await awaitRequest(child, 'thread/start', { thread: { id: 'thread-1' } });
    await awaitRequest(child, 'turn/start', { turn: { id: 'turn-1', items: [], status: 'inProgress' } });

    controller.abort();

    await expect(promise).rejects.toMatchObject({ code: CODEX_TURN_ERROR_CODES.turnInterrupted });
    await vi.waitFor(() => expect(child.lastRequest('turn/interrupt')).toBeTruthy());
    expect(child.lastRequest('turn/interrupt').params).toEqual({ threadId: 'thread-1', turnId: 'turn-1' });
  });

  it('abandons the turn when the caller aborts during the app-server cold start', async () => {
    // `connect()` can spawn and handshake a whole child, so the up-front
    // `signal.aborted` check is many awaits stale by the time it resolves and
    // no listener is registered yet. Without a re-read, a Stop pressed here
    // dispatched a full turn against the subscription.
    const controller = new AbortController();
    const promise = runCodexTextTurn({ prompt: 'long one', signal: controller.signal });

    let frame = null;
    await vi.waitFor(() => { frame = child.take('initialize'); expect(frame).toBeTruthy(); });
    controller.abort();
    child.reply(frame, {});

    await expect(promise).rejects.toMatchObject({ code: CODEX_TURN_ERROR_CODES.turnInterrupted });
    expect(child.lastRequest('thread/start')).toBeUndefined();
    expect(child.lastRequest('turn/start')).toBeUndefined();
  });

  it('honours an abort that lands while the thread is starting, which fires no late event', async () => {
    // An AbortSignal emits 'abort' exactly once: aborting before the listener
    // is registered means the listener never runs, so the flag has to be
    // re-read at registration time.
    const controller = new AbortController();
    const promise = runCodexTextTurn({ prompt: 'long one', signal: controller.signal });
    await handshake();
    await awaitRequest(child, 'thread/start', (frame) => {
      controller.abort();
      child.reply(frame, { thread: { id: 'thread-1' } });
    });

    await expect(promise).rejects.toMatchObject({ code: CODEX_TURN_ERROR_CODES.turnInterrupted });
    // Cancellation is surfaced without dispatching the turn at all, so Stop
    // neither spends quota nor waits out a `turn/start` round trip.
    expect(child.lastRequest('turn/start')).toBeUndefined();
  });

  it('carries a quota failure out as a usage-limit category', async () => {
    const promise = runCodexTextTurn({ prompt: 'hi' });
    await handshake();
    await driveTurn(child, {
      status: 'failed',
      error: { message: 'You have hit your usage limit.', codexErrorInfo: 'usageLimitExceeded' },
    });

    await expect(promise).rejects.toMatchObject({
      code: CODEX_TURN_ERROR_CODES.turnFailed,
      context: { category: ERROR_CATEGORIES.USAGE_LIMIT },
    });
  });

  it('surfaces an expired sign-in as an auth failure from the RPC itself', async () => {
    const promise = runCodexTextTurn({ prompt: 'hi' });
    await handshake();
    await awaitRequest(child, 'thread/start', (frame) =>
      child.replyError(frame, { code: -32000, message: 'HTTP 401 unauthorized — please re-authenticate' }));

    await expect(promise).rejects.toMatchObject({ code: CODEX_ERROR_CODES.authRevoked });
  });

  it('ignores a malformed event rather than crashing the stdout handler', async () => {
    const promise = runCodexTextTurn({ prompt: 'hi' });
    await handshake();
    await awaitRequest(child, 'thread/start', { thread: { id: 'thread-1' } });
    await awaitRequest(child, 'turn/start', { turn: { id: 'turn-1', items: [], status: 'inProgress' } });

    child.stdout.emit('data', 'not json at all\n');
    child.notify('item/agentMessage/delta', { threadId: 'thread-1', turnId: 'turn-1' });
    child.notify('thread/tokenUsage/updated', { threadId: 'thread-1', turnId: 'turn-1', tokenUsage: 'nope' });
    child.notify('item/agentMessage/delta', { threadId: 'thread-1', turnId: 'turn-1', delta: 'still fine' });
    child.notify('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', items: [], status: 'completed' } });

    await expect(promise).resolves.toMatchObject({ text: 'still fine', usage: null });
  });

  it('fails a turn whose app-server died mid-stream instead of hanging forever', async () => {
    // `turn/start` already answered, so there is no pending request to reject —
    // without the teardown hook this call would wait on a notification that can
    // never arrive.
    const promise = runCodexTextTurn({ prompt: 'hi' });
    await handshake();
    await awaitRequest(child, 'thread/start', { thread: { id: 'thread-1' } });
    await awaitRequest(child, 'turn/start', { turn: { id: 'turn-1', items: [], status: 'inProgress' } });

    child.emit('exit', 1, null);

    await expect(promise).rejects.toMatchObject({ code: CODEX_ERROR_CODES.exited });
  });

  it('refuses to run while the transport is benched, without touching the wire', async () => {
    benchCodexTextTransport({ waitMs: 60_000, category: ERROR_CATEGORIES.USAGE_LIMIT, message: 'plan spent' });

    await expect(runCodexTextTurn({ prompt: 'hi' })).rejects.toMatchObject({
      code: CODEX_TURN_ERROR_CODES.transportBenched,
    });
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('the transport bench', () => {
  it('expires on its own and never shortens an existing bench', () => {
    benchCodexTextTransport({ waitMs: 60_000, category: ERROR_CATEGORIES.USAGE_LIMIT, message: 'long' });
    benchCodexTextTransport({ waitMs: 1_000, category: ERROR_CATEGORIES.RATE_LIMIT, message: 'short' });
    expect(getCodexTextTransportBench().message).toBe('long');

    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 61_000);
    expect(getCodexTextTransportBench()).toBeNull();
    vi.useRealTimers();
  });
});

describe('model discovery', () => {
  it('caches a genuinely empty catalog instead of re-listing on every call', async () => {
    const promise = listCodexModels();
    await handshake();
    await awaitRequest(child, 'model/list', { data: [] });

    await expect(promise).resolves.toMatchObject({ models: [], error: null });
    // [] is a real answer: a second read must be served from cache.
    await expect(listCodexModels()).resolves.toMatchObject({ models: [] });
    expect(child.written.filter((f) => f.method === 'model/list')).toHaveLength(1);
  });

  it('follows the catalog cursor so a later page still reaches the picker', async () => {
    // A truncated catalog is not just a short picker: a model on a later page is
    // absent from the effort-clamp lookup, so its effort is sent unvalidated.
    const promise = listCodexModels();
    await handshake();
    await awaitRequest(child, 'model/list', {
      data: [{ id: 'model-alpha', supportedReasoningEfforts: [] }], nextCursor: 'page-2',
    });
    await awaitRequest(child, 'model/list', {
      data: [{ id: 'model-beta', supportedReasoningEfforts: [] }], nextCursor: null,
    });

    const result = await promise;
    expect(result.models.map((m) => m.id)).toEqual(['model-alpha', 'model-beta']);
    expect(child.written.filter((f) => f.method === 'model/list')[1].params).toEqual({ cursor: 'page-2' });
  });

  it('keeps the last-known-good list when a refresh fails', async () => {
    const first = listCodexModels();
    await handshake();
    await awaitRequest(child, 'model/list', {
      data: [{ id: 'model-alpha', displayName: 'Alpha', supportedReasoningEfforts: [] }],
    });
    await first;

    const refresh = listCodexModels({ fresh: true });
    await awaitRequest(child, 'model/list', (frame) => child.replyError(frame, { message: 'upstream down' }));

    const result = await refresh;
    expect(result.models).toEqual([expect.objectContaining({ id: 'model-alpha' })]);
    expect(result.error.message).toMatch(/upstream down/);
  });

  it('peeks null before anything has ever asked', () => {
    expect(peekCodexModels()).toBeNull();
  });
});

describe('bench and readiness are independent', () => {
  it('does not clear a quota bench just because the account reads ready', async () => {
    // `ready` is weak evidence: a spent per-session budget, or a quota read that
    // merely FAILED, both land there. Clearing on it would unbench a still-spent
    // subscription on the Providers page's next 15s poll, forever.
    benchCodexTextTransport({ waitMs: 60_000, category: 'usage-limit', message: 'session budget spent' });

    const promise = getCodexAccountReadiness({ fresh: true });
    await handshake();
    await awaitRequest(child, 'account/read', { account: { type: 'chatgpt', planType: 'pro' } });
    await awaitRequest(child, 'account/rateLimits/read', { primary: { usedPercent: 60 } });

    await expect(promise).resolves.toMatchObject({ status: 'ready' });
    expect(getCodexTextTransportBench()).not.toBeNull();
  });

  it('clears the bench when the user signs out', async () => {
    benchCodexTextTransport({ waitMs: 60_000, category: 'auth-error', message: 'signed out' });

    const promise = codexLogout();
    await handshake();
    await awaitRequest(child, 'account/logout', {});
    await awaitRequest(child, 'account/read', null);
    await promise;

    expect(getCodexTextTransportBench()).toBeNull();
  });
});

describe('protocol errors that quote a credential', () => {
  it('scrubs the RPC message before it reaches a log or the HTTP response', async () => {
    const promise = listCodexModels();
    await handshake();
    await awaitRequest(child, 'model/list', (frame) =>
      child.replyError(frame, { code: -32000, message: 'refresh failed: access_token=sk-live-ABCDEFGH1234 expired' }));

    const result = await promise;
    expect(result.error.message).not.toMatch(/sk-live-ABCDEFGH1234/);
    expect(result.error.message).toContain('[redacted]');
  });
});

describe('progress hooks', () => {
  it('never streams a delta belonging to a different turn', async () => {
    const seen = [];
    const promise = runCodexTextTurn({ prompt: 'hi', onDelta: (d) => seen.push(d) });
    await handshake();
    await awaitRequest(child, 'thread/start', { thread: { id: 'thread-1' } });
    await awaitRequest(child, 'turn/start', { turn: { id: 'turn-1', items: [], status: 'inProgress' } });

    child.notify('item/agentMessage/delta', { threadId: 'thread-1', turnId: 'turn-1', delta: 'mine' });
    child.notify('item/agentMessage/delta', { threadId: 'thread-1', turnId: 'turn-2', delta: 'SOMEBODY ELSE' });
    child.notify('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', items: [], status: 'completed' } });

    await expect(promise).resolves.toMatchObject({ text: 'mine' });
    expect(seen).toEqual(['mine']);
  });
});

describe('shutdown while a turn is live', () => {
  it('fails the turn instead of leaving it to time out, and never respawns the child', async () => {
    // `turn/start` already answered, so there is no pending RPC to reject — only
    // the teardown hook can settle this. If shutdown drops the live handle first,
    // the turn hangs for its full 5-minute deadline and its cleanup then spawns a
    // WHOLE NEW app-server just to interrupt a thread that no longer exists.
    const promise = runCodexTextTurn({ prompt: 'hi' });
    await handshake();
    await awaitRequest(child, 'thread/start', { thread: { id: 'thread-1' } });
    await awaitRequest(child, 'turn/start', { turn: { id: 'turn-1', items: [], status: 'inProgress' } });
    expect(spawn).toHaveBeenCalledTimes(1);

    // The expectation is attached BEFORE the shutdown, the way a real caller is
    // already awaiting its turn: shutdown now fails the turn synchronously, and
    // an unawaited rejection surfacing between here and the assertion would be
    // reported as unhandled.
    const rejected = expect(promise).rejects.toMatchObject({ code: CODEX_ERROR_CODES.exited });
    await stopCodexAppServer();
    await rejected;
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

describe('a catalog that will not stop paginating', () => {
  it('reports an error rather than caching a partial list as authoritative', async () => {
    // Caching a truncated catalog would replace a complete last-known-good list
    // with a partial one, and `error: null` would tell the client it is whole.
    const promise = listCodexModels();
    await handshake();
    for (let page = 0; page < 20; page += 1) {
      await awaitRequest(child, 'model/list', {
        data: [{ id: `model-${page}`, supportedReasoningEfforts: [] }], nextCursor: `page-${page + 1}`,
      });
    }

    const result = await promise;
    expect(result.models).toBeNull();
    expect(result.error.message).toMatch(/paginating/i);
    expect(peekCodexModels()).toBeNull();
  });
});

describe('shutdown racing a connect', () => {
  it('drops a handshake that lands mid-shutdown instead of leaving a dead handle', async () => {
    // The published handle would be a CLOSED one, and the next call would see
    // that and spawn a replacement — a fresh app-server started after the
    // graceful-shutdown hook already ran.
    const connecting = getCodexAccountReadiness({ fresh: true });
    let initialize = null;
    await vi.waitFor(() => { initialize = child.take('initialize'); expect(initialize).toBeTruthy(); });

    const stopping = stopCodexAppServer();
    child.reply(initialize, {});
    await stopping;

    await expect(connecting).resolves.toMatchObject({ status: 'unknown' });
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

describe('a new sign-in is a different account', () => {
  it('drops the cached model catalog when a login completes', async () => {
    // Otherwise account B is offered account A's models for up to the 10m TTL.
    const listing = listCodexModels();
    await handshake();
    await awaitRequest(child, 'model/list', { data: [{ id: 'model-alpha', supportedReasoningEfforts: [] }] });
    await listing;
    expect(peekCodexModels()).not.toBeNull();

    child.notify('account/login/completed', { loginId: 'other-client', success: true });

    expect(peekCodexModels()).toBeNull();
  });
});
