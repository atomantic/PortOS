/**
 * Beeper realtime transport (#33, decided on #12).
 *
 * One long-lived WebSocket from the PortOS server to Beeper Desktop's local
 * `/v1/ws`. The browser cannot hold this connection itself — Beeper binds to
 * loopback with CORS locked to the machine, and a browser cannot set an
 * `Authorization` header on `new WebSocket()` — so the server owns the socket
 * and relays over Socket.IO (`socket.js`, the `beeper` subscriber set).
 *
 * **The `ws` package, not Node's built-in WHATWG `WebSocket`.** A live 105-second
 * probe (#12) recorded a protocol-level server ping at 10.5s and then every 30s,
 * which the research note said did not exist. That ping is the only liveness
 * signal Beeper offers, and the built-in WebSocket does not surface ping frames
 * to application code at all — which is why `moltworldWs.js` cannot be copied
 * here, only imitated. Its reconnect shape is still the model.
 *
 * **This socket is not the source of truth.** Delivery is at-most-once with no
 * replay on reconnect, `seq` is per connection, an event is silently skipped
 * when the message is not yet retrievable, and the window before
 * `subscriptions.updated` is dark. Correctness comes from #32's HTTP sweep; the
 * socket only makes ingestion prompt, and asks the sweep to run early on the
 * three occasions frames could have been lost:
 *   - a reconnect (anything during the outage is gone),
 *   - a `seq` gap (frames dropped while the socket still looked healthy),
 *   - a recovery from an actionable `app.state` (the install was broken).
 *
 * **Never gated on `app.state`.** The probe measured it reporting `initializing`
 * for 105 continuous seconds while nine accounts were connected and a chat page
 * returned in 230ms. It is a display input for the settings card, never a gate.
 *
 * **Two gates, and the transport and the sweep sit behind different ones (#11).**
 *   - `isBeeperIngestionArmed()` — the instance FEATURE plus a stored token —
 *     arms the TRANSPORT. Holding the socket open writes nothing: it only feeds
 *     the settings card's liveness dot and its actionable `app.state` line,
 *     which is the surface a user needs precisely when they are deciding
 *     whether to turn ingestion on. So the connection is deliberately kept.
 *   - `settings.beeper.enabled` ("Enable scheduled Beeper sync", default OFF)
 *     is the user's ingestion opt-in, and it gates every `runBeeperSweep` call
 *     from here — re-read at EVERY trigger, exactly as
 *     `createSettingsGatedSyncScheduler.js` re-reads it on every tick, so
 *     flipping the toggle off mid-session stops sweeps without a restart.
 *     With it off the socket connects, subscribes and relays invalidations, and
 *     never writes a conversation or a message body to Postgres.
 *
 * Everything below runs OUTSIDE the Express request lifecycle — socket callbacks
 * and timers — so hook bodies catch and log rather than letting a throw take the
 * process down, per root AGENTS.md.
 */

import WebSocket from 'ws';
import { beeperSocketEvents } from './beeperSocketEvents.js';
import { DEFAULT_BASE_URL, resolveBeeperConfig } from './beeperClient.js';
import { getBeeperSyncConfig, isBeeperIngestionArmed, runBeeperSweep } from './beeperSync.js';

const LOG_PREFIX = '🫧 Beeper socket';

// 2.5 missed server pings. Tight enough that the liveness dot cannot lie for
// long, loose enough to survive one late ping (#12 decision 5).
export const SILENCE_TIMEOUT_MS = 75_000;
const BASE_RECONNECT_DELAY_MS = 1_000;
const MAX_RECONNECT_DELAY_MS = 60_000;

// Beeper Desktop simply being closed is the common case, and at the 60s ceiling
// an unbounded loop writes a line a minute forever. The first few attempts are
// the diagnostic ones; after that only every 10th is narrated.
const VERBOSE_RECONNECT_ATTEMPTS = 3;
const QUIET_RECONNECT_LOG_EVERY = 10;

