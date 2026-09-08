/**
 * Tailcat federated peers — connect to a remote PortOS over
 * [tailcat](https://github.com/tailscale/tailcat) without a Tailscale account.
 *
 * Flow: ensure the `tailcat` CLI is installed → pre-warm the DERP map cache →
 * start `tailcat forward <tcADDR> LOCAL:5565` (preferred LOCAL=15555) → prove the
 * tunnel actually carries a request → register a normal peer at
 * `127.0.0.1:LOCAL` over HTTP or explicitly selected HTTPS.
 *
 * The tc address is a bearer capability. Persist it only in the machine-local
 * forwards file for restart and retry; never log the full value, never put it on
 * the peer record that clients or peers can scrape, never return it from an API
 * response, and never ship it in docs/tests.
 */

import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { spawn } from '../lib/childProcess.js';
import { dataPath, readJSONFile, ensureDir, PATHS, atomicWrite } from '../lib/fileUtils.js';
import { createMutex } from '../lib/asyncMutex.js';
import { isPortReachable } from '../lib/connectivity.js';
import { peerFetch } from '../lib/peerHttpClient.js';
import { peerBaseUrl } from '../lib/peerUrl.js';
import { isTestRunner } from '../lib/runtimeEnv.js';
import { safeChildProcessEnv, safeChildProcessOptions } from '../lib/processEnv.js';
import {
  PORTS,
  DEFAULT_TAILCAT_LOCAL_PORT,
  DEFAULT_TAILCAT_REMOTE_PORT,
} from '../lib/ports.js';
import { ServerError } from '../lib/errorHandler.js';
import {
  addPeer,
  getPeers,
  removePeer as removeInstancePeer,
  setTailcatPeerPort,
} from './instances.js';
import { ensureTailcatInstalled, primeDerpMapCache } from './tailcatRuntime.js';
import { isValidTcAddress, redactTcAddress, redactTailcatDiagnostics } from '../lib/tailcatAddress.js';

// Compatibility for existing callers; shared implementations live with their owners.
export { MIN_TAILCAT_VERSION } from '../lib/tailcatVersion.js';
export {
  listCandidateTailcatBins, readTailcatBinaryVersion, detectTailcat, findTooOldTailcat,
  manualInstallHint, listTailcatInstallers, ensureTailcatInstalled, derpMapCachePath, primeDerpMapCache,
} from './tailcatRuntime.js';
export { isValidTcAddress, redactTcAddress, redactTailcatDiagnostics } from '../lib/tailcatAddress.js';

const FORWARDS_FILE = dataPath('tailcat-forwards.json');
const FORWARD_READY_MS = 8_000;
const FORWARD_PROBE_INTERVAL_MS = 150;
const DIAGNOSTIC_TAIL_CHARS = 4096;
const PORT_SCAN_LIMIT = 32;
// Long enough to outlast tailcat's own per-connection dial deadline, so a
// blocked tunnel fails with tailcat's explanation rather than ours.
const TUNNEL_VERIFY_TIMEOUT_MS = 20_000;
// How long a delivery failure keeps describing the tunnel. tailcat re-emits the
// line on every failed request, so a still-broken forward keeps refreshing it,
// while one that started working again simply goes quiet and ages out. Without
// a window a single blip would latch "no route" forever — the same lie as a
// permanently green "running", pointing the other way.
const TUNNEL_ERROR_FRESH_MS = 5 * 60 * 1000;
const DEFAULT_DATA = { version: 1, forwards: [] };

const withLock = createMutex();
const withLifecycle = createMutex();
const ownedChildren = new Set();
let shuttingDown = false;

/** @type {Map<string, { child: import('node:child_process').ChildProcess, localPort: number, remotePort: number }>} */
const liveForwards = new Map();

/**
 * tailcat's per-connection delivery failures. `tailcat forward` binds its local
 * listener eagerly and only brings the WireGuard/DERP tunnel up when a
 * connection arrives, so a forward whose relay is blocked still binds, still
 * reports `active`, and still shows `running` — while every request through it
 * is reset once the dial deadline expires. That line is the only place tailcat
 * says so, which is why the post-startup stderr has to be read rather than
 * drained: the operator's symptom is "the loopback says running but nothing
 * answers", and this is the sentence that explains it.
 *
 * Deliberately narrow. Relay reconnects and netcheck chatter are normal even on
 * a healthy tunnel; a failed dial is not.
 */
