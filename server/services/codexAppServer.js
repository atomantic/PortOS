/**
 * PortOS's client for the Codex **app-server** — the JSON-RPC-over-stdio
 * endpoint OpenAI documents for embedding Codex in a product.
 *
 * This is the process half of `lib/codexAccount.js`: it spawns
 * `codex app-server`, speaks the handshake, and exposes exactly the bounded
 * account actions the Providers page needs — read the account, start a ChatGPT
 * sign-in, cancel it, sign out. Nothing else in this phase: no threads, no
 * turns, no inference (that is #5590).
 *
 * Rules this module exists to keep in one place:
 *
 *   - **Codex owns the credentials.** PortOS never reads `~/.codex/auth.json`,
 *     never asks for a token, and never persists one. `account/read` is the
 *     source of truth; every payload crossing this boundary goes through
 *     `redactCodexPayload` before it can reach a log or an error context.
 *   - **Nothing starts at boot.** The child is spawned lazily, on an explicit
 *     request only, so a cold install makes no Codex process and no network
 *     call (AGENTS.md, "No cold-bootstrap LLM calls" — and this is stricter,
 *     since an OAuth flow is not something a boot sequence may begin).
 *   - **Every wait is bounded and settles once.** A request, the handshake, and
 *     a login each carry their own deadline; a child exit fails every pending
 *     request with a typed error rather than hanging the page forever.
 *   - **Writes are serialized.** JSON-RPC framing is newline-delimited, so two
 *     concurrent writers could interleave a frame. Every write is chained onto
 *     one tail promise.
 *
 * The readiness snapshot is CACHED and separately PEEKABLE: `GET /api/providers`
 * decorates cards from `peekCodexAccountReadiness()`, which never spawns
 * anything, while the Providers page's own explicit fetch is what fills that
 * cache.
 */

import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

import { spawn } from '../lib/childProcess.js';
import { ServerError } from '../lib/errorHandler.js';
import { createLineReader } from '../lib/streamLines.js';
import { findCommandOnPath } from '../lib/processEnv.js';
import {
  CODEX_APP_SERVER_ARGS,
  CODEX_APP_SERVER_COMMAND,
  CODEX_ERROR_CODES,
  CODEX_NOTIFICATIONS,
  CODEX_RPC,
  deriveCodexAccountStatus,
  describeCodexAccountStatus,
  isCodexAuthError,
  normalizeCodexAccount,
  normalizeCodexLoginStart,
  normalizeCodexRateLimits,
  redactCodexMessage,
  redactCodexPayload,
} from '../lib/codexAccount.js';
import {
  CODEX_TEXT_THREAD_CONFIG,
  CODEX_TEXT_TURN_SANDBOX,
  CODEX_TURN_ERROR_CODES,
  CODEX_TURN_NOTIFICATIONS,
  CODEX_TURN_RPC,
  applyCodexTurnEvent,
  createTurnAccumulator,
  finalizeCodexTurn,
  normalizeCodexModels,
  resolveCodexEffort,
} from '../lib/codexTurn.js';

/** The app-server answers a local read in milliseconds; a stall is a fault. */
const REQUEST_TIMEOUT_MS = 15_000;
/** Cold start pays for process launch and config load, so it gets more room. */
const HANDSHAKE_TIMEOUT_MS = 20_000;
/**
 * How long a browser sign-in may stay pending before PortOS stops waiting. Long
 * enough for a real OAuth round trip in another tab, short enough that an
 * abandoned flow does not pin the card in `login-pending` until a restart.
 */
const LOGIN_TIMEOUT_MS = 5 * 60_000;
/**
 * Matches the Providers page's poll cadence: a user who just signed in must see
 * `ready` on the next tick, while a page reload landing on top of a poll reuses
 * the answer instead of spawning a second read.
 */
const READINESS_TTL_MS = 15_000;

const CLIENT_INFO = Object.freeze({ name: 'PortOS', title: 'PortOS', version: '1' });

/** The live connection, or `null` when nothing is running. */
let connection = null;
/** Coalesces concurrent connects so one page load cannot spawn two children. */
let connecting = null;
/** The child being handshaken, before `connect()` can publish it as live. */
let connectingTarget = null;
/** `{ at, readiness }` — the last successful read. `null` = never probed. */
let readinessCache = null;
/** `{ loginId, startedAt, expiresAt, timer }` for a PortOS-initiated login. */
let pendingLogin = null;
/**
 * Live text turns, keyed by threadId. One app-server connection serves every
 * caller, so notifications are routed by thread rather than broadcast — a
 * concurrent turn's deltas must never leak into another caller's answer.
 */
