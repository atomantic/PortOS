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

import { randomUUID } from 'crypto';
import { chmod, copyFile, lstat, mkdir, mkdtemp, readdir, realpath, rename, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, isAbsolute, join, relative, sep } from 'path';
import { ServerError } from '../lib/errorHandler.js';
import { sleep } from '../lib/fileUtils.js';
import { LOCAL_RUNTIMES, localEndpointPort, localRuntimeForProvider, isLocalInstanceEndpoint } from '../lib/localProviderRuntime.js';
import {
  createDaemonLogFiles,
  createDaemonWatcher,
  createOnDemandDaemon,
  createPm2ExitTail,
  pm2ArgValue,
  SLOTSTREAM_APP,
} from '../lib/managedDaemon.js';
import { persistDaemonLaunchConfig } from './localDaemonLaunchConfig.js';
import { probeOpenAiModels } from '../lib/openAiModelsProbe.js';
import { isAppleSilicon, isPortInUse } from '../lib/platform.js';
import { PORTS } from '../lib/ports.js';
import { findCommandOnPath } from '../lib/processEnv.js';
import { SLOTSTREAM_CATALOG } from '../lib/slotstreamCatalog.js';
import {
  isSlotstreamCheckpointId,
  listSlotstreamCachedModels,
  pickSlotstreamCachedModel,
  planSlotstreamMemory,
  slotstreamBinDir,
  SLOTSTREAM_CACHE_DISPLAY,
} from '../lib/slotstreamModels.js';
import { runStreamingCommand } from '../lib/streamingSpawn.js';
import { execPm2, getAppStatusStrict, clearJlistCache, getSavedProcessNames } from './pm2.js';

export { SLOTSTREAM_APP };

// Pinned Apple Silicon Slotstream release; digest comes from the release's published SHA-256 asset.
export const SLOTSTREAM_RELEASE_REPO = 'carloslfu/slotstream';
export const SLOTSTREAM_RELEASE_TAG = 'v0.2.30';
export const SLOTSTREAM_RELEASE_TARGETS = Object.freeze({
  'darwin-arm64': {
    archive: 'slotstream-arm64.tar.gz',
    sha256: 'e7a3e6532ae0931ea3538abe1974dead0fc741d9d8a529e1f02517b7ac78335c',
  },
});

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
const SLOTSTREAM_NO_MODEL_ERROR = 'Slotstream has no cached checkpoint. Open Configure and select Download checkpoint before starting Slotstream.';
const SLOTSTREAM_OLLAMA_PORT_ERROR = `Port ${OLLAMA_COLLISION_PORT} is Ollama's default and a PortOS-managed Ollama already uses it. Point Slotstream at its dedicated loopback port (${DEFAULT_PORT}) instead.`;

const slotstreamLogs = createDaemonLogFiles(SLOTSTREAM_APP);

let currentConfig = null;
let lastExitError = null;
let installationChange = null;

function changeSlotstreamInstallation(work) {
  if (installationChange) {
    throw new ServerError('Slotstream already has an installation change in progress.', { status: 409 });
  }
  installationChange = Promise.resolve().then(work).finally(() => { installationChange = null; });
  return installationChange;
}

async function slotstreamInstallFile() {
  const bin = slotstreamBinDir();
  const binary = join(bin, 'slotstream');
  const entry = (path) => lstat(path).catch((error) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  // A PATH lookup may resolve to Homebrew or a symlink. Neither establishes
  // ownership. Only a regular file at our release-install location is removable.
  for (const directory of [dirname(bin), bin]) {
    if (!(await entry(directory))?.isDirectory()) return null;
  }
  return (await entry(binary))?.isFile() ? binary : null;
}

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
  setLastExitError: (error) => { lastExitError = error; },
  getAppStatus: (...args) => getAppStatusStrict(...args),
  clearStatusCache: () => clearJlistCache(),
  getSavedProcessNames: (...args) => getSavedProcessNames(...args),
  execPm2: (...args) => execPm2(...args),
});
const appendLog = daemon.appendLog;

// `settings.js` reached only through a dynamic import — see the note beside
// `mtplxServerManager.js`'s copy of this same pattern.
const readSettings = () => import('./settings.js').then((m) => m.getSettings()).catch(() => null);