const RUNTIME_FAILURE_PATTERN = /^.*\bdial remote\b.*$/m;

/** The redacted tailcat line explaining a failed delivery, or null. */
export function classifyTailcatRuntimeError(text) {
  const match = RUNTIME_FAILURE_PATTERN.exec(String(text || ''));
  return match ? redactTailcatDiagnostics(match[0]) || null : null;
}

async function loadForwards() {
  const data = await readJSONFile(FORWARDS_FILE, DEFAULT_DATA, { strict: true, logError: false })
    .catch(() => { throw new ServerError('Could not read tailcat forward storage', { status: 503 }); });
  if (data?.version !== 1 || !Array.isArray(data.forwards)) {
    throw new ServerError('Invalid tailcat forward storage', { status: 503 });
  }
  return data;
}

async function saveForwards(entries) {
  await ensureDir(PATHS.data);
  await atomicWrite(FORWARDS_FILE, { version: 1, forwards: entries });
}

/**
 * Normalize a stored entry. Installs written before retry support keyed entries
 * by `peerId` alone with no `id`/`status`, so derive both rather than dropping
 * a working forward. An entry without a usable capability is unusable — drop it.
 */
function normalizeForwardEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  if (!isValidTcAddress(entry.tcAddress)) return null;
  const peerId = typeof entry.peerId === 'string' && entry.peerId ? entry.peerId : null;
  const status = ['active', 'failed', 'pending'].includes(entry.status)
    ? entry.status
    // A pre-retry entry only ever existed once its peer was registered.
    : 'active';
  return {
    id: typeof entry.id === 'string' && entry.id ? entry.id : `fwd_${peerId || randomUUID()}`,
    peerId,
    tcAddress: entry.tcAddress,
    localPort: Number.isInteger(entry.localPort) ? entry.localPort : null,
    remotePort: Number.isInteger(entry.remotePort) ? entry.remotePort : PORTS.API,
    name: typeof entry.name === 'string' && entry.name ? entry.name : null,
    protocol: entry.protocol === 'https' ? 'https' : 'http',
    // Kept beside the capability so a retry can re-register a password-gated
    // peer without the operator re-entering anything. Machine-local only.
    auth: entry.auth && typeof entry.auth === 'object' ? entry.auth : null,
    status,
    lastError: typeof entry.lastError === 'string' ? entry.lastError : null,
    lastErrorAt: typeof entry.lastErrorAt === 'string' ? entry.lastErrorAt : null,
    createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : new Date().toISOString(),
  };
}

/** Read every stored forward, normalized. Internal — these carry the capability. */
async function readForwards() {
  const data = await loadForwards();
  return data.forwards.map(normalizeForwardEntry).filter(Boolean);
}

async function upsertForward(entry) {
  await withLock(async () => {
    const entries = await readForwards();
    await saveForwards([...entries.filter((f) => f.id !== entry.id), entry]);
  });
}

/** Merge fields into one stored entry. No-op when the entry is already gone. */
async function patchForward(id, patch) {
  return withLock(async () => {
    const entries = await readForwards();
    const found = entries.find((f) => f.id === id);
    if (!found) return null;
    const next = { ...found, ...patch };
    await saveForwards([...entries.filter((f) => f.id !== id), next]);
    return next;
  });
}

async function deleteForward(id) {
  await withLock(async () => {
    const entries = await readForwards();
    await saveForwards(entries.filter((f) => f.id !== id));
  });
}

/** Record why a forward is not running, so the next session can act on it. */
async function markForwardFailed(id, error, patchFn = patchForward) {
  const detail = redactTailcatDiagnostics(error?.message || String(error || 'unknown error'));
  await patchFn(id, {
    status: 'failed',
    lastError: detail || 'unknown error',
    lastErrorAt: new Date().toISOString(),
  }).catch(() => null); // never mask the original failure with a bookkeeping one
}

