/**
 * Machine-local `tailcat serve` for the remote ingress port — the reverse polarity
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

import { createHash } from 'node:crypto';
import { instanceEvents } from './instanceEvents.js';
import { ensureTailcatIngress } from './tailcatIngress.js';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { spawn } from '../lib/childProcess.js';
import { bufferedSpawn, spawnFailureDetail } from '../lib/bufferedSpawn.js';
import { dataPath, readJSONFile, ensureDir, PATHS, atomicWrite } from '../lib/fileUtils.js';
import { createMutex } from '../lib/asyncMutex.js';
import { PORTS } from '../lib/ports.js';
import { ServerError } from '../lib/errorHandler.js';
import { safeChildProcessEnv, safeChildProcessOptions } from '../lib/processEnv.js';
import { ensureTailcatInstalled, primeDerpMapCache } from './tailcatRuntime.js';
import {
  isValidTcAddress,
  isValidNodePublicKey,
  redactTcAddress,
  redactTailcatDiagnostics,
} from '../lib/tailcatAddress.js';

const SERVE_FILE = dataPath('tailcat-serve.json');
const ADDR_FILE = dataPath('tailcat-serve.addr');
const DEFAULT_KEY_NAME = 'portos-api';
const DEFAULT_LOCAL_PORT = PORTS.TAILCAT_INGRESS;
const SERVE_READY_MS = 20_000;
const DIAGNOSTIC_TAIL_CHARS = 4096;
const GENKEY_TIMEOUT_MS = 60_000;
const RELAY_OBSERVATION_MS = 5 * 60 * 1000;
const DEFAULT_DATA = { version: 2, serve: null };
const MAX_DEVICES = 100;

const withLock = createMutex();
const withLifecycle = createMutex();

/** @type {{ child: import('node:child_process').ChildProcess, localPort: number, keyName: string } | null} */
let liveServe = null;
let shuttingDown = false;