/**
 * The shared on-demand wake mechanism (#8105) — see the identical block in
 * `mtplxServerManager.js` for the full contract. `resolveLaunch` here carries
 * `memoryGb` instead of `tuning`.
 */
const onDemand = createOnDemandDaemon({
  appName: SLOTSTREAM_APP,
  label: 'Slotstream',
  emoji: '🌊',
  readSection: () => readSettings().then((settings) => settings?.localLlm?.slotstream ?? null),
  endpointFor,
  probe: probeEndpoint,
  start: (config) => launchSlotstreamServer(config),
  stop: () => stopSlotstreamServer(),
  getStatusStrict: () => getAppStatusStrict(SLOTSTREAM_APP),
  clearStatusCache: () => clearJlistCache(),
  exitTail: createPm2ExitTail({ appName: SLOTSTREAM_APP, execPm2: (...args) => execPm2(...args), appendLog }),
  resolveLaunch: (current, saved) => ({
    port: current?.port ?? saved.port ?? DEFAULT_PORT,
    model: current?.model ?? saved.model ?? null,
    memoryGb: current?.memoryGb ?? (Number.isFinite(Number(saved.raw?.memoryGb)) ? Number(saved.raw.memoryGb) : null),
  }),
  getConfig: () => currentConfig,
  parseConfigFromArgs,
  sleep,
  getRelaunchReadyTimeoutMs: () => relaunchReadyTimeoutMs,
  getRelaunchPollMs: () => relaunchPollMs,
});
onDemand.registerIdle();

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
export async function getSlotstreamServerStatus({ includeLogs } = {}) {
  const binaryPath = resolveSlotstreamBinary();
  const installed = Boolean(binaryPath);
  const supported = installed || isAppleSilicon();
  const base = await daemon.getStatusBase({ installed, includeLogs });
  const ownedBinary = installed && await slotstreamInstallFile().catch(() => null);
  const saved = await savedLaunchConfig();
  const cache = await listSlotstreamCachedModels({ includeRows: true });
  // The SAVED override, never the running config: `--memory-gb` is always on
  // the launch line, so reading the target back off it would report every
  // auto-sized start as an explicit cap and `auto` would never be true.
  const memoryPlan = planSlotstreamMemory({ overrideGb: saved.memoryGb });

  return {
    ...base,
    config: base.config && { ...base.config, model: isSlotstreamCheckpointId(base.config.model) ? base.config.model : null },
    supported,
    canUninstall: Boolean(ownedBinary) && !installationChange && !base.running && base.managed === false,
    unsupportedReason: supported ? null : SLOTSTREAM_UNSUPPORTED_REASON,
    idleMinutes: await onDemand.idleMinutes(),
    keepLoaded: await onDemand.keepLoaded(),
    launch: { ...saved, model: isSlotstreamCheckpointId(saved.model) ? saved.model : null },
    memoryPlan,
    cachedModels: (cache.models || []).map((m) => m?.id).filter(Boolean),
    cachedModelRows: cache.rows,
    cacheDir: SLOTSTREAM_CACHE_DISPLAY,
    cacheError: cache.error,
    // The download menu rides on the status payload rather than a route of its
    // own: it is three frozen rows, so a second fetch (and a second cache to
    // keep in step with the cached-checkpoint list beside it) would buy nothing.
    catalog: SLOTSTREAM_CATALOG,
  };
}

/**
 * Install the pinned Apple Silicon Slotstream binary from GitHub Releases into
 * `~/.slotstream/bin`. Downloads and verifies SHA-256 in an isolated temp dir
 * before extracting, never pipes a remote script to a shell, and never
 * fetches model weights.
 */
export async function installSlotstream(options = {}) {
  return changeSlotstreamInstallation(() => installPinnedSlotstream(options));
}