/**
 * Operator-facing view of the saved forwards: enough to see *which* peer cannot
 * start and why, with the bearer capability replaced by its redacted form. This
 * is what makes a failed add recoverable — the address stays on disk, so a retry
 * never asks the operator for it again.
 */
export async function listTailcatForwards() {
  const entries = await readForwards();
  return entries.map((entry) => {
    // In-memory, never persisted: it describes the child running right now, and
    // a per-connection failure repeating every few seconds would thrash the file.
    const recorded = liveForwards.get(entry.id)?.child?.tailcatRuntimeError || null;
    const runtimeError = recorded && Date.now() - Date.parse(recorded.at) < TUNNEL_ERROR_FRESH_MS
      ? recorded
      : null;
    return {
      id: entry.id,
      peerId: entry.peerId,
      tcAddress: redactTcAddress(entry.tcAddress),
      localPort: entry.localPort,
      remotePort: entry.remotePort,
      name: entry.name,
      protocol: entry.protocol,
      hasAuth: !!entry.auth,
      status: entry.status,
      lastError: entry.lastError,
      lastErrorAt: entry.lastErrorAt,
      createdAt: entry.createdAt,
      live: liveForwards.has(entry.id),
      // "running" only ever meant the local listener is bound. This is the
      // separate answer to "can it actually carry a request?".
      tunnelError: runtimeError?.message || null,
      tunnelErrorAt: runtimeError?.at || null,
    };
  });
}

/**
 * Client-safe forward summary attached onto a peer with transport === 'tailcat'.
 * Same fields as listTailcatForwards rows (already redacted) so the peer card
 * can be the primary surface without a second mental model.
 */
export function summarizeTailcatForwardForPeer(forward) {
  if (!forward) return null;
  return {
    id: forward.id,
    peerId: forward.peerId,
    tcAddress: forward.tcAddress,
    localPort: forward.localPort,
    remotePort: forward.remotePort,
    name: forward.name,
    protocol: forward.protocol,
    hasAuth: forward.hasAuth,
    status: forward.status,
    lastError: forward.lastError,
    lastErrorAt: forward.lastErrorAt,
    createdAt: forward.createdAt,
    live: forward.live,
    tunnelError: forward.tunnelError,
    tunnelErrorAt: forward.tunnelErrorAt,
  };
}

/**
 * Attach `tailcatForward` onto sanitized peer payloads. Peers that are not
 * tailcat transport are unchanged. A missing forward (e.g. metadata wiped)
 * still gets `tailcatForward: null` so the UI can say so explicitly.
 */
export async function attachTailcatForwardsToPeers(peers) {
  if (!Array.isArray(peers) || peers.length === 0) return peers;
  if (!peers.some((p) => p?.transport === 'tailcat')) return peers;
  const forwards = await listTailcatForwards();
  const byPeerId = new Map(
    forwards.filter((f) => f.peerId).map((f) => [f.peerId, summarizeTailcatForwardForPeer(f)]),
  );
  return peers.map((peer) => {
    if (peer?.transport !== 'tailcat') return peer;
    return { ...peer, tailcatForward: byPeerId.get(peer.id) || null };
  });
}

export async function attachTailcatForwardToPeer(peer) {
  if (!peer || peer.transport !== 'tailcat') return peer;
  const [enriched] = await attachTailcatForwardsToPeers([peer]);
  return enriched;
}

