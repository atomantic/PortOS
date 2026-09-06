/**
 * Tailcat federated peers — connect to a remote PortOS over
 * [tailcat](https://github.com/tailscale/tailcat) without a Tailscale account.
 *
 * Flow: ensure the `tailcat` CLI is installed → start
 * `tailcat forward <tcADDR> LOCAL:5555` (preferred LOCAL=15555) → register a
 * normal peer at `127.0.0.1:LOCAL` over HTTP or explicitly selected HTTPS.
 *
 * The tc address is a bearer capability. Persist it only in the machine-local
 * forwards file for restart; never log the full value, never put it on the peer
 * record that clients or peers can scrape, and never ship it in docs/tests.
 */

import { createServer } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from '../lib/childProcess.js';
import { createLineReader } from '../lib/streamLines.js';
import { commandExists } from '../lib/commandExists.js';
import { dataPath, readJSONFile, ensureDir, PATHS, atomicWrite } from '../lib/fileUtils.js';
import { createMutex } from '../lib/asyncMutex.js';
import { findCommandOnPath, safeChildProcessEnv, safeChildProcessOptions } from '../lib/processEnv.js';
import {
  DEFAULT_TAILCAT_LOCAL_PORT,
  DEFAULT_TAILCAT_REMOTE_PORT,
} from '../lib/ports.js';
import { ServerError } from '../lib/errorHandler.js';
import { addPeer, getPeers, removePeer as removeInstancePeer } from './instances.js';

const FORWARDS_FILE = dataPath('tailcat-forwards.json');
const GO_INSTALL_PKG = 'github.com/tailscale/tailcat/cmd/tailcat@latest';
const INSTALL_TIMEOUT_MS = 180_000;
const FORWARD_READY_MS = 8_000;
const PORT_SCAN_LIMIT = 32;
const DEFAULT_DATA = { version: 1, forwards: [] };

const withLock = createMutex();
const withLifecycle = createMutex();
const ownedChildren = new Set();
let shuttingDown = false;

/** @type {Map<string, { child: import('node:child_process').ChildProcess, localPort: number, remotePort: number }>} */
const liveForwards = new Map();

/** Redact a tc address for logs / UI — never echo the full capability. */
export function redactTcAddress(tc) {
  const raw = String(tc || '').trim();
  if (!raw) return '(empty)';
  if (raw.length <= 8) return 'tc…';
  return `${raw.slice(0, 4)}…${raw.slice(-4)}`;
}

/**
 * Accept a pasted tailcat address. Real addresses are `tc` + base64url CBOR;
 * keep the gate loose enough for DNS TXT forms that still begin with `tc`, but
 * reject obvious garbage so we never spawn with an operator typo as argv.
 */
export function isValidTcAddress(tc) {
  const raw = String(tc || '').trim();
  if (!raw.startsWith('tc')) return false;
  if (raw.length < 24 || raw.length > 2048) return false;
  // Letters, digits, _ - = + / (base64 / base64url) only after the tc prefix.
  return /^tc[A-Za-z0-9_+\/=-]+$/.test(raw);
}

async function loadForwards() {
  const data = await readJSONFile(FORWARDS_FILE, DEFAULT_DATA, { strict: true, logError: false })
    .catch(() => { throw new ServerError('Could not read tailcat forward storage', { status: 503 }); });
  if (data?.version !== 1 || !Array.isArray(data.forwards)) {
    throw new ServerError('Invalid tailcat forward storage', { status: 503 });
  }
  return data;
}

async function saveForwards(data) {
  await ensureDir(PATHS.data);
  await atomicWrite(FORWARDS_FILE, data);
}

export function listCandidateTailcatBins() {
  const home = homedir();
  const candidates = [
    findCommandOnPath('tailcat'),
    join(home, 'go', 'bin', 'tailcat'),
    join(home, 'go', 'bin', 'tailcat.exe'),
    '/usr/local/bin/tailcat',
    '/opt/homebrew/bin/tailcat',
  ].filter(Boolean);
  return [...new Set(candidates)];
}

/**
 * Resolve an installed `tailcat` binary, or null when none is runnable.
 * Injected deps keep unit tests off the real PATH / child_process.
 */
export async function detectTailcat({
  candidates = listCandidateTailcatBins(),
  probe = (bin) => commandExists(bin, ['version'], { timeoutMs: 5_000 }),
} = {}) {
  for (const bin of candidates) {
    if (await probe(bin)) return bin;
  }
  return null;
}

/**
 * Install via `go install` when Go is available. Clear, actionable errors when
 * neither binary nor toolchain is present — PortOS never downloads arbitrary
 * URLs without the operator knowing.
 */