async function installPinnedSlotstream({ onProgress = () => {} } = {}) {
  const emit = (message) => onProgress({ event: 'progress', message });
  if (!isAppleSilicon()) {
    throw new ServerError(SLOTSTREAM_UNSUPPORTED_REASON, { status: 400, code: 'SLOTSTREAM_UNSUPPORTED_PLATFORM' });
  }

  const target = SLOTSTREAM_RELEASE_TARGETS['darwin-arm64'];
  const workDir = await mkdtemp(join(tmpdir(), 'portos-slotstream-install-'));
  try {
    const archivePath = join(workDir, target.archive);
    const extractDir = join(workDir, 'extract');
    await mkdir(extractDir, { recursive: true });

    emit(`Downloading Slotstream ${SLOTSTREAM_RELEASE_TAG} from GitHub Releases…`);
    const { streamResumableDownload } = await import('../lib/downloadPreflight.js');
    const stalled = new AbortController();
    try {
      await streamResumableDownload({
        url: `https://github.com/${SLOTSTREAM_RELEASE_REPO}/releases/download/${SLOTSTREAM_RELEASE_TAG}/${target.archive}`,
        destPath: archivePath,
        expectedSha256: target.sha256,
        signal: AbortSignal.any([AbortSignal.timeout(INSTALL_TIMEOUT_MS), stalled.signal]),
        idleStallTimeoutMs: 60_000,
        onIdleStall: () => stalled.abort(new ServerError('Slotstream download stalled.', {
          status: 502, code: 'DOWNLOAD_FAILED',
        })),
      });
    } catch (err) {
      if (err?.code !== 'DOWNLOAD_HASH_MISMATCH') throw err;
      throw new ServerError(
        'Slotstream download failed SHA-256 verification and was discarded.',
        { status: 502, code: 'SLOTSTREAM_DIGEST_MISMATCH' },
      );
    }

    emit('Extracting Slotstream…');
    const extract = await runStreamingCommand('tar', ['-xzf', archivePath, '-C', extractDir], emit, { timeoutMs: 60_000 });
    if (!extract.success) throw new ServerError(`Slotstream extract failed: ${extract.error}`, { status: 502, code: 'INTERNAL_ERROR' });

    const extractedBinary = join(extractDir, 'slotstream');
    const extractedStat = await lstat(extractedBinary).catch(() => null);
    if (!extractedStat || extractedStat.isSymbolicLink() || !extractedStat.isFile()) {
      throw new ServerError(
        'Slotstream archive did not contain a regular slotstream binary.',
        { status: 502, code: 'SLOTSTREAM_INVALID_ARCHIVE' },
      );
    }

    const binDir = slotstreamBinDir();
    await mkdir(binDir, { recursive: true });
    const binary = join(binDir, 'slotstream');
    const stagedBinary = join(binDir, `.slotstream.tmp-${randomUUID()}`);
    try {
      await copyFile(extractedBinary, stagedBinary);
      await chmod(stagedBinary, 0o755);
      await rename(stagedBinary, binary);
    } catch (err) {
      await rm(stagedBinary, { force: true }).catch(() => {});
      throw err;
    }

    if (!resolveSlotstreamBinary() && !findCommandOnPath(binary)) {
      throw new ServerError('Slotstream downloaded but the binary was not found in ~/.slotstream/bin.', { status: 502, code: 'INTERNAL_ERROR' });
    }
    return { success: true, message: 'Slotstream installed' };
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

/**
 * Require an idle runtime; don't kill a process to remove its executable.
 * Share the wake/start slot so an inference request cannot launch it midway.
 */
export async function uninstallSlotstream() {
  return changeSlotstreamInstallation(() => onDemand.runStart(async () => {
    const binary = await slotstreamInstallFile();
    if (!binary) {
      throw new ServerError('Slotstream is not installed at the PortOS release location.', {
        status: 409, code: 'SLOTSTREAM_NOT_MANAGED',
      });
    }
    const { port: savedPort } = await savedLaunchConfig();
    await daemon.assertStoppedForUninstall({ label: 'Slotstream', codePrefix: 'SLOTSTREAM', savedPort });
    await rm(binary);
    return { success: true, message: 'Slotstream uninstalled. Checkpoints and provider settings were kept.' };
  }));
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
    return { error: SLOTSTREAM_NO_MODEL_ERROR };
  }
  if (cache.models.length === 0) return { error: SLOTSTREAM_NO_MODEL_ERROR };
  const model = pickSlotstreamCachedModel(cache.models, requested);
  if (!model) return { error: SLOTSTREAM_NO_MODEL_ERROR };
  if (!cache.models.some((row) => row?.id === model)) {
    return {
      error: `The selected Slotstream checkpoint is unavailable. A start never downloads weights. Choose a cached checkpoint (${cache.models.map((row) => row.id).join(', ')}) or open Configure and select Download checkpoint.`,
    };
  }
  return { model };
}

/**
 * Start `slotstream serve` under PM2, queued behind any in-flight on-demand
 * wake or explicit start (`onDemand.runStart`, #12723) so it cannot
 * `pm2 delete` a launch that is still loading.
 *
 * @param {Parameters<typeof launchSlotstreamServer>[0]} [options]
 */
export const startSlotstreamServer = (options = {}) => onDemand.runStart(() => launchSlotstreamServer(options));

/**
 * Share the start slot with explicit and on-demand starts so a checked
 * checkpoint cannot disappear between model selection and launch.
 */
export const withUnusedSlotstreamCheckpoint = ({ model, modelDir, cacheDir, linked }, remove) => onDemand.runStart(async () => {
  const inUse = () => new ServerError('Stop Slotstream before removing a checkpoint it may be serving.', {
    status: 409, code: 'SLOTSTREAM_CHECKPOINT_IN_USE',
  });

  clearJlistCache();
  const app = await getAppStatusStrict(SLOTSTREAM_APP);
  if (!app) {
    throw new ServerError('PortOS could not verify whether Slotstream is serving this checkpoint. Check PM2 and retry.', {
      status: 503, code: 'SLOTSTREAM_PM2_UNAVAILABLE',
    });
  }

  if (app.status === 'online') {
    const active = parseConfigFromArgs(app.args)?.model;
    if (!isSlotstreamCheckpointId(active) || active === model) throw inUse();
    // Resolve aliases and filesystem case before removing a directory. Removing
    // a different link leaves the weights intact, even if it shares the target.
    const activeDir = join(cacheDir, active);
    const actualActive = await realpath(activeDir).catch(() => null);
    const actualCandidate = await realpath(modelDir).catch(() => null);
    if (actualActive && actualActive === actualCandidate) {
      const names = new Set(await readdir(cacheDir));
      if (!linked || !names.has(model) || !names.has(active)) throw inUse();
    }
    if (!linked && actualActive && actualCandidate) {
      const child = relative(actualCandidate, actualActive);
      if (child && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child)) throw inUse();
    }
  } else {
    // External servers do not expose a trusted cache entry ID. Check known
    // runtime ports even while a listener is still warming up.
    if (!['not_found', 'stopped', 'errored'].includes(app.status)) throw inUse();
    const saved = await savedLaunchConfig();
    const ports = new Set([DEFAULT_PORT, saved.port, currentConfig?.port].filter(Boolean));
    if ((await Promise.all([...ports].map((port) => isPortInUse(port)))).some(Boolean)) throw inUse();
  }

  return remove();
});