/** True when nothing is listening on 127.0.0.1:port (or bind fails for other reasons → busy). */
export function isLocalPortFree(port, { createServerFn = createServer } = {}) {
  return new Promise((resolve) => {
    const server = createServerFn();
    server.unref?.();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * Prefer DEFAULT_TAILCAT_LOCAL_PORT (15555). When busy, walk upward so a second
 * peer can still be forwarded without colliding.
 */
export async function allocateLocalPort({
  preferred = DEFAULT_TAILCAT_LOCAL_PORT,
  isFree = isLocalPortFree,
  limit = PORT_SCAN_LIMIT,
} = {}) {
  const start = Number(preferred) || DEFAULT_TAILCAT_LOCAL_PORT;
  for (let i = 0; i < limit; i += 1) {
    const port = start + i;
    if (port > 65535) break;
    // Skip ports already claimed by a live forward we manage.
    const taken = [...liveForwards.values()].some((f) => f.localPort === port);
    if (taken) continue;
    if (await isFree(port)) return port;
  }
  throw new ServerError(
    `No free local port near ${start} for tailcat forward (tried ${limit} ports)`,
    { status: 503, code: 'TAILCAT_PORT_BUSY' }
  );
}

/**
 * Start `tailcat forward <tc> local:remote`. Injected `spawnFn` for tests.
 * Resolves only once the requested local listener is actually bound.
 *
 * Readiness has two independent signals, because relying on the log line alone
 * silently broke against a released CLI: tailcat ≤0.5.0 emits `forwarding …`
 * through its verbose-only logger, so an add against that build timed out after
 * 8s even though the listener was up and healthy. `--verbose` restores the line
 * on those builds (and is what surfaces per-connection dial failures at all),
 * while the connect probe confirms the same fact without depending on any log
 * wording, so a future CLI reword cannot regress this again.
 */
export async function startForwardProcess({
  bin,
  tcAddress,
  localPort,
  remotePort = DEFAULT_TAILCAT_REMOTE_PORT,
  spawnFn = spawn,
  readyMs = FORWARD_READY_MS,
  // A connect probe, never a bind: a bind would hold the port while tailcat is
  // still trying to claim it and could kill the CLI with EADDRINUSE.
  isListening = (port) => isPortReachable({ port }),
  probeMs = FORWARD_PROBE_INTERVAL_MS,
} = {}) {
  if (!isValidTcAddress(tcAddress)) {
    throw new ServerError('Invalid tailcat address — paste a tc… address from the peer', {
      status: 400, code: 'TAILCAT_BAD_ADDRESS',
    });
  }
  if (shuttingDown) throw new Error('PortOS is shutting down');
  const child = spawnFn(bin, ['forward', '--verbose', '--bind=127.0.0.1', tcAddress.trim(), `${localPort}:${remotePort}`],
    safeChildProcessOptions({ env: safeChildProcessEnv(), stdio: ['ignore', 'pipe', 'pipe'] }));
  ownedChildren.add(child);
  child.stdout?.on('data', () => {});
  // Liveness of the listener is not liveness of the tunnel — see
  // RUNTIME_FAILURE_PATTERN. Null until tailcat reports it cannot deliver.
  child.tailcatRuntimeError = null;

  // Post-startup stderr is read, not merely drained. The rolling buffer holds
  // at most one partial line, so a diagnostic split across chunk boundaries is
  // still recognizable and no capability bytes are retained beyond a line.
  let runtimeTail = '';
  const observeRuntime = (text) => {
    runtimeTail = (runtimeTail + text).slice(-DIAGNOSTIC_TAIL_CHARS);
    const lastNewline = runtimeTail.lastIndexOf('\n');
    if (lastNewline === -1) return;
    const complete = runtimeTail.slice(0, lastNewline);
    runtimeTail = runtimeTail.slice(lastNewline + 1);
    const message = classifyTailcatRuntimeError(complete);
    if (!message) return;
    // Once per distinct reason: a blocked relay repeats this every request.
    if (child.tailcatRuntimeError?.message !== message) {
      console.error(`❌ tailcat forward 127.0.0.1:${localPort} cannot reach the remote — ${message}`);
    }
    child.tailcatRuntimeError = { message, at: new Date().toISOString() };
  };

  // tailcat's own diagnostics can contain the bearer capability, so the raw tail
  // is bounded, redacted on the way into an error, and no longer accumulated once
  // we are past startup — it is never retained and never surfaced unredacted.
  let tail = '';
  let settled = false;
  const readyPattern = new RegExp(`forwarding 127\\.0\\.0\\.1:${localPort} -> remote localhost:${remotePort}(?![0-9])`);

  await new Promise((resolve, reject) => {
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poller);
      const diagnostics = error ? redactTailcatDiagnostics(tail) : '';
      tail = '';
      if (error) {
        if (diagnostics) error.message = `${error.message} — tailcat said: ${diagnostics}`;
        try { child.kill('SIGTERM'); } catch { /* process event boundary */ }
        reject(error);
      } else resolve();
    };
    const timer = setTimeout(() => finish(new Error('tailcat listener startup timed out')), readyMs);
    // The connect probe is the version-independent half: a loopback port that
    // accepts a connection is a port tailcat is listening on, whatever it logged.
    const poller = setInterval(() => {
      isListening(localPort).then((listening) => { if (listening) finish(); }, () => {});
    }, probeMs);
    // Stays attached past startup: the startup tail stops accumulating (settled
    // means those capability bytes are no longer kept) and the same pipe becomes
    // the runtime health signal.
    child.stderr?.on('data', (chunk) => {
      if (settled) {
        // Stream callback, outside any request lifecycle: an uncaught throw here
        // would take the whole server down.
        try { observeRuntime(String(chunk)); } catch { /* diagnostics only */ }
        return;
      }
      tail = (tail + String(chunk)).slice(-DIAGNOSTIC_TAIL_CHARS);
      if (readyPattern.test(tail)) finish();
    });
    child.on('error', () => finish(new Error('tailcat forward process failed')));
    child.once('exit', (code, signal) => {
      ownedChildren.delete(child);
      finish(new Error(`tailcat forward exited early (code=${code}, signal=${signal})`));
    });
  }).catch((error) => {
    ownedChildren.delete(child);
    throw error;
  });

  console.log(`🐈 tailcat forward listening on 127.0.0.1:${localPort} (remote :${remotePort})`);
  return child;
}

/**
 * Prove the tunnel can carry a request, resolving to null when it did or to a
 * short failure detail when it did not. See "A bound listener is not a working
 * tunnel" in docs/features/tailcat-peers.md for why an add cannot stop at the
 * listener, and why ANY HTTP response counts as proof.
 *
 * Deliberately not `probePeer`: that one needs a registered peer record, writes
 * probe status into the store, and budgets a tailnet hop rather than tailcat's
 * own dial deadline. The URL is still built through `peerBaseUrl`, so the probe
 * cannot address the forward differently from the peer it gates.
 *
 * `fetchFn` defaults to null under the test runner so a suite can never reach
 * the network by forgetting to inject it.
 */
export async function verifyTunnelReachable({
  localPort,
  protocol = 'http',
  auth = null,
  fetchFn = isTestRunner() ? null : peerFetch,
  timeoutMs = TUNNEL_VERIFY_TIMEOUT_MS,
} = {}) {
  if (!fetchFn) return null;
  const base = peerBaseUrl({ transport: 'tailcat', protocol, address: '127.0.0.1', port: localPort });
  return fetchFn(`${base}/api/system/health`, { signal: AbortSignal.timeout(timeoutMs) }, auth ? { auth } : null)
    .then(() => null, (err) => String(err?.message || 'no response'));
}

export function stopForwardForPeer(peerId) {
  return withLifecycle(async () => {
    const entries = await readForwards();
    const entry = entries.find((f) => f.peerId === peerId);
    if (!entry) return;
    killLiveForward(entry.id);
    await deleteForward(entry.id);
  });
}

/** Forget a saved forward outright — stops it and drops its stored capability. */
export function forgetTailcatForward(id, { removePeerFn = removeInstancePeer } = {}) {
  return withLifecycle(async () => {
    const entries = await readForwards();
    const entry = entries.find((f) => f.id === id);
    if (!entry) throw new ServerError('Tailcat forward not found', { status: 404 });
    killLiveForward(id);
    await deleteForward(id);
    if (entry.peerId) {
      // stopTransport:false — this lifecycle operation already owns the child
      // and just dropped the metadata, so re-entering it would deadlock.
      await removePeerFn(entry.peerId, { stopTransport: false });
    }
    return { id, peerId: entry.peerId };
  });
}

function killLiveForward(id) {
  const live = liveForwards.get(id);
  if (live?.child && !live.child.killed) {
    try {
      live.child.kill('SIGTERM');
    } catch {
      // best-effort
    }
  }
  liveForwards.delete(id);
}

/** Track a started child so shutdown and retry can find it again. */
function trackForward(id, child, localPort, remotePort) {
  liveForwards.set(id, { child, localPort, remotePort });
  child.on('exit', () => {
    if (liveForwards.get(id)?.child === child) liveForwards.delete(id);
  });
}

/**
 * Operator-facing entry: install if needed, allocate a local port, start the
 * forward, then register a classic loopback peer. Loopback is intentional here
 * — the public POST /peers schema still rejects 127/8 for classic adds.
 */
export function addPeerViaTailcat(options = {}) {
  return withLifecycle(() => addTailcatPeer(options));
}

async function addTailcatPeer({
  tcAddress,
  name,
  auth,
  protocol = 'http',
  remotePort = DEFAULT_TAILCAT_REMOTE_PORT,
  ensureInstalled = ensureTailcatInstalled,
  primeDerpMap = primeDerpMapCache,
  allocatePort = allocateLocalPort,
  startForward = startForwardProcess,
  addPeerFn = addPeer,
  persistForwardEntry = upsertForward,
  patchForwardEntry = patchForward,
  removePeerFn = removeInstancePeer,
  verifyTunnel,
} = {}) {
  if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
    throw new ServerError('Invalid remote Tailcat port', { status: 400, code: 'TAILCAT_BAD_PORT' });
  }
  const trimmed = String(tcAddress || '').trim();
  if (!isValidTcAddress(trimmed)) {
    throw new ServerError('Invalid tailcat address — paste a tc… address from the peer', {
      status: 400,
      code: 'TAILCAT_BAD_ADDRESS',
    });
  }

  if (shuttingDown) throw new Error('PortOS is shutting down');

  // Save the capability BEFORE anything can fail. A forward that never starts
  // then stays retryable from the UI instead of throwing the operator's pasted
  // address away and making them fetch it from the remote a second time.
  const entry = {
    id: `fwd_${randomUUID()}`,
    peerId: null,
    tcAddress: trimmed,
    localPort: null,
    remotePort,
    name: name || null,
    protocol: protocol === 'https' ? 'https' : 'http',
    auth: auth && typeof auth === 'object' ? auth : null,
    status: 'pending',
    lastError: null,
    lastErrorAt: null,
    createdAt: new Date().toISOString(),
  };
  await persistForwardEntry(entry).catch(() => {
    throw new ServerError('Could not save tailcat forward; nothing was started', {
      status: 503, code: 'TAILCAT_PERSIST_FAILED',
    });
  });

  const peer = await startAndRegister({
    entry, ensureInstalled, primeDerpMap, allocatePort, startForward, addPeerFn,
    patchForwardEntry, removePeerFn, verifyTunnel,
  }).catch(async (err) => {
    await markForwardFailed(entry.id, err, patchForwardEntry);
    throw err;
  });
  return peer;
}