const activeTurns = new Map();
/**
 * `{ at, models }` — the last successful `model/list`. `null` = NEVER FETCHED,
 * which is not the same as a fetched catalog that is genuinely empty; a failed
 * read leaves the last-known-good list in place rather than publishing "this
 * account has no models".
 */
let modelsCache = null;
/** `{ until, category, message }` while the TEXT transport is benched. */
let textTransportBench = null;
/** The empty scratch directory generic text turns run in. Created lazily. */
let textTurnCwd = null;
/** Coalesces concurrent first-calls so only one scratch directory is created. */
let creatingTextTurnCwd = null;

const codexError = (code, message, options = {}) => new ServerError(message, {
  status: options.status ?? 502,
  code,
  context: options.context ?? {},
});

/**
 * Where the `codex` binary is, or `null` when it is not on PortOS's PATH.
 *
 * A synchronous PATH walk, not a spawn — this is the gate that keeps a
 * runtime-missing host from launching a child that can only fail with ENOENT.
 */
const resolveCodexBinary = () => findCommandOnPath(CODEX_APP_SERVER_COMMAND);

/**
 * Fail every in-flight request and drop the connection.
 *
 * Called from the child's `exit`/`error` handlers and from `stop()`. Each
 * pending entry is removed from the map BEFORE it is settled, so a rejection
 * handler that immediately retries cannot see the same id twice.
 */
const teardown = (target, error) => {
  if (!target) return;
  const pendingEntries = [...target.pending.values()];
  target.pending.clear();
  target.closed = true;
  for (const entry of pendingEntries) {
    // Clearing matters more now that turns exist: a request deadline can be the
    // full 5-minute turn timeout, and an unfired timer for an already-rejected
    // request keeps a callback armed for the rest of that window.
    clearTimeout(entry.timer);
    entry.reject(error);
  }
  // A turn whose `turn/start` already answered has no pending request to reject,
  // so losing the child would otherwise leave it waiting on a notification that
  // can never arrive. Scoped to the LIVE connection: a stale target's late
  // `exit` event must not kill turns running on the replacement that took over.
  const wasLive = connection === target;
  if (wasLive) {
    connection = null;
    failActiveTurns(error);
  }
};

/**
 * Fail every live text turn with `error`.
 *
 * Each entry is removed before it is settled, so a caller that immediately
 * retries cannot observe the same thread id twice.
 */
function failActiveTurns(error) {
  const turns = [...activeTurns.values()];
  activeTurns.clear();
  for (const turn of turns) turn.fail(error);
}

/** Reject the target and terminate its child unless it already stopped. */
const stopTarget = (target, error) => {
  if (!target || target.closed) return;
  teardown(target, error);
  if (target.child.killed) return;
  try {
    target.child.kill('SIGTERM');
  } catch (err) {
    console.error(`❌ Failed to stop Codex app-server: ${err.message}`);
  }
};

/** Settle a pending login once, clearing its deadline. */
const settleLogin = (reason) => {
  if (!pendingLogin) return;
  clearTimeout(pendingLogin.timer);
  pendingLogin = null;
  if (reason) console.log(`🔑 Codex sign-in ${reason}`);
};

/**
 * Notifications PortOS acts on. Everything else the app-server streams is for
 * a thread/turn client and is ignored here.
 *
 * The account cache is dropped rather than patched: the notification says the
 * state CHANGED, and re-reading `account/read` is one cheap local call, whereas
 * merging a partial payload would invent state PortOS was not told.
 */
const handleNotification = (method, params) => {
  routeTurnNotification(method, params);
  if (method === CODEX_NOTIFICATIONS.accountUpdated || method === CODEX_NOTIFICATIONS.rateLimitsUpdated) {
    readinessCache = null;
    return;
  }
  if (method !== CODEX_NOTIFICATIONS.loginCompleted) return;
  readinessCache = null;
  const loginId = typeof params?.loginId === 'string' ? params.loginId : null;
  // A completion for a login PortOS did not start (another Codex client on this
  // host) still invalidates the cache above, but must not settle ours.
  if (!pendingLogin || (loginId && loginId !== pendingLogin.loginId)) return;
  // A completed sign-in is a user action that really did change the account, so
  // unlike a background readiness poll it may clear an auth/quota bench.
  if (params?.success !== false) clearCodexTextTransportBench();
  settleLogin(params?.success === false ? 'failed' : 'completed');
};

/**
 * Hand one server notification to the turn that owns its thread.
 *
 * Runs BEFORE the account handling so a turn keeps streaming even while an
 * account notification is invalidating the readiness cache. A frame for a
 * thread PortOS is not running is dropped, not logged: the app-server also
 * streams a coding agent's own thread over this connection.
 */
