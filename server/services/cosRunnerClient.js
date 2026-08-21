/**
 * CoS Runner Client
 *
 * Communicates with the standalone portos-cos PM2 process
 * that manages agent spawning to prevent orphaned processes.
 */

import { io } from 'socket.io-client';
import { fetchWithTimeout } from '../lib/fetchWithTimeout.js';
import { readResponseJson } from '../lib/readResponseJson.js';
import { PORTS } from '../lib/ports.js';

const COS_RUNNER_URL = process.env.COS_RUNNER_URL || `http://localhost:${PORTS.COS}`;

/**
 * Read a runner response body as JSON, tolerating a non-JSON body.
 *
 * The runner can answer with an HTML error page (e.g. a 500 while PM2 is
 * restarting it mid-request) instead of JSON, which would crash a bare
 * `response.json()` with `Unexpected token <`. The non-JSON fallback surfaces
 * the runner's raw message as `{ error: <raw text> }` so callers throw a useful
 * error; an empty body returns `{}` (the shared helper's `emptyValue`), distinct
 * from a parse failure, so spreading callers like `getRunnerHealth` don't pick
 * up a spurious `error`.
 */
const readRunnerJson = (response) =>
  readResponseJson(response, { fallback: (text) => ({ error: text.trim() }) });

// Socket.IO client for real-time events
let socket = null;
// Map of event name -> array of handlers (supports multiple listeners per event)
const eventHandlers = new Map();
// Runner-owned TUI PTYs are represented locally by small node-pty-compatible
// proxies. The callbacks survive Socket.IO reconnects within this server
// process; after a full server restart, runner-agent reconciliation owns the
// still-running process and its eventual completion.
const tuiSessions = new Map();

const dispatchTuiEvent = (event, data) => {
  const session = tuiSessions.get(data?.sessionId);
  if (!session) return;
  const handlers = event === 'tui:output' ? session.dataHandlers : session.exitHandlers;
  for (const handler of handlers) {
    try {
      const result = handler(event === 'tui:output'
        ? data.data
        : {
          exitCode: data.exitCode,
          signal: data.signal,
          ...(typeof data.outputTail === 'string' && data.outputTail ? { outputTail: data.outputTail } : {}),
        });
      if (result && typeof result.then === 'function') {
        result.catch(err => console.error(`🔌 CoS runner ${event} handler rejected: ${err.message}`));
      }
    } catch (err) {
      console.error(`🔌 CoS runner ${event} handler threw: ${err.message}`);
    }
  }
  if (event === 'tui:exit') tuiSessions.delete(data.sessionId);
};

const createTuiProxy = (sessionId, pid, state) => {
  const subscribe = (handlers, handler) => {
    handlers.add(handler);
    return { dispose: () => handlers.delete(handler) };
  };
  const emitControl = (event, payload = {}) => {
    if (!socket?.connected) {
      state.pendingControls.push({ event, payload });
      return true;
    }
    socket.emit(event, { sessionId, ...payload });
    return true;
  };
  return {
    sessionId,
    pid,
    ptyProcess: {
      pid,
      onData: (handler) => subscribe(state.dataHandlers, handler),
      onExit: (handler) => subscribe(state.exitHandlers, handler),
      write: (data) => emitControl('tui:input', { data }),
      resize: (cols, rows) => emitControl('tui:resize', { cols, rows }),
      kill: (signal = 'SIGTERM') => emitControl('tui:kill', { signal }),
    },
  };
};

/**
 * Initialize connection to CoS Runner
 */