/**
 * Shared body of add and retry: bring the forward up, make sure a peer points at
 * it, and record the outcome. Callers own the failure bookkeeping.
 */
async function startAndRegister({
  entry,
  existingPeer = null,
  ensureInstalled,
  primeDerpMap,
  allocatePort,
  startForward,
  addPeerFn,
  patchForwardEntry,
  removePeerFn,
  setPeerPortFn = setTailcatPeerPort,
  verifyTunnel = verifyTunnelReachable,
}) {
  const { bin } = await ensureInstalled();
  // Best-effort, and deliberately before the spawn: on a host whose filter
  // blocks Go's dialer this is the difference between a working tunnel and a
  // CLI that cannot resolve its own relay.
  // Promise.resolve().then defers the call so a synchronous throw is caught here
  // too, the same guard ensureTailcatInstalled documents for its installers.
  await Promise.resolve().then(primeDerpMap).catch(() => null);
  const remotePort = entry.remotePort;
  const localPort = await allocatePort({ preferred: entry.localPort || DEFAULT_TAILCAT_LOCAL_PORT });

  let child;
  try {
    child = await startForward({ bin, tcAddress: entry.tcAddress, localPort, remotePort });
  } catch (err) {
    throw new ServerError(
      `Could not start tailcat forward: ${err.message}`,
      { status: 502, code: 'TAILCAT_FORWARD_FAILED' }
    );
  }

  ownedChildren.add(child);

  // The listener being bound is not the tunnel being usable — see
  // verifyTunnelReachable. Fail the add here, while the operator is watching,
  // instead of registering a peer that can never answer.
  const unreachable = await verifyTunnel({ localPort, protocol: entry.protocol, auth: entry.auth });
  if (unreachable) {
    try { child.kill('SIGTERM'); } catch { /* best-effort */ }
    ownedChildren.delete(child);
    // tailcat's own line names the cause; ours only says the request failed.
    const detail = child.tailcatRuntimeError?.message || unreachable;
    throw new ServerError(
      `tailcat is forwarding 127.0.0.1:${localPort} but the tunnel could not reach the remote — ${detail}. `
      + 'Check that the remote is still serving its tailcat address, and that a local firewall is not '
      + 'blocking the `tailcat` binary itself.',
      { status: 502, code: 'TAILCAT_TUNNEL_UNREACHABLE' }
    );
  }

  let peer = existingPeer;
  try {
    if (shuttingDown) throw new Error('PortOS is shutting down');
    if (peer) {
      // A reallocated port has to reach the peer record too, or every request
      // would keep dialing the port the dead forward used to hold. A null result
      // means the record is gone or is no longer a tailcat peer — failing here is
      // the point: falling back to the stale object would report success while the
      // peer kept pointing at the dead port.
      if (peer.port !== localPort) {
        peer = await setPeerPortFn(peer.id, localPort);
        if (!peer) throw new ServerError(
          `Could not repoint peer ${existingPeer.id} at 127.0.0.1:${localPort}`,
          { status: 409, code: 'TAILCAT_PEER_REPOINT_FAILED' }
        );
      }
    } else {
      peer = await addPeerFn({
        address: '127.0.0.1',
        port: localPort,
        name: entry.name || `tailcat:${redactTcAddress(entry.tcAddress)}`,
        auth: entry.auth || undefined,
        transport: 'tailcat',
        protocol: entry.protocol,
      });
    }
  } catch (err) {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    throw err;
  }

  // A vanished entry (null) counts as a failed save: the restart mapping is the
  // thing being persisted, and a peer without one cannot come back after a boot.
  const patched = await patchForwardEntry(entry.id, {
    peerId: peer.id,
    localPort,
    remotePort,
    status: 'active',
    lastError: null,
    lastErrorAt: null,
  }).then((result) => result !== null, () => false);
  if (!patched || shuttingDown) {
    child.kill('SIGTERM');
    if (!existingPeer) {
      // removePeer skips transport cleanup here: this lifecycle operation already
      // owns the child and the queue, so re-entering it would deadlock.
      await removePeerFn(peer.id, { stopTransport: false });
    }
    throw new ServerError('Could not save tailcat forward; peer creation rolled back', {
      status: 503, code: 'TAILCAT_PERSIST_FAILED',
    });
  }

  trackForward(entry.id, child, localPort, remotePort);
  child.on('exit', () => {
    console.log(`🐈 tailcat forward stopped for peer ${peer.id} (${redactTcAddress(entry.tcAddress)})`);
  });
  return peer;
}