const routeTurnNotification = (method, params) => {
  const threadId = typeof params?.threadId === 'string' ? params.threadId : null;
  if (!threadId) return;
  const turn = activeTurns.get(threadId);
  if (!turn) return;
  // The accumulator is pure; a malformed frame can still throw inside a
  // normalizer, and this runs on a stdout event handler where an uncaught
  // throw would take down the node process.
  // Whether the accumulator will accept this frame, computed BEFORE applying it
  // (which may latch the turn id). The progress hook honours the same filters:
  // streaming another turn's delta, or one that lands after this turn already
  // failed, would show a consumer partial text from an answer PortOS is going to
  // refuse.
  const accepted = turn.acc.status === 'inProgress'
    && (!turn.acc.turnId || typeof params.turnId !== 'string' || params.turnId === turn.acc.turnId);

  let terminal = false;
  try {
    terminal = applyCodexTurnEvent(turn.acc, method, params);
  } catch (err) {
    console.error(`❌ Codex turn event ${method} could not be applied: ${err.message}`);
    return;
  }
  // Fired AFTER the accumulator, and in its own guard: a throwing hook must not
  // skip the frame (the finished answer would silently lose that text), and an
  // async hook's rejection is invisible to try/catch — unhandled here would be a
  // process-level crash, since this runs on a stdout event outside any request.
  if (accepted && turn.onDelta && method === CODEX_TURN_NOTIFICATIONS.agentMessageDelta
    && typeof params.delta === 'string') {
    try {
      Promise.resolve(turn.onDelta(params.delta))
        .catch((err) => console.error(`❌ Codex turn progress hook rejected: ${err.message}`));
    } catch (err) {
      console.error(`❌ Codex turn progress hook failed: ${err.message}`);
    }
  }
  if (terminal) turn.settle();
};

/** One decoded stdout line. Malformed input is logged and dropped, never thrown. */
const handleFrame = (target, line) => {
  const text = line.trim();
  if (text === '') return;
  let frame = null;
  try {
    frame = JSON.parse(text);
  } catch {
    console.error(`❌ Codex app-server sent a frame PortOS could not parse (${text.length} chars)`);
    return;
  }
  if (!frame || typeof frame !== 'object') return;
  if (frame.id === undefined || frame.id === null) {
    if (typeof frame.method === 'string') handleNotification(frame.method, frame.params);
    return;
  }
  const entry = target.pending.get(frame.id);
  if (!entry) return; // A late answer to a request that already timed out.
  target.pending.delete(frame.id);
  clearTimeout(entry.timer);
  if (frame.error) {
    // Scrubbed, not raw: this message is logged AND returned to the browser by
    // the `/codex/*` routes, and an upstream failure can quote the credential
    // that failed ("access_token=… expired").
    const message = redactCodexMessage(frame.error?.message) ?? 'Codex app-server returned an error';
    const rpcError = codexError(
      isCodexAuthError(frame.error) ? CODEX_ERROR_CODES.authRevoked : CODEX_ERROR_CODES.protocol,
      message,
      { context: { method: entry.method, error: redactCodexPayload(frame.error) } },
    );
    entry.reject(rpcError);
    return;
  }
  entry.resolve(frame.result ?? null);
};

/**
 * Write one JSON-RPC frame, chained onto the connection's write tail.
 *
 * The tail is what makes concurrent callers safe: `stdin.write` can return
 * false mid-frame, and two unchained writers would interleave halves of two
 * JSON lines into one unparseable stream.
 */
const writeFrame = (target, frame) => {
  target.writeTail = target.writeTail.then(() => new Promise((resolve, reject) => {
    if (target.closed || target.child.stdin.destroyed) {
      reject(codexError(CODEX_ERROR_CODES.exited, 'The Codex app-server is no longer running.'));
      return;
    }
    target.child.stdin.write(`${JSON.stringify(frame)}\n`, (err) => (err ? reject(err) : resolve()));
  }));
  return target.writeTail;
};

/** A JSON-RPC request with its own deadline. Settles exactly once. */
const sendRequest = (target, method, params = {}, timeoutMs = REQUEST_TIMEOUT_MS) => new Promise((resolve, reject) => {
  const id = target.nextId++;
  const timer = setTimeout(() => {
    if (!target.pending.delete(id)) return;
    reject(codexError(CODEX_ERROR_CODES.timeout, `Codex app-server did not answer ${method} within ${Math.round(timeoutMs / 1000)}s.`));
  }, timeoutMs);
  timer.unref?.();
  target.pending.set(id, { method, resolve, reject, timer });
  writeFrame(target, { jsonrpc: '2.0', id, method, params }).catch((err) => {
    if (!target.pending.delete(id)) return;
    clearTimeout(timer);
    reject(err);
  });
});