// The four domain events, all with the same flat frame: `type`, `seq`, `ts`,
// `chatID`, `ids` required, `entries` OPTIONAL on every one of them (not only
// on deletes, as the research note recorded). `entries` is deliberately never
// read — see `toInvalidation` below.
const DOMAIN_EVENT_TYPES = new Set(['chat.upserted', 'chat.deleted', 'message.upserted', 'message.deleted']);

// The `app.state` values that mean a human has to do something. `initializing`
// and `needs-first-sync` are explicitly NOT in this set: the probe caught
// `initializing` lying for the whole session on a working install.
const ACTIONABLE_APP_STATES = new Set([
  'needs-login', 'needs-cross-signing-setup', 'needs-verification', 'needs-secrets',
]);

const DEFAULT_RUNTIME = Object.freeze({
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle),
  random: () => Math.random(),
  createSocket: (url, options) => new WebSocket(url, options),
});

let runtime = { ...DEFAULT_RUNTIME };
let socket = null;
let watchdogTimer = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
let connectionCount = 0;
let running = false;
let connectionState = 'down';
let lastEventAt = null;
let lastPingAt = null;
let lastSeq = null;
let appState = null;
let requestCounter = 0;
// Bumped by every `stopBeeperSocket()` so an in-flight `await` can tell that the
// session it belongs to was torn down while it was suspended.
let stopGeneration = 0;
let hasEverConnected = false;
let authRejected = false;

/**
 * `http://127.0.0.1:23373` → `ws://127.0.0.1:23373/v1/ws`. Exported for the
 * test; the path is not in Beeper's OpenAPI document, so it is hardcoded here
 * rather than discovered.
 */
export function beeperWebSocketUrl(baseUrl) {
  const trimmed = String(baseUrl || '').trim().replace(/\/+$/, '') || DEFAULT_BASE_URL;
  return `${trimmed.replace(/^https:\/\//i, 'wss://').replace(/^http:\/\//i, 'ws://')}/v1/ws`;
}

/**
 * The transport liveness snapshot. Four states, matching what the settings
 * card renders: `connected`, `connecting` (trying, never yet connected),
 * `reconnecting` (was connected, trying again), `down` (not armed, deliberately
 * stopped, or stood down after Beeper rejected the token).
 */
export function getBeeperRealtimeState() {
  return {
    state: connectionState,
    lastEventAt: lastEventAt === null ? null : new Date(lastEventAt).toISOString(),
    lastPingAt: lastPingAt === null ? null : new Date(lastPingAt).toISOString(),
    reconnectAttempts,
    appState,
    // The card's actionable-fault line: an `app.state` a human must act on.
    // Never `initializing`, which the probe proved is not evidence of anything.
    appStateActionable: appState !== null && ACTIONABLE_APP_STATES.has(appState),
    // Beeper answered the upgrade with 401/403: the stored token is not going
    // to start working, so the transport stood down rather than looping. The
    // settings card turns this into its own remedy line.
    authRejected,
  };
}

/** `connecting` until the first successful handshake of this session; `reconnecting` after. */
function pendingStateWord() {
  return hasEverConnected ? 'reconnecting' : 'connecting';
}

/**
 * The sweep's effective gate, re-read at EVERY trigger.
 *
 * `isBeeperIngestionArmed()` alone is only "may the sweep be armed at all"
 * (feature + token). The user's own `settings.beeper.enabled` opt-in is the
 * second gate, and `runBeeperSweep` does not check it itself — the scheduler
 * factory re-reads it on every tick for exactly this reason, so a socket
 * trigger re-reads it too and a mid-session toggle-off takes effect at once.
 */
async function isSweepEnabled() {
  if (!await isBeeperIngestionArmed()) return false;
  const { enabled } = await getBeeperSyncConfig();
  return enabled === true;
}

function emitState() {
  beeperSocketEvents.emit('state', getBeeperRealtimeState());
}

function setConnectionState(next) {
  if (connectionState === next) return;
  connectionState = next;
  console.log(`${LOG_PREFIX}: ${next}`);
  emitState();
}

