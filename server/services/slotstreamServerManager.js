/**
 * SSD-streaming MoE process manager
 *
 * Lifecycle management (status probe, install, start, stop, recent logs) for a
 * local `slotstream serve` OpenAI-compatible API server, managed as an optional
 * PM2 process (`portos-slotstream`) — the same shape as `mtplxServerManager.js`.
 *
 * A start never downloads weights. An absent checkpoint is reported, not
 * silently fetched. The memory plan (target GB, expected peak, expected warm
 * decode) is part of the status payload so the LLMs row can show it, and an
 * explicit memory-cap override is persisted on the saved launch line the
 * on-demand start replays.
 *
 * Always passes `--port` explicitly. Upstream's default (11434) collides with
 * a PortOS-managed Ollama, so that port is refused.
 */

import { chmod, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { commandExists } from '../lib/commandExists.js';
import { ServerError } from '../lib/errorHandler.js';
import { sleep } from '../lib/fileUtils.js';
import { LOCAL_RUNTIMES, localEndpointPort, localRuntimeKind, isLocalInstanceEndpoint } from '../lib/localProviderRuntime.js';
import {
  createDaemonWatcher,
  pm2ArgValue,
  idleWindowMs,
  markDaemonUsed,
  registerIdleDaemon,
  SLOTSTREAM_APP,
} from '../lib/managedDaemon.js';
import { probeOpenAiModels } from '../lib/openAiModelsProbe.js';
import { isAppleSilicon, isPortInUse } from '../lib/platform.js';
import { PORTS } from '../lib/ports.js';
import { findCommandOnPath } from '../lib/processEnv.js';
import { SLOTSTREAM_CATALOG } from '../lib/slotstreamCatalog.js';
import {
  listSlotstreamCachedModels,
  pickSlotstreamCachedModel,
  planSlotstreamMemory,
  slotstreamBinDir,
  slotstreamCacheDir,
} from '../lib/slotstreamModels.js';
import { runStreamingCommand } from '../lib/streamingSpawn.js';
import { execPm2, getAppStatusStrict, clearJlistCache, getSavedProcessNames } from './pm2.js';

export { SLOTSTREAM_APP };

const PROBE_TIMEOUT_MS = 1500;
const INSTALL_TIMEOUT_MS = 20 * 60 * 1000;
const OLLAMA_COLLISION_PORT = 11434;

let startupWaitMs = 8_000;
let startupPollMs = 1500;
let relaunchReadyTimeoutMs = 300_000;
let relaunchPollMs = 1000;

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = Number(localEndpointPort(LOCAL_RUNTIMES.slotstream.defaultBaseUrl)) || PORTS.SLOTSTREAM;

export const SLOTSTREAM_UNSUPPORTED_REASON = 'Slotstream runs only on macOS with Apple Silicon.';
const slotstreamNoModelError = () => `Slotstream has no model weights cached, so its server would exit before it binds a port. A start never downloads weights — place a checkpoint directory in ${slotstreamCacheDir()}, then start it again.`;
const SLOTSTREAM_OLLAMA_PORT_ERROR = `Port ${OLLAMA_COLLISION_PORT} is Ollama's default and a PortOS-managed Ollama already uses it. Point Slotstream at its dedicated loopback port (${DEFAULT_PORT}) instead.`;

const DEFAULT_SLOTSTREAM_LOG_FILES = {
  stdout: join(tmpdir(), 'portos-slotstream-out.log'),
  stderr: join(tmpdir(), 'portos-slotstream-error.log'),
};

let slotstreamLogFiles = DEFAULT_SLOTSTREAM_LOG_FILES;

const resetSlotstreamLogs = async () => {
  const results = await Promise.all(
    Object.entries(slotstreamLogFiles).map(([stream, path]) => (
      writeFile(path, '')
        .then(() => true)
        .catch((error) => {
          console.error(`❌ Slotstream: could not reset ${stream} startup log (${error?.code || 'unknown'}); bootstrap diagnosis disabled for this launch`);
          return false;
        })
    )),
  );
  return results.every(Boolean);
};

let currentConfig = null;
let lastExitError = null;

const probeEndpoint = async (endpoint) =>
  (await probeOpenAiModels(endpoint, { timeoutMs: PROBE_TIMEOUT_MS })).reachable;

const endpointFor = (config) =>
  `http://${DEFAULT_HOST}:${config?.port ?? DEFAULT_PORT}/v1`;

const daemon = createDaemonWatcher({
  appName: SLOTSTREAM_APP,
  defaultHost: DEFAULT_HOST,
  defaultPort: DEFAULT_PORT,
  endpointFor,
  parseConfigFromArgs,
  probe: probeEndpoint,
  isPortInUse: (...args) => isPortInUse(...args),
  sleep,
  getConfig: () => currentConfig,
  setConfig: (config) => { currentConfig = config; },
  getLastExitError: () => lastExitError,
  getAppStatus: (...args) => getAppStatusStrict(...args),
  getSavedProcessNames: (...args) => getSavedProcessNames(...args),
  execPm2: (...args) => execPm2(...args),
});
const appendLog = daemon.appendLog;

/**
 * Reconstructs the launch config from PM2 process args when PortOS restarted
 * while the PM2 process stayed online.
 */
function parseConfigFromArgs(args) {
  if (!args) return null;
  const list = Array.isArray(args) ? args : String(args).split(' ');
  if (!list.includes('serve')) return null;
  const port = pm2ArgValue(list, '--port');
  const memoryGb = pm2ArgValue(list, '--memory-gb');
  return {
    port: port ? Number(port) : DEFAULT_PORT,
    model: pm2ArgValue(list, '--model'),
    memoryGb: memoryGb && Number.isFinite(Number(memoryGb)) ? Number(memoryGb) : null,
  };
}

const resolveStartPort = (requested) => {
  const port = Number.isFinite(Number(requested)) ? Number(requested) : DEFAULT_PORT;
  if (port === OLLAMA_COLLISION_PORT) {
    throw new ServerError(SLOTSTREAM_OLLAMA_PORT_ERROR, { status: 400, code: 'SLOTSTREAM_PORT_COLLISION' });
  }
  return port;
};

/** Resolve the `slotstream` executable on PATH, then the release-install location. */
export const resolveSlotstreamBinary = () =>
  findCommandOnPath('slotstream') || findCommandOnPath(join(slotstreamBinDir(), 'slotstream'));

export async function getSlotstreamServerEndpoint() {
  if (!currentConfig) {
    await daemon.readLaunch();
  }
  return daemon.endpoint();
}

/**
 * Current Slotstream state: binary, process, endpoint, memory plan, cache, logs.
 */
export async function getSlotstreamServerStatus() {
  const binaryPath = resolveSlotstreamBinary();
  const installed = Boolean(binaryPath);
  const supported = installed || isAppleSilicon();
  const base = await daemon.getStatusBase({ installed });
  const saved = await savedLaunchConfig();
  const cache = installed ? await listSlotstreamCachedModels() : { models: null, error: null };
  // The SAVED override, never the running config: `--memory-gb` is always on
  // the launch line, so reading the target back off it would report every
  // auto-sized start as an explicit cap and `auto` would never be true.
  const memoryPlan = planSlotstreamMemory({ overrideGb: saved.memoryGb });

  return {
    ...base,
    supported,
    unsupportedReason: supported ? null : SLOTSTREAM_UNSUPPORTED_REASON,
    idleMinutes: await configuredIdleMinutes(),
    launch: saved,
    memoryPlan,
    cachedModels: (cache.models || []).map((m) => m?.id).filter(Boolean),
    cacheDir: slotstreamCacheDir(),
    cacheError: cache.error,
    // The download menu rides on the status payload rather than a route of its
    // own: it is three frozen rows, so a second fetch (and a second cache to
    // keep in step with the cached-checkpoint list beside it) would buy nothing.
    catalog: SLOTSTREAM_CATALOG,
  };
}

/**
 * Install the Apple Silicon Slotstream binary from GitHub Releases into
 * `~/.slotstream/bin`. Never pipes a remote script to a shell, and never
 * fetches model weights.
 */
export async function installSlotstream({ onProgress = () => {} } = {}) {
  const emit = (message) => onProgress({ event: 'progress', message });
  if (!isAppleSilicon()) {
    throw new ServerError(SLOTSTREAM_UNSUPPORTED_REASON, { status: 400, code: 'SLOTSTREAM_UNSUPPORTED_PLATFORM' });
  }

  const binDir = slotstreamBinDir();
  await mkdir(binDir, { recursive: true });

  if (!(await commandExists('gh', ['--version']))) {
    throw new ServerError(
      'PortOS could not install Slotstream because GitHub CLI is not available on this machine.',
      { status: 400, code: 'SLOTSTREAM_INSTALL_UNAVAILABLE' },
    );
  }

  emit('Downloading Slotstream from GitHub Releases…');
  const download = await runStreamingCommand('gh', [
    'release', 'download',
    '--repo', 'carloslfu/slotstream',
    '--pattern', 'slotstream-arm64.tar.gz',
    '--dir', binDir,
    '--clobber',
  ], emit, { timeoutMs: INSTALL_TIMEOUT_MS });
  if (!download.success) throw new ServerError(`Slotstream install failed: ${download.error}`, { status: 500 });

  const archive = join(binDir, 'slotstream-arm64.tar.gz');
  emit('Extracting Slotstream…');
  const extract = await runStreamingCommand('tar', ['-xzf', archive, '-C', binDir], emit, { timeoutMs: 60_000 });
  if (!extract.success) throw new ServerError(`Slotstream extract failed: ${extract.error}`, { status: 500 });

  const binary = join(binDir, 'slotstream');
  await chmod(binary, 0o755).catch(() => {});
  if (!resolveSlotstreamBinary() && !findCommandOnPath(binary)) {
    throw new ServerError('Slotstream downloaded but the binary was not found in ~/.slotstream/bin.', { status: 500 });
  }
  return { success: true, message: 'Slotstream installed' };
}

/**
 * The checkpoint a start hands `--model`, always resolved against the on-disk
 * cache.
 *
 * An explicitly requested checkpoint is verified to be cached rather than
 * passed straight through: `slotstream serve` treats an uncached name as
 * something to fetch, so trusting the request would be the one path that
 * downloads weights on a start.
 */
async function resolveStartModel(requested, emit) {
  const cache = await listSlotstreamCachedModels();
  if (cache.models === null) {
    emit(`Could not read Slotstream's model cache (${cache.error}) — refusing to start rather than fetching weights.`);
    return { error: slotstreamNoModelError() };
  }
  if (cache.models.length === 0) return { error: slotstreamNoModelError() };
  const model = pickSlotstreamCachedModel(cache.models, requested);
  if (!model) return { error: slotstreamNoModelError() };
  if (!cache.models.some((row) => row?.id === model)) {
    return {
      error: `Slotstream has no cached checkpoint named "${model}". A start never downloads weights — pick one of the cached checkpoints (${cache.models.map((row) => row.id).join(', ')}) instead.`,
    };
  }
  return { model };
}

/**
 * Start `slotstream serve` under PM2.
 *
 * @param {{port?: number, model?: string, memoryGb?: number, waitMs?: number, onProgress?: (line: string) => void}} options
 */
export async function startSlotstreamServer(options = {}) {
  const { port: requestedPort, model: requestedModel = null, memoryGb = null, waitMs, onProgress = () => {} } = options;
  const port = resolveStartPort(requestedPort ?? DEFAULT_PORT);
  const emit = (line) => { appendLog(line); onProgress(line); };

  if (!isAppleSilicon()) {
    throw new ServerError(SLOTSTREAM_UNSUPPORTED_REASON, { status: 400, code: 'SLOTSTREAM_UNSUPPORTED_PLATFORM' });
  }

  const binaryPath = resolveSlotstreamBinary();
  if (!binaryPath) {
    throw new ServerError(
      'The Slotstream binary was not found. Install it from this card, then try again.',
      { status: 400, code: 'SLOTSTREAM_NOT_INSTALLED' },
    );
  }

  const pm2Status = await getAppStatusStrict(SLOTSTREAM_APP);
  if (pm2Status && pm2Status.status === 'online') {
    throw new ServerError(`Slotstream is already running with PID ${pm2Status.pid}`, { status: 409 });
  }

  const endpoint = `http://${DEFAULT_HOST}:${port}/v1`;
  if (await probeEndpoint(endpoint)) {
    throw new ServerError(`Port ${port} is already in use by an active server at ${endpoint}`, { status: 409 });
  }
  if (await isPortInUse(port)) {
    throw new ServerError(
      `Port ${port} is already in use on ${DEFAULT_HOST}. Point Slotstream at a different port before starting it.`,
      { status: 409, code: 'SLOTSTREAM_PORT_IN_USE' },
    );
  }

  daemon.resetLogs();
  lastExitError = null;

  const resolved = await resolveStartModel(requestedModel, emit);
  if (resolved.error) throw new ServerError(resolved.error, { status: 400, code: 'SLOTSTREAM_NO_CACHED_MODEL' });
  const model = resolved.model;
  if (model) emit(`Serving the cached Slotstream checkpoint ${model}.`);

  const plan = planSlotstreamMemory({ overrideGb: memoryGb });
  const args = [
    'serve',
    '--port', String(port),
    '--memory-gb', String(plan.targetGb),
    ...(model ? ['--model', model] : []),
  ];
  // `config.memoryGb` is the resolved target actually in effect — the same
  // number `parseConfigFromArgs` reads back off the PM2 launch line. The
  // user's *override* (null when PortOS sized it) is a separate fact, kept on
  // the saved launch below, because the launch line alone cannot tell an
  // auto-sized 85.8 GB from one the user typed.
  currentConfig = { port, model, memoryGb: plan.targetGb };
  appendLog(`Starting: slotstream ${args.join(' ')}`);

  await execPm2(['delete', SLOTSTREAM_APP]).catch(() => {});
  clearJlistCache();

  console.log(`🌊 Slotstream starting on ${DEFAULT_HOST}:${port}${model ? ` (model ${model})` : ''} (memory ${plan.targetGb} GB${plan.auto ? ', auto' : ''})`);
  const logsReset = await resetSlotstreamLogs();
  await execPm2([
    'start', binaryPath,
    '--name', SLOTSTREAM_APP,
    '--interpreter', 'none',
    '--no-autorestart',
    '--output', slotstreamLogFiles.stdout,
    '--error', slotstreamLogFiles.stderr,
    '--',
    ...args,
  ]);
  clearJlistCache();

  const deadline = Date.now() + (Number.isFinite(waitMs) ? waitMs : startupWaitMs);
  let online = false;
  let currentProc = null;
  while (Date.now() < deadline) {
    await sleep(startupPollMs);
    clearJlistCache();
    currentProc = await getAppStatusStrict(SLOTSTREAM_APP);
    if (currentProc && ['errored', 'stopped', 'not_found'].includes(currentProc.status)) break;
    online = await probeEndpoint(endpoint);
    if (online) break;
  }

  if (currentProc && ['errored', 'stopped', 'not_found'].includes(currentProc.status)) {
    const pm2Logs = await execPm2(['logs', SLOTSTREAM_APP, '--nostream', '--lines', '15']).catch(() => null);
    // Only trust the tail when the startup logs were actually truncated —
    // otherwise this launch's diagnosis would be the PREVIOUS launch's output,
    // sending the user after an error they already fixed.
    const lines = logsReset
      ? `${pm2Logs?.stderr || pm2Logs?.stdout || ''}`.split('\n').map((l) => l.trimEnd()).filter(Boolean)
      : [];
    for (const line of lines) appendLog(line);
    const tail = (lines.length ? lines : daemon.snapshotLogs()).slice(-4).join(' | ');
    lastExitError = `PM2 status: ${currentProc.status}`;
    await execPm2(['delete', SLOTSTREAM_APP]).catch(() => {});
    clearJlistCache();
    currentConfig = null;
    throw new ServerError(
      `Slotstream exited immediately (${lastExitError}).${tail ? ` Last output: ${tail}` : ''}`,
      { status: 500, code: 'SLOTSTREAM_EXITED' },
    );
  }

  await persistLaunchConfig({ port, model, memoryGb: plan.auto ? null : plan.targetGb });

  const finalProc = await getAppStatusStrict(SLOTSTREAM_APP);
  return {
    success: true,
    running: true,
    managed: true,
    pid: finalProc?.pid || null,
    endpoint,
    online,
    config: currentConfig,
    memoryPlan: plan,
  };
}

/** Stop the managed Slotstream process. */
export async function stopSlotstreamServer() {
  const pm2Status = await getAppStatusStrict(SLOTSTREAM_APP);
  const isManaged = Boolean(pm2Status && pm2Status.status === 'online');

  if (!isManaged) {
    const endpoint = endpointFor(currentConfig);
    if (await probeEndpoint(endpoint)) {
      return {
        success: false,
        message: `An external process is listening on ${endpoint}. It was not started by PortOS and cannot be stopped here.`,
      };
    }
    return { success: true, message: 'Slotstream is not running' };
  }

  appendLog(`Stopping ${SLOTSTREAM_APP}`);
  await execPm2(['delete', SLOTSTREAM_APP]).catch((err) => {
    throw new ServerError(`Failed to stop Slotstream: ${err.message}`, { status: 500 });
  });
  clearJlistCache();
  currentConfig = null;
  return { success: true, message: 'Slotstream stopped' };
}

export function _resetSlotstreamServerStateForTests({
  startupWait,
  startupPoll,
  relaunchReadyTimeout,
  relaunchPoll,
  idleMinutes = 0,
  logFiles,
} = {}) {
  idleMinutesOverride = idleMinutes;
  slotstreamLogFiles = logFiles ? {
    stdout: logFiles.stdout || DEFAULT_SLOTSTREAM_LOG_FILES.stdout,
    stderr: logFiles.stderr || DEFAULT_SLOTSTREAM_LOG_FILES.stderr,
  } : DEFAULT_SLOTSTREAM_LOG_FILES;
  currentConfig = null;
  daemon.resetLogs();
  lastExitError = null;
  startupWaitMs = Number.isFinite(startupWait) ? startupWait : 8_000;
  startupPollMs = Number.isFinite(startupPoll) ? startupPoll : 1500;
  relaunchReadyTimeoutMs = Number.isFinite(relaunchReadyTimeout) ? relaunchReadyTimeout : 300_000;
  relaunchPollMs = Number.isFinite(relaunchPoll) ? relaunchPoll : 1000;
}

const readSettings = () => import('./settings.js').then((m) => m.getSettings()).catch(() => null);
let idleMinutesOverride = null;

async function configuredIdleMinutes() {
  if (idleMinutesOverride !== null) return idleMinutesOverride;
  const settings = await readSettings();
  const raw = Number(settings?.localLlm?.slotstream?.idleMinutes);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

registerIdleDaemon({
  name: SLOTSTREAM_APP,
  getIdleMs: async () => idleWindowMs(await configuredIdleMinutes()),
  stop: () => stopSlotstreamServer(),
});

async function savedLaunchConfig() {
  const settings = await readSettings();
  const launch = settings?.localLlm?.slotstream?.launch;
  return {
    model: typeof launch?.model === 'string' && launch.model.trim() ? launch.model.trim() : null,
    port: Number.isFinite(Number(launch?.port)) ? Number(launch.port) : null,
    memoryGb: Number.isFinite(Number(launch?.memoryGb)) ? Number(launch.memoryGb) : null,
  };
}

/**
 * Record the launch a start actually used, so the on-demand restart after an
 * idle release replays it.
 *
 * Without this an explicit memory cap lives only in `currentConfig`, which
 * `stopSlotstreamServer` clears — so the reaper would silently trade the cap
 * the user chose for an auto-sized target on the next request. `memoryGb` stays
 * the user's *override* (null when PortOS sized it), never the resolved target,
 * so a later status still knows which of the two it is looking at.
 */
async function persistLaunchConfig({ port, model, memoryGb }) {
  const settings = await import('./settings.js').catch(() => null);
  if (!settings?.updateSettingsWith) return;
  await settings.updateSettingsWith((current) => ({
    ...current,
    localLlm: {
      ...current?.localLlm,
      slotstream: {
        ...current?.localLlm?.slotstream,
        launch: { port, model, memoryGb },
      },
    },
  })).catch((error) => {
    console.error(`❌ Slotstream: could not persist the launch line (${error?.message || 'unknown'}); an idle restart will re-size from host RAM`);
  });
}

export const markSlotstreamUsed = () => markDaemonUsed(SLOTSTREAM_APP);

/**
 * Bring Slotstream up if the idle reaper (or the user) stopped it.
 *
 * @returns {Promise<{ready: boolean, reason: string|null}>}
 */
export async function ensureSlotstreamRunning() {
  markSlotstreamUsed();

  const pm2Status = await getAppStatusStrict(SLOTSTREAM_APP);
  if (pm2Status?.status === 'online') return { ready: true, reason: null };

  const saved = await savedLaunchConfig();
  const config = {
    port: currentConfig?.port ?? saved.port ?? DEFAULT_PORT,
    model: currentConfig?.model ?? saved.model ?? null,
    memoryGb: currentConfig?.memoryGb ?? saved.memoryGb ?? null,
  };

  const endpoint = endpointFor(config);
  if (await probeEndpoint(endpoint)) return { ready: true, reason: null };

  console.log(`🌊 Slotstream is stopped — starting it for an incoming request`);
  const started = await startSlotstreamServer(config).catch((err) => ({ error: err }));
  if (started.error) return { ready: false, reason: started.error.message };
  if (started.online) return { ready: true, reason: null };

  const deadline = Date.now() + relaunchReadyTimeoutMs;
  while (Date.now() < deadline) {
    if (await probeEndpoint(started.endpoint ?? endpoint)) return { ready: true, reason: null };
    clearJlistCache();
    const proc = await getAppStatusStrict(SLOTSTREAM_APP);
    if (proc && ['errored', 'stopped', 'not_found'].includes(proc.status)) {
      return { ready: false, reason: `Slotstream exited while loading (PM2 status: ${proc.status})` };
    }
    await sleep(relaunchPollMs);
  }
  return { ready: false, reason: 'Slotstream relaunched but never answered on its port' };
}

export function isSlotstreamProvider(provider) {
  if (!provider || !['api', 'tui'].includes(provider.type)) return false;
  if (!isLocalInstanceEndpoint(provider.endpoint)) return false;
  if (localRuntimeKind(provider) === 'slotstream') return true;
  const managedPort = currentConfig?.port;
  return Boolean(managedPort) && Number(localEndpointPort(provider.endpoint)) === managedPort;
}

export async function ensureSlotstreamProviderReady(provider) {
  if (!isSlotstreamProvider(provider)) return { success: true };
  const { ready, reason } = await ensureSlotstreamRunning();
  return ready ? { success: true } : { success: false, error: reason };
}
