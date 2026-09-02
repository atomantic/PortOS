/**
 * MTPLX process manager
 *
 * Lifecycle management (status probe, install, start, stop, recent logs) for the
 * local `mtplx serve` OpenAI-compatible API server, managed as an optional PM2
 * process (`portos-mtplx`) — deliberately the same shape as
 * `llamaServerManager.js`.
 *
 * PM2 rather than a bare detached spawn, because that is what makes the daemon
 * *manageable*: `pm2 list` shows it next to the rest of the install, `pm2 logs`
 * has its output, restart-on-boot is a `pm2 save` away, and a PortOS restart can
 * re-adopt a server it started earlier instead of losing track of a detached
 * pid. A detached child gets none of that.
 *
 * Two limits carried over from `docs/features/mtplx.md`:
 *   - **A start never downloads weights.** `mtplx serve` is started on a
 *     checkpoint ALREADY in MTPLX's cache; an empty cache is reported rather
 *     than silently filled. Fetching one is its own explicit, user-pressed
 *     action in `mtplxModelManager.js` — in the UI, never in a terminal.
 *   - **MTPLX's privileged paths are never touched.** Upstream's optional
 *     `mtplx max --install` fan-control helper stays an explicit operator action
 *     outside PortOS.
 */

import { commandExists } from '../lib/commandExists.js';
import { writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { sleep } from '../lib/fileUtils.js';
import { ServerError } from '../lib/errorHandler.js';
import { launchArgs, normalizeTuning, tuningSpecsFor } from '../lib/localModelTuning.js';
import { LOCAL_RUNTIMES, localEndpointPort, localRuntimeKind, isLocalInstanceEndpoint } from '../lib/localProviderRuntime.js';
import { listMtplxCachedModels, pickMtplxCachedModel } from '../lib/mtplxModels.js';
import { describeMtplxRuntime } from '../lib/mtplxRuntime.js';
import { probeOpenAiModels } from '../lib/openAiModelsProbe.js';
import { createDaemonWatcher, pm2ArgValue, idleWindowMs, markDaemonUsed, registerIdleDaemon, MTPLX_APP } from '../lib/managedDaemon.js';
// `settings.js` is lazy-imported at its call sites below, never statically: it
// eagerly resolves `fileUtils.PATHS` at module load, which drags PATHS into the
// module graph of every consumer of this manager and breaks the many suites that
// partial-mock fileUtils without it. Same reason `services/aiProvider.js` defers
// `localModelHealing`.

import { isAppleSilicon, isPortInUse } from '../lib/platform.js';
import { findCommandOnPath } from '../lib/processEnv.js';
import { runStreamingCommand } from '../lib/streamingSpawn.js';
import { execPm2, getAppStatusStrict, clearJlistCache, getSavedProcessNames } from './pm2.js';

export { MTPLX_APP };

const PROBE_TIMEOUT_MS = 1500;
/**
 * How long `startMtplxServer` waits before returning.
 *
 * This is NOT how long MTPLX gets to come up — it is how long the HTTP request
 * blocks. MTPLX loads a multi-gigabyte MLX checkpoint before it binds, which
 * routinely outlasts any sane request timeout, so the wait exists only to catch
 * a server that dies immediately (an empty cache, a bad checkpoint). Still
 * loading after this returns `online: false` and the status poll takes over —
 * exactly what `llamaServerManager` does with its own four-second beat.
 *
 * Mutable only through the test seam below, so a suite asserting the
 * still-loading path doesn't have to sit through the real budget.
 */
let startupWaitMs = 8_000;
/**
 * Beat between startup polls. Mutable through the same test seam as the budget
 * above: a suite that pins the endpoint probe unreachable pays this delay in
 * FULL on every lifecycle test, which is what made this file the slowest server
 * suite — a 1.5s floor per start, several starts per relaunch case, close enough
 * to the 10s per-test timeout to flake under CI load.
 */
let startupPollMs = 1500;
/**
 * How long to let the stopped daemon give the port up before starting the next
 * one. Six times llama.cpp's five seconds, because what is being torn down is a
 * multi-gigabyte MLX process and giving up early is the expensive mistake here:
 * `startMtplxServer` refuses a bound port BEFORE it launches anything, so a
 * relaunch that jumps the gun fails the tuned start AND the restore behind it,
 * leaving the install's `mtplx` provider down over a race rather than over
 * anything the user tuned. Mutable through the test seam below, like the other
 * budgets here, so a suite exercising a still-held port does not sit it out.
 */
let portReleaseTimeoutMs = 30_000;
/**
 * How long a TUNING relaunch waits for the new launch line to answer before
 * calling it wedged and putting the previous configuration back.
 *
 * Far longer than `startupWaitMs`, and deliberately longer than llama.cpp's
 * equivalent: `startMtplxServer` only proves the process survived its first
 * seconds, and a cold multi-gigabyte MLX checkpoint routinely takes minutes to
 * load. Judging it at eight seconds would restore the previous configuration
 * over a server that was merely still loading. Mutable through the test seam so
 * a suite asserting the never-answered path doesn't sit through the real budget.
 */
let relaunchReadyTimeoutMs = 300_000;
// Readiness poll cadence. Kept separate from the budget so lifecycle tests can
// exercise retries and timer-driven PM2 transitions without one real second per
// loop.
let relaunchPollMs = 1000;
/** Package-manager installs routinely run for minutes. */
const INSTALL_TIMEOUT_MS = 20 * 60 * 1000;

/**
 * The default loopback endpoint the shipped MTPLX provider presets point at.
 * Read from the runtime table rather than re-declared, so the launcher and the
 * readiness probe cannot drift onto different ports.
 */
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = Number(localEndpointPort(LOCAL_RUNTIMES.mtplx.defaultBaseUrl)) || 8000;

/** MTPLX is an Apple-Silicon MLX runtime — nothing to install anywhere else. */
export const MTPLX_UNSUPPORTED_REASON = 'MTPLX runs only on macOS with Apple Silicon.';

/**
 * Why an installed MTPLX still cannot be started. Weights are a multi-gigabyte
 * download and stay the user's decision — so a start never fetches them
 * silently, and this names the in-app control that does instead of a terminal
 * command (`services/mtplxModelManager.js`).
 */
const MTPLX_NO_MODEL_ERROR = 'MTPLX has no model weights cached, so its server exits before it binds a port. Use "Download default checkpoint" on the MTPLX card (or search for another MTP model there) to fetch one — a multi-gigabyte download PortOS will not start without you asking — then start MTPLX again.';

const MTPLX_RUNTIME_BOOTSTRAP_ERROR = 'MTPLX\'s own Python runtime failed to bootstrap because Homebrew\'s Python does not provide a working `ensurepip`. Try `brew reinstall python@3.13` (or `brew reinstall --build-from-source youssofal/mtplx/mtplx` to force a rebuild against a working interpreter), then start MTPLX again.';

/**
 * Why an installed MTPLX still cannot be started, one layer below a missing
 * checkpoint: the Homebrew wrapper on PATH has not built its Python venv yet, so
 * its first act would be a multi-hundred-megabyte pip install — inside an
 * eight-second startup window, reported afterwards as a crashed daemon. Same
 * contract as MTPLX_NO_MODEL_ERROR: a large download is a button the user
 * presses, never something a start does behind them.
 */
const MTPLX_RUNTIME_NOT_BOOTSTRAPPED_ERROR = `MTPLX's Python runtime has not been downloaded yet — Homebrew installs a wrapper that fetches it (several hundred megabytes) on first run, and PortOS will not do that inside a server start. Use "Download MTPLX runtime" on the MTPLX card to run it as its own step, then start MTPLX again.`;

/**
 * Keep MTPLX startup logs raw while scoping each diagnosis to the current
 * launch. PM2 appends to its configured files across process deletion, so
 * stable, app-specific paths are truncated before every start.
 */
const DEFAULT_MTPLX_LOG_FILES = {
  stdout: join(tmpdir(), 'portos-mtplx-out.log'),
  stderr: join(tmpdir(), 'portos-mtplx-error.log'),
};

let mtplxLogFiles = DEFAULT_MTPLX_LOG_FILES;

const resetMtplxLogs = async () => {
  const results = await Promise.all(
    Object.entries(mtplxLogFiles).map(([stream, path]) => (
      writeFile(path, '')
        .then(() => true)
        .catch((error) => {
          console.error(`❌ MTPLX: could not reset ${stream} startup log (${error?.code || 'unknown'}); bootstrap diagnosis disabled for this launch`);
          return false;
        })
    )),
  );
  return results.every(Boolean);
};

const isMtplxRuntimeBootstrapFailure = (output) => {
  const text = String(output ?? '');
  return /runtime is not installed|bootstrapping with pip/i.test(text)
    && /ensurepip/i.test(text)
    && /returned non-zero exit status|no module named ensurepip|ensurepip is not available|failed to bootstrap/i.test(text);
};

let currentConfig = null;
let lastExitError = null;

const probeEndpoint = async (endpoint) =>
  (await probeOpenAiModels(endpoint, { timeoutMs: PROBE_TIMEOUT_MS })).reachable;

const endpointFor = (config) =>
  `http://${DEFAULT_HOST}:${config?.port ?? DEFAULT_PORT}/v1`;

const daemon = createDaemonWatcher({
  appName: MTPLX_APP,
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
  getPortReleaseTimeoutMs: () => portReleaseTimeoutMs,
});
const appendLog = daemon.appendLog;

/**
 * Reconstructs the launch config from PM2 process args when PortOS restarted
 * while the PM2 process stayed online — same recovery `llamaServerManager` does,
 * so a restart doesn't report a server it started as "external".
 */
function parseConfigFromArgs(args) {
  if (!args) return null;
  const list = Array.isArray(args) ? args : String(args).split(' ');
  if (!list.includes('serve')) return null;
  const port = pm2ArgValue(list, '--port');
  return {
    port: port ? Number(port) : DEFAULT_PORT,
    // Absent means MTPLX was started on its OWN default checkpoint — don't
    // invent a repo id the launch line never carried.
    model: pm2ArgValue(list, '--model'),
    tuning: parseTuningFromArgs(list),
  };
}

/**
 * Recover the tuning knobs from a launch line PortOS is re-adopting.
 *
 * Walks the CATALOG rather than the argv, so a flag PortOS no longer declares
 * cannot come back as a knob, and every value goes through `normalizeTuning` —
 * argv holds strings, while the status payload and the restore path both expect
 * the coerced shape. Empty when nothing was tuned, which reads the same as a
 * server started before tuning existed.
 *
 * This is a READ of a running process, so a value the catalog cannot represent
 * is DROPPED, never clamped. `normalizeTuning` clamps, which is right for user
 * input (the form offered the range) and wrong here: installs upgrade on their
 * own schedule, so a daemon started before a release that tightened a bound is
 * exactly the case this hits — and clamping would report `--depth 4` on the card
 * and hand `--depth 4` to a restore, while the process is demonstrably running
 * `--depth 8`. Absent at least means "PortOS cannot name this", which is true.
 */
function parseTuningFromArgs(list) {
  const raw = {};
  for (const spec of tuningSpecsFor('mtplx')) {
    if (!spec.cli) continue;
    // `launchArgs` renders a boolean as a BARE flag, so its inverse is presence,
    // not the next token — reading one would recover the NEXT flag's name as
    // this knob's value. No MTPLX knob is boolean today; this is here so adding
    // one cannot silently break re-adoption.
    if (spec.type === 'boolean') {
      if (list.includes(spec.cli)) raw[spec.id] = true;
      continue;
    }
    const value = pm2ArgValue(list, spec.cli);
    if (value === null) continue;
    // Outside the declared range: drop rather than let `normalizeTuning` clamp
    // it into a number the daemon is not running with. (An enum value the
    // catalog no longer lists is already dropped there, for the same reason.)
    if (spec.type === 'number' && !withinDeclaredRange(spec, value)) continue;
    raw[spec.id] = value;
  }
  return normalizeTuning('mtplx', raw);
}

const withinDeclaredRange = (spec, raw) => {
  const num = Number(raw);
  return Number.isFinite(num) && num >= (spec.min ?? -Infinity) && num <= (spec.max ?? Infinity);
};

const waitForPortRelease = daemon.waitForPortRelease;

/**
 * Block until the relaunched server answers, or until it is proven dead.
 *
 * Polls PM2 alongside the endpoint, because the two failures look identical from
 * the endpoint alone and cost wildly different amounts of time. `mtplx serve`
 * accepts a `--context-window` far past what the machine can hold, then dies
 * partway through loading the checkpoint — well after `startMtplxServer`'s short
 * startup window has already returned. Waiting the full readiness budget out on
 * a process PM2 has already marked `errored` would leave the install's `mtplx`
 * provider down for minutes per bad launch line, and a tuning sweep is EXPECTED
 * to produce bad launch lines.
 *
 * Resolves `{ ready, reason }` — and the two not-ready cases carry DIFFERENT
 * reasons, because they send the user to different places. A process PM2 marks
 * `errored` printed something on the way out, and that tail is the whole
 * diagnosis ("metal buffer allocation failed"); reporting it as "never answered
 * on its port" would throw away the one fact that explains the failure.
 */
async function waitForRelaunchedEndpoint(endpoint) {
  const deadline = Date.now() + relaunchReadyTimeoutMs;
  while (Date.now() < deadline) {
    if (await probeEndpoint(endpoint)) return { ready: true, reason: null };
    clearJlistCache();
    const proc = await getAppStatusStrict(MTPLX_APP);
    if (proc && ['errored', 'stopped', 'not_found'].includes(proc.status)) {
      return { ready: false, reason: `MTPLX exited while loading (${await exitTail(proc.status)})` };
    }
    await sleep(relaunchPollMs);
  }
  return { ready: false, reason: 'MTPLX relaunched but never answered on its port' };
}

/**
 * The last few lines the dead process printed, appended to its PM2 status —
 * the same tail `startMtplxServer` surfaces for a server that dies inside its
 * startup window, so a launch line that fails later is diagnosed the same way.
 */
async function exitTail(status) {
  const pm2Logs = await execPm2(['logs', MTPLX_APP, '--nostream', '--lines', '15']).catch(() => null);
  const lines = `${pm2Logs?.stderr || pm2Logs?.stdout || ''}`.split('\n').map((l) => l.trimEnd()).filter(Boolean);
  for (const line of lines) appendLog(line);
  const tail = lines.slice(-4).join(' | ');
  return tail ? `PM2 status: ${status} — ${tail}` : `PM2 status: ${status}`;
}

/** Resolve the `mtplx` executable on the child-process PATH. */
const resolveMtplxBinary = () => findCommandOnPath('mtplx');

/** Just the base URL MTPLX is serving on — no endpoint probe, no PM2 log fetch. */
export async function getMtplxServerEndpoint() {
  if (!currentConfig) {
    await daemon.readLaunch();
  }
  return daemon.endpoint();
}

/**
 * Current MTPLX state: binary availability, runtime readiness, process state,
 * endpoint, config, logs, and what is in its model cache.
 *
 * The cache listing (`mtplx models --json`) reads a local directory and pulls
 * nothing over the network — but it does so by INVOKING `mtplx`, and the
 * Homebrew `mtplx` is a wrapper whose first invocation on a given version
 * bootstraps a several-hundred-megabyte Python venv (`lib/mtplxRuntime.js`).
 * On a host where that has not happened yet, this poll WAS the bootstrap: it
 * outran the 30s cache-query budget, got killed, reported `cacheError`, and the
 * next poll started the download over. So the cache is only read once
 * `runtimeReady` says the wrapper will exec straight through to the real
 * binary; until then `cachedModels` stays empty with `cacheError: null` —
 * "not read", never "read and empty".
 */
export async function getMtplxServerStatus() {
  const binaryPath = resolveMtplxBinary();
  const installed = Boolean(binaryPath);
  // The platform gate is about what PortOS may INSTALL, never about what is
  // already there: a binary on PATH (or a server answering) is proof enough that
  // this host runs it, and reporting "macOS only" over a working install would
  // be a false negative.
  const supported = installed || isAppleSilicon();

  const base = await daemon.getStatusBase({ installed });

  // Reading the wrapper, never running it — see `lib/mtplxRuntime.js`.
  const runtimeReady = installed ? (await describeMtplxRuntime(binaryPath)).ready : false;

  // `models: null` means the cache could NOT be read — deliberately not the same
  // as `[]` (read, and empty). Only the latter blocks a start.
  const cache = installed && runtimeReady ? await listMtplxCachedModels() : { models: null, error: null };

  return {
    ...base,
    supported,
    unsupportedReason: supported ? null : MTPLX_UNSUPPORTED_REASON,
    // Installed ≠ runnable: the Homebrew binary is a wrapper that downloads the
    // real runtime on first use. The card needs the two apart so it offers the
    // download instead of a Start button that is guaranteed to fail.
    runtimeReady,
    // The tuning flags the running daemon was LAUNCHED with, rendered by the
    // catalog that owns the transport rather than re-derived in the UI. A
    // measured assessment relaunches this daemon and leaves its flags on, so a
    // status that reported only the model would show a server as plain
    // "running" while it serves with, say, MTP decoding switched off. Empty for
    // an untuned server, and for one PortOS does not manage — it cannot read
    // another process's launch line.
    tuningFlags: base.managed === true ? launchArgs('mtplx', currentConfig?.tuning) : [],
    idleMinutes: await configuredIdleMinutes(),
    // What a lazy start will launch on, so the card's fields show the saved
    // choice rather than resetting to "Auto" on every page load.
    launch: await savedLaunchConfig(),
    cachedModels: (cache.models || []).map((m) => m?.repo_id).filter(Boolean),
    // The same cache, with what the manage-checkpoints UI needs to let a user
    // free the disk: how big each pack is, and whether it is actually servable
    // (an interrupted pull leaves a directory that lists but cannot load).
    cachedModelRows: (cache.models || [])
      .filter((m) => m?.repo_id)
      .map((m) => ({
        repo: m.repo_id,
        sizeBytes: Number.isFinite(Number(m.size_bytes)) ? Number(m.size_bytes) : null,
        hasRuntimeContract: m.has_runtime_contract === true,
        // `validation.ok` absent means an older `mtplx models` that did not
        // report one — treat that as usable rather than flagging every row.
        valid: m.validation?.ok !== false,
      })),
    cacheError: cache.error,
  };
}

/**
 * Run the Homebrew wrapper's deferred bootstrap HERE, where the user pressed a
 * button and the budget fits.
 *
 * `brew install` finishes with only a shell shim on PATH; the actual MTPLX —
 * fastapi, huggingface_hub, numpy/scipy, the MLX stack — is downloaded by the
 * wrapper's first invocation (`lib/mtplxRuntime.js`). Left alone, that lands on
 * whatever runs `mtplx` next: a 30s status poll or an 8s-judged PM2 start,
 * neither of which can survive it, both of which misreport it. `mtplx --version`
 * is the cheapest invocation that trips the same guard, and it streams into the
 * install modal under the 20-minute install budget.
 *
 * A failure here FAILS the install: returning success would leave a card
 * reporting `installed: true` for something that cannot serve a request.
 *
 * Skipped when the runtime is already present — a re-run of the install (the
 * card's "Download MTPLX runtime" button drives this same flow) then costs a
 * `brew install` no-op rather than another invocation.
 */
async function warmMtplxRuntime(emit) {
  const binaryPath = resolveMtplxBinary();
  if (!binaryPath) return;
  const runtime = await describeMtplxRuntime(binaryPath);
  if (runtime.ready) return;

  emit('MTPLX bootstraps its own Python runtime on first run — downloading it now. This can take several minutes.');
  const result = await runStreamingCommand(binaryPath, ['--version'], emit, { timeoutMs: INSTALL_TIMEOUT_MS });
  if (!result.success) {
    throw new ServerError(`MTPLX installed, but its Python runtime failed to bootstrap: ${result.error}`, { status: 500, code: 'MTPLX_RUNTIME_BOOTSTRAP_FAILED' });
  }
}

/**
 * Install MTPLX from upstream's Homebrew tap, falling back to pip on a host
 * without Homebrew. Both install the same `mtplx` binary, and neither runs the
 * optional privileged fan-control helper.
 */
export async function installMtplx({ onProgress = () => {} } = {}) {
  const emit = (message) => onProgress({ event: 'progress', message });
  if (!isAppleSilicon()) {
    throw new ServerError(MTPLX_UNSUPPORTED_REASON, { status: 400, code: 'MTPLX_UNSUPPORTED_PLATFORM' });
  }
  if (await commandExists('brew', ['--version'])) {
    emit('Installing MTPLX via Homebrew (youssofal/mtplx/mtplx)…');
    const result = await runStreamingCommand('brew', ['install', 'youssofal/mtplx/mtplx'], emit, { timeoutMs: INSTALL_TIMEOUT_MS });
    if (!result.success) throw new ServerError(`MTPLX install failed: ${result.error}`, { status: 500 });
    await warmMtplxRuntime(emit);
    return { success: true, message: 'MTPLX installed' };
  }
  if (await commandExists('python3', ['--version'])) {
    // No warm-up here: pip installs the REAL package, not a wrapper, so there is
    // no deferred runtime left to fetch.
    emit('Homebrew was not found — installing MTPLX with pip instead…');
    const result = await runStreamingCommand('python3', ['-m', 'pip', 'install', '--upgrade', 'mtplx'], emit, { timeoutMs: INSTALL_TIMEOUT_MS });
    if (!result.success) throw new ServerError(`MTPLX install failed: ${result.error}`, { status: 500 });
    return { success: true, message: 'MTPLX installed' };
  }
  throw new ServerError('Neither Homebrew nor python3 is available. Install Homebrew from https://brew.sh, then try again.', { status: 400 });
}

/**
 * Resolve which cached checkpoint `mtplx serve` should be started on.
 *
 * `mtplx serve` defaults `--model` to ONE hard-coded repo id and exits 1 before
 * binding when that repo is not cached — even on a machine holding a different
 * MTP model that would have served fine. So ask the cache first and name what is
 * actually there.
 *
 * Returns `{ model }` (possibly `null` = fall through to MTPLX's own default
 * because the cache could not be READ) or `{ error }`.
 */
async function resolveStartModel(requested, emit) {
  if (requested) return { model: requested };
  const cache = await listMtplxCachedModels();
  if (cache.models === null) {
    emit(`Could not read MTPLX's model cache (${cache.error}) — starting with its default model.`);
    return { model: null };
  }
  if (cache.models.length === 0) return { error: MTPLX_NO_MODEL_ERROR };
  const model = pickMtplxCachedModel(cache.models);
  if (!model) {
    const count = cache.models.length;
    return { error: `MTPLX's cache holds ${count} model${count === 1 ? '' : 's'}, but none passed its own file check — an interrupted download leaves a partial pack behind. Remove it on the MTPLX card and download the checkpoint again, then try again.` };
  }
  return { model };
}

/**
 * Start `mtplx serve` under PM2.
 *
 * `waitMs` overrides how long this blocks before handing back `online: false`
 * for a server that is still loading. The LLMs-page launcher takes the short
 * default and lets its status poll finish the story; the provider-readiness
 * checklist passes its own longer budget, because that flow's contract is "the
 * endpoint answers when this returns".
 *
 * There is deliberately no `host` option: MTPLX is a loopback daemon
 * (`docs/features/mtplx.md`), every shipped provider preset points at
 * 127.0.0.1, and accepting a host PortOS never puts on the launch line would
 * report an endpoint the server is not bound to.
 *
 * `tuning` is a knob set from `lib/localModelTuning.js` (`TUNING_SPECS.mtplx`),
 * rendered to `mtplx serve` flags by the catalog rather than by a flag map here,
 * so a knob cannot reach the launch line without also being declared, described,
 * and offered in the form. It is kept on `currentConfig` because that is what a
 * failed tuning relaunch puts back: without it the restore would bring the
 * daemon up untuned and call that "the previous configuration".
 *
 * @param {{port?: number, model?: string, tuning?: object, waitMs?: number, onProgress?: (line: string) => void}} options
 */
export async function startMtplxServer(options = {}) {
  const { port = DEFAULT_PORT, model: requestedModel = null, tuning = null, waitMs, onProgress = () => {} } = options;
  const normalizedTuning = normalizeTuning('mtplx', tuning);
  const emit = (line) => { appendLog(line); onProgress(line); };

  const binaryPath = resolveMtplxBinary();
  if (!binaryPath) {
    throw new ServerError(
      'The `mtplx` binary was not found on PATH. Install it from this card (Homebrew tap, or pip as a fallback), then try again.',
      { status: 400, code: 'MTPLX_NOT_INSTALLED' }
    );
  }

  // A start never performs a large silent download — the same limit that keeps
  // it off model weights. Launching the wrapper before its venv exists would
  // hand PM2 a process whose first act is a pip install, judged (and killed) by
  // an eight-second startup window and reported as a crashed daemon.
  if (!(await describeMtplxRuntime(binaryPath)).ready) {
    throw new ServerError(MTPLX_RUNTIME_NOT_BOOTSTRAPPED_ERROR, { status: 400, code: 'MTPLX_RUNTIME_NOT_BOOTSTRAPPED' });
  }

  const pm2Status = await getAppStatusStrict(MTPLX_APP);
  if (pm2Status && pm2Status.status === 'online') {
    throw new ServerError(`MTPLX is already running with PID ${pm2Status.pid}`, { status: 409 });
  }

  const endpoint = `http://${DEFAULT_HOST}:${port}/v1`;
  if (await probeEndpoint(endpoint)) {
    throw new ServerError(`Port ${port} is already in use by an active server at ${endpoint}`, { status: 409 });
  }
  if (await isPortInUse(port)) {
    throw new ServerError(
      `Port ${port} is already in use on ${DEFAULT_HOST}. Point MTPLX at a different port before starting it.`,
      { status: 409, code: 'MTPLX_PORT_IN_USE' }
    );
  }

  daemon.resetLogs();
  lastExitError = null;

  const resolved = await resolveStartModel(requestedModel, emit);
  if (resolved.error) throw new ServerError(resolved.error, { status: 400, code: 'MTPLX_NO_CACHED_MODEL' });
  const model = resolved.model;
  if (model) emit(`Serving the cached MTPLX model ${model}.`);

  // `mtplx start` is interactive (it prompts for a model); `serve` is the
  // API-only server, which is the half PortOS talks to. The daemon must bind
  // where the PROVIDER points — a user who moved MTPLX to 8010 would otherwise
  // get a second server on 8000 that nothing talks to.
  const tuningArgs = launchArgs('mtplx', normalizedTuning);
  const args = ['serve', '--port', String(port), ...(model ? ['--model', model] : []), ...tuningArgs];
  currentConfig = { port, model, tuning: normalizedTuning };
  appendLog(`Starting: mtplx ${args.join(' ')}`);

  // Delete any stale PM2 entry so our own previous instance doesn't count as a collision.
  await execPm2(['delete', MTPLX_APP]).catch(() => {});
  clearJlistCache();

  console.log(`🚄 MTPLX starting on ${DEFAULT_HOST}:${port}${model ? ` (model ${model})` : ' (MTPLX default model)'}${tuningArgs.length ? ` with ${tuningArgs.join(' ')}` : ''}`);
  const logsReset = await resetMtplxLogs();
  await execPm2([
    'start', binaryPath,
    '--name', MTPLX_APP,
    '--interpreter', 'none',
    '--no-autorestart',
    '--output', mtplxLogFiles.stdout,
    '--error', mtplxLogFiles.stderr,
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
    currentProc = await getAppStatusStrict(MTPLX_APP);
    if (currentProc && ['errored', 'stopped', 'not_found'].includes(currentProc.status)) break;
    online = await probeEndpoint(endpoint);
    if (online) break;
  }

  if (currentProc && ['errored', 'stopped', 'not_found'].includes(currentProc.status)) {
    const pm2Logs = await execPm2(['logs', MTPLX_APP, '--nostream', '--lines', '15']).catch(() => null);
    const lines = `${pm2Logs?.stderr || pm2Logs?.stdout || ''}`.split('\n').map((l) => l.trimEnd()).filter(Boolean);
    const currentLines = logsReset ? lines : [];
    for (const line of currentLines) appendLog(line);
    const tail = (currentLines.length ? currentLines : daemon.snapshotLogs()).slice(-4).join(' | ');
    lastExitError = `PM2 status: ${currentProc.status}`;
    const message = logsReset && isMtplxRuntimeBootstrapFailure(currentLines.join('\n'))
      ? `${MTPLX_RUNTIME_BOOTSTRAP_ERROR}${tail ? ` Last output: ${tail}` : ''}`
      : `MTPLX exited immediately (${lastExitError}).${tail ? ` Last output: ${tail}` : ''}`;

    await execPm2(['delete', MTPLX_APP]).catch(() => {});
    clearJlistCache();
    currentConfig = null;
    throw new ServerError(
      message,
      { status: 500, code: 'MTPLX_EXITED' }
    );
  }

  const finalProc = await getAppStatusStrict(MTPLX_APP);
  return {
    success: true,
    running: true,
    managed: true,
    pid: finalProc?.pid || null,
    endpoint,
    online,
    config: currentConfig,
  };
}

/** Stop the managed MTPLX process. */
export async function stopMtplxServer() {
  const pm2Status = await getAppStatusStrict(MTPLX_APP);
  const isManaged = Boolean(pm2Status && pm2Status.status === 'online');

  if (!isManaged) {
    const endpoint = endpointFor(currentConfig);
    if (await probeEndpoint(endpoint)) {
      return {
        success: false,
        message: `An external process is listening on ${endpoint}. It was not started by PortOS and cannot be stopped here.`,
      };
    }
    return { success: true, message: 'MTPLX is not running' };
  }

  appendLog(`Stopping ${MTPLX_APP}`);
  await execPm2(['delete', MTPLX_APP]).catch((err) => {
    throw new ServerError(`Failed to stop MTPLX: ${err.message}`, { status: 500 });
  });
  clearJlistCache();
  currentConfig = null;
  return { success: true, message: 'MTPLX stopped' };
}

/**
 * Relaunch `mtplx serve` with a different tuning, keeping the checkpoint and
 * port it is already serving.
 *
 * This is MTPLX's half of the measured-assessment feature: a sweep across MTP
 * depths or KV-quantization modes is only possible if something can put those
 * flags on the launch line between runs. It returns the same result shape as
 * `llamaServerManager.relaunchLlamaServerWithTuning`, because the assessment
 * runner treats every runtime's applier identically.
 *
 * **It is NOT a line-for-line copy of that function, and syncing the two from
 * this comment would reintroduce bugs.** Two deliberate divergences:
 *   - llama MERGES the request onto the flags already set (`{...previous,
 *     ...tuning}`); this REPLACES them, so the launch line is exactly the knob
 *     set the record is labelled with. See the note at the merge point below.
 *   - llama returns as soon as the restore's `startLlamaServer` returns; this
 *     waits for the restored daemon to actually answer. See `restorePrevious`.
 *
 * It refuses rather than guesses in the four cases where it cannot know what to
 * relaunch, or must not:
 *   - nothing is running, so there is no checkpoint to reuse;
 *   - PM2 could not be read, so PortOS cannot prove it owns the process;
 *   - something IS listening but PortOS did not start it, so stopping it would
 *     kill a process the user owns;
 *   - the launch line names no `--model`, so the running server is on MTPLX's
 *     own hard-coded default. Restarting with `model: null` sends the request
 *     back through `resolveStartModel`, which now picks from the cache — a
 *     DIFFERENT checkpoint from the one being measured, filed under the model
 *     id of the one that was.
 *
 * Every one of those returns `{ applied: false, reason }` instead of throwing:
 * the caller can still measure whatever is actually serving and record that the
 * tuning was NOT applied, which is far more useful than failing the whole run.
 *
 * The restore path is not optional. A tuning sweep EXPECTS launch lines that do
 * not work — a `--context-window` past what unified memory holds, a `--depth`
 * the checkpoint's MTP sidecar will not draft. `mtplx serve` exits before it
 * binds and `startMtplxServer` throws; leaving the daemon down would break the
 * whole install's `mtplx` provider, not just the measurement. So the previous
 * configuration goes back up before the failure is reported.
 *
 * @param {object} tuning launch knobs from `lib/localModelTuning.js`
 * @returns {Promise<{applied: boolean, reason: string|null, config: object|null}>}
 */
export async function relaunchMtplxServerWithTuning(tuning = {}) {
  const normalized = normalizeTuning('mtplx', tuning);
  const knobs = Object.entries(normalized);
  if (knobs.length === 0) {
    return { applied: false, reason: 'no launch knobs were requested', config: currentConfig };
  }
  // Gated on the RENDERED flags, not the knob count: a knob can normalize to a
  // value that renders nothing (a boolean set to false — a CLI has no spelling
  // for "explicitly off"). Relaunching on that would run daemon defaults while
  // the caller records `tuningApplied: true`, which is the un-applied-but-claimed
  // reading this whole path exists to prevent.
  if (launchArgs('mtplx', normalized).length === 0) {
    return { applied: false, reason: 'that tuning renders no `mtplx serve` flag, so there is nothing to relaunch with', config: currentConfig };
  }

  const status = await getMtplxServerStatus();
  if (!status.running) {
    return { applied: false, reason: 'MTPLX is not running, so PortOS has no checkpoint to relaunch with', config: null };
  }
  // `null` is "PM2 could not be read", NOT "someone else started it". Collapsing
  // the two would tell a user their own managed daemon is external — a
  // misdiagnosis that points them at the wrong fix. Refusing is still right:
  // PortOS must not stop a process it cannot prove it owns.
  if (status.managed === null) {
    return {
      applied: false,
      reason: 'PortOS could not read PM2, so it cannot tell whether it owns this MTPLX server',
      config: status.config || null,
    };
  }
  if (!status.managed) {
    return {
      applied: false,
      reason: 'MTPLX was started outside PortOS — start it from the LLMs page to let PortOS apply tuning',
      config: status.config || null,
    };
  }
  if (!status.config?.model) {
    return {
      applied: false,
      reason: 'MTPLX is serving its own default checkpoint, which PortOS cannot name — restart it on a chosen checkpoint from the LLMs page to let PortOS apply tuning',
      config: status.config || null,
    };
  }

  const previous = status.config;
  // REPLACES the tuning on the launch line rather than merging onto it, so the
  // flags `mtplx serve` runs with are exactly the knob set the caller named —
  // and the assessment's `tuningKey`/`tuningLabel`, which describe only that
  // set, describe the whole configuration. Merging would leave the second run
  // of a sweep carrying the first run's flags while labelled with only its own,
  // which makes `compareTunings` rank two readings that were not what they say.
  // Replacing is exact here because an absent `mtplx serve` flag IS the daemon
  // default — the same sentinel contract `lib/localModelTuning.js` documents.
  const next = { ...previous, tuning: normalized };
  const port = next.port ?? DEFAULT_PORT;
  console.log(`🚄 MTPLX: relaunching to apply tuning (${knobs.map(([k, v]) => `${k}=${v}`).join(', ')})`);

  await stopMtplxServer();
  await waitForPortRelease(port);

  const started = await startMtplxServer(next).catch((err) => ({ failure: err }));
  if (started.failure) {
    const reason = launchFailureReason(started.failure);
    console.error(`❌ MTPLX: tuning launch failed (${started.failure.message}) — restoring the previous configuration`);
    return { applied: false, reason, config: await restorePrevious(previous, reason) };
  }

  // `startMtplxServer` returning is not the same as the endpoint answering — it
  // waits only long enough to catch a server that dies immediately, and a cold
  // MLX checkpoint takes far longer than that to load. So `online: false` here
  // is "not ready YET", not "wedged"; give it the real readiness budget first.
  const ready = started.online ? { ready: true, reason: null } : await waitForRelaunchedEndpoint(started.endpoint);
  if (ready.ready) return { applied: true, reason: null, config: started.config };

  // Treat it exactly like a rejected launch line: put the previous configuration
  // back, so the install's mtplx provider is not left pointing at a process that
  // never serves. Without this the caller would go on to measure a dead endpoint
  // and record the timeouts as evidence for this tuning.
  console.error(`❌ MTPLX: ${ready.reason} — restoring the previous configuration`);
  await stopMtplxServer().catch(() => {});
  return { applied: false, reason: ready.reason, config: await restorePrevious(previous, ready.reason) };
}

/**
 * Why the tuned launch failed, in the caller's words.
 *
 * "MTPLX rejected that tuning" is only true when `mtplx serve` actually ran and
 * exited. `startMtplxServer` also throws from guards that fire BEFORE the
 * process starts — most realistically the port still being held by the daemon
 * that was just stopped — and reporting those as a rejected tuning sends the
 * user looking for a bad flag that was never even passed.
 */
const launchFailureReason = (err) => (err?.code === 'MTPLX_EXITED'
  ? `MTPLX rejected that tuning: ${err.message}`
  : `PortOS could not start MTPLX with that tuning: ${err?.message || 'relaunch failed'}`);

/**
 * Put the configuration MTPLX was serving before back up, and WAIT for it.
 *
 * Returning as soon as `startMtplxServer` does would hand back a config the
 * daemon is still minutes from honouring — and the caller goes straight on to
 * measure, so every sample times out and a junk `does-not-fit` record is stored
 * against the model. That record then counts as "assessed", dropping the model
 * out of the unassessed list and the sweep's `unmeasured` scope for good.
 *
 * `null` when it could not be brought back at all, which is the honest answer:
 * the caller reports the tuning as not applied either way, and a config here
 * would claim a daemon that is not running.
 */
async function restorePrevious(previous, failure) {
  await waitForPortRelease(previous.port ?? DEFAULT_PORT);
  const restored = await startMtplxServer(previous).catch((err) => {
    console.error(`❌ MTPLX: could not restore the previous configuration: ${err.message}`);
    return null;
  });
  // `startMtplxServer` clears the log buffer and `lastExitError` for the server
  // it is about to launch — correct in general, but here it would erase the ONLY
  // trace of why the tuning failed. The card would then show a healthy daemon
  // with empty logs, and the reason would survive only inside the assessment
  // record. Put the failure back so the LLMs page can still explain it.
  if (failure) {
    lastExitError = failure;
    appendLog(`Tuning launch failed (${failure}) — restored the previous configuration.`);
  }
  if (!restored) return null;
  if (restored.online) return restored.config;
  const back = await waitForRelaunchedEndpoint(restored.endpoint);
  if (back.ready) return restored.config;
  console.error(`❌ MTPLX: the restored configuration ${back.reason}`);
  return null;
}

/** Clears in-memory state (used by test suites). */
export function _resetMtplxServerStateForTests({
  startupWait,
  startupPoll,
  portRelease,
  relaunchReadyTimeout,
  relaunchPoll,
  idleMinutes = 0,
  logFiles,
} = {}) {
  idleMinutesOverride = idleMinutes;
  mtplxLogFiles = logFiles ? {
    stdout: logFiles.stdout || DEFAULT_MTPLX_LOG_FILES.stdout,
    stderr: logFiles.stderr || DEFAULT_MTPLX_LOG_FILES.stderr,
  } : DEFAULT_MTPLX_LOG_FILES;
  currentConfig = null;
  daemon.resetLogs();
  lastExitError = null;
  // Restored to the production budget unless a suite asks for a shorter one.
  startupWaitMs = Number.isFinite(startupWait) ? startupWait : 8_000;
  startupPollMs = Number.isFinite(startupPoll) ? startupPoll : 1500;
  portReleaseTimeoutMs = Number.isFinite(portRelease) ? portRelease : 30_000;
  relaunchReadyTimeoutMs = Number.isFinite(relaunchReadyTimeout) ? relaunchReadyTimeout : 300_000;
  relaunchPollMs = Number.isFinite(relaunchPoll) ? relaunchPoll : 1000;
}

// =============================================================================
// IDLE STOP + LAZY START
// =============================================================================

/**
 * Why MTPLX is stopped on idle while llama-server is not.
 *
 * MTPLX holds its whole MLX checkpoint — 20GB is ordinary — for as long as the
 * process is up, and it has no way to put that down in place: its
 * `--retrieval-idle-timeout` unloads RETRIEVAL models (embedding/rerank) only,
 * never the main checkpoint, and `mtplx settings set` covers live tunables like
 * depth, not residency. Stopping the process is therefore the only lever, and
 * lazy-start is what makes stopping it safe to do automatically.
 *
 * `llamaServerManager` deliberately takes the other path (`--sleep-idle-seconds`),
 * because llama.cpp CAN unload in place — see `supportsSleepIdle` there.
 */

/**
 * The configured idle window for MTPLX, in minutes. `0`/absent = never stop,
 * which is what every install did before this setting existed, so an upgrade
 * changes nothing until the user opts in.
 */
const readSettings = () => import('./settings.js').then((m) => m.getSettings()).catch(() => null);
// See `configuredIdleMinutes`. Only `_resetMtplxServerStateForTests` writes it.
let idleMinutesOverride = null;

async function configuredIdleMinutes() {
  // Test seam, same reason as `llamaServerManager`'s: a suite must not depend on
  // whether this developer has an idle window configured. `null` reads settings.
  if (idleMinutesOverride !== null) return idleMinutesOverride;
  const settings = await readSettings();
  const raw = Number(settings?.localLlm?.mtplx?.idleMinutes);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

// Registered at module load so the reaper knows about MTPLX regardless of which
// call path touches this module first. Registration itself starts nothing and
// reads no settings — the window is resolved per sweep, inside `getIdleMs`.
registerIdleDaemon({
  name: MTPLX_APP,
  getIdleMs: async () => idleWindowMs(await configuredIdleMinutes()),
  stop: () => stopMtplxServer(),
});

/**
 * The checkpoint/port the user last saved on the MTPLX card, for a lazy start to
 * replay. Empty when nothing was saved — `startMtplxServer` then resolves a
 * cached checkpoint itself, which is what the old Start button did.
 */
async function savedLaunchConfig() {
  const settings = await readSettings();
  const launch = settings?.localLlm?.mtplx?.launch;
  return {
    model: typeof launch?.model === 'string' && launch.model.trim() ? launch.model.trim() : null,
    port: Number.isFinite(Number(launch?.port)) ? Number(launch.port) : null,
  };
}

/** Record real MTPLX traffic. Never call this from a status poll — see `markDaemonUsed`. */
export const markMtplxUsed = () => markDaemonUsed(MTPLX_APP);

/**
 * Bring MTPLX up if the idle reaper (or the user) stopped it, and mark it used
 * either way.
 *
 * A no-op when it is already online — the overwhelmingly common case, and it
 * must stay cheap enough to sit in front of every request. The one PM2 status
 * read it costs is the same read `getMtplxServerStatus` already does on a poll.
 *
 * The relaunch reuses the config recovered from PM2's argv when PortOS still
 * holds one, so the daemon comes back on exactly the checkpoint, port, and
 * tuning the user last launched it with. `startMtplxServer` resolves a cached
 * checkpoint on its own when there is no such record (a fresh PortOS whose
 * reaper stopped a server it never started), which is the same fallback the
 * Start button used to take.
 *
 * Resolves `{ ready, reason }` rather than throwing: a caller in front of an
 * inference request wants to report "MTPLX could not be started" alongside its
 * own error, not have a lazy start unwind its stack.
 *
 * @returns {Promise<{ready: boolean, reason: string|null}>}
 */
export async function ensureMtplxRunning() {
  markMtplxUsed();

  const pm2Status = await getAppStatusStrict(MTPLX_APP);
  if (pm2Status?.status === 'online') return { ready: true, reason: null };

  // Resolve the launch line BEFORE probing, so the probe below asks about the
  // port this start would actually bind. Precedence: the config recovered from
  // the last live process (it carries the tuning an assessment relaunch applied,
  // which settings never see), then the launch options the user saved on the
  // MTPLX card, then MTPLX's own cache pick. Reversing the first two would let a
  // stale saved port fight a daemon PortOS is already tracking on another one.
  const saved = await savedLaunchConfig();
  const config = {
    port: currentConfig?.port ?? saved.port ?? DEFAULT_PORT,
    model: currentConfig?.model ?? saved.model ?? null,
    tuning: currentConfig?.tuning ?? null,
  };

  // Something else is already serving that port — an MTPLX the user started
  // outside PortOS, or another daemon entirely. Either way this is not ours to
  // start, and probing beats racing `startMtplxServer` into a port conflict.
  // Probing `endpointFor(currentConfig)` instead would ask about the DEFAULT
  // port whenever PortOS restarted while MTPLX was stopped, which is exactly
  // when the saved port is the only record of where it belongs.
  const endpoint = endpointFor(config);
  if (await probeEndpoint(endpoint)) return { ready: true, reason: null };

  console.log(`🚄 MTPLX is stopped — starting it for an incoming request`);
  const started = await startMtplxServer(config).catch((err) => ({ error: err }));

  if (started.error) return { ready: false, reason: started.error.message };
  // `startMtplxServer` returns as soon as it knows the process did not die on
  // the spot; a multi-gigabyte MLX checkpoint routinely outlasts that window, so
  // the caller's request has to wait for the real readiness signal.
  if (started.online) return { ready: true, reason: null };
  return waitForRelaunchedEndpoint(started.endpoint ?? endpoint);
}

/**
 * Is this provider served by the MTPLX daemon PortOS manages?
 *
 * Mirrors `ollamaManager.isOllamaProvider` so `services/aiProvider.js` gates both
 * local daemons the same way. Only a LOCAL endpoint counts: an MTPLX on a
 * tailnet peer is someone else's process, and neither starting nor idle-stopping
 * it is this install's business.
 */
export function isMtplxProvider(provider) {
  // API providers reach MTPLX directly, while OpenCode TUI providers carry
  // the same local endpoint and need the exact same lazy wake-up before the
  // TUI is spawned.
  if (!provider || !['api', 'tui'].includes(provider.type)) return false;
  if (!isLocalInstanceEndpoint(provider.endpoint)) return false;
  // `localRuntimeKind`, not `localBackendForProvider` — the latter only ever
  // answers 'ollama'/'lmstudio' (it maps those two catalog ports), so it reports
  // every MTPLX provider as having no local backend at all. The authoritative
  // signal is the `mtplxBacked` marker the spawner itself keys on.
  if (localRuntimeKind(provider) === 'mtplx') return true;
  // ...and an endpoint-only provider aimed at the port THIS daemon is serving.
  // Deliberately compared against the live launch config rather than treating
  // :8000 as "must be MTPLX" — 8000 is a generic port, and claiming any local
  // server on it would lazily start MTPLX for someone else's API.
  const managedPort = currentConfig?.port;
  return Boolean(managedPort) && localEndpointPort(provider.endpoint) === managedPort;
}

/**
 * The `ensureProviderReady` shape `services/aiProvider.js` expects, for MTPLX.
 *
 * This is the one call site that both refreshes the idle clock and lazily
 * restarts — deliberately on the INFERENCE path rather than in
 * `getMtplxServerEndpoint`, which status polls call every few seconds and which
 * would therefore keep a 20GB checkpoint resident for a UI nobody is watching.
 */
export async function ensureMtplxProviderReady(provider) {
  if (!isMtplxProvider(provider)) return { success: true };
  const { ready, reason } = await ensureMtplxRunning();
  return ready ? { success: true } : { success: false, error: reason };
}