export async function ensureTailcatInstalled({
  detect = detectTailcat,
  goBin = findCommandOnPath('go') || 'go',
  runGoInstall = defaultGoInstall,
  probeGo = (bin) => commandExists(bin, ['version'], { timeoutMs: 10_000 }),
} = {}) {
  const existing = await detect();
  if (existing) return { bin: existing, installed: false };

  const goOk = await probeGo(goBin);
  if (!goOk) {
    throw new ServerError(
      'tailcat is not installed and Go was not found on PATH. '
      + 'Install from https://github.com/tailscale/tailcat/releases '
      + 'or `brew install tailcat`, then retry.',
      { status: 503, code: 'TAILCAT_MISSING' }
    );
  }

  try {
    await runGoInstall(goBin);
  } catch (err) {
    throw new ServerError(
      'Failed to install tailcat via go install. '
      + 'Install a release binary from https://github.com/tailscale/tailcat/releases and retry.',
      { status: 503, code: 'TAILCAT_INSTALL_FAILED' }
    );
  }

  const bin = await detect();
  if (!bin) {
    throw new ServerError(
      'go install finished but `tailcat` is still not on PATH '
      + '(check ~/go/bin). Add that directory to PATH and retry.',
      { status: 503, code: 'TAILCAT_INSTALL_PATH' }
    );
  }
  return { bin, installed: true };
}

function defaultGoInstall(goBin) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      goBin,
      ['install', GO_INSTALL_PKG],
      safeChildProcessOptions({
        env: safeChildProcessEnv(),
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    );
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
      if (stderr.length > 8_000) stderr = stderr.slice(-8_000);
    });
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`timed out after ${INSTALL_TIMEOUT_MS}ms`));
    }, INSTALL_TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `exit ${code}`));
    });
  });
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
 * Resolves only after the CLI confirms that the requested listener is bound.
 */