/**
 * Retry a saved forward using the capability already on disk. This is the whole
 * point of persisting it: an operator (or an agent debugging the install) can
 * bring a failed peer up without ever handling the tc address again.
 */
export function retryTailcatForward(id, options = {}) {
  return withLifecycle(() => retryForward(id, options));
}

async function retryForward(id, {
  remotePort,
  ensureInstalled = ensureTailcatInstalled,
  primeDerpMap = primeDerpMapCache,
  allocatePort = allocateLocalPort,
  startForward = startForwardProcess,
  addPeerFn = addPeer,
  patchForwardEntry = patchForward,
  removePeerFn = removeInstancePeer,
  getPeersFn = getPeers,
  setPeerPortFn = setTailcatPeerPort,
} = {}) {
  if (shuttingDown) throw new Error('PortOS is shutting down');
  const entries = await readForwards();
  const entry = entries.find((f) => f.id === id);
  if (!entry) throw new ServerError('Tailcat forward not found', { status: 404 });

  if (remotePort !== undefined) {
    if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535) {
      throw new ServerError('Invalid remote Tailcat port', { status: 400, code: 'TAILCAT_BAD_PORT' });
    }
    const patched = await patchForwardEntry(entry.id, { remotePort });
    if (!patched) throw new ServerError('Could not update Tailcat remote port', { status: 503 });
    entry.remotePort = remotePort;
  }

  // A live child on a stale mapping would keep the port and mask the retry.
  killLiveForward(entry.id);

  const peers = await getPeersFn();
  // Match the transport too, exactly as the boot-time restore does: a stale entry
  // whose peerId now names a classic peer must register a fresh one, never adopt it.
  const existingPeer = entry.peerId
    ? peers.find((p) => p.id === entry.peerId && p.transport === 'tailcat') || null
    : null;
  const peer = await startAndRegister({
    entry, existingPeer, ensureInstalled, primeDerpMap, allocatePort, startForward,
    addPeerFn, patchForwardEntry, removePeerFn, setPeerPortFn,
  }).catch(async (err) => {
    await markForwardFailed(entry.id, err, patchForwardEntry);
    throw err;
  });
  console.log(`🐈 tailcat forward retried for peer ${peer.id} (${redactTcAddress(entry.tcAddress)})`);
  return peer;
}