/** A JSON-RPC notification — fire and forget, but still serialized. */
const sendNotification = (target, method, params = {}) =>
  writeFrame(target, { jsonrpc: '2.0', method, params });

/**
 * Spawn the app-server and complete the handshake, or throw a typed error.
 *
 * `spawn` can throw synchronously and the child can die before the handshake
 * answers; both are caught here because this runs outside the Express request
 * lifecycle, where an unhandled rejection from a process event kills the node.
 */
const openConnection = async () => {
  const binary = resolveCodexBinary();
  if (!binary) {
    throw codexError(
      CODEX_ERROR_CODES.runtimeMissing,
      'The Codex CLI is not installed, so PortOS cannot check the ChatGPT account.',
      { status: 409 },
    );
  }

  let child = null;
  try {
    // Fixed argv, inherited env, no shell — nothing from a request or a stored
    // provider record reaches this command line.
    child = spawn(binary, [...CODEX_APP_SERVER_ARGS], { stdio: ['pipe', 'pipe', 'pipe'] });
  } catch (err) {
    throw codexError(CODEX_ERROR_CODES.startFailed, `Codex app-server failed to start: ${err.message}`);
  }

  const target = { child, pending: new Map(), nextId: 1, writeTail: Promise.resolve(), closed: false };
  const reader = createLineReader((line) => handleFrame(target, line));
  child.stdout?.on('data', reader.push);
  // stderr is Codex's own diagnostics. Never forwarded to a client and never
  // parsed — the protocol answer is the only thing PortOS acts on.
  child.stderr?.on('data', () => {});
  child.stdin?.on('error', (err) => console.error(`❌ Codex app-server stdin: ${err.message}`));
  child.on('error', (err) => {
    teardown(target, codexError(CODEX_ERROR_CODES.startFailed, `Codex app-server failed to start: ${err.message}`));
    settleLogin('ended because the Codex app-server stopped');
  });
  child.on('exit', (code, signal) => {
    reader.flush();
    teardown(target, codexError(
      CODEX_ERROR_CODES.exited,
      `The Codex app-server exited (${signal ? `signal ${signal}` : `code ${code}`}).`,
    ));
    settleLogin('ended because the Codex app-server stopped');
  });

  connectingTarget = target;
  try {
    await sendRequest(target, CODEX_RPC.initialize, { clientInfo: CLIENT_INFO }, HANDSHAKE_TIMEOUT_MS);
    await sendNotification(target, CODEX_RPC.initialized, {});
    console.log('🔌 Codex app-server connected');
    return target;
  } catch (err) {
    // A handshake timeout/rejection happens before `connect()` can publish the
    // target in `connection`; clean up here so the child cannot become an
    // orphan that later account checks cannot see or stop.
    stopTarget(target, err);
    throw err;
  }
};

/** The live connection, opening one if needed. One connect in flight at a time. */
const connect = async () => {
  if (connection && !connection.closed) return connection;
  if (!connecting) {
    connecting = openConnection()
      .then((target) => { connection = target; return target; })
      .finally(() => { connecting = null; connectingTarget = null; });
  }
  return connecting;
};

/** A request against a fresh-or-existing connection. */
const call = async (method, params = {}, timeoutMs = REQUEST_TIMEOUT_MS) =>
  sendRequest(await connect(), method, params, timeoutMs);

const loginSnapshot = () => (pendingLogin
  ? { loginId: pendingLogin.loginId, startedAt: pendingLogin.startedAt, expiresAt: pendingLogin.expiresAt }
  : null);

const buildReadiness = ({ runtimeInstalled, accountFetched, account, rateLimits, error }) => {
  const status = deriveCodexAccountStatus({
    runtimeInstalled,
    accountFetched,
    account,
    rateLimits,
    loginPending: pendingLogin !== null,
    error,
  });
  return {
    status,
    detail: describeCodexAccountStatus(status, account),
    runtimeInstalled,
    // Published, not derived downstream: `account: null` alone cannot tell a
    // successful read that found no account (SIGNED OUT) from a read that never
    // answered (UNKNOWN), and every consumer would have to re-derive it.
    accountFetched,
    account,
    rateLimits,
    login: loginSnapshot(),
    error,
    checkedAt: Date.now(),
  };
};

/**
 * Read the account and the quota window, and fold both into one readiness
 * verdict.
 *
 * The two reads are independent on purpose. A quota read that fails leaves
 * `rateLimits: null` — NOT FETCHED — and a signed-in account still reports
 * `ready`, because "PortOS could not read the usage window" is not "you are out
 * of quota". Only the account read can move the verdict off `unknown`.
 */
