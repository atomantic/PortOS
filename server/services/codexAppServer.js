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
  redactCodexPayload,
} from '../lib/codexAccount.js';

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
  for (const entry of pendingEntries) entry.reject(error);
  if (connection === target) connection = null;
};

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
  settleLogin(params?.success === false ? 'failed' : 'completed');
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
    const message = typeof frame.error?.message === 'string' ? frame.error.message : 'Codex app-server returned an error';
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
  console.log('🔒 Codex ChatGPT account signed out');
  return getCodexAccountReadiness({ fresh: true });
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
}
