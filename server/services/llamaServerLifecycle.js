/**
 * llama-server process manager
 *
 * Provides lifecycle management (status probe, start, stop, recent logs)
 * for a local `llama-server` instance running speculative decoding (e.g. DFlash 2)
 * managed as an optional PM2 process (`portos-llama-server`).
 */

import { stat } from 'fs/promises';
import { execFile } from '../lib/childProcess.js';
import { safeChildProcessOptions } from '../lib/processEnv.js';
import { expandHome, sleep } from '../lib/fileUtils.js';
import { createDaemonLogFiles, createDaemonWatcher, createPm2ExitTail, pm2ArgValue, waitForDaemonReady, LLAMA_APP } from '../lib/managedDaemon.js';
import { parseSpecTypes, isDraftSpecType, resolveSpecModelPath } from '../lib/specDecodePresets.js';
import { probeOpenAiModels } from '../lib/openAiModelsProbe.js';
import { isPortInUse } from '../lib/platform.js';
import { PORTS } from '../lib/ports.js';
import { ServerError } from '../lib/errorHandler.js';
import { execPm2, getAppStatusStrict, clearJlistCache, getSavedProcessNames } from './pm2.js';
import {
  _setLlamaInstallPlatformForTests,
  getLlamaServerInstallPlan,
  resolveLlamaServerBinary,
} from './llamaServerInstall.js';

// `settings.js` is lazy-imported at its call sites below, never statically: it
// eagerly resolves `fileUtils.PATHS` at module load, which drags PATHS into the
// module graph of every consumer of this manager and breaks the many suites that
// partial-mock fileUtils without it. Same reason `services/aiProvider.js` defers
// `localModelHealing`.
const PROBE_TIMEOUT_MS = 1500;
const STARTUP_WAIT_TIMEOUT_MS = 4000;
const STARTUP_POLL_DELAY_MS = 500;
const RELAUNCH_READY_TIMEOUT_MS = 120000;
const RELAUNCH_POLL_DELAY_MS = 1000;
// `llama-server --help` is a fast local exec; this only bounds a wedged binary.
const HELP_PROBE_TIMEOUT_MS = 5000;
// llama.cpp's own in-place idle unload. See `supportsSleepIdle`.
const SLEEP_IDLE_FLAG = '--sleep-idle-seconds';
// binary path -> does it understand SLEEP_IDLE_FLAG. Keyed by path so a user who
// swaps in a newer build at a different location is re-probed rather than
// inheriting the old answer.
const sleepIdleSupport = new Map();
// See `configuredSleepIdleMinutes`. Only `_resetLlamaServerStateForTests` writes it.
let sleepIdleMinutesOverride = null;
let sleepIdleKeepLoadedOverride = null;
// How long a relaunch waits for the kernel to release the old listener.
const PORT_RELEASE_TIMEOUT_MS = 5000;
// How long a relaunch waits for the new process to answer. `startLlamaServer`
// polls for only STARTUP_WAIT_TIMEOUT_MS, which a large GGUF routinely exceeds
// while loading — so a relaunch must not read "not ready yet" as "wedged".
// Mutable only through the test seam below: a suite asserting the give-up path
// cannot sit through two real minutes of polling.
let startupWaitTimeoutMs = STARTUP_WAIT_TIMEOUT_MS;
let startupPollDelayMs = STARTUP_POLL_DELAY_MS;
let relaunchReadyTimeoutMs = RELAUNCH_READY_TIMEOUT_MS;
let relaunchPollDelayMs = RELAUNCH_POLL_DELAY_MS;
// How many times a path that would REFUSE on an unreadable PM2 re-reads it
// first. See `readLlamaServerStatusRetrying`.
const PM2_READ_RETRIES = 2;
// Mutable only through the test seam below, for the same reason as the readiness
// budget above.
const PM2_READ_RETRY_DELAY_MS = 250;
let pm2ReadRetryDelayMs = PM2_READ_RETRY_DELAY_MS;