const readReadiness = async () => {
  const runtimeInstalled = resolveCodexBinary() !== null;
  if (!runtimeInstalled) {
    return buildReadiness({ runtimeInstalled: false, accountFetched: false, account: null, rateLimits: null, error: null });
  }

  let account = null;
  let accountFetched = false;
  let error = null;
  try {
    account = normalizeCodexAccount(await call(CODEX_RPC.accountRead));
    accountFetched = true;
  } catch (err) {
    error = { code: err.code || CODEX_ERROR_CODES.protocol, message: err.message };
    console.error(`❌ Codex account/read failed: ${err.message}`);
  }

  let rateLimits = null;
  if (accountFetched && account) {
    try {
      rateLimits = normalizeCodexRateLimits(await call(CODEX_RPC.rateLimitsRead));
    } catch (err) {
      // Sentinel, not a verdict: an unread quota stays `null` and the account
      // keeps whatever status it earned.
      console.error(`❌ Codex rate-limit read failed: ${err.message}`);
    }
  }

  // Deliberately does NOT clear a bench. `ready` is far weaker evidence than it
  // looks: a per-session budget can be spent while the account's 5h/weekly
  // windows sit at 60%, and a quota read that merely FAILED also lands on
  // `ready` (an unread window is not an exhausted one). Clearing on either would
  // unbench a still-spent subscription on the Providers page's next 15s poll,
  // and loop that way for the whole window. The bench expires on the reset time
  // Codex itself reported; only an explicit sign-in or sign-out clears it early.
  return buildReadiness({ runtimeInstalled: true, accountFetched, account, rateLimits, error });
};

/**
 * The current Codex account readiness, from cache unless `fresh` is set or the
 * cache has aged out.
 *
 * LAZY: the only callers are the Providers page's explicit fetch and an
 * explicitly requested run. Nothing on the boot path may call this.
 */
export async function getCodexAccountReadiness({ fresh = false } = {}) {
  if (!fresh && readinessCache && Date.now() - readinessCache.at < READINESS_TTL_MS) {
    // Recompute the envelope so a login that started or expired since the read
    // is reflected without paying for another round trip — but keep the ORIGINAL
    // `checkedAt`, or a cache hit would claim a freshness it does not have.
    return { ...buildReadiness(readinessCache.readiness), checkedAt: readinessCache.readiness.checkedAt };
  }
  const readiness = await readReadiness();
  readinessCache = { at: Date.now(), readiness };
  return readiness;
}

/**
 * The cached readiness, or `null` when nothing has probed it yet.
 *
 * Spawns nothing and awaits nothing, so `GET /api/providers` can decorate cards
 * with it on a hot cache while a cold one publishes an honest "unprobed"
 * instead of an accusation.
 */
export function peekCodexAccountReadiness() {
  if (!readinessCache) return null;
  if (Date.now() - readinessCache.at >= READINESS_TTL_MS) return null;
  return readinessCache.readiness;
}

/**
 * Start an explicit ChatGPT sign-in and hand back only what the browser needs.
 *
 * Never called implicitly: an OAuth flow is a user action, so this runs from a
 * POST and from nowhere else. A second call while one is pending is refused
 * rather than silently replacing it — two live `loginId`s would leave the
 * completion notification unable to say which flow finished.
 *
 * @param {object} [options]
 * @param {boolean} [options.deviceCode] — use the device-code flow (a URL plus
 *   a short code) instead of opening a browser URL directly.
 */
export async function startCodexChatGptLogin({ deviceCode = false } = {}) {
  if (pendingLogin) {
    throw codexError(CODEX_ERROR_CODES.loginFailed, 'A ChatGPT sign-in is already in progress. Finish or cancel it first.', { status: 409 });
  }
  const result = await call(CODEX_RPC.loginStart, { type: deviceCode ? 'chatgptDeviceCode' : 'chatgpt' });
  const login = normalizeCodexLoginStart(result);
  const startedAt = Date.now();
  const timer = setTimeout(() => {
    readinessCache = null;
    settleLogin('timed out');
  }, LOGIN_TIMEOUT_MS);
  timer.unref?.();
  pendingLogin = { loginId: login.loginId, startedAt, expiresAt: startedAt + LOGIN_TIMEOUT_MS, timer };
  readinessCache = null;
  console.log('🔑 Codex ChatGPT sign-in started');
  return { ...login, startedAt, expiresAt: startedAt + LOGIN_TIMEOUT_MS };
}

/**
 * Cancel the sign-in this PortOS started.
 *
 * The id is checked against the pending login before anything is sent, so a
 * stale page cannot cancel a flow the user started afterwards.
 */