export async function startForwardProcess({
  bin,
  tcAddress,
  localPort,
  remotePort = DEFAULT_TAILCAT_REMOTE_PORT,
  spawnFn = spawn,
  readyMs = FORWARD_READY_MS,
} = {}) {
  if (!isValidTcAddress(tcAddress)) {
    throw new ServerError('Invalid tailcat address — paste a tc… address from the peer', {
      status: 400, code: 'TAILCAT_BAD_ADDRESS',
    });
  }
  if (shuttingDown) throw new Error('PortOS is shutting down');
  const child = spawnFn(bin, ['forward', '--bind=127.0.0.1', tcAddress.trim(), `${localPort}:${remotePort}`],
    safeChildProcessOptions({ env: safeChildProcessEnv(), stdio: ['ignore', 'pipe', 'pipe'] }));
  ownedChildren.add(child);
  child.stdout?.on('data', () => {});
  await new Promise((resolve, reject) => {
    let settled = false;
    let reader;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reader = null;
      // Diagnostics can contain the bearer capability, including across chunks.
      // Drain them, but never expose them in errors or retain them after startup.
      if (error) {
        try { child.kill('SIGTERM'); } catch { /* process event boundary */ }
        reject(error);
      } else resolve();
    };
    const timer = setTimeout(() => finish(new Error('tailcat listener startup timed out')), readyMs);
    reader = createLineReader((line) => {
      if (line.endsWith(`forwarding 127.0.0.1:${localPort} -> remote localhost:${remotePort}`)) finish();
    }, { maxCarry: 4096 });
    child.stderr?.on('data', (chunk) => reader?.push(chunk));
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

async function persistForward(entry) {
  await withLock(async () => {
    const data = await loadForwards();
    const forwards = Array.isArray(data.forwards) ? data.forwards.filter((f) => f.peerId !== entry.peerId) : [];
    forwards.push(entry);
    await saveForwards({ version: 1, forwards });
  });
}

async function forgetForward(peerId) {
  await withLock(async () => {
    const data = await loadForwards();
    const forwards = (Array.isArray(data.forwards) ? data.forwards : []).filter((f) => f.peerId !== peerId);
    await saveForwards({ version: 1, forwards });
  });
}

export function stopForwardForPeer(peerId) {
  return withLifecycle(() => stopForward(peerId));
}

async function stopForward(peerId) {
  const live = liveForwards.get(peerId);
  if (live?.child && !live.child.killed) {
    try {
      live.child.kill('SIGTERM');
    } catch {
      // best-effort
    }
  }
  await forgetForward(peerId);
  liveForwards.delete(peerId);
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
  ensureInstalled = ensureTailcatInstalled,
  allocatePort = allocateLocalPort,
  startForward = startForwardProcess,
  addPeerFn = addPeer,
  persistForwardEntry = persistForward,
  removePeerFn = removeInstancePeer,
} = {}) {
  const trimmed = String(tcAddress || '').trim();
  if (!isValidTcAddress(trimmed)) {
    throw new ServerError('Invalid tailcat address — paste a tc… address from the peer', {
      status: 400,
      code: 'TAILCAT_BAD_ADDRESS',
    });
  }

  if (shuttingDown) throw new Error('PortOS is shutting down');
  const { bin } = await ensureInstalled();
  const localPort = await allocatePort();
  const remotePort = DEFAULT_TAILCAT_REMOTE_PORT;

  let child;
  try {
    child = await startForward({ bin, tcAddress: trimmed, localPort, remotePort });
  } catch (err) {
    throw new ServerError(
      `Could not start tailcat forward: ${err.message}`,
      { status: 502, code: 'TAILCAT_FORWARD_FAILED' }
    );
  }

  ownedChildren.add(child);
  child.once('exit', () => ownedChildren.delete(child));
  let peer;
  try {
    if (shuttingDown) throw new Error('PortOS is shutting down');
    peer = await addPeerFn({
      address: '127.0.0.1',
      port: localPort,
      name: name || `tailcat:${redactTcAddress(trimmed)}`,
      auth,
      transport: 'tailcat',
      protocol,
    });
  } catch (err) {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    throw err;
  }

  await persistForwardEntry({
    peerId: peer.id,
    tcAddress: trimmed,
    localPort,
    remotePort,
    createdAt: new Date().toISOString(),
  }).then(() => {
    if (shuttingDown) throw new Error('PortOS is shutting down');
  }).catch(async () => {
    child.kill('SIGTERM');
    // removePeer skips transport cleanup here: this lifecycle operation already
    // owns the child and the queue, so re-entering it would deadlock.
    await removePeerFn(peer.id, { stopTransport: false });
    throw new ServerError('Could not save tailcat forward; peer creation rolled back', {
      status: 503, code: 'TAILCAT_PERSIST_FAILED',
    });
  });

  liveForwards.set(peer.id, { child, localPort, remotePort });
  child.on('exit', () => {
    if (liveForwards.get(peer.id)?.child === child) liveForwards.delete(peer.id);
    console.log(`🐈 tailcat forward stopped for peer ${peer.id} (${redactTcAddress(trimmed)})`);
  });

  return peer;
}

/** Restart persisted forwards after PortOS boot (best-effort). */
export function restoreForwards(options = {}) {
  return withLifecycle(() => restoreTailcatForwards(options));
}

async function restoreTailcatForwards({
  ensureInstalled = ensureTailcatInstalled,
  startForward = startForwardProcess,
  getPeersFn = getPeers,
} = {}) {
  if (shuttingDown) return { restored: 0 };
  const data = await loadForwards();
  const forwards = Array.isArray(data.forwards) ? data.forwards : [];
  if (forwards.length === 0) return { restored: 0 };

  let bin;
  try {
    ({ bin } = await ensureInstalled());
  } catch (err) {
    console.log(`⚠️ tailcat restore skipped — ${err.message}`);
    return { restored: 0, error: err.message };
  }

  const peers = await getPeersFn();
  let restored = 0;
  for (const entry of forwards) {
    if (shuttingDown) break;
    if (!entry?.peerId || !isValidTcAddress(entry.tcAddress)) continue;
    // A stale entry must never resurrect a removed peer or reuse another route.
    if (!peers.some((peer) => peer.id === entry.peerId && peer.transport === 'tailcat'
      && peer.address === '127.0.0.1' && peer.port === entry.localPort)) continue;
    if (!Number.isInteger(entry.localPort) || entry.localPort < 1024 || entry.localPort > 65535
      || entry.remotePort !== DEFAULT_TAILCAT_REMOTE_PORT) continue;
    if (liveForwards.has(entry.peerId)) continue;
    try {
      const child = await startForward({
        bin,
        tcAddress: entry.tcAddress,
        localPort: entry.localPort || DEFAULT_TAILCAT_LOCAL_PORT,
        remotePort: entry.remotePort || DEFAULT_TAILCAT_REMOTE_PORT,
      });
      liveForwards.set(entry.peerId, {
        child,
        localPort: entry.localPort,
        remotePort: entry.remotePort || DEFAULT_TAILCAT_REMOTE_PORT,
      });
      child.on('exit', () => {
        if (liveForwards.get(entry.peerId)?.child === child) liveForwards.delete(entry.peerId);
      });
      restored += 1;
    } catch (err) {
      console.log(`⚠️ tailcat restore failed for peer ${entry.peerId}`);
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