function clearWatchdog() {
  if (watchdogTimer !== null) {
    runtime.clearTimeout(watchdogTimer);
    watchdogTimer = null;
  }
}

function clearReconnectTimer() {
  if (reconnectTimer !== null) {
    runtime.clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

/**
 * Re-arm the silence watchdog. Called from the connection attempt (so a
 * half-open TCP handshake trips too) and from every inbound signal — a ping
 * frame, a pong, or any message. `ws` auto-replies to a ping, so counting it as
 * liveness is exactly the measured heartbeat and needs no keepalive of our own.
 */
function armWatchdog() {
  clearWatchdog();
  watchdogTimer = runtime.setTimeout(() => {
    watchdogTimer = null;
    console.warn(`${LOG_PREFIX}: silent for ${SILENCE_TIMEOUT_MS / 1000}s — tearing down and reconnecting`);
    dropSocket();
    scheduleReconnect();
  }, SILENCE_TIMEOUT_MS);
  if (typeof watchdogTimer?.unref === 'function') watchdogTimer.unref();
}

function noteFrame() {
  lastEventAt = runtime.now();
  armWatchdog();
}

/**
 * Ask #32's watermark-bounded sweep to run now. Fire-and-forget with its own
 * catch: this is a timer/socket callback, so an unhandled rejection here would
 * be an unhandled rejection in the process, not a 500.
 */
function triggerSweep(reason) {
  Promise.resolve()
    .then(async () => {
      if (!await isSweepEnabled()) {
        // Debug level: with the toggle off this fires on every reconnect and
        // every seq gap, and it is the configured behaviour, not a fault.
        console.debug(`${LOG_PREFIX}: sweep (${reason}) skipped — scheduled Beeper sync is off`);
        return;
      }
      console.log(`${LOG_PREFIX}: requesting a sweep (${reason})`);
      await runBeeperSweep({ reason });
    })
    .catch((err) => console.error(`${LOG_PREFIX}: sweep (${reason}) failed: ${err?.message ?? err}`));
}

/**
 * Jittered exponential backoff: the delay lands in the top half of the
 * exponential window, so a fleet of retries cannot align on the same instant
 * and a single dead Beeper Desktop is not hammered at a fixed cadence.
 */
function nextReconnectDelayMs() {
  const capped = Math.min(BASE_RECONNECT_DELAY_MS * (2 ** reconnectAttempts), MAX_RECONNECT_DELAY_MS);
  return Math.round((capped / 2) + (runtime.random() * (capped / 2)));
}

/**
 * Whether this reconnect cycle gets logged. A closed Beeper Desktop reconnects
 * forever by design (it will be reopened), so the loop narrates the first few
 * attempts and then only every 10th.
 */
function shouldNarrateAttempt() {
  return reconnectAttempts <= VERBOSE_RECONNECT_ATTEMPTS
    || reconnectAttempts % QUIET_RECONNECT_LOG_EVERY === 0;
}

function scheduleReconnect() {
  if (!running) return;
  clearReconnectTimer();
  const delay = nextReconnectDelayMs();
  reconnectAttempts += 1;
  setConnectionState(pendingStateWord());
  if (shouldNarrateAttempt()) {
    console.log(`${LOG_PREFIX}: reconnecting in ${Math.round(delay / 1000)}s (attempt ${reconnectAttempts})`);
  }
  reconnectTimer = runtime.setTimeout(() => {
    reconnectTimer = null;
    // A rejected `connect()` (a credential read that throws — an unreadable
    // vault, not merely an absent token) must not silently end the reconnect
    // loop: without this catch the timer never fires again, yet
    // `getBeeperRealtimeState()` keeps reporting `reconnecting` for the life of
    // the process. Drop whatever half-open socket the attempt left behind and
    // schedule the next attempt exactly as a `close`/`error` event would.
    connect().catch((err) => {
      console.error(`${LOG_PREFIX}: reconnect failed: ${err?.message ?? err}`);
      dropSocket();
      scheduleReconnect();
    });
  }, delay);
  if (typeof reconnectTimer?.unref === 'function') reconnectTimer.unref();
}

function dropSocket() {
  clearWatchdog();
  const dying = socket;
  socket = null;
  if (!dying) return;
  dying.removeAllListeners?.();
  // `terminate()` is the `ws` escape hatch for a socket that may be half-open —
  // `close()` waits for a close handshake the dead peer will never send.
  if (typeof dying.terminate === 'function') dying.terminate();
  else dying.close?.();
}

// ---------------------------------------------------------------------------
// Frame handling
// ---------------------------------------------------------------------------

function toIsoTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value !== 'string' || !value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * The invalidation frame the browser gets — ids and kinds ONLY (#12 decision 3).
 *
 * Fields are picked EXPLICITLY, never spread: a Beeper domain frame may carry a
 * hydrated `entries` array with full message text, sender display names and
 * network handles, and none of that may leave this machine. The browser refetches
 * from the PortOS mirror instead, which also keeps "displayed" implying
 * "persisted" — a payload relay can render a message the mirror never committed.
 *
 * `ids` are message ids for `message.*` and chat ids for `chat.*`, matching the
 * frame's own shape.
 */
export function toInvalidation(frame) {
  return {
    kind: frame?.type ?? null,
    chatID: typeof frame?.chatID === 'string' ? frame.chatID : null,
    ids: Array.isArray(frame?.ids) ? frame.ids.filter((id) => typeof id === 'string') : [],
    seq: Number.isFinite(frame?.seq) ? frame.seq : null,
    ts: toIsoTimestamp(frame?.ts),
  };
}

/**
 * `seq` is a per-connection counter that spans every event type (the probe saw
 * `app.state.updated` arrive as `seq: 1`), so a jump means frames were dropped
 * while the socket still looked perfectly healthy — the one loss mode a
 * reconnect-triggered sweep would never notice.
 */
function checkSequence(frame) {
  if (!Number.isFinite(frame?.seq)) return;
  const seq = frame.seq;
  if (lastSeq !== null && seq > lastSeq + 1) {
    console.warn(`${LOG_PREFIX}: seq gap (${lastSeq} → ${seq}) — frames were dropped`);
    triggerSweep('socket-seq-gap');
  }
  lastSeq = seq;
}

function handleAppState(frame) {
  const next = typeof frame?.appState?.state === 'string' ? frame.appState.state : null;
  if (next === null || next === appState) return;
  const wasActionable = appState !== null && ACTIONABLE_APP_STATES.has(appState);
  appState = next;
  emitState();
  // A recovery FROM an actionable state means the install was broken and is now
  // working — whatever arrived while it was broken was never delivered here.
  if (wasActionable && !ACTIONABLE_APP_STATES.has(next)) triggerSweep('socket-app-state-recovery');
}

function sendSubscription(target) {
  requestCounter += 1;
  // `["*"]` plus app state, never a scoped chat set: `subscriptions.set`
  // replaces state wholesale and the window during a re-`set` is dark, so
  // re-subscribing on every conversation change would manufacture a loss window
  // on exactly the event you most want to catch — a brand new conversation.
  target.send(JSON.stringify({
    type: 'subscriptions.set',
    requestID: `portos-${requestCounter}`,
    chatIDs: ['*'],
    app: { state: true },
  }));
}

function handleFrame(raw, target) {
  // External data from a local daemon — a parse guard is justified here (this
  // runs in a socket callback, outside any Express error middleware).
  let frame;
  try {
    frame = JSON.parse(raw);
  } catch {
    console.error(`${LOG_PREFIX}: unparseable frame discarded`);
    return;
  }
  if (!frame || typeof frame !== 'object') return;

  checkSequence(frame);

  if (frame.type === 'ready') {
    sendSubscription(target);
    return;
  }
  if (frame.type === 'subscriptions.updated') {
    hasEverConnected = true;
    setConnectionState('connected');
    // The first connection of a process is not a reconnect: boot arms the
    // transport, it does not fire a sweep (`type: 'interval'` in #32's
    // scheduler makes the same choice for the same reason).
    if (connectionCount > 1) triggerSweep('socket-reconnect');
    return;
  }
  if (frame.type === 'error') {
    // The code only. A Beeper `error` frame carries a free-text `message` that
    // is not ours to log.
    console.error(`${LOG_PREFIX}: protocol error (${frame.code || 'unknown'})`);
    return;
  }
  if (frame.type === 'app.state.updated') {
    handleAppState(frame);
    return;
  }
  if (DOMAIN_EVENT_TYPES.has(frame.type)) {
    beeperSocketEvents.emit('invalidate', toInvalidation(frame));
  }
}

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

async function connect() {
  if (!running || socket) return;
  const generation = stopGeneration;
  const { baseUrl, token } = await resolveBeeperConfig();
  // A `stopBeeperSocket()` (shutdown, token revoked) can land while the config
  // read is suspended. Without this the teardown is followed by a brand new
  // socket the shutdown path no longer knows about.
  if (!running || stopGeneration !== generation || socket) return;
  if (!token) {
    // The token went away mid-session (revoked, vault cleared). Stop rather
    // than loop against a socket that can only ever answer 401.
    console.warn(`${LOG_PREFIX}: no token configured — standing down`);
    stopBeeperSocket();
    return;
  }

  connectionCount += 1;
  lastSeq = null;
  setConnectionState(pendingStateWord());
  // Armed before the handshake so a half-open connect trips the watchdog too.
  armWatchdog();

  // The token rides the upgrade request's `Authorization` header and is never
  // logged, never placed in the URL, and never emitted to a browser.
  const instance = runtime.createSocket(beeperWebSocketUrl(baseUrl), {
    headers: { Authorization: `Bearer ${token}` },
  });
  socket = instance;

  const guard = (label, handler) => (...args) => {
    if (socket !== instance) return; // a superseded socket must not drive state
    try {
      handler(...args);
    } catch (err) {
      console.error(`${LOG_PREFIX}: ${label} handler failed: ${err?.message ?? err}`);
    }
  };

  instance.on('open', guard('open', () => {
    reconnectAttempts = 0;
    noteFrame();
  }));
  // `ws` exposes the protocol ping the built-in WebSocket hides, and auto-replies
  // pong. Measured cadence: 10.5s after open, then every 30s.
  //
  // No `emitState()` here (finding PERF-7): a bare ping changes nothing but
  // `lastPingAt`, which `getBeeperRealtimeState()` reads live off this
  // module's own variable — so `GET /api/beeper/status` and
  // `hasRecentBeeperActivity()` (`beeperStatus.js`) both still see a fresh
  // value with no broadcast involved. The socket-pushed `beeper:realtime`
  // payload is that same `getBeeperRealtimeState()` object, so it DOES carry
  // `lastPingAt` (and `lastEventAt`) — but no client reader renders either
  // timestamp from the push: the surfaces that consume the event
  // (`useBeeperRealtime.js` → the connection dot and the settings panel's
  // realtime row) read only `state`, `appState`, `appStateActionable` and
  // `authRejected`, none of which a plain ping changes. Broadcasting a
  // payload whose visible fields
  // read identically to the last one was pure re-render cost 2-3 times a
  // minute on every open tab, for nothing anyone could see change.
  // `noteFrame()` still re-arms the watchdog, so the ping continues to count
  // as liveness exactly as before.
  instance.on('ping', guard('ping', () => {
    lastPingAt = runtime.now();
    noteFrame();
  }));
  instance.on('pong', guard('pong', () => noteFrame()));
  instance.on('message', guard('message', (data) => {
    noteFrame();
    handleFrame(typeof data === 'string' ? data : String(data), instance);
  }));
  instance.on('error', guard('error', (err) => {
    if (shouldNarrateAttempt()) console.error(`${LOG_PREFIX}: connection error: ${err?.message ?? err}`);
  }));
  // A non-101 answer to the upgrade. 401/403 means the stored token is rejected,
  // not that Beeper is momentarily away: reconnecting can only produce the same
  // answer forever, so the transport stands down and the settings card carries
  // the remedy. `ws` routes this here instead of `error` because a listener is
  // attached; `dropSocket()` terminates the still-CONNECTING socket, which
  // aborts the underlying request.
  instance.on('unexpected-response', guard('unexpected-response', (_request, response) => {
    const status = response?.statusCode ?? null;
    if (status === 401 || status === 403) {
      console.error(`${LOG_PREFIX}: Beeper rejected the token (HTTP ${status}) — standing down`);
      stopBeeperSocket();
      authRejected = true;
      emitState();
      return;
    }
    if (shouldNarrateAttempt()) console.error(`${LOG_PREFIX}: unexpected upgrade response (HTTP ${status ?? 'unknown'})`);
    dropSocket();
    scheduleReconnect();
  }));
  instance.on('close', guard('close', (code) => {
    if (shouldNarrateAttempt()) console.log(`${LOG_PREFIX}: closed (code=${code ?? 'none'})`);
    dropSocket();
    scheduleReconnect();
  }));
}

/**
 * Arm the realtime transport at boot on the TRANSPORT gate — the instance
 * FEATURE on plus a token present, and never `app.state` — and just as SILENT
 * when it does not apply: a fresh install that has never opened the Beeper card
 * neither connects nor logs.
 *
 * Deliberately NOT gated on `settings.beeper.enabled`: the socket writes
 * nothing, and the liveness dot it feeds is what the settings card shows while
 * the user decides whether to enable ingestion. Every sweep it would request is
 * gated on that toggle instead (`isSweepEnabled`), re-read per trigger.
 *
 * `overrides` injects `{ now, setTimeout, clearTimeout, random, createSocket }`
 * so the watchdog and the backoff are provable without a real sleep.
 */
export async function startBeeperSocket(overrides = {}) {
  if (running) return false;
  const generation = stopGeneration;
  if (!await isBeeperIngestionArmed()) return false;
  // A stop landing during the gate read must not be undone by the start that
  // was already in flight when it arrived.
  if (stopGeneration !== generation || running) return false;
  runtime = { ...DEFAULT_RUNTIME, ...overrides };
  running = true;
  reconnectAttempts = 0;
  connectionCount = 0;
  hasEverConnected = false;
  authRejected = false;
  try {
    await connect();
  } catch (err) {
    // A credential read that throws (an unreadable vault, not merely an
    // absent token — #11 decision 8) rejects `connect()` before it ever
    // schedules a reconnect. Left at `running: true` with no timer behind it,
    // this is stuck for the life of the process: `isBeeperSocketRunning()`
    // says armed, the state stays whatever `pendingStateWord()` last set, and
    // no later reconcile call can re-arm it because `startBeeperSocket()`
    // declines whenever `running` is already true. Reset it here — guarded on
    // generation so a `stopBeeperSocket()` that landed while `connect()` was
    // suspended is not undone — so the next `reconcileBeeperIngestion()` call
    // (a credential re-saved, a feature retoggled) gets a fresh attempt.
    console.error(`${LOG_PREFIX}: initial connect failed: ${err?.message ?? err}`);
    if (stopGeneration === generation) running = false;
  }
  return true;
}

/** Whether the transport is armed (connected, connecting, or backing off). */
export function isBeeperSocketRunning() {
  return running;
}

/**
 * Tear the transport down (shutdown, a token that disappeared, or a rejected
 * one). Returns whether it was running, so a caller reconciling the arming gate
 * can log a real transition rather than every pass.
 */
export function stopBeeperSocket() {
  const wasRunning = running;
  running = false;
  stopGeneration += 1;
  clearReconnectTimer();
  dropSocket();
  reconnectAttempts = 0;
  lastSeq = null;
  hasEverConnected = false;
  setConnectionState('down');
  runtime = { ...DEFAULT_RUNTIME };
  return wasRunning;
}