export async function cancelCodexChatGptLogin(loginId) {
  if (!pendingLogin || pendingLogin.loginId !== loginId) {
    throw codexError(CODEX_ERROR_CODES.unknownLogin, 'That ChatGPT sign-in is no longer in progress.', { status: 409 });
  }
  try {
    await call(CODEX_RPC.loginCancel, { loginId });
  } finally {
    // The flow is over for PortOS either way: a cancel the app-server refused
    // must not strand the card in `login-pending` forever.
    settleLogin('cancelled');
    readinessCache = null;
  }
  return getCodexAccountReadiness({ fresh: true });
}

/** Sign out of ChatGPT. Codex drops its own credentials; PortOS holds none. */
export async function codexLogout() {
  await call(CODEX_RPC.logout);
  settleLogin('ended by sign-out');
  readinessCache = null;
  modelsCache = null;
  // Signing out invalidates whatever the bench was waiting on, and signing back
  // in must not inherit the previous account's cooldown.
  clearCodexTextTransportBench();
  console.log('🔒 Codex ChatGPT account signed out');
  return getCodexAccountReadiness({ fresh: true });
}

/* ------------------------------------------------------------------------- *
 * Text inference (#5590)
 *
 * Everything below serves the SUBSCRIPTION TEXT TRANSPORT — the second, opt-in
 * capability of the `codex` provider record. It is deliberately separate from
 * the CLI/TUI coding harness: a Brain or JIRA summary runs here, in an empty
 * throwaway directory under a read-only no-network sandbox with no MCP servers
 * and no web search, while a CoS coding task keeps going through
 * `executeCliRun` with the workspace it was given.
 * ------------------------------------------------------------------------- */

/** A turn is a network round trip against a frontier model — not a local read. */
const TURN_TIMEOUT_MS = 300_000;
/** The catalog changes when a plan does. Long enough to not re-list per call. */
const MODELS_TTL_MS = 10 * 60_000;
/** A real catalog is tens of models; this only bounds a misbehaving server. */
const MODEL_LIST_MAX_PAGES = 20;

/**
 * The empty directory every generic text turn runs in.
 *
 * Outside the PortOS checkout and outside `data/`, so even a sandbox escape
 * would land somewhere with nothing in it. Created once per process and reused;
 * `mkdtemp` guarantees it is fresh and unshared.
 */
const ensureTextTurnCwd = async () => {
  if (textTurnCwd) return textTurnCwd;
  // Coalesced the same way `connect()` is: two turns starting together would
  // otherwise each `mkdtemp`, and the loser's directory would leak for the life
  // of the process because only one path can be remembered.
  if (!creatingTextTurnCwd) {
    creatingTextTurnCwd = mkdtemp(join(tmpdir(), 'portos-codex-text-'))
      .then((dir) => { textTurnCwd = dir; return dir; })
      .finally(() => { creatingTextTurnCwd = null; });
  }
  return creatingTextTurnCwd;
};

/**
 * Is the text transport benched right now?
 *
 * Returns `null` when it is usable, or `{ until, category, message }` while a
 * quota/auth failure is still in its cooldown. Benching is SCOPED TO THE
 * TRANSPORT on purpose: an exhausted subscription window must not take the
 * `codex` coding harness — which the user may still want for a task that is
 * already mid-flight — off the board as a side effect.
 */
export function getCodexTextTransportBench() {
  if (!textTransportBench) return null;
  if (Date.now() >= textTransportBench.until) {
    textTransportBench = null;
    return null;
  }
  return { ...textTransportBench };
}

/**
 * Bench the text transport for `waitMs`.
 *
 * The DURATION is the caller's, resolved from the shared cooldown policy in
 * `lib/providerCooldown.js`, so a quota exhaustion waits the same window here
 * as it does on every other path. A longer bench never shortens an existing
 * one.
 */
export function benchCodexTextTransport({ waitMs, category, message } = {}) {
  const until = Date.now() + Math.max(Number(waitMs) || 0, 0);
  if (textTransportBench && textTransportBench.until >= until) return getCodexTextTransportBench();
  textTransportBench = { until, category: category || null, message: message || null };
  console.log(`⚠️ Codex subscription text transport benched for ${Math.round((until - Date.now()) / 60000)}m: ${category || 'unknown'}`);
  return getCodexTextTransportBench();
}

/** Clear the bench — used when the account is re-read as ready, and by tests. */
export function clearCodexTextTransportBench() {
  textTransportBench = null;
}