// The launch line the daemon was serving BEFORE PortOS put an assessment tuning
// on it. `null` means no PortOS-applied tuning is in effect — either none was
// ever applied, or it has since been cleared — and is what makes an UNTUNED
// assessment honest: without it a baseline run would sample whatever the
// previous measurement left running and file the numbers as "Backend defaults".
//
// Deliberately NOT the same thing as `CLEARED_TUNING`. That renders the launch
// line with every sweepable knob off, which also wipes flags the USER set on the
// LLMs page — correct for a sweep, which captured them and will put them back,
// and wrong for an ordinary measurement, which did not. Restoring the captured
// line undoes only what PortOS itself applied.
//
// Module state, so it does not survive a PortOS restart that re-adopts a still
// -tuned PM2 process. That case degrades to today's behaviour (the untuned run
// no-ops) rather than to a wrong relaunch, and the reconstructed launch line
// cannot tell a PortOS tuning apart from the same flags typed by the user.
export const llamaLaunchState = { currentConfig: null, preTuningConfig: null };
export const clearSleepIdleSupport = () => sleepIdleSupport.clear();
let lastExitError = null;


/**
 * Probes whether an OpenAI-compatible endpoint responds at the given host/port.
 * Shares one implementation with the readiness checklist.
 */
const probeEndpoint = async (endpoint) =>
  (await probeOpenAiModels(endpoint, { timeoutMs: PROBE_TIMEOUT_MS })).reachable;


/**
 * Does the installed `llama-server` understand `--sleep-idle-seconds`?
 *
 * That flag is how llama.cpp releases a checkpoint WITHOUT the process going
 * away: after N idle seconds the server unloads the model and reloads it on the
 * next request, keeping its PM2 entry, its port, and its launch line. Stopping
 * the process instead would reclaim the same memory at the cost of a full cold
 * start — which is why PortOS reaps MTPLX (it has no such flag) but not this.
 *
 * Probed rather than assumed because PortOS is distributed software: the flag
 * landed in a recent llama.cpp, and every install upgrades on its own schedule.
 * An older binary REJECTS an unknown flag and exits before it binds, so emitting
 * it blind would break the start outright for anyone who hasn't upgraded.
 *
 * Cached per binary path — `--help` is a subprocess, and a start already pays
 * for several. A probe that cannot run at all answers `false`: leaving the flag
 * off costs the idle release, while guessing `true` costs the daemon.
 *
 * @param {string} binaryPath
 * @returns {Promise<boolean>}
 */
async function supportsSleepIdle(binaryPath) {
  if (sleepIdleSupport.has(binaryPath)) return sleepIdleSupport.get(binaryPath);
  const help = await new Promise((resolve) => {
    execFile(binaryPath, ['--help'], { timeout: HELP_PROBE_TIMEOUT_MS, ...safeChildProcessOptions() },
      (err, stdout, stderr) => resolve(`${stdout || ''}${stderr || ''}`));
  }).catch(() => '');
  const supported = help.includes(SLEEP_IDLE_FLAG);
  sleepIdleSupport.set(binaryPath, supported);
  if (!supported) {
    console.log(`🦙 llama-server at ${binaryPath} has no ${SLEEP_IDLE_FLAG} — idle unload unavailable on this build`);
  }
  return supported;
}

/**
 * The configured idle window for llama-server, in minutes.
 *
 * `0` is a real choice ("keep the model resident", the behaviour every install
 * had before this setting existed) and is the default, so an upgrade changes
 * nothing until the user asks for it. An unreadable settings file degrades to
 * the same `0` rather than to a window nobody chose.
 *
 * @returns {Promise<number>}
 */
