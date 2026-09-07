/**
 * Machine-local `tailcat serve` for the PortOS API port — the reverse polarity
 * of `tailcatPeer.js` forwards.
 *
 * When this node is a better *outbound initiator* than the peer that should
 * dial it (firewall / Little Snitch / path asymmetry), the operator starts
 * serve here, copies the printed `tc…` address out of band, and pastes it into
 * the *other* PortOS as Dial-them (forward). No Tailscale account, no
 * `serve all`, no exit-node.
 *
 * The serve address is this machine's own capability: it is persisted
 * machine-locally, returned by the status API so the Instances UI can offer a
 * Copy control, and always redacted in logs. It is never placed on a peer
 * record, never federated, and never committed.
 */

import { mkdir, readFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { spawn } from '../lib/childProcess.js';
import { bufferedSpawn, spawnFailureDetail } from '../lib/bufferedSpawn.js';
import { dataPath, readJSONFile, ensureDir, PATHS, atomicWrite } from '../lib/fileUtils.js';
import { createMutex } from '../lib/asyncMutex.js';
import { PORTS } from '../lib/ports.js';
import { ServerError } from '../lib/errorHandler.js';
import { safeChildProcessEnv, safeChildProcessOptions } from '../lib/processEnv.js';
import {
  ensureTailcatInstalled,
  primeDerpMapCache,
  isValidTcAddress,
  redactTcAddress,
  redactTailcatDiagnostics,
} from './tailcatPeer.js';

const SERVE_FILE = dataPath('tailcat-serve.json');
const ADDR_FILE = dataPath('tailcat-serve.addr');
const DEFAULT_KEY_NAME = 'portos-api';
const DEFAULT_LOCAL_PORT = PORTS.API;
const SERVE_READY_MS = 20_000;
const DIAGNOSTIC_TAIL_CHARS = 4096;
const GENKEY_TIMEOUT_MS = 60_000;
const DEFAULT_DATA = { version: 1, serve: null };

const withLock = createMutex();
const withLifecycle = createMutex();

/** @type {{ child: import('node:child_process').ChildProcess, localPort: number, keyName: string } | null} */
let liveServe = null;
let shuttingDown = false;

/**
 * Normalize a stored serve record. Drop anything that cannot drive a restore
 * (missing key name / bad port). The tc address is optional until the first
 * successful start prints one.
 */
function normalizeServeEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const keyName = typeof entry.keyName === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(entry.keyName)
    ? entry.keyName
    : DEFAULT_KEY_NAME;
  const localPort = Number.isInteger(entry.localPort) && entry.localPort >= 1 && entry.localPort <= 65535
    ? entry.localPort
    : DEFAULT_LOCAL_PORT;
  const status = ['active', 'failed', 'stopped', 'pending'].includes(entry.status)
    ? entry.status
    : 'stopped';
  const tcAddress = isValidTcAddress(entry.tcAddress) ? entry.tcAddress.trim() : null;
  return {
    enabled: entry.enabled === true,
    status,
    localPort,
    keyName,
    tcAddress,
    lastError: typeof entry.lastError === 'string' ? entry.lastError : null,
    lastErrorAt: typeof entry.lastErrorAt === 'string' ? entry.lastErrorAt : null,
    createdAt: typeof entry.createdAt === 'string' ? entry.createdAt : new Date().toISOString(),
    updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : null,
  };
}

async function loadServeData() {
  const data = await readJSONFile(SERVE_FILE, DEFAULT_DATA, { strict: true, logError: false })
    .catch(() => { throw new ServerError('Could not read tailcat serve storage', { status: 503 }); });
  if (data?.version !== 1) {
    throw new ServerError('Invalid tailcat serve storage', { status: 503 });
  }
  return { version: 1, serve: normalizeServeEntry(data.serve) };
}

async function saveServeEntry(entry) {
  await ensureDir(PATHS.data);
  await atomicWrite(SERVE_FILE, { version: 1, serve: entry });
}

async function readServeEntry() {
  const data = await loadServeData();
  return data.serve;
}

async function patchServeEntry(patch) {
  return withLock(async () => {
    const current = await readServeEntry() || {
      enabled: false,
      status: 'stopped',
      localPort: DEFAULT_LOCAL_PORT,
      keyName: DEFAULT_KEY_NAME,
      tcAddress: null,
      lastError: null,
      lastErrorAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: null,
    };
    const next = normalizeServeEntry({
      ...current,
      ...patch,
      updatedAt: new Date().toISOString(),
    });
    await saveServeEntry(next);
    return next;
  });
}

