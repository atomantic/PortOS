/**
 * Tailcat federated peers — connect to a remote PortOS over
 * [tailcat](https://github.com/tailscale/tailcat) without a Tailscale account.
 *
 * Flow: ensure the `tailcat` CLI is installed → pre-warm the DERP map cache →
 * start `tailcat forward <tcADDR> LOCAL:5555` (preferred LOCAL=15555) → register
 * a normal peer at `127.0.0.1:LOCAL` over HTTP or explicitly selected HTTPS.
 *
 * The tc address is a bearer capability. Persist it only in the machine-local
 * forwards file for restart and retry; never log the full value, never put it on
 * the peer record that clients or peers can scrape, never return it from an API
 * response, and never ship it in docs/tests.
 */

import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawn } from '../lib/childProcess.js';
import { commandExists } from '../lib/commandExists.js';
import { bufferedSpawn, spawnFailureDetail } from '../lib/bufferedSpawn.js';
import { dataPath, readJSONFile, ensureDir, PATHS, atomicWrite } from '../lib/fileUtils.js';
import { createMutex } from '../lib/asyncMutex.js';
import { isPortReachable } from '../lib/connectivity.js';
import { isTestRunner } from '../lib/runtimeEnv.js';
import { findCommandOnPath, safeChildProcessEnv, safeChildProcessOptions } from '../lib/processEnv.js';
import {
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

const FORWARDS_FILE = dataPath('tailcat-forwards.json');
const GO_INSTALL_PKG = 'github.com/tailscale/tailcat/cmd/tailcat@latest';
const BREW_FORMULA = 'tailcat';
const RELEASES_URL = 'https://github.com/tailscale/tailcat/releases';
const DEFAULT_DERP_MAP_URL = 'https://tailcat.dev/derpmap.json';
const INSTALL_TIMEOUT_MS = 180_000;
const FORWARD_READY_MS = 8_000;
const FORWARD_PROBE_INTERVAL_MS = 150;
const DERP_MAP_FRESH_MS = 6 * 60 * 60 * 1000;
const DERP_MAP_FETCH_TIMEOUT_MS = 15_000;
const DIAGNOSTIC_TAIL_CHARS = 4096;
const DIAGNOSTIC_MAX_CHARS = 320;
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

/**
 * Strip every capability-shaped token out of tailcat's own diagnostics, then
 * bound them, so a startup failure can finally be *reported* to the operator
 * instead of collapsing into an opaque "startup timed out". Redaction runs over
 * the whole buffered tail at once, never per chunk, so an address split across
 * reads is still caught after reassembly.
 */
export function redactTailcatDiagnostics(text) {
  const lines = String(text || '')
    // 8+ payload chars, so even a tail-truncated address fragment is scrubbed.
    .replace(/tc[A-Za-z0-9_+\/=-]{8,}/g, 'tc…')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const joined = lines.slice(-3).join(' | ');
  return joined.length > DIAGNOSTIC_MAX_CHARS ? `${joined.slice(0, DIAGNOSTIC_MAX_CHARS)}…` : joined;
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
    remotePort: Number.isInteger(entry.remotePort) ? entry.remotePort : DEFAULT_TAILCAT_REMOTE_PORT,
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
  return entries.map((entry) => ({
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
  }));
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

/** Go's `url.QueryEscape`, which is what names tailcat's DERP map cache files. */
function goQueryEscape(value) {
  return String(value).replace(/[^A-Za-z0-9\-_.~]/g, (char) => (char === ' '
    ? '+'
    : [...Buffer.from(char, 'utf8')].map((byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`).join('')));
}

/** The DERP map URL tailcat will use, honoring the env override it reads itself. */
function derpMapUrl(env = process.env) {
  return env.TAILCAT_DERPMAP_URL || DEFAULT_DERP_MAP_URL;
}

/**
 * tailcat's own on-disk DERP map cache: `<user cache dir>/tailcat/derpmap-<escaped URL>.json`,
 * whose mtime is the stored-at time. Mirrors Go's `os.UserCacheDir()` per platform.
 */
export function derpMapCachePath({
  url = derpMapUrl(),
  env = process.env,
  home = homedir(),
  platform = process.platform,
} = {}) {
  const base = platform === 'darwin' ? join(home, 'Library', 'Caches')
    : platform === 'win32' ? (env.LOCALAPPDATA || join(home, 'AppData', 'Local'))
      : (env.XDG_CACHE_HOME || join(home, '.cache'));
  return join(base, 'tailcat', `derpmap-${goQueryEscape(url)}.json`);
}

/**
 * Pre-warm tailcat's DERP map cache using PortOS's own HTTP stack.
 *
 * tailcat resolves a tc address's relay region by fetching that map with Go's
 * HTTP client. On a host where a local network filter permits Node and curl but
 * blocks Go's dialer, the fetch fails (`context deadline exceeded`, or the same
 * `connect: bad file descriptor` that breaks `go install`) and **every** tailcat
 * command dies before it can serve or dial — while PortOS reaches the identical
 * URL fine. Writing the map into the cache tailcat already reads makes the CLI
 * work without needing the network itself.
 *
 * Strictly best-effort and never fatal: any failure just leaves tailcat to fetch
 * the map the way it normally would. `fetchFn` defaults to null under the test
 * runner so a suite can never reach the network by forgetting to inject it.
 */
export async function primeDerpMapCache({
  url = derpMapUrl(),
  cachePath = derpMapCachePath(),
  fetchFn = isTestRunner() ? null : fetch,
  statFn = stat,
  writeFn = atomicWrite,
  freshMs = DERP_MAP_FRESH_MS,
  now = Date.now(),
} = {}) {
  if (!fetchFn) return { primed: false, reason: 'no-fetch' };
  const cachedAt = await statFn(cachePath).then((info) => info.mtimeMs, () => null);
  if (cachedAt !== null && now - cachedAt < freshMs) return { primed: false, reason: 'fresh' };

  const body = await fetchFn(url, { signal: AbortSignal.timeout(DERP_MAP_FETCH_TIMEOUT_MS) })
    .then((res) => (res.ok ? res.text() : null))
    .catch(() => null);
  // Only a parseable map goes in — never poison the cache with an error page.
  if (!safeParseJson(body)) return { primed: false, reason: 'unavailable' };

  const written = await writeFn(cachePath, body).then(() => true, () => false);
  if (written) console.log(`🐈 Primed tailcat DERP map cache (${body.length} bytes) for ${url}`);
  return { primed: written, reason: written ? 'written' : 'write-failed' };
}

function safeParseJson(text) {
  try {
    const value = JSON.parse(text);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null; // an error page or truncated body is not a DERP map
  }
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
    // Stays attached past startup so the pipe keeps draining, but stops
    // accumulating: settled means the capability bytes are no longer kept.
    child.stderr?.on('data', (chunk) => {
      if (settled) return;
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
  ensureInstalled = ensureTailcatInstalled,
  primeDerpMap = primeDerpMapCache,
  allocatePort = allocateLocalPort,
  startForward = startForwardProcess,
  addPeerFn = addPeer,
  persistForwardEntry = upsertForward,
  patchForwardEntry = patchForward,
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

  // Save the capability BEFORE anything can fail. A forward that never starts
  // then stays retryable from the UI instead of throwing the operator's pasted
  // address away and making them fetch it from the remote a second time.
  const entry = {
    id: `fwd_${randomUUID()}`,
    peerId: null,
    tcAddress: trimmed,
    localPort: null,
    remotePort: DEFAULT_TAILCAT_REMOTE_PORT,
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
    patchForwardEntry, removePeerFn,
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
}) {
  const { bin } = await ensureInstalled();
  // Best-effort, and deliberately before the spawn: on a host whose filter
  // blocks Go's dialer this is the difference between a working tunnel and a
  // CLI that cannot resolve its own relay.
  await primeDerpMap().catch(() => null);
  const remotePort = DEFAULT_TAILCAT_REMOTE_PORT;
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
  let peer = existingPeer;
  try {
    if (shuttingDown) throw new Error('PortOS is shutting down');
    if (peer) {
      // A reallocated port has to reach the peer record too, or every request
      // would keep dialing the port the dead forward used to hold.
      if (peer.port !== localPort) peer = await setPeerPortFn(peer.id, localPort) || peer;
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

  // A live child on a stale mapping would keep the port and mask the retry.
  killLiveForward(entry.id);

  const peers = await getPeersFn();
  const existingPeer = entry.peerId ? peers.find((p) => p.id === entry.peerId) || null : null;
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
  await primeDerpMap().catch(() => null);

  const peers = await getPeersFn();
  let restored = 0;
  for (const entry of forwards) {
    if (shuttingDown) break;
    // A stale entry must never resurrect a removed peer or reuse another route.
    if (!entry.peerId || !peers.some((peer) => peer.id === entry.peerId && peer.transport === 'tailcat'
      && peer.address === '127.0.0.1' && peer.port === entry.localPort)) continue;
    if (!Number.isInteger(entry.localPort) || entry.localPort < 1024 || entry.localPort > 65535
      || entry.remotePort !== DEFAULT_TAILCAT_REMOTE_PORT) continue;
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