/**
 * The unserialized start behind `startSlotstreamServer`; only the on-demand
 * wake, which already holds the start slot, calls it directly.
 *
 * @param {{port?: number, model?: string, memoryGb?: number, waitMs?: number, onProgress?: (line: string) => void}} options
 */
async function launchSlotstreamServer(options = {}) {
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

  const endpoint = await daemon.assertPortFree({
    host: DEFAULT_HOST,
    port,
    label: 'Slotstream',
    codePrefix: 'SLOTSTREAM',
    portAdvice: 'Point Slotstream at a different port before starting it.',
  });

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
  currentConfig = { port, model, memoryGb: plan.targetGb };
  appendLog(`Starting: slotstream ${args.join(' ')}`);

  console.log(`🌊 Slotstream starting on ${DEFAULT_HOST}:${port}${model ? ` (model ${model})` : ''} (memory ${plan.targetGb} GB${plan.auto ? ', auto' : ''})`);

  // The saved override stays null for auto sizing. The live config carries
  // the resolved target, which PM2 argv can recover but cannot tell was auto.
  const result = await daemon.launch({
    binaryPath,
    args,
    endpoint,
    waitMs: Number.isFinite(waitMs) ? waitMs : startupWaitMs,
    pollMs: startupPollMs,
    logs: slotstreamLogs,
    label: 'Slotstream',
    codePrefix: 'SLOTSTREAM',
    onStarted: () => persistDaemonLaunchConfig({ key: 'slotstream', label: 'Slotstream', launch: { port, model, memoryGb: plan.auto ? null : plan.targetGb } }),
  });
  return { ...result, memoryPlan: plan };
}

/** Stop the managed Slotstream process. */
export async function stopSlotstreamServer() {
  return daemon.stop({ label: 'Slotstream' });
}