export function initCosRunnerConnection() {
  if (socket) return;

  // Reconnect FOREVER. The runner is a separate PM2 app the user can stop from
  // the Apps page (or that PM2 can hold down through a long restart), and it is
  // the only transport for `agent:output` / `agent:completed`. A finite attempt
  // budget — this was 10 attempts at 1s, so ~10 seconds — permanently gave up on
  // a runner that came back a minute later, leaving this server connected to
  // nothing while `useRunner` still routed every spawn at it. The capped backoff
  // keeps a long outage cheap (one probe every 10s) instead of a 1s hot loop.
  socket = io(COS_RUNNER_URL, {
    reconnection: true,
    reconnectionAttempts: Infinity,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 10000
  });

  const dispatch = (event, data) => {
    const handlers = eventHandlers.get(event);
    if (!handlers) return;
    for (const h of handlers) {
      // Guard against sync throws and async rejections so a single bad handler
      // can't crash the process via unhandledRejection.
      try {
        const ret = h(data);
        if (ret && typeof ret.then === 'function') {
          ret.catch(err => console.error(`🔌 CoS runner handler for ${event} rejected: ${err.message}`));
        }
      } catch (err) {
        console.error(`🔌 CoS runner handler for ${event} threw: ${err.message}`);
      }
    }
  };

  // One connection-error line per outage, not one per retry. The socket is now
  // opened unconditionally (issue #4134) so a promotion can happen when the
  // runner comes up later — which means an install whose runner is simply off
  // would otherwise log a `connect_error` every 10s, forever. Reset on connect
  // so the NEXT outage is reported again.
  let connectErrorLogged = false;

  socket.on('connect', () => {
    connectErrorLogged = false;
    console.log('🔌 Connected to CoS Runner');
    for (const [sessionId, state] of tuiSessions) {
      for (const { event, payload } of state.pendingControls.splice(0)) {
        socket.emit(event, { sessionId, ...payload });
      }
    }
    dispatch('connection:ready', undefined);
  });

  socket.on('disconnect', () => {
    console.log('🔌 Disconnected from CoS Runner');
    dispatch('connection:lost', undefined);
  });

  socket.on('connect_error', (err) => {
    if (connectErrorLogged) return;
    connectErrorLogged = true;
    console.error(`🔌 CoS Runner connection error: ${err.message} — retrying until it answers`);
  });

  // Forward events to registered handlers
  socket.on('agent:output', (data) => dispatch('agent:output', data));
  socket.on('agent:completed', (data) => dispatch('agent:completed', data));
  socket.on('agent:error', (data) => dispatch('agent:error', data));
  socket.on('agent:btw', (data) => dispatch('agent:btw', data));
  socket.on('tui:output', (data) => dispatchTuiEvent('tui:output', data));
  socket.on('tui:exit', (data) => dispatchTuiEvent('tui:exit', data));

  // Batch orphaned agents event (startup cleanup)
  socket.on('agents:orphaned', (data) => dispatch('agents:orphaned', data));
}

/**
 * How a runner SPAWN rpc failed (#4615).
 *
 * `refused` — the runner DECIDED against the request: a 4xx, which its spawn
 * routes only ever answer from up-front validation (command missing from the
 * allowlist, malformed args, an agent id already running, an executable that
 * fails the preflight). Nothing was forked, so the caller may safely record
 * that the run never started.
 *
 * `ambiguous` — everything else. No answer at all (a socket reset, the request
 * timeout, a response lost in flight) AND a 5xx: `POST /spawn` registers and
 * forks the child before its final state persist, so an internal error can be
 * answered with a process already running. "The runner never took it" and "the
 * runner took it and the acknowledgement was lost" are indistinguishable from
 * this side, and recording the second as a refusal is what leaves a live agent
 * running in the runner with nothing on the server tracking it — surfacing ~15
 * minutes later as an orphan attributed to the wrong cause.
 *
 * Anything UNLABELED classifies as ambiguous: only a 4xx is evidence of a
 * refusal, so absence of evidence must not become one.
 */
export const RUNNER_SPAWN_REFUSED = 'refused';
export const RUNNER_SPAWN_AMBIGUOUS = 'ambiguous';

/** @returns {'refused'|'ambiguous'} how a spawn rpc rejection should be read */
export const classifyRunnerSpawnFailure = (err) =>
  err?.spawnOutcome === RUNNER_SPAWN_REFUSED ? RUNNER_SPAWN_REFUSED : RUNNER_SPAWN_AMBIGUOUS;