/**
 * The models this ChatGPT account may run, from the app-server catalog.
 *
 * `null` means NEVER FETCHED and `[]` means fetched-and-empty; a failed read
 * returns the last-known-good list rather than either. That distinction is what
 * lets the Providers page tell "we have not asked yet" from "this plan really
 * has no models", and stops one transient failure from emptying a good picker.
 *
 * LAZY: only an explicit request reaches this. Nothing on the boot path may.
 */
export async function listCodexModels({ fresh = false } = {}) {
  if (!fresh && modelsCache && Date.now() - modelsCache.at < MODELS_TTL_MS) {
    return { models: modelsCache.models, fetchedAt: modelsCache.at, error: null };
  }
  try {
    // Follow `nextCursor`. A truncated catalog is not just a short picker: a
    // model on a later page is absent from `cachedModelEntry`, so its effort is
    // sent unclamped — the exact failure the clamp exists to prevent. The page
    // cap bounds a server that never stops handing back a cursor.
    const models = [];
    let cursor = null;
    for (let page = 0; page < MODEL_LIST_MAX_PAGES; page += 1) {
      const result = normalizeCodexModels(await call(CODEX_TURN_RPC.modelList, cursor ? { cursor } : {}));
      models.push(...result.models);
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    if (cursor) console.error(`❌ Codex model/list stopped after ${MODEL_LIST_MAX_PAGES} pages with a cursor still pending`);
    modelsCache = { at: Date.now(), models };
    return { models, fetchedAt: modelsCache.at, error: null };
  } catch (err) {
    console.error(`❌ Codex model/list failed: ${err.message}`);
    return {
      models: modelsCache ? modelsCache.models : null,
      fetchedAt: modelsCache ? modelsCache.at : null,
      error: { code: err.code || CODEX_ERROR_CODES.protocol, message: err.message },
    };
  }
}

/** The cached catalog without spawning anything. `null` = never fetched. */
export function peekCodexModels() {
  return modelsCache ? { models: modelsCache.models, fetchedAt: modelsCache.at } : null;
}

/** The catalog entry for `modelId`, or `null` when the catalog is unknown. */
const cachedModelEntry = (modelId) => {
  if (!modelId || !modelsCache?.models) return null;
  return modelsCache.models.find((entry) => entry.id === modelId) ?? null;
};

/**
 * Run ONE bounded text turn against the ChatGPT subscription.
 *
 * Resolves `{ text, usage, model, effort, effortClamped }`, or rejects with a
 * typed `ServerError`. It never resolves with partial text: an interrupted or
 * failed turn rejects, so a caller parsing JSON can't be handed half an object.
 *
 * @param {object} options
 * @param {string} options.prompt — the only thing the model is given
 * @param {string|null} [options.model] — a catalog id; null uses Codex's default
 * @param {string|null} [options.effort] — clamped against the model's catalog entry
 * @param {number} [options.timeoutMs]
 * @param {AbortSignal|null} [options.signal] — aborting interrupts the turn
 * @param {(delta: string) => void} [options.onDelta] — live progress
 * @param {object|null} [options.responseSchema] — JSON Schema constraining the
 *   final assistant message, when the caller needs structured output
 */
export async function runCodexTextTurn({
  prompt,
  model = null,
  effort = null,
  timeoutMs = TURN_TIMEOUT_MS,
  signal = null,
  onDelta = null,
  responseSchema = null,
} = {}) {
  if (typeof prompt !== 'string' || prompt.trim() === '') {
    throw codexError(CODEX_ERROR_CODES.protocol, 'A Codex text turn needs a prompt.', { status: 400 });
  }
  // An already-aborted signal fires no 'abort' event when a listener is added
  // later, so the caller's cancellation has to be honoured here or the turn runs
  // (and bills) for an answer nobody is waiting for.
  if (signal?.aborted) {
    throw codexError(CODEX_TURN_ERROR_CODES.turnInterrupted, 'The Codex turn was cancelled.', { status: 499 });
  }
  const benched = getCodexTextTransportBench();
  if (benched) {
    throw codexError(
      CODEX_TURN_ERROR_CODES.transportBenched,
      benched.message || 'The ChatGPT subscription is temporarily unavailable.',
      { status: 503, context: { category: benched.category, until: benched.until } },
    );
  }

  const cwd = await ensureTextTurnCwd();
  const { effort: resolvedEffort, clamped, reason } = resolveCodexEffort(effort, cachedModelEntry(model));
  if (clamped) console.log(`⚠️ Codex effort clamped: ${reason}`);

  const started = await call(CODEX_TURN_RPC.threadStart, {
    ...CODEX_TEXT_THREAD_CONFIG,
    cwd,
    ...(model ? { model } : {}),
  });
  const threadId = typeof started?.thread?.id === 'string' ? started.thread.id : null;
  if (!threadId) {
    throw codexError(CODEX_ERROR_CODES.protocol, 'Codex started a thread with no id.');
  }

  const acc = createTurnAccumulator({ threadId });
  let settle = null;
  let fail = null;
  const finished = new Promise((resolve, reject) => { settle = resolve; fail = reject; });
  // `finished` is not awaited until `turn/start` answers, and it can be rejected
  // before then (a lost child, an abort, the deadline). Without this parked
  // handler that rejection is an UNHANDLED one — which is a process-level crash
  // under Node's default policy, not a test-only nuisance. The real error still
  // surfaces from the `await finished` below.
  finished.catch(() => {});
  // Registered BEFORE `turn/start` is sent: the first delta can arrive before
  // that request's own response does, and an unregistered thread drops frames.
  activeTurns.set(threadId, {
    acc,
    settle: () => settle(),
    fail: (err) => fail(err),
    onDelta: typeof onDelta === 'function' ? onDelta : null,
  });

  const timer = setTimeout(() => {
    fail(codexError(CODEX_ERROR_CODES.timeout, `The Codex turn did not finish within ${Math.round(timeoutMs / 1000)}s.`));
  }, timeoutMs);
  timer.unref?.();

  const onAbort = () => fail(codexError(CODEX_TURN_ERROR_CODES.turnInterrupted, 'The Codex turn was cancelled.', { status: 499 }));
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const response = await call(CODEX_TURN_RPC.turnStart, {
      threadId,
      input: [{ type: 'text', text: prompt }],
      sandboxPolicy: { ...CODEX_TEXT_TURN_SANDBOX },
      approvalPolicy: CODEX_TEXT_THREAD_CONFIG.approvalPolicy,
      ...(model ? { model } : {}),
      ...(resolvedEffort ? { effort: resolvedEffort } : {}),
      ...(responseSchema ? { outputSchema: responseSchema } : {}),
    }, timeoutMs);
    const turnId = typeof response?.turn?.id === 'string' ? response.turn.id : null;
    if (turnId) acc.turnId = turnId;
    // A turn that completed before its own response was read leaves the
    // accumulator terminal with nobody to settle it.
    if (acc.status !== 'inProgress') settle();

    await finished;
    const result = finalizeCodexTurn(acc);
    if (result.error) {
      throw codexError(
        result.canceled ? CODEX_TURN_ERROR_CODES.turnInterrupted : CODEX_TURN_ERROR_CODES.turnFailed,
        result.error,
        { context: { category: result.category } },
      );
    }
    // The model Codex ACTUALLY ran, which is the thread's answer rather than the
    // request's — a caller that passed `null` still gets told what served it.
    const ranModel = typeof started.model === 'string' && started.model ? started.model : (model ?? null);
    return { ...result, model: ranModel, effort: resolvedEffort, effortClamped: clamped, clampReason: reason };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    activeTurns.delete(threadId);
    // Best-effort: tell the app-server to stop working a turn PortOS has
    // abandoned, so a cancelled request does not keep burning subscription
    // quota. A thread that already completed answers with an error we ignore.
    if (acc.status === 'inProgress' && acc.turnId) {
      call(CODEX_TURN_RPC.turnInterrupt, { threadId, turnId: acc.turnId })
        .catch((err) => console.error(`❌ Codex turn interrupt failed: ${err.message}`));
    }
  }
}