async function markServeFailed(error) {
  const detail = redactTailcatDiagnostics(error?.message || String(error || 'unknown error'));
  await patchServeEntry({
    status: 'failed',
    lastError: detail || 'unknown error',
    lastErrorAt: new Date().toISOString(),
  }).catch(() => null);
}

/**
 * Operator-facing serve status. Returns the full `tcAddress` when known so the
 * Instances UI can offer Copy — this is *our* serve address, not a peer's
 * pasted capability. Logs elsewhere still use the redacted form only.
 */
export async function getTailcatServeStatus() {
  const entry = await readServeEntry();
  const live = !!(liveServe?.child && !liveServe.child.killed);
  if (!entry) {
    return {
      enabled: false,
      status: 'stopped',
      live: false,
      localPort: DEFAULT_LOCAL_PORT,
      keyName: DEFAULT_KEY_NAME,
      tcAddress: null,
      tcAddressRedacted: null,
      hasAddress: false,
      lastError: null,
      lastErrorAt: null,
      createdAt: null,
      updatedAt: null,
    };
  }
  return {
    enabled: entry.enabled,
    status: live ? 'active' : entry.status,
    live,
    localPort: entry.localPort,
    keyName: entry.keyName,
    tcAddress: entry.tcAddress,
    tcAddressRedacted: entry.tcAddress ? redactTcAddress(entry.tcAddress) : null,
    hasAddress: !!entry.tcAddress,
    lastError: entry.lastError,
    lastErrorAt: entry.lastErrorAt,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}

/**
 * Ensure a named server key exists under tailcat's config dir. `genkey` without
 * `--force` refuses to overwrite; that refusal is success for us — we want a
 * stable address across PortOS restarts.
 */
export async function ensureServeKey({
  bin,
  keyName = DEFAULT_KEY_NAME,
  runGenkey = (b, args) => bufferedSpawn(b, args, {
    env: safeChildProcessEnv(),
    timeoutMs: GENKEY_TIMEOUT_MS,
  }),
} = {}) {
  if (!bin) throw new ServerError('tailcat binary required to create a serve key', { status: 503 });
  const result = await runGenkey(bin, ['genkey', `--key=${keyName}`]);
  if (result.success) return { created: true, keyName };
  const detail = spawnFailureDetail(result, `exit ${result.code}`);
  // Existing key is the common case after the first start.
  if (/already|exist|overwrite/i.test(detail)) {
    return { created: false, keyName };
  }
  // Proceed anyway: serve will fail with a clearer message if the key is gone.
  // A DERP-map blip during genkey should not block a retry that already has a key.
  return { created: false, keyName, warning: redactTailcatDiagnostics(detail) };
}

/**
 * Parse `{"listenAddr":"tc…"}` JSON that `tailcat serve --json` writes to stdout.
 */
export function parseServeListenAddr(text) {
  const raw = String(text || '');
  // The encoder writes one JSON object; tolerate leading chatter / multiple lines.
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      const addr = typeof parsed?.listenAddr === 'string' ? parsed.listenAddr.trim() : '';
      if (isValidTcAddress(addr)) return addr;
    } catch {
      // not the listenAddr frame
    }
  }
  // Fallback: a bare tc… token (e.g. TAILCAT_ADDR_FILE contents).
  const match = raw.match(/tc[A-Za-z0-9_+\/=-]{24,}/);
  return match && isValidTcAddress(match[0]) ? match[0] : null;
}

/**
 * Start `tailcat serve --full-address --json --key=<name> <port>`. Resolves once
 * the listen address is known (stdout JSON and/or TAILCAT_ADDR_FILE).
 */