/** Restart persisted forwards after PortOS boot (best-effort). */
export function restoreForwards(options = {}) {
  return withLifecycle(() => restoreTailcatForwards(options));
}

async function restoreTailcatForwards({
  ensureInstalled = ensureTailcatInstalled,
  primeDerpMap = primeDerpMapCache,
  startForward = startForwardProcess,
  getPeersFn = getPeers,
} = {}) {
  if (shuttingDown) return { restored: 0 };
  const forwards = await readForwards();
  if (forwards.length === 0) return { restored: 0 };

  let bin;
  try {
    ({ bin } = await ensureInstalled());
  } catch (err) {
    console.log(`⚠️ tailcat restore skipped — ${err.message}`);
    return { restored: 0, error: err.message };
  }
  await Promise.resolve().then(primeDerpMap).catch(() => null);

  const peers = await getPeersFn();
  let restored = 0;
  for (const entry of forwards) {
    if (shuttingDown) break;
    // A stale entry must never resurrect a removed peer or reuse another route.
    if (!entry.peerId || !peers.some((peer) => peer.id === entry.peerId && peer.transport === 'tailcat'
      && peer.address === '127.0.0.1' && peer.port === entry.localPort)) continue;
    if (!Number.isInteger(entry.localPort) || entry.localPort < 1024 || entry.localPort > 65535
      || !Number.isInteger(entry.remotePort) || entry.remotePort < 1 || entry.remotePort > 65535) continue;
    if (liveForwards.has(entry.id)) continue;
    try {
      const child = await startForward({
        bin,
        tcAddress: entry.tcAddress,
        localPort: entry.localPort,
        remotePort: entry.remotePort,
      });
      trackForward(entry.id, child, entry.localPort, entry.remotePort);
      await patchForward(entry.id, { status: 'active', lastError: null, lastErrorAt: null }).catch(() => null);
      restored += 1;
    } catch (err) {
      // Keep the reason on the entry: a boot-time failure is exactly the case
      // nobody is watching, and the retry UI is the only place it resurfaces.
      console.log(`⚠️ tailcat restore failed for peer ${entry.peerId} — ${redactTailcatDiagnostics(err.message)}`);
      await markForwardFailed(entry.id, err);
    }
  }
  if (restored > 0) console.log(`🐈 Restored ${restored} tailcat forward(s)`);
  return { restored };
}

/** Stop server-owned children on shutdown; keep mappings for the next boot. */
export function stopAllForwards() {
  shuttingDown = true;
  for (const child of new Set([...ownedChildren, ...[...liveForwards.values()].map((live) => live.child)])) {
    child.kill('SIGTERM');
  }
  ownedChildren.clear();
  liveForwards.clear();
}

// Test-only helpers
export function _resetLiveForwardsForTests() {
  stopAllForwards();
  shuttingDown = false;
  liveForwards.clear();
}

export function _liveForwardCountForTests() {
  return liveForwards.size;
}