/**
 * Terminate the app-server child, if one is running.
 *
 * Registered with the graceful-shutdown sequence so PortOS never leaves an
 * orphaned Codex process behind. Safe to call when nothing is running.
 */
export async function stopCodexAppServer() {
  settleLogin(null);
  readinessCache = null;
  modelsCache = null;
  const scratch = textTurnCwd;
  textTurnCwd = null;
  creatingTextTurnCwd = null;
  if (scratch) {
    await rm(scratch, { recursive: true, force: true })
      .catch((err) => console.error(`❌ Failed to remove the Codex text scratch directory: ${err.message}`));
  }
  const target = connection || connectingTarget;
  connection = null;
  if (!target || target.closed) return;
  stopTarget(target, codexError(CODEX_ERROR_CODES.exited, 'PortOS is shutting down the Codex app-server.'));
  console.log('🔌 Codex app-server stopped');
}

/** Test-only: drop every module-level handle so a suite starts clean. */
export function __resetCodexAppServer() {
  if (pendingLogin) clearTimeout(pendingLogin.timer);
  pendingLogin = null;
  readinessCache = null;
  connection = null;
  connecting = null;
  connectingTarget = null;
  activeTurns.clear();
  modelsCache = null;
  textTransportBench = null;
  textTurnCwd = null;
  creatingTextTurnCwd = null;
}
