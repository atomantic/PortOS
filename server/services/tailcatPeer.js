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
import { delimiter, join } from 'node:path';
import { spawn } from '../lib/childProcess.js';
import { createLineReader } from '../lib/streamLines.js';
import { commandExists } from '../lib/commandExists.js';
import { bufferedSpawn, spawnFailureDetail } from '../lib/bufferedSpawn.js';
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
const BREW_FORMULA = 'tailcat';
const RELEASES_URL = 'https://github.com/tailscale/tailcat/releases';
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

/**
 * Where a freshly installed `tailcat` can land. PATH is checked first, then the
 * install directories a package manager uses but a long-running server process
 * may never have inherited: GOBIN / GOPATH/bin for `go install`, and the
 * Homebrew prefix for `brew install`.
 */
export function listCandidateTailcatBins({ env = process.env, home = homedir() } = {}) {
  // GOPATH may be a delimiter-separated list; `go install` writes into the first entry's bin.
  const goPath = String(env.GOPATH || '').split(delimiter).find(Boolean) || join(home, 'go');
  const goBinDir = env.GOBIN || join(goPath, 'bin');
  const brewPrefixes = [env.HOMEBREW_PREFIX, '/opt/homebrew', '/usr/local'].filter(Boolean);
  const candidates = [
    findCommandOnPath('tailcat', { env }),
    join(goBinDir, 'tailcat'),
    join(goBinDir, 'tailcat.exe'),
    ...brewPrefixes.map((prefix) => join(prefix, 'bin', 'tailcat')),
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
 * Manual-install guidance for this host. Tailcat publishes release binaries for
 * Linux and Windows ONLY — pointing a macOS operator at the releases page is a
 * dead end, so darwin gets the Homebrew formula instead.
 */
export function manualInstallHint(platform = process.platform) {
  if (platform === 'darwin') {
    return `Install it with \`brew install ${BREW_FORMULA}\` (Tailcat ships no macOS release binary), then retry.`;
  }
  return `Install a release binary from ${RELEASES_URL}, then retry.`;
}

/**
 * Ordered install strategies available on this host.
 *
 * Homebrew comes first: it is the only prebuilt route on macOS, and it fetches
 * over plain HTTPS, so it still works where `go install` cannot reach the Go
 * module proxy (a local network filter breaking Go's dialer shows up as an
 * opaque `connect: bad file descriptor`). `go install` stays as the fallback
 * for hosts with a toolchain but no brew.
 */
export function listTailcatInstallers({
  brewBin = findCommandOnPath('brew'),
  goBin = findCommandOnPath('go'),
  runInstall = runInstallCommand,
} = {}) {
  const installers = [];
  if (brewBin) {
    installers.push({
      label: `brew install ${BREW_FORMULA}`,
      // Auto-update pulls the whole formula index before installing a ~10MB
      // bottle; the operator asked to add a peer, not to refresh Homebrew.
      run: () => runInstall(brewBin, ['install', BREW_FORMULA], {
        HOMEBREW_NO_AUTO_UPDATE: '1',
        HOMEBREW_NO_INSTALL_CLEANUP: '1',
      }),
    });
  }
  if (goBin) {
    installers.push({
      label: 'go install',
      run: () => runInstall(goBin, ['install', GO_INSTALL_PKG]),
    });
  }
  return installers;
}

/**
 * Resolve a runnable `tailcat`, installing it through the first strategy that
 * works. Every strategy is a named package manager the operator already has —
 * PortOS never downloads an arbitrary URL on their behalf — and a total failure
 * reports what each one actually said so the operator can act on it.
 */
export async function ensureTailcatInstalled({
  detect = detectTailcat,
  installers = listTailcatInstallers(),
  platform = process.platform,
} = {}) {
  const existing = await detect();
  if (existing) return { bin: existing, installed: false };

  if (installers.length === 0) {
    throw new ServerError(
      `tailcat is not installed, and neither Homebrew nor Go was found on PATH. ${manualInstallHint(platform)}`,
      { status: 503, code: 'TAILCAT_MISSING' }
    );
  }

  const failures = [];
  for (const installer of installers) {
    // Promise.resolve().then defers the call, so an installer that throws
    // SYNCHRONOUSLY still falls through to the next one instead of escaping
    // past the ServerError wrapper as an unhandled 500.
    const error = await Promise.resolve().then(() => installer.run()).then(() => null, (err) => err);
    if (error) {
      failures.push(`${installer.label} failed: ${summarizeInstallError(error)}`);
      continue;
    }
    const bin = await detect();
    if (bin) return { bin, installed: true };
    failures.push(`${installer.label} finished but no tailcat binary was found`);
  }

  throw new ServerError(
    `Could not install tailcat — ${failures.join('; ')}. ${manualInstallHint(platform)}`,
    { status: 503, code: 'TAILCAT_INSTALL_FAILED' }
  );
}

/** One line of an installer's diagnostics, bounded so a toast stays readable. */
function summarizeInstallError(error) {
  const first = String(error?.message || 'unknown error').split('\n').map((line) => line.trim()).find(Boolean);
  const text = first || 'unknown error';
  return text.length > 240 ? `${text.slice(0, 240)}…` : text;
}

async function runInstallCommand(bin, args, extraEnv = {}) {
  const result = await bufferedSpawn(bin, args, {
    env: safeChildProcessEnv(extraEnv),
    timeoutMs: INSTALL_TIMEOUT_MS,
  });
  if (result.success) return;
  throw new Error(result.timedOut
    ? `timed out after ${INSTALL_TIMEOUT_MS / 1000}s`
    // Homebrew opens with tap/deprecation warnings, so its FIRST stderr line is
    // rarely the failure — spawnFailureDetail takes the last one it printed.
    : spawnFailureDetail(result, `exit ${result.code}`));
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