/** The runner answered a non-2xx. Only the 4xx half is a decision — see above. */
const answeredSpawnFailure = (message, status) =>
  Object.assign(new Error(message), {
    spawnOutcome: status >= 400 && status < 500 ? RUNNER_SPAWN_REFUSED : RUNNER_SPAWN_AMBIGUOUS,
    status,
  });

const ambiguousSpawn = (err) => {
  const error = err instanceof Error ? err : new Error(String(err));
  error.spawnOutcome = RUNNER_SPAWN_AMBIGUOUS;
  return error;
};

/**
 * Run a spawn POST, splitting a transport failure from an answer.
 * `{ response }` — the runner answered (2xx or not). `{ transportError }` — it
 * did not, which is the ambiguous case above.
 */
const postSpawn = (path, body) =>
  fetchWithTimeout(`${COS_RUNNER_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, 60000).then(
    response => ({ response }),
    err => ({ transportError: ambiguousSpawn(err) })
  );

/**
 * Does the runner have this agent after all? (#4615)
 *
 * The runner's own `/agents` view is the authority on what it is running —
 * `syncRunnerAgents` already adopts from it after a server restart, and this is
 * the same adoption a half-second earlier. A probe that cannot be answered
 * returns null: an unanswerable question is not evidence the agent is alive,
 * and the caller falls through to the failure it already had.
 *
 * Presence in the runner's map is the whole test; the row's `processActive` is
 * deliberately NOT required. It comes from a `ps` probe that reports `dead` for
 * an exec failure as well as for a real exit, so gating on it would let a
 * flaky `ps` reject a live agent — reintroducing exactly the orphan this
 * reconcile removes. Adopting a row whose process has just exited is harmless
 * here: the caller registered its local ownership BEFORE the spawn rpc, so no
 * completion event can have been dropped for want of an entry.
 */
const findLiveRunnerAgent = async (agentId) => {
  const agents = await getActiveAgentsFromRunner().catch(err => {
    console.error(`🔌 CoS runner spawn reconcile failed for ${agentId}: ${err.message}`);
    return [];
  });
  return (Array.isArray(agents) ? agents : []).find(agent => agent?.id === agentId) || null;
};

/**
 * Resolve an ambiguous spawn failure by asking the runner (#4615).
 *
 * `adopt(live)` builds the caller's normal success value from the runner's
 * record, or returns null when the record can't be the agent we spawned (a
 * `kind` mismatch). Adoption is stamped so the caller can record in the ledger
 * that this handoff was recovered rather than acknowledged. When the runner
 * does not have the agent, the original transport error is rethrown and the
 * caller's existing failure path runs unchanged.
 */
const reconcileAmbiguousSpawn = async (agentId, failure, adopt) => {
  const live = await findLiveRunnerAgent(agentId);
  const adopted = live ? adopt(live) : null;
  if (!adopted) throw failure;
  console.log(`🔁 CoS runner spawn ack lost for ${agentId} (${failure.message}); adopted its live process (PID: ${live.pid})`);
  return { ...adopted, adopted: true, adoptedReason: failure.message };
};

/**
 * The single resolution point for a failed spawn rpc: a refusal is final, an
 * ambiguous failure gets the reconcile above first.
 */
const resolveSpawnFailure = (agentId, failure, adopt) =>
  classifyRunnerSpawnFailure(failure) === RUNNER_SPAWN_REFUSED
    ? Promise.reject(failure)
    : reconcileAmbiguousSpawn(agentId, failure, adopt);

/**
 * Re-key the local relay onto the session id the runner reports and hand back a
 * proxy over the SAME handler state, so the `onData`/`onExit` callbacks
 * registered before the lost acknowledgement keep receiving the live PTY.
 */
const adoptTuiRelay = (live, sessionId, state) => {
  const liveSessionId = live.sessionId || sessionId;
  if (liveSessionId !== sessionId) tuiSessions.delete(sessionId);
  tuiSessions.set(liveSessionId, state);
  return createTuiProxy(liveSessionId, live.pid ?? null, state);
};

/**
 * Spawn a TUI PTY in the durable CoS runner and return a node-pty-compatible
 * proxy used by the existing Shell/TUI orchestration.
 */
export async function spawnTuiSessionViaRunner(options) {
  const { onData, onExit, ...requestOptions } = options;
  const sessionId = requestOptions.sessionId || requestOptions.agentId;
  const state = {
    dataHandlers: new Set(onData ? [onData] : []),
    exitHandlers: new Set(onExit ? [onExit] : []),
    pendingControls: [],
  };
  tuiSessions.set(sessionId, state);
  const { response, transportError } = await postSpawn('/spawn-tui', { ...requestOptions, sessionId });
  const failure = transportError || (response.ok
    ? null
    : answeredSpawnFailure(
      (await readRunnerJson(response)).error || 'Failed to spawn runner-owned TUI session',
      response.status
    ));
  if (failure) {
    // The relay state stays registered across the reconcile: if the runner DOES
    // have the PTY, its `tui:output` events must still find these handlers. It
    // is only torn down once adoption is ruled out.
    return resolveSpawnFailure(
      requestOptions.agentId || sessionId,
      failure,
      live => (live.kind === 'tui' ? adoptTuiRelay(live, sessionId, state) : null)
    ).catch(err => {
      tuiSessions.delete(sessionId);
      throw err;
    });
  }

  const result = await readRunnerJson(response);
  const pid = result.pid;

  return createTuiProxy(sessionId, pid, state);
}

/**
 * Recreate the local relay for a TUI that survived a portos-server restart.
 */
export function connectTuiSessionViaRunner({ sessionId, pid }) {
  const state = tuiSessions.get(sessionId) || {
    dataHandlers: new Set(),
    exitHandlers: new Set(),
    pendingControls: [],
  };
  tuiSessions.set(sessionId, state);
  return createTuiProxy(sessionId, pid, state);
}

/**
 * Register event handler (multiple handlers per event are supported)
 */
export function onCosRunnerEvent(event, handler) {
  if (!eventHandlers.has(event)) eventHandlers.set(event, []);
  eventHandlers.get(event).push(handler);
}

/**
 * The one `GET /health` every liveness question in this module goes through.
 * Resolves the raw response (or null if the runner never answered) — callers
 * decide whether they want the boolean or the parsed body.
 */
const probeRunnerHealth = (timeoutMs) =>
  fetchWithTimeout(`${COS_RUNNER_URL}/health`, {}, timeoutMs)
    .then(response => (response?.ok ? response : null), () => null);

/**
 * Check if CoS Runner is available.
 *
 * The COLD-START SEED for the mode decision (`setUseRunner`), taken before any
 * socket exists, which is why it probes rather than reading `socket.connected`
 * the way `isRunnerReachable` does. The generous timeout is deliberate: during a
 * rolling PM2 start the runner can be slow to answer, and a premature `false`
 * here starts the process in direct mode. It no longer strands it there —
 * `connection:ready` promotes the process the moment the socket lands (#4134) —
 * but every task dispatched in the meantime is spawned as a child of this
 * server, so the seed is still worth getting right.
 */
export async function isRunnerAvailable() {
  return (await probeRunnerHealth(10000)) !== null;
}

/**
 * Is the runner reachable right now?
 *
 * Answered for free from the socket this module already owns: in runner mode it
 * is connected whenever the runner is up, and socket.io flips the flag the
 * moment the runner goes away — no HTTP round-trip on the path that asks this
 * most (a dequeue during an outage). The probe is only the cold path, for a
 * caller asking before `initCosRunnerConnection()` has ever run.
 *
 * Caveat worth knowing: after a hard SIGKILL the flag can read `true` until
 * socket.io's ping window closes. A graceful `pm2 stop` — the case this exists
 * for — disconnects immediately.
 */
export async function isRunnerReachable() {
  if (socket) return socket.connected;
  return (await probeRunnerHealth(2000)) !== null;
}

/**
 * Get runner health status
 */
export async function getRunnerHealth() {
  const response = await probeRunnerHealth(10000);
  if (!response) {
    return { available: false, error: 'Runner not available' };
  }
  const data = await readRunnerJson(response);
  return { available: true, ...data };
}

/**
 * Spawn an agent via the CoS Runner
 */
export async function spawnAgentViaRunner(options) {
  const {
    agentId,
    taskId,
    prompt,
    workspacePath,
    model,
    envVars,
    // New: CLI-agnostic parameters
    cliCommand,
    cliArgs,
    // Legacy (deprecated)
    claudePath
  } = options;

  const { response, transportError } = await postSpawn('/spawn', {
    agentId,
    taskId,
    prompt,
    workspacePath,
    model,
    envVars,
    cliCommand,
    cliArgs,
    claudePath
  });

  // Anything but a 4xx may have left a child running. Ask the runner before
  // letting the caller record that the run never started (#4615).
  const failure = transportError || (response.ok
    ? null
    : answeredSpawnFailure((await readRunnerJson(response)).error || 'Failed to spawn agent', response.status));
  if (failure) {
    return resolveSpawnFailure(
      agentId,
      failure,
      live => (live.kind === 'tui' ? null : { pid: live.pid ?? null })
    );
  }

  return readRunnerJson(response);
}

/**
 * Get list of active agents from runner
 */
export async function getActiveAgentsFromRunner() {
  const response = await fetchWithTimeout(`${COS_RUNNER_URL}/agents`, {}, 10000);
  if (!response.ok) {
    throw new Error('Failed to get agents');
  }
  return readRunnerJson(response);
}

/**
 * Terminate an agent via the runner (graceful SIGTERM with SIGKILL fallback)
 */
export async function terminateAgentViaRunner(agentId) {
  const response = await fetchWithTimeout(`${COS_RUNNER_URL}/terminate/${agentId}`, {
    method: 'POST'
  }, 30000);
  if (!response.ok) {
    const error = await readRunnerJson(response);
    // Preserve the runner's HTTP status so callers can distinguish a genuine
    // 404 (agent gone / runner restarted out of sync) from a 5xx infra failure.
    throw Object.assign(new Error(error.error || 'Failed to terminate agent'), { status: response.status });
  }
  return readRunnerJson(response);
}

/**
 * Force kill an agent via the runner (immediate SIGKILL)
 */
export async function killAgentViaRunner(agentId) {
  const response = await fetchWithTimeout(`${COS_RUNNER_URL}/kill/${agentId}`, {
    method: 'POST'
  }, 30000);
  if (!response.ok) {
    const error = await readRunnerJson(response);
    throw Object.assign(new Error(error.error || 'Failed to kill agent'), { status: response.status });
  }
  return readRunnerJson(response);
}

/**
 * Pause an agent via the runner without emitting normal completion cleanup.
 */
export async function pauseAgentViaRunner(agentId, reason = null) {
  const response = await fetchWithTimeout(`${COS_RUNNER_URL}/pause/${agentId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason })
  }, 30000);
  if (!response.ok) {
    const error = await readRunnerJson(response);
    throw Object.assign(new Error(error.error || 'Failed to pause agent'), { status: response.status });
  }
  return readRunnerJson(response);
}

/**
 * Get process stats for an agent
 */
export async function getAgentStatsFromRunner(agentId) {
  const response = await fetchWithTimeout(`${COS_RUNNER_URL}/agents/${agentId}/stats`, {}, 10000);
  if (!response.ok) {
    return null;
  }
  return readRunnerJson(response);
}

/**
 * Terminate all agents via the runner
 */
export async function terminateAllAgentsViaRunner() {
  const response = await fetchWithTimeout(`${COS_RUNNER_URL}/terminate-all`, {
    method: 'POST'
  }, 30000);
  if (!response.ok) {
    throw new Error('Failed to terminate agents');
  }
  return readRunnerJson(response);
}

/**
 * Get agent output from runner
 */
export async function getAgentOutputFromRunner(agentId) {
  const response = await fetchWithTimeout(`${COS_RUNNER_URL}/agents/${agentId}/output`, {}, 10000);
  if (!response.ok) {
    const error = await readRunnerJson(response);
    throw new Error(error.error || 'Failed to get agent output');
  }
  return readRunnerJson(response);
}