/** Observe complete stderr lines without exposing their private endpoints or tokens. */
function observeServeRelay(child) {
  let partial = '';
  let droppingLine = false;
  let expiry;
  let closed = false;
  // Relay evidence belongs to this process, never the persisted serve config.
  child.tailcatRelay = { status: 'unknown', error: null, at: null };
  let failedRegion = null;
  const publish = (status, error, at = new Date().toISOString()) => {
    clearTimeout(expiry);
    if (status === 'unknown') failedRegion = null;
    child.tailcatRelay = { status, error, at };
    child.emit('tailcat:relay');
    if (status !== 'unknown') {
      expiry = setTimeout(() => {
        if (!closed) publish('unknown', null, null);
      }, RELAY_OBSERVATION_MS);
      expiry.unref?.();
    }
  };
  const lineReceived = (line) => {
    if (!/\bderp(?:http|[-.( :])/i.test(line)) return;
    const region = line.match(/\bderp-(\d+)\b/)?.[1] || null;
    if (/\bmagicsock: derp-\d+ connected\b/.test(line)) {
      // A different relay connecting does not disprove the observed failure.
      if (failedRegion && region !== failedRegion) return;
      failedRegion = null;
      publish('connected', null);
    } else if (/\b(?:error|failed|timeout|timed out|deadline exceeded|refused|no such host|socket is not connected)\b/i.test(line)
      || /\bclosing connection to derp-\d+.*\(conn-close\)/.test(line)) {
      failedRegion = region;
      // Fixed messages intentionally avoid replaying arbitrary CLI text. Even a
      // truncated capability, password or endpoint cannot cross this boundary.
      const error = /timeout|timed out|deadline exceeded/i.test(line)
        ? 'Tailcat relay connection timed out.'
        : 'Tailcat reported a relay connection failure or loss.';
      publish('degraded', error);
    }
  };
  child.stderr?.on('data', (chunk) => {
    if (closed) return;
    try {
      for (const part of String(chunk).split(/(\n)/)) {
        if (part === '\n') {
          if (!droppingLine) lineReceived(partial);
          partial = '';
          droppingLine = false;
        } else if (!droppingLine) {
          if (partial.length + part.length > DIAGNOSTIC_TAIL_CHARS) {
            partial = '';
            droppingLine = true;
          } else partial += part;
        }
      }
    } catch { /* process stream boundary: diagnostics must not stop PortOS */ }
  });
  child.disposeTailcatRelay = () => {
    closed = true;
    partial = '';
    clearTimeout(expiry);
  };
  child.once('exit', child.disposeTailcatRelay);
}

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
  // Old managed entries targeted the main API. Never restore that authority.
  const localPort = DEFAULT_LOCAL_PORT;
  const status = ['active', 'failed', 'stopped', 'pending', 'suspended'].includes(entry.status)
    ? entry.status
    : 'stopped';
  const tcAddress = isValidTcAddress(entry.tcAddress) ? entry.tcAddress.trim() : null;
  // Invalid policy never becomes capability-only or an empty, permissive list.
  if ((entry.deviceEnforcement !== undefined && typeof entry.deviceEnforcement !== 'boolean')
    || (entry.devices !== undefined && (!Array.isArray(entry.devices) || entry.devices.length > MAX_DEVICES))) {
    throw new ServerError('Invalid Tailcat device policy', { status: 503 });
  }
  const devices = (entry.devices ?? []).map((device) => {
    if (!isValidNodePublicKey(device?.publicKey) || device.id !== deviceId(device.publicKey)
      || typeof device.label !== 'string' || !device.label.trim() || device.label.length > 100
      || !validTimestamp(device.approvedAt)
      || (device.revokedAt !== null && !validTimestamp(device.revokedAt))) {
      throw new ServerError('Invalid Tailcat device identity', { status: 503 });
    }
    return { id: device.id, label: device.label, publicKey: device.publicKey,
      approvedAt: device.approvedAt, revokedAt: device.revokedAt };
  });
  if (new Set(devices.map(device => device.id)).size !== devices.length) {
    throw new ServerError('Duplicate Tailcat device identity', { status: 503 });
  }
  return {
    enabled: entry.enabled === true,
    deviceEnforcement: entry.deviceEnforcement === true,
    devices,
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

function validTimestamp(value) {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function deviceId(publicKey) {
  return createHash('sha256').update(publicKey).digest('hex');
}

function allowedKeys(entry) {
  return entry?.deviceEnforcement ? entry.devices.filter(device => device.revokedAt === null).map(device => device.publicKey).sort() : null;
}

function policyIdentity(entry) {
  return JSON.stringify(allowedKeys(entry));
}

function deviceState(entry, live) {
  const keys = allowedKeys(entry);
  const enabled = entry?.deviceEnforcement === true;
  return {
    devices: entry?.devices ?? [],
    enforcement: {
      enabled,
      state: !enabled ? 'capability-only'
        : live && !liveServe.stopping && liveServe.policy === policyIdentity(entry) ? 'enforced'
          : keys.length === 0 && !live ? 'suspended' : 'pending',
      approvedCount: (entry?.devices ?? []).filter(device => device.revokedAt === null).length,
    },
  };
}

/** Device management never returns the server capability. */
export async function getTailcatDevices() {
  const status = await getTailcatServeStatus();
  delete status.tcAddress;
  return status;
}

export function approveTailcatDevice({ label, publicKey }, options = {}) {
  if (!isValidNodePublicKey(publicKey) || typeof label !== 'string' || !label.trim() || label.trim().length > 100) {
    throw new ServerError('A label and client nodekey public key are required', { status: 400 });
  }
  return changeDevicePolicy((entry) => {
    const id = deviceId(publicKey);
    const existing = entry.devices.find(device => device.id === id);
    if (!existing && entry.devices.length >= MAX_DEVICES) {
      throw new ServerError('Tailcat device limit reached', { status: 409 });
    }
    const device = { id, label: label.trim(), publicKey,
      approvedAt: existing?.revokedAt === null ? existing.approvedAt : new Date().toISOString(), revokedAt: null };
    return { devices: [...entry.devices.filter(device => device.id !== id), device] };
  }, options);
}

export function revokeTailcatDevice(id, options = {}) {
  return changeDevicePolicy((entry) => {
    if (!entry.devices.some(device => device.id === id)) {
      throw new ServerError('Tailcat device not found', { status: 404 });
    }
    return { devices: entry.devices.map(device => device.id === id
      ? { ...device, revokedAt: device.revokedAt ?? new Date().toISOString() } : device) };
  }, options);
}

export function setTailcatDeviceEnforcement(enabled, options = {}) {
  if (typeof enabled !== 'boolean') throw new ServerError('Enforcement must be boolean', { status: 400 });
  return changeDevicePolicy(() => ({ deviceEnforcement: enabled }), options);
}

function changeDevicePolicy(update, options) {
  return withLifecycle(async () => {
    const entry = await readServeEntry() ?? { devices: [], enabled: false };
    const next = await patchServeEntry(update(entry));
    // Metadata-only edits cannot change admission or justify dropping sessions.
    if (next.enabled && liveServe && !liveServe.exited && !liveServe.stopping
      && liveServe.policy === policyIdentity(next)) return getTailcatDevices();
    // Persist before cutting sessions; a failed save never reports revocation.
    // Even a previously failed replacement remains retryable with the new policy.
    await terminateLiveServe();
    if (entry.enabled) await ensureServe({ ...options, keyName: entry.keyName });
    return getTailcatDevices();
  });
}

async function loadServeData() {
  const data = await readJSONFile(SERVE_FILE, DEFAULT_DATA, { strict: true, logError: false })
    .catch(() => { throw new ServerError('Could not read tailcat serve storage', { status: 503 }); });
  if (![1, 2].includes(data?.version)
    || (data.version === 2 && data.serve && (typeof data.serve.deviceEnforcement !== 'boolean' || !Array.isArray(data.serve.devices)))) {
    throw new ServerError('Invalid tailcat serve storage', { status: 503 });
  }
  return { version: 2, serve: normalizeServeEntry(data.serve) };
}

async function saveServeEntry(entry) {
  await ensureDir(PATHS.data);
  await atomicWrite(SERVE_FILE, { version: 2, serve: entry });
  instanceEvents.emit('tailcat:serve:changed');
}

async function readServeEntry() {
  const data = await loadServeData();
  return data.serve;
}

async function patchServeEntry(patch) {
  return withLock(async () => {
    const current = await readServeEntry() || {
      enabled: false,
      deviceEnforcement: false,
      devices: [],
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
  }).catch(() => {
    // Process state still changed even if its failure cannot be persisted.
    instanceEvents.emit('tailcat:serve:changed');
  });
}

/**
 * Operator-facing serve status. Returns the full `tcAddress` when known so the
 * Instances UI can offer Copy — this is *our* serve address, not a peer's
 * pasted capability. Logs elsewhere still use the redacted form only.
 */
export async function getTailcatServeStatus() {
  const entry = await readServeEntry();
  const live = !!(liveServe?.child && !liveServe.exited);
  if (!entry) {
    return {
      ...deviceState(null, false),
      enabled: false,
      status: 'stopped',
      live: false,
      relayStatus: 'unknown',
      relayError: null,
      relayObservedAt: null,
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
    ...deviceState(entry, live),
    enabled: entry.enabled,
    status: live ? 'active' : (entry.status === 'active' ? 'stopped' : entry.status),
    live,
    relayStatus: live ? (liveServe.child.tailcatRelay?.status || 'unknown') : 'unknown',
    relayError: live ? (liveServe.child.tailcatRelay?.error || null) : null,
    relayObservedAt: live ? (liveServe.child.tailcatRelay?.at || null) : null,
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
  approvedKeys = null,
} = {}) {
  if (shuttingDown) throw new Error('PortOS is shutting down');
  if (localPort !== DEFAULT_LOCAL_PORT) {
    throw new ServerError('Managed Tailcat serve must use the remote ingress port', { status: 400, code: 'TAILCAT_SERVE_BAD_PORT' });
  }

  if (approvedKeys !== null && (!Array.isArray(approvedKeys) || approvedKeys.length === 0
    || approvedKeys.some(key => !isValidNodePublicKey(key)))) {
    throw new ServerError('An enforced Tailcat listener requires approved public keys', { status: 409 });
  }

  await mkdirFn(dirname(addrFile), { recursive: true }).catch(() => null);
  await unlink(addrFile).catch(() => null);

  const child = spawnFn(
    bin,
    ['serve', '--verbose', '--full-address', '--json', `--key=${keyName}`,
      ...(approvedKeys === null ? [] : [`--allow=${approvedKeys.join(',')}`]), String(localPort)],
    safeChildProcessOptions({
      env: safeChildProcessEnv({ TAILCAT_ADDR_FILE: addrFile }),
      stdio: ['ignore', 'pipe', 'pipe'],
    }),
  );

  observeServeRelay(child);

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
    stdoutTail = '';
    stderrTail = '';
    if (error) {
      child.disposeTailcatRelay?.();
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
    if (approvedKeys !== null) return;
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
    if (settled) return;
    stdoutTail = (stdoutTail + String(chunk)).slice(-DIAGNOSTIC_TAIL_CHARS);
    tryResolve().catch(() => {});
  });
  child.stderr?.on('data', (chunk) => {
    if (settled) return;
    stderrTail = (stderrTail + String(chunk)).slice(-DIAGNOSTIC_TAIL_CHARS);
    // Human line often includes the address before --json flushes; harvest it.
    const fromErr = approvedKeys === null ? parseServeListenAddr(stderrTail) : null;
    if (fromErr) {
      resolvedAddr = fromErr;
      finish();
      return;
    }
    tryResolve().catch(() => {});
  });
  child.on('error', () => finish(new Error('tailcat serve process failed')));
  child.once('exit', (code, signal) => {
    child.tailcatExited = true;
    if (!settled) {
      finish(new Error(`tailcat serve exited early (code=${code}, signal=${signal})`));
    }
  });

  await ready;
  if (child.tailcatExited) throw new Error('Tailcat exited before startup completed');

  console.log(
    `🐈 tailcat serve listening for PortOS :${localPort} (${redactTcAddress(resolvedAddr)}, key=${keyName})`,
  );
  return { child, tcAddress: resolvedAddr, localPort, keyName };
}

function killLiveServe() {
  const child = liveServe?.child;
  // Relinquish ownership before signalling: a synchronous exit is intentional.
  liveServe = null;
  child?.disposeTailcatRelay?.();
  if (child) instanceEvents.emit('tailcat:serve:changed');
  if (child && !child.killed) {
    try { child.kill('SIGTERM'); } catch { /* best-effort */ }
  }
}

/** Wait for process exit: child.killed only means a signal was sent. */
async function terminateLiveServe() {
  const owned = liveServe;
  if (!owned) return;
  const { child } = owned;
  owned.stopping = true;
  await new Promise((resolve, reject) => {
    let timer;
    const finished = () => {
      clearTimeout(timer);
      child.removeListener('exit', finished);
      if (liveServe === owned) liveServe = null;
      child.disposeTailcatRelay?.();
      instanceEvents.emit('tailcat:serve:changed');
      resolve();
    };
    if (owned.exited) return finished();
    child.once('exit', finished);
    timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* terminal process boundary */ }
      if (owned.exited) return;
      timer = setTimeout(() => {
        child.removeListener('exit', finished);
        reject(new ServerError('Tailcat has not stopped; device policy is saved but revocation is incomplete', {
          status: 503, code: 'TAILCAT_STOP_UNCONFIRMED',
        }));
      }, 2_000);
    }, 2_000);
    try { child.kill('SIGTERM'); } catch { /* escalate on the bounded timer */ }
  });
}

function trackServe(child, localPort, keyName, entry) {
  if (child.tailcatExited || child.exitCode != null || child.signalCode != null) {
    throw new Error('Tailcat exited before its listener could be tracked');
  }
  liveServe = { child, localPort, keyName, policy: policyIdentity(entry), exited: false, stopping: false };
  const owned = liveServe;
  child.on('tailcat:relay', () => {
    if (liveServe === owned && !child.killed) instanceEvents.emit('tailcat:serve:changed');
  });
  child.on('exit', (code, signal) => {
    owned.exited = true;
    if (liveServe !== owned || owned.stopping) return;
    // Serialize the terminal write behind startup persistence. Retry/stop may
    // already own the lifecycle lock, in which case their newer state wins.
    void withLifecycle(async () => {
      if (shuttingDown || liveServe !== owned) return;
      liveServe = null;
      await markServeFailed(new Error(`tailcat serve exited (code=${code}, signal=${signal})`));
    }).catch((err) => console.error(`❌ Could not record tailcat serve exit: ${redactTailcatDiagnostics(err.message)}`));
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
  ensureIngress = ensureTailcatIngress,
  ensureInstalled = ensureTailcatInstalled,
  primeDerpMap = primeDerpMapCache,
  ensureKey = ensureServeKey,
  startServe = startServeProcess,
  persist = patchServeEntry,
} = {}) {
  if (shuttingDown) throw new Error('PortOS is shutting down');

  if (localPort != null && localPort !== DEFAULT_LOCAL_PORT) {
    throw new ServerError('Managed Tailcat serve must use the remote ingress port', { status: 400, code: 'TAILCAT_SERVE_BAD_PORT' });
  }
  const port = DEFAULT_LOCAL_PORT;
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

  const policy = await readServeEntry();
  const approvedKeys = allowedKeys(policy);
  if (liveServe?.child && !liveServe.child.killed
    && liveServe.localPort === port && liveServe.keyName === key && liveServe.policy === policyIdentity(policy)) {
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

  await terminateLiveServe();
  if (approvedKeys?.length === 0) {
    await persist({ status: 'suspended' });
    return getTailcatServeStatus();
  }

  try {
    await ensureIngress();
    const { bin } = await ensureInstalled();
    await Promise.resolve().then(primeDerpMap).catch(() => null);
    await ensureKey({ bin, keyName: key });
    const started = await startServe({ bin, localPort: port, keyName: key, approvedKeys });
    trackServe(started.child, started.localPort, started.keyName, policy);
    await persist({
      enabled: true,
      status: 'active',
      localPort: started.localPort,
      keyName: started.keyName,
      tcAddress: started.tcAddress,
      lastError: null,
      lastErrorAt: null,
    });
    if (liveServe.exited) throw new Error('Tailcat exited while saving startup state');
    started.child.on('exit', () => {
      console.log(`🐈 tailcat serve stopped (${redactTcAddress(started.tcAddress)})`);
    });
    return getTailcatServeStatus();
  } catch (err) {
    await terminateLiveServe();
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
    await terminateLiveServe();
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
    await terminateLiveServe();
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
  ensureIngress = ensureTailcatIngress,
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
    await ensureServe({ localPort: entry.localPort, keyName: entry.keyName,
      ensureIngress, ensureInstalled, primeDerpMap, ensureKey, startServe });
    return (await getTailcatServeStatus()).live
      ? { restored: true } : { restored: false, reason: 'no-approved-devices' };
  } catch (err) {
    console.log(`⚠️ tailcat serve restore failed — ${redactTailcatDiagnostics(err.message)}`);
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