async function configuredSleepIdleMinutes() {
  // Test seam. Suites here assert EXACT launch lines, so reading the developer's
  // real `data/settings.json` would make them pass or fail on whether that
  // developer happens to use this feature. `null` (production) reads settings.
  if (sleepIdleMinutesOverride !== null) return sleepIdleMinutesOverride;
  const settings = await import('./settings.js').then((m) => m.getSettings()).catch(() => null);
  const raw = Number(settings?.localLlm?.llama?.idleMinutes);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

/** Boot auto-start toggle and the launch line it would replay (llamaServerAutoStart.js). */
async function configuredAutoStart() {
  const settings = await import('./settings.js').then((m) => m.getSettings()).catch(() => null);
  const llama = settings?.localLlm?.llama;
  // The whole line, so a Start button elsewhere (Voice) can replay it as-is.
  return { autoStart: llama?.autoStart === true, savedLaunch: llama?.launch?.model ? llama.launch : null };
}

async function configuredSleepIdleKeepLoaded() {
  if (sleepIdleKeepLoadedOverride !== null) return sleepIdleKeepLoadedOverride;
  const settings = await import('./settings.js').then((m) => m.getSettings()).catch(() => null);
  return Boolean(settings?.localLlm?.llama?.keepLoaded ?? settings?.localLlm?.llama?.pinned);
}

/**
 * Fails the start request when a GGUF the launch line names is not on disk.
 */
async function assertModelFileExists(label, modelPath) {
  const stats = await stat(resolveSpecModelPath(modelPath)).catch(() => null);
  if (stats?.isFile()) return;
  throw new ServerError(
    `${label} was not found at \`${modelPath}\`. Use the Download button next to this preset in the Speculative Decoding card to fetch it, or point this field at a file you already have.`,
    { status: 400, code: 'LLAMA_MODEL_FILE_MISSING' }
  );
}

/**
 * Reconstructs the launch config from PM2 process args if PortOS restarted
 * while the PM2 process remained online.
 */
function parseConfigFromArgs(args) {
  if (!args) return null;
  const list = Array.isArray(args) ? args : String(args).split(' ');
  const getArg = (flag) => pm2ArgValue(list, flag);

  const model = getArg('-m') || getArg('--model');
  if (!model) return null;

  const draftModel = getArg('--model-draft') || getArg('--spec-draft-model') || getArg('-md');
  // Absent means the recovered process is running text-only — a pre-#7611
  // PortOS could not emit this flag at all, so every launch line it left behind
  // reads back as no projector, which is the truth about that process.
  const projector = getArg('--mmproj');
  // Absent means the process is running WITHOUT speculative decoding — don't
  // invent a type the launch line never carried.
  const specType = getArg('--spec-type');
  const port = getArg('--port') ? Number(getArg('--port')) : PORTS.LLAMA_SERVER;
  const host = getArg('--host') || '127.0.0.1';
  const ctxSize = getArg('--ctx-size') ? Number(getArg('--ctx-size')) : 32768;
  const nGpuLayers = getArg('-ngl') !== null ? Number(getArg('-ngl')) : 99;
  const alias = getArg('--alias') || 'dflash';
  // Absent is not 1: an older launch line with no `--parallel` is running
  // llama.cpp's own default (often 4 slots), which is distinct from a value
  // PortOS chose. A relaunch still pins 1 — see startLlamaServer.
  const parallelRaw = getArg('--parallel') ?? getArg('-np');
  const parallel = parallelRaw !== null ? Number(parallelRaw) : null;

  return {
    model,
    draftModel,
    projector,
    specType,
    port,
    host,
    ctxSize,
    nGpuLayers,
    alias,
    parallel,
    // Tuning flags. `null` means the flag was NOT on the launch line, so
    // llama.cpp's own default applied — distinct from a value we chose. A
    // caller re-launching with this config must leave a null off the line
    // rather than substituting a number llama.cpp never saw.
    batchSize: getArg('-b') !== null ? Number(getArg('-b')) : null,
    ubatchSize: getArg('-ub') !== null ? Number(getArg('-ub')) : null,
    threads: getArg('-t') !== null ? Number(getArg('-t')) : null,
    flashAttn: list.includes('--flash-attn') || list.includes('-fa'),
    cacheTypeK: getArg('--cache-type-k'),
    cacheTypeV: getArg('--cache-type-v'),
    // Current llama.cpp calls this `--spec-draft-n-max`; retain the older
    // spelling on read so a pre-upgrade PortOS launch line can still be captured
    // and restored without inventing a new value.
    // Stored in MINUTES here, on the launch line in SECONDS — the flag's own
    // unit. Absent means the daemon is running without idle unload, which is 0
    // ("keep it resident"), not "unknown".
    sleepIdleMinutes: getArg(SLEEP_IDLE_FLAG) !== null
      ? Math.round(Number(getArg(SLEEP_IDLE_FLAG)) / 60)
      : 0,
    draftMax: getArg('--spec-draft-n-max') !== null
      ? Number(getArg('--spec-draft-n-max'))
      : (getArg('--draft-max') !== null ? Number(getArg('--draft-max')) : null),
  };
}

// The endpoint the current (or last-known) configuration serves on. Split out so
// the two callers below can't drift on how host/port are defaulted.
const endpointFor = (config) =>
  `http://${config?.host || '127.0.0.1'}:${config?.port ?? PORTS.LLAMA_SERVER}/v1`;

const daemon = createDaemonWatcher({
  appName: LLAMA_APP,
  defaultPort: PORTS.LLAMA_SERVER,
  endpointFor,
  parseConfigFromArgs,
  probe: probeEndpoint,
  isPortInUse: (...args) => isPortInUse(...args),
  sleep,
  getConfig: () => llamaLaunchState.currentConfig,
  setConfig: (config) => { llamaLaunchState.currentConfig = config; },
  getLastExitError: () => lastExitError,
  setLastExitError: (error) => { lastExitError = error; },
  getAppStatus: (...args) => getAppStatusStrict(...args),
  clearStatusCache: () => clearJlistCache(),
  getSavedProcessNames: (...args) => getSavedProcessNames(...args),
  execPm2: (...args) => execPm2(...args),
  getPortReleaseTimeoutMs: () => PORT_RELEASE_TIMEOUT_MS,
  preserveConfigOnReadFailure: true,
});
const appendLog = daemon.appendLog;
const llamaLogs = createDaemonLogFiles(LLAMA_APP);
const exitTail = createPm2ExitTail({ appName: LLAMA_APP, execPm2: (...a) => execPm2(...a), appendLog });

/**
 * Just the base URL llama-server is serving on — no endpoint probe, no PM2 log
 * fetch.
 *
 * `getLlamaServerStatus` answers a much bigger question and pays for it with a
 * network probe AND an `execPm2 logs` subprocess. A caller that only needs
 * "which port is it on?" (the assessments read path, which runs on every
 * Performance page load) must not spawn a process to find out and then discard
 * the logs it paid for.
 *
 * Reads the same recovered-config path as the status call, so a PortOS restart
 * that left the PM2 process online still resolves the real port rather than the
 * default.
 */
export async function getLlamaServerEndpoint() {
  // Reconstructs `currentConfig` from PM2's args as a side effect when PortOS
  // restarted under a still-running daemon — see `readLlamaServerLaunch`.
  if (!llamaLaunchState.currentConfig) await readLlamaServerLaunch();
  return daemon.endpoint();
}

/**
 * Returns current status of llama-server (binary availability, running state, config, logs).
 */
export async function getLlamaServerStatus({ includeLogs } = {}) {
  const binaryPath = resolveLlamaServerBinary();
  const installed = Boolean(binaryPath);
  const plan = getLlamaServerInstallPlan();

  return {
    ...await daemon.getStatusBase({ installed, includeLogs }),
    // How llama.cpp is installed HERE, so the LLMs page can name the command
    // instead of guessing. Carried on the lifecycle status rather than on the
    // update probe below, because the not-installed card is exactly the one
    // that has to name it — and it never reaches that probe, which needs a
    // binary to ask about.
    packageManager: plan.manager,
    packageManagerLabel: plan.managerLabel,
    installCommand: plan.installCommand,
    // The SAVED window, which is what the settings field edits. What the running
    // process actually got is `config.sleepIdleMinutes` — they differ until the
    // next start, because this is a launch flag.
    idleMinutes: await configuredSleepIdleMinutes(),
    keepLoaded: await configuredSleepIdleKeepLoaded(),
    ...await configuredAutoStart(),
  };
}

/**
 * `getLlamaServerStatus`, re-read while PM2 answers nothing at all.
 *
 * `managed: null` is "the PM2 read FAILED", and a failed read is a transient
 * subprocess/IPC hiccup far more often than a standing condition — `fetchJlist`
 * caches successes only, so each attempt is a genuine second read rather than
 * the same cached null handed back.
 *
 * Every caller below turns a `null` into a refusal, and a refusal costs a
 * measured assessment its whole reading: an untuned run that cannot be applied
 * is filed `applied: false`, which `getAssessmentReport` drops from `scorable`,
 * which takes the BASELINE row `compareTunings` ranks everything else against
 * off the table. One blip is not worth that, so ask again before answering.
 */
export async function readLlamaServerStatusRetrying() {
  let status = await getLlamaServerStatus();
  for (let attempt = 0; status.managed === null && attempt < PM2_READ_RETRIES; attempt += 1) {
    await sleep(pm2ReadRetryDelayMs);
    status = await getLlamaServerStatus();
  }
  return status;
}

const trimmedOrNull = (value) => (typeof value === 'string' && value.trim() ? value.trim() : null);

/**
 * Fills defaults for the launch options. Every tuning knob defaults to `null` =
 * NOT SET: the flag is left off the launch line entirely so llama.cpp applies
 * its own default. Substituting a number would silently pin a value the user
 * never chose and make two "default" runs incomparable.
 */
function normalizeLaunchOptions({
  model,
  draftModel,
  // llama.cpp's multimodal projector (`--mmproj`). Independent of speculative
  // decoding: a vision-capable GGUF loads text-only without it.
  projector,
  specType = 'draft-dflash',
  port = PORTS.LLAMA_SERVER,
  host = '127.0.0.1',
  ctxSize = 32768,
  nGpuLayers = 99,
  alias = 'dflash',
  parallel = 1,
  batchSize = null,
  ubatchSize = null,
  threads = null,
  flashAttn = false,
  cacheTypeK = null,
  cacheTypeV = null,
  draftMax = null,
  // `undefined` = not supplied, so fall through to the saved setting; an
  // explicit number (including 0) is the caller's own choice and wins, which
  // is what lets a relaunch replay exactly the line it captured.
  sleepIdleMinutes = undefined,
}) {
  return {
    model, draftModel, projector, specType, port, host, ctxSize, nGpuLayers, alias, parallel,
    batchSize, ubatchSize, threads, flashAttn, cacheTypeK, cacheTypeV, draftMax, sleepIdleMinutes,
  };
}

/** Refuses a launch the host cannot honor: no binary, already online, port taken. */
async function assertLaunchable(binaryPath, { model, host, port }) {
  if (!binaryPath) {
    throw new ServerError(
      `llama-server binary was not found on PATH. Install it with \`${getLlamaServerInstallPlan().installCommand}\` or build from source.`,
      { status: 400 }
    );
  }

  return daemon.assertPortFree({
    host,
    port,
    label: 'llama-server',
    codePrefix: 'LLAMA_SERVER',
    portAdvice: 'Choose a different port under Advanced options before starting llama-server.',
    // Keep the missing-model refusal between PM2 ownership and port probes.
    beforeProbe: () => {
      if (!model || typeof model !== 'string') {
        throw new ServerError('model path is required to start llama-server', { status: 400 });
      }
    },
  });
}

/**
 * `--spec-type` is a comma-separated LIST, and only its `draft-*` entries want
 * a drafter GGUF — every `ngram-*` implementation speculates off the tokens
 * already in the context window. Emitting the flag only alongside a drafter
 * would throw away valid drafter-free launches (`--spec-type ngram-map-k`) and
 * silently ignore the ngram half of a mixed one (`draft-dflash,ngram-map-k`).
 *
 * The two halves are resolved against each other, because the launcher card
 * seeds BOTH fields from a preset: switching Spec Type to an `ngram-*` leaves
 * the preset's drafter path sitting in the form, and passing that as
 * `--model-draft` would load weights the run can't use — or fail the existence
 * check on a preset GGUF that was never downloaded. So a drafter is only
 * carried when some requested type actually drafts with one, and drafter-based
 * types are dropped when no drafter is set, which keeps the card's documented
 * "clear the field to run without it" working. An EMPTY spec type deliberately
 * still counts as wanting the drafter: llama.cpp speculates off a bare
 * `--model-draft`, so dropping it there would silently disable a working
 * configuration.
 */
function resolveSpecDrafter({ specType, draftModel }) {
  const configuredDraftPath = trimmedOrNull(draftModel);
  const requestedSpecTypes = parseSpecTypes(specType);
  const drafterInUse = requestedSpecTypes.length === 0 || requestedSpecTypes.some(isDraftSpecType);
  const draftPath = drafterInUse ? configuredDraftPath : null;
  const effectiveSpecTypes = draftPath
    ? requestedSpecTypes
    : requestedSpecTypes.filter((type) => !isDraftSpecType(type));
  const droppedSpecTypes = requestedSpecTypes.filter((type) => !effectiveSpecTypes.includes(type));
  return { configuredDraftPath, draftPath, effectiveSpecTypes, droppedSpecTypes };
}

/**
 * llama.cpp's in-place idle unload. A build without the flag gets the line it
 * would have got before this feature existed — never a rejected launch.
 * `effective` is what actually reached the process, so the status card reports
 * the truth rather than the request.
 */
async function resolveIdleMinutes({ sleepIdleMinutes, binaryPath }) {
  const requested = Number.isFinite(sleepIdleMinutes)
    ? Math.max(0, Math.floor(sleepIdleMinutes))
    : await configuredSleepIdleMinutes();
  const pinned = await configuredSleepIdleKeepLoaded();
  const effective = !pinned && requested > 0 && await supportsSleepIdle(binaryPath)
    ? requested
    : 0;
  return { requested, effective, pinned };
}

/** Everything the launch line and `llamaLaunchState.currentConfig` are derived from. */
async function resolveLaunch(options, binaryPath) {
  const opts = normalizeLaunchOptions(options);
  // Validate the weights before building the launch line
  await assertModelFileExists('The base model', opts.model.trim());
  // Unlike the drafter, the projector is resolved against nothing — no spec type
  // turns vision on or off, so what the caller set is what goes on the line.
  const projectorPath = trimmedOrNull(opts.projector);
  if (projectorPath) await assertModelFileExists('The vision projector', projectorPath);
  const drafter = resolveSpecDrafter(opts);
  if (drafter.draftPath) await assertModelFileExists('The drafter model', drafter.draftPath);
  // Resolved AFTER the rest so a relaunch that carried an explicit value replays
  // it verbatim, and only then falls back to the saved setting.
  const idle = await resolveIdleMinutes({ sleepIdleMinutes: opts.sleepIdleMinutes, binaryPath });
  // Always on the line — leaving it off reverts to llama.cpp's multi-slot
  // default, which is the VRAM tax this pin exists to avoid. `null` from a
  // recovered pre-flag launch still means 1, not "daemon default".
  const parallelSlots = Number.isFinite(opts.parallel) && opts.parallel >= 1 ? opts.parallel : 1;
  return { ...opts, ...drafter, projectorPath, parallelSlots, idle };
}

/** The llama-server argv, in a stable order. Pure over the resolved launch. */
function buildLaunchArgs(r) {
  const args = ['-m', expandHome(r.model.trim())];
  if (r.draftPath) args.push('--model-draft', expandHome(r.draftPath));
  if (r.projectorPath) args.push('--mmproj', expandHome(r.projectorPath));
  if (r.effectiveSpecTypes.length > 0) args.push('--spec-type', r.effectiveSpecTypes.join(','));
  if (r.port) args.push('--port', String(r.port));
  if (r.host) args.push('--host', r.host);
  if (r.ctxSize) args.push('--ctx-size', String(r.ctxSize));
  if (r.nGpuLayers !== undefined && r.nGpuLayers !== null) args.push('-ngl', String(r.nGpuLayers));
  args.push('--parallel', String(r.parallelSlots));
  if (Number.isFinite(r.batchSize)) args.push('-b', String(r.batchSize));
  if (Number.isFinite(r.ubatchSize)) args.push('-ub', String(r.ubatchSize));
  if (Number.isFinite(r.threads)) args.push('-t', String(r.threads));
  if (r.flashAttn) args.push('--flash-attn');
  if (r.cacheTypeK) args.push('--cache-type-k', String(r.cacheTypeK));
  if (r.cacheTypeV) args.push('--cache-type-v', String(r.cacheTypeV));
  // Only meaningful alongside a drafter — passing it without one makes
  // llama-server reject the launch line outright.
  if (Number.isFinite(r.draftMax) && r.draftPath) args.push('--spec-draft-n-max', String(r.draftMax));
  if (r.alias) args.push('--alias', r.alias);
  if (r.idle.effective > 0) args.push(SLEEP_IDLE_FLAG, String(r.idle.effective * 60));
  return args;
}

/**
 * What the status card reports: the values actually on the launch line (the
 * drafter, projector and spec types that survived resolution), not what the
 * form happened to hold. `null` projector/drafter means the process runs without.
 */
function buildCurrentConfig(r) {
  return {
    model: r.model,
    draftModel: r.draftPath,
    projector: r.projectorPath,
    specType: r.effectiveSpecTypes.join(','),
    port: r.port,
    host: r.host,
    ctxSize: r.ctxSize,
    nGpuLayers: r.nGpuLayers,
    alias: r.alias,
    parallel: r.parallelSlots,
    batchSize: r.batchSize,
    ubatchSize: r.ubatchSize,
    threads: r.threads,
    flashAttn: r.flashAttn,
    cacheTypeK: r.cacheTypeK,
    cacheTypeV: r.cacheTypeV,
    draftMax: r.draftMax,
    sleepIdleMinutes: r.idle.effective,
  };
}

function logLaunchResolution(r, args) {
  if (!r.idle.pinned && r.idle.requested > 0 && r.idle.effective === 0) {
    appendLog(`This llama-server build has no ${SLEEP_IDLE_FLAG} — the model stays resident while idle`);
  }
  if (r.droppedSpecTypes.length > 0) {
    appendLog(`Ignoring spec-type ${r.droppedSpecTypes.join(',')} — no drafter model is set`);
    console.log(`🦙 llama-server dropping drafter-based spec types ${r.droppedSpecTypes.join(',')} (no --model-draft configured)`);
  }
  if (r.configuredDraftPath && !r.draftPath) {
    appendLog(`Ignoring drafter ${r.configuredDraftPath} — no requested spec type uses one`);
    console.log(`🦙 llama-server ignoring drafter ${r.configuredDraftPath} (spec types ${r.effectiveSpecTypes.join(',') || 'none'} need no drafter)`);
  }
  appendLog(`Starting: llama-server ${args.join(' ')}`);
}

/**
 * Starts llama-server with the specified model and options under PM2.
 */
export async function startLlamaServerUnlocked(options = {}) {
  const binaryPath = resolveLlamaServerBinary();
  const endpoint = await assertLaunchable(binaryPath, normalizeLaunchOptions(options));
  const resolved = await resolveLaunch(options, binaryPath);
  const args = buildLaunchArgs(resolved);
  const { host, port, model, draftPath, projectorPath } = resolved;

  lastExitError = null;
  daemon.resetLogs();
  logLaunchResolution(resolved, args);

  // A fresh launch line supersedes any baseline: whatever PortOS tuned is gone
  // with the process it tuned, and restoring the old daemon's configuration over
  // this one would undo a start the user just asked for. A relaunch re-arms this
  // AFTER the start returns, from the baseline it captured itself.
  llamaLaunchState.preTuningConfig = null;
  llamaLaunchState.currentConfig = buildCurrentConfig(resolved);

  console.log(`🦙 llama-server starting on ${host}:${port} (model ${model}${draftPath ? `, drafter ${draftPath}` : ''}${projectorPath ? `, projector ${projectorPath}` : ''})`);
  return daemon.launch({
    binaryPath,
    args,
    endpoint,
    waitMs: startupWaitTimeoutMs,
    pollMs: startupPollDelayMs,
    logs: llamaLogs,
    label: 'llama-server',
    codePrefix: 'LLAMA_SERVER',
    // Keep the historical formatting of llama-server's exit tail.
    trimExitOutput: true,
  });
}

/** Stops the managed llama-server process. */
export async function stopLlamaServer() {
  return daemon.stop({
    label: 'llama-server',
    onStopped: () => {
      // A tuning relaunch re-establishes the baseline from its captured config.
      llamaLaunchState.preTuningConfig = null;
    },
  });
}

/**
 * Block until nothing is listening on `port`, or the timeout elapses.
 *
 * `startLlamaServer` refuses when the port is still bound, and PM2's delete
 * returns before the kernel has released the listener — without this a relaunch
 * loses a race with itself and reports "port already in use" for the server it
 * just stopped.
 */
export const waitForPortRelease = daemon.waitForPortRelease;

/**
 * Block until the endpoint answers, or the readiness budget elapses. Fails
 * fast, with PM2's exit tail, when the process dies while loading — a GGUF OOM
 * after the startup window must not cost the full budget polling a dead port.
 *
 * @returns {Promise<{ready: boolean, reason: string|null}>}
 */
const waitForEndpoint = (endpoint) => waitForDaemonReady({
  endpoint,
  label: 'llama-server',
  probe: probeEndpoint,
  getStatusStrict: () => getAppStatusStrict(LLAMA_APP),
  clearStatusCache: clearJlistCache,
  exitTail,
  sleep,
  timeoutMs: relaunchReadyTimeoutMs,
  pollMs: relaunchPollDelayMs,
});

/** Wait for a just-started server to answer (stops early when PM2 reports it dead); `{ready, reason}`. */
export const waitForLlamaServerReady = waitForEndpoint;

/**
 * The launch line PM2 is currently running llama-server on, without the log
 * fetch and endpoint probe `getLlamaServerStatus` spends on a full status.
 *
 * `managed: false` covers both "nothing is running" and "something is listening
 * that PortOS did not start" — neither is a launch line PortOS may change.
 *
 * `readFailed: true` is a THIRD answer and must not collapse into either: it
 * means PM2 itself could not be read (`getAppStatusStrict`'s null sentinel), so
 * PortOS does not know what is running. Reporting that as "not PortOS's" would
 * tell a user who owns the daemon to go add `--alias` to a launch line PortOS
 * wrote — the fix is to retry. `getLlamaServerStatus` draws the same
 * distinction (`isReadFailed`).
 *
 * @returns {Promise<{managed: boolean, config: object|null, readFailed: boolean}>}
 */
export async function readLlamaServerLaunch() {
  return daemon.readLaunch();
}

/**
 * Clears in-memory test state (used by test suites).
 */
export function _resetLlamaServerStateForTests({
  startupWaitTimeout,
  startupPollDelay,
  relaunchReadyTimeout,
  relaunchPollDelay,
  pm2ReadRetryDelay,
  sleepIdleMinutes = 0,
  sleepIdleKeepLoaded = null,
  platform = null,
  logFiles,
} = {}) {
  sleepIdleSupport.clear();
  // Pinned rather than read from disk — see `configuredSleepIdleMinutes`.
  sleepIdleMinutesOverride = sleepIdleMinutes;
  sleepIdleKeepLoadedOverride = sleepIdleKeepLoaded;
  // `null` = use the real host platform, which is what every suite that is not
  // specifically exercising the other package manager's path wants.
  _setLlamaInstallPlatformForTests(platform);
  llamaLogs.setForTests(logFiles);
  llamaLaunchState.currentConfig = null;
  llamaLaunchState.preTuningConfig = null;
  daemon.resetLogs();
  lastExitError = null;
  // Restored to the production budget unless a suite asks for a shorter one.
  startupWaitTimeoutMs = Number.isFinite(startupWaitTimeout) ? startupWaitTimeout : STARTUP_WAIT_TIMEOUT_MS;
  startupPollDelayMs = Number.isFinite(startupPollDelay) ? startupPollDelay : STARTUP_POLL_DELAY_MS;
  relaunchReadyTimeoutMs = Number.isFinite(relaunchReadyTimeout) ? relaunchReadyTimeout : RELAUNCH_READY_TIMEOUT_MS;
  relaunchPollDelayMs = Number.isFinite(relaunchPollDelay) ? relaunchPollDelay : RELAUNCH_POLL_DELAY_MS;
  pm2ReadRetryDelayMs = Number.isFinite(pm2ReadRetryDelay) ? pm2ReadRetryDelay : PM2_READ_RETRY_DELAY_MS;
}

export function _setLlamaKeepLoadedOverrideForTests(val) {
  sleepIdleKeepLoadedOverride = val;
}