export async function startServeProcess({
  bin,
  localPort = DEFAULT_LOCAL_PORT,
  keyName = DEFAULT_KEY_NAME,
  addrFile = ADDR_FILE,
  spawnFn = spawn,
  readyMs = SERVE_READY_MS,
  readFileFn = readFile,
  mkdirFn = mkdir,
} = {}) {
  if (shuttingDown) throw new Error('PortOS is shutting down');
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) {
    throw new ServerError('Invalid local port for tailcat serve', { status: 400, code: 'TAILCAT_SERVE_BAD_PORT' });
  }

  await mkdirFn(dirname(addrFile), { recursive: true }).catch(() => null);
  await unlink(addrFile).catch(() => null);

  const child = spawnFn(
    bin,
    ['serve', '--verbose', '--full-address', '--json', `--key=${keyName}`, String(localPort)],
    safeChildProcessOptions({
      env: safeChildProcessEnv({ TAILCAT_ADDR_FILE: addrFile }),
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );

  let stdoutTail = '';
  let stderrTail = '';
  let settled = false;
  let resolvedAddr = null;
  let resolveReady;
  let rejectReady;
  let timer;
  let poller;

  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const finish = (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    clearInterval(poller);
    const diagnostics = error ? redactTailcatDiagnostics(stderrTail || stdoutTail) : '';
    if (error) {
      if (diagnostics) error.message = `${error.message} — tailcat said: ${diagnostics}`;
      try { child.kill('SIGTERM'); } catch { /* process event boundary */ }
      rejectReady(error);
    } else {
      resolveReady();
    }
  };

  const tryResolve = async () => {
    if (settled) return;
    const fromStdout = parseServeListenAddr(stdoutTail);
    if (fromStdout) {
      resolvedAddr = fromStdout;
      finish();
      return;
    }
    const fromFile = await readFileFn(addrFile, 'utf8').then(
      (text) => parseServeListenAddr(text),
      () => null,
    );
    if (fromFile) {
      resolvedAddr = fromFile;
      finish();
    }
  };

  timer = setTimeout(() => finish(new Error('tailcat serve startup timed out')), readyMs);
  poller = setInterval(() => { tryResolve().catch(() => {}); }, 150);

  child.stdout?.on('data', (chunk) => {
    stdoutTail = (stdoutTail + String(chunk)).slice(-DIAGNOSTIC_TAIL_CHARS);
    tryResolve().catch(() => {});
  });
  child.stderr?.on('data', (chunk) => {
    stderrTail = (stderrTail + String(chunk)).slice(-DIAGNOSTIC_TAIL_CHARS);
    // Human line often includes the address before --json flushes; harvest it.
    const fromErr = parseServeListenAddr(stderrTail);
    if (fromErr) {
      resolvedAddr = fromErr;
      finish();
      return;
    }
    tryResolve().catch(() => {});
  });
  child.on('error', () => finish(new Error('tailcat serve process failed')));
  child.once('exit', (code, signal) => {
    if (!settled) {
      finish(new Error(`tailcat serve exited early (code=${code}, signal=${signal})`));
    }
  });

  await ready;

  console.log(
    `🐈 tailcat serve listening for PortOS :${localPort} (${redactTcAddress(resolvedAddr)}, key=${keyName})`,
  );
  return { child, tcAddress: resolvedAddr, localPort, keyName };
}

function killLiveServe() {
  if (liveServe?.child && !liveServe.child.killed) {
    try { liveServe.child.kill('SIGTERM'); } catch { /* best-effort */ }
  }
  liveServe = null;
}

function trackServe(child, localPort, keyName) {
  liveServe = { child, localPort, keyName };
  child.on('exit', () => {
    if (liveServe?.child === child) liveServe = null;
  });
}

/**
 * Ensure serve is running for the PortOS API port. Idempotent when already live
 * with the same port/key; otherwise stops and restarts.
 */
export function ensureTailcatServe(options = {}) {
  return withLifecycle(() => ensureServe(options));
}

async function ensureServe({
  localPort = DEFAULT_LOCAL_PORT,
  keyName = DEFAULT_KEY_NAME,
  ensureInstalled = ensureTailcatInstalled,
  primeDerpMap = primeDerpMapCache,
  ensureKey = ensureServeKey,
  startServe = startServeProcess,
  persist = patchServeEntry,
} = {}) {
  if (shuttingDown) throw new Error('PortOS is shutting down');

  const port = Number.isInteger(localPort) ? localPort : DEFAULT_LOCAL_PORT;
  const key = typeof keyName === 'string' && keyName ? keyName : DEFAULT_KEY_NAME;

  // Persist intent before spawn so a failed start stays retryable / restorable.
  await persist({
    enabled: true,
    status: 'pending',
    localPort: port,
    keyName: key,
    lastError: null,
    lastErrorAt: null,
  }).catch(() => {
    throw new ServerError('Could not save tailcat serve config; nothing was started', {
      status: 503, code: 'TAILCAT_SERVE_PERSIST_FAILED',
    });
  });

  if (liveServe?.child && !liveServe.child.killed
    && liveServe.localPort === port && liveServe.keyName === key) {
    const entry = await readServeEntry();
    await persist({
      enabled: true,
      status: 'active',
      localPort: port,
      keyName: key,
      tcAddress: entry?.tcAddress || null,
      lastError: null,
      lastErrorAt: null,
    });
    return getTailcatServeStatus();
  }

  killLiveServe();

  try {
    const { bin } = await ensureInstalled();
    await Promise.resolve().then(primeDerpMap).catch(() => null);
    await ensureKey({ bin, keyName: key });
    const started = await startServe({ bin, localPort: port, keyName: key });
    trackServe(started.child, started.localPort, started.keyName);
    await persist({
      enabled: true,
      status: 'active',
      localPort: started.localPort,
      keyName: started.keyName,
      tcAddress: started.tcAddress,
      lastError: null,
      lastErrorAt: null,
    });
    started.child.on('exit', () => {
      console.log(`🐈 tailcat serve stopped (${redactTcAddress(started.tcAddress)})`);
    });
    return getTailcatServeStatus();
  } catch (err) {
    await markServeFailed(err);
    throw err instanceof ServerError
      ? err
      : new ServerError(`Could not start tailcat serve: ${err.message}`, {
        status: 502, code: 'TAILCAT_SERVE_FAILED',
      });
  }
}

/** Restart serve from the saved config (or defaults). */
export function retryTailcatServe(options = {}) {
  return withLifecycle(async () => {
    const entry = await readServeEntry();
    killLiveServe();
    return ensureServe({
      localPort: entry?.localPort || DEFAULT_LOCAL_PORT,
      keyName: entry?.keyName || DEFAULT_KEY_NAME,
      ...options,
    });
  });
}

/**
 * Stop the live serve process. When `disable` is true (default), clear the
 * restore-on-boot flag so the next PortOS start leaves serve off.
 */
export function stopTailcatServe({ disable = true } = {}) {
  return withLifecycle(async () => {
    killLiveServe();
    const entry = await readServeEntry();
    if (!entry && !disable) {
      return getTailcatServeStatus();
    }
    await patchServeEntry({
      enabled: disable ? false : (entry?.enabled === true),
      status: 'stopped',
      localPort: entry?.localPort || DEFAULT_LOCAL_PORT,
      keyName: entry?.keyName || DEFAULT_KEY_NAME,
      tcAddress: entry?.tcAddress || null,
      lastError: null,
      lastErrorAt: null,
    });
    return getTailcatServeStatus();
  });
}

/** Restore serve after PortOS boot when the operator left it enabled. */
export function restoreServe(options = {}) {
  return withLifecycle(() => restoreTailcatServe(options));
}

async function restoreTailcatServe({
  ensureInstalled = ensureTailcatInstalled,
  primeDerpMap = primeDerpMapCache,
  ensureKey = ensureServeKey,
  startServe = startServeProcess,
} = {}) {
  if (shuttingDown) return { restored: false };
  const entry = await readServeEntry();
  if (!entry?.enabled) return { restored: false, reason: 'disabled' };
  if (liveServe) return { restored: false, reason: 'already-live' };

  try {
    const { bin } = await ensureInstalled();
    await Promise.resolve().then(primeDerpMap).catch(() => null);
    await ensureKey({ bin, keyName: entry.keyName });
    const started = await startServe({
      bin,
      localPort: entry.localPort,
      keyName: entry.keyName,
    });
    trackServe(started.child, started.localPort, started.keyName);
    await patchServeEntry({
      enabled: true,
      status: 'active',
      localPort: started.localPort,
      keyName: started.keyName,
      tcAddress: started.tcAddress || entry.tcAddress,
      lastError: null,
      lastErrorAt: null,
    });
    console.log(`🐈 Restored tailcat serve on :${started.localPort}`);
    return { restored: true };
  } catch (err) {
    console.log(`⚠️ tailcat serve restore failed — ${redactTailcatDiagnostics(err.message)}`);
    await markServeFailed(err);
    return { restored: false, error: redactTailcatDiagnostics(err.message) };
  }
}

/** Stop the serve child on PortOS shutdown; keep enabled metadata for next boot. */
export function stopServeProcess() {
  shuttingDown = true;
  killLiveServe();
}

// Test-only helpers
export function _resetLiveServeForTests() {
  stopServeProcess();
  shuttingDown = false;
  liveServe = null;
}

export function _liveServeForTests() {
  return liveServe;
}

export { DEFAULT_KEY_NAME, DEFAULT_LOCAL_PORT as DEFAULT_SERVE_PORT };