export function _resetSlotstreamServerStateForTests({
  startupWait,
  startupPoll,
  relaunchReadyTimeout,
  relaunchPoll,
  idleMinutes = 0,
  keepLoaded = null,
  logFiles,
} = {}) {
  onDemand.setIdleMinutesOverrideForTests(idleMinutes);
  onDemand.setKeepLoadedOverrideForTests(keepLoaded);
  slotstreamLogs.setForTests(logFiles);
  currentConfig = null;
  daemon.resetLogs();
  lastExitError = null;
  startupWaitMs = Number.isFinite(startupWait) ? startupWait : 8_000;
  startupPollMs = Number.isFinite(startupPoll) ? startupPoll : 1500;
  relaunchReadyTimeoutMs = Number.isFinite(relaunchReadyTimeout) ? relaunchReadyTimeout : 300_000;
  relaunchPollMs = Number.isFinite(relaunchPoll) ? relaunchPoll : 1000;
}

/**
 * The launch line last saved on the Slotstream card, for a lazy start to
 * replay — including the `memoryGb` override, the one field the shared
 * `onDemand.savedLaunch()` (model/port only) does not sanitize on its own.
 */
async function savedLaunchConfig() {
  const { model, port, raw } = await onDemand.savedLaunch();
  return {
    model,
    port,
    memoryGb: Number.isFinite(Number(raw?.memoryGb)) ? Number(raw.memoryGb) : null,
  };
}

// `registerIdleDaemon`, the idle-minutes/keep-loaded reads, `markSlotstreamUsed`,
// and `ensureSlotstreamRunning` all now live in `onDemand` (#8105) — see the
// identical block in `mtplxServerManager.js`.
export const markSlotstreamUsed = () => onDemand.markUsed();

/** Wait for a just-started server to answer (stops early when PM2 reports it dead); `{ready, reason}`. */
export const waitForSlotstreamReady = (endpoint) => onDemand.waitForReady(endpoint);

/**
 * Bring Slotstream up if the idle reaper (or the user) stopped it. See
 * `onDemand.ensureRunning` for the shared mechanism; Slotstream's own
 * contribution is the `resolveLaunch` hook wired above, which carries
 * `memoryGb` alongside `port`/`model`.
 *
 * @returns {Promise<{ready: boolean, reason: string|null}>}
 */
export const ensureSlotstreamRunning = () => onDemand.ensureRunning();

export function isSlotstreamProvider(provider) {
  if (!provider || !['api', 'cli', 'tui'].includes(provider.type)) return false;
  if (localRuntimeForProvider(provider)?.kind === 'slotstream') return true;
  if (!isLocalInstanceEndpoint(provider.endpoint)) return false;
  return onDemand.servesPort(provider, currentConfig?.port);
}

/**
 * The checkpoints THIS machine can serve, for a Slotstream provider's model
 * refresh — the Slotstream half of `services/localCachedModels.js`.
 *
 * Same shape of bug as MTPLX, and worse in one way: `slotstream serve` loads one
 * checkpoint and answers only under that id, while the shipped `slotstream`
 * record lists THREE. So a refresh did not merely fail to add a newly downloaded
 * checkpoint — it pruned the record's other two shipped ids down to whatever the
 * daemon happened to have loaded, including the `defaultModel` pin whenever that
 * was not the loaded one.
 *
 * `null` for a provider that is not this daemon's and for a cache that could not
 * be READ — deliberately not `[]`, which the caller must be free to read as
 * "read, and genuinely empty". Unlike MTPLX this costs no subprocess and needs
 * no runtime gate: the listing is a directory read (`lib/slotstreamModels.js`).
 *
 * @param {{type?: string, endpoint?: string}|null} provider
 * @returns {Promise<string[]|null>}
 */
export async function slotstreamCachedModelIds(provider) {
  if (!isSlotstreamProvider(provider)) return null;
  const { models } = await listSlotstreamCachedModels();
  if (!Array.isArray(models)) return null;
  return models.map((row) => row?.id).filter((id) => typeof id === 'string' && id !== '');
}

export async function ensureSlotstreamProviderReady(provider) {
  if (!isSlotstreamProvider(provider)) return { success: true };
  const { ready, reason } = await ensureSlotstreamRunning();
  return ready ? { success: true } : { success: false, error: reason };
}
