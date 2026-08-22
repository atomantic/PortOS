/**
 * llama-server process manager
 *
 * Provides lifecycle management (status probe, start, stop, recent logs)
 * for a local `llama-server` instance running speculative decoding (e.g. DFlash 2)
 * managed as an optional PM2 process (`portos-llama-server`).
 */

import { stat } from 'fs/promises';
import { spawn } from '../lib/childProcess.js';
import { commandExists } from '../lib/commandExists.js';
import { findCommandOnPath, safeChildProcessEnv, safeChildProcessOptions } from '../lib/processEnv.js';
import { expandHome, sleep } from '../lib/fileUtils.js';
import { createDaemonLogBuffer, pm2ArgValue } from '../lib/managedDaemon.js';
import { resolveSpecModelPath } from './specDecodeModels.js';
import { parseSpecTypes, isDraftSpecType } from '../lib/specDecodePresets.js';
import { probeOpenAiModels } from '../lib/openAiModelsProbe.js';
import { isPortInUse } from '../lib/platform.js';
import { PORTS } from '../lib/ports.js';
import { tuningSpecsFor } from '../lib/localModelTuning.js';
import { ServerError } from '../lib/errorHandler.js';
import { execPm2, getAppStatusStrict, clearJlistCache, getSavedProcessNames } from './pm2.js';

export const LLAMA_APP = 'portos-llama-server';

const PROBE_TIMEOUT_MS = 1500;
const STARTUP_WAIT_TIMEOUT_MS = 4000;
// How long a relaunch waits for the kernel to release the old listener.
const PORT_RELEASE_TIMEOUT_MS = 5000;
// How long a relaunch waits for the new process to answer. `startLlamaServer`
// polls for only STARTUP_WAIT_TIMEOUT_MS, which a large GGUF routinely exceeds
// while loading — so a relaunch must not read "not ready yet" as "wedged".
// Mutable only through the test seam below: a suite asserting the give-up path
// cannot sit through two real minutes of polling.
let relaunchReadyTimeoutMs = 120000;
// How many times a path that would REFUSE on an unreadable PM2 re-reads it
// first. See `readLlamaServerStatusRetrying`.
const PM2_READ_RETRIES = 2;
// Mutable only through the test seam below, for the same reason as the readiness
// budget above.
const PM2_READ_RETRY_DELAY_MS = 250;
let pm2ReadRetryDelayMs = PM2_READ_RETRY_DELAY_MS;

let currentConfig = null;
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
let preTuningConfig = null;
let lastExitError = null;
const logs = createDaemonLogBuffer();
const appendLog = logs.append;

/**
 * Probes whether an OpenAI-compatible endpoint responds at the given host/port.
 * Shares one implementation with the readiness checklist.
 */
const probeEndpoint = async (endpoint) =>
  (await probeOpenAiModels(endpoint, { timeoutMs: PROBE_TIMEOUT_MS })).reachable;

/**
 * Resolves the `llama-server` executable on the child-process PATH.
 *
 * Deliberately a filesystem probe only — `findCommandOnPath` already requires a
 * regular file carrying the execute bit, which is all "is it installed?" means.
 * Do NOT re-add a `commandExists`-style `llama-server --version` probe on top.
 *
 * @returns {string|null} absolute path, or null when it is not on PATH
 */
function resolveLlamaServerBinary() {
  return findCommandOnPath('llama-server');
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
    draftMax: getArg('--spec-draft-n-max') !== null
      ? Number(getArg('--spec-draft-n-max'))
      : (getArg('--draft-max') !== null ? Number(getArg('--draft-max')) : null),
  };
}

// The endpoint the current (or last-known) configuration serves on. Split out so
// the two callers below can't drift on how host/port are defaulted.
const endpointFor = (config) =>
  `http://${config?.host || '127.0.0.1'}:${config?.port ?? PORTS.LLAMA_SERVER}/v1`;

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
  if (!currentConfig) await readLlamaServerLaunch();
  return endpointFor(currentConfig);
}

/**
 * Returns current status of llama-server (binary availability, running state, config, logs).
 */
export async function getLlamaServerStatus() {
  const binaryPath = resolveLlamaServerBinary();
  const installed = Boolean(binaryPath);

  const [pm2Status, savedApps] = await Promise.all([getAppStatusStrict(LLAMA_APP), getSavedProcessNames()]);
  const isReadFailed = pm2Status === null;
  const isManagedActive = Boolean(pm2Status && pm2Status.status === 'online');

  if (!currentConfig && isManagedActive && pm2Status?.args) {
    currentConfig = parseConfigFromArgs(pm2Status.args);
  }

  const host = currentConfig?.host || '127.0.0.1';
  const port = currentConfig?.port ?? PORTS.LLAMA_SERVER;
  const endpoint = endpointFor(currentConfig);

  const reachable = await probeEndpoint(endpoint);

  const pm2Logs = isManagedActive || (pm2Status && pm2Status.status !== 'not_found')
    ? await execPm2(['logs', LLAMA_APP, '--nostream', '--lines', String(logs.maxLines)]).catch(() => null)
    : null;

  return {
    installed,
    running: isManagedActive || reachable,
    managed: isReadFailed ? null : isManagedActive,
    pid: isManagedActive ? (pm2Status?.pid || null) : null,
    host,
    port,
    endpoint,
    // NOT nulled on a failed read. `currentConfig` is the launch line PortOS
    // itself last started this daemon on, and a subprocess hiccup reading PM2 is
    // no evidence it stopped serving it. Nulling it here collapsed `managed:
    // null` ("could not tell") straight back into `managed: false` ("somebody
    // else's daemon") for every caller guarding on `!managed || !config?.model`
    // — defeating, one line later, the entire point of the null sentinel.
    config: isManagedActive || isReadFailed ? currentConfig : null,
    // Is this PM2 app in the saved dump `pm2 resurrect` replays at boot?
    // `null` = the dump could not be read, which is not the same as "no".
    runAtStartup: savedApps === null ? null : savedApps.includes(LLAMA_APP),
    recentLogs: logs.withPm2Logs(`${pm2Logs?.stdout || ''}\n${pm2Logs?.stderr || ''}`),
    lastExitError: isReadFailed ? 'Failed to read PM2 status' : lastExitError,
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
async function readLlamaServerStatusRetrying() {
  let status = await getLlamaServerStatus();
  for (let attempt = 0; status.managed === null && attempt < PM2_READ_RETRIES; attempt += 1) {
    await sleep(pm2ReadRetryDelayMs);
    status = await getLlamaServerStatus();
  }
  return status;
}

/**
 * Starts llama-server with the specified model and options under PM2.
 */
export async function startLlamaServer(options = {}) {
  const binaryPath = resolveLlamaServerBinary();
  if (!binaryPath) {
    throw new ServerError(
      'llama-server binary was not found on PATH. Install it via Homebrew (`brew install llama.cpp`) or build from source.',
      { status: 400 }
    );
  }

  const pm2Status = await getAppStatusStrict(LLAMA_APP);
  if (pm2Status && pm2Status.status === 'online') {
    throw new ServerError(`llama-server is already running with PID ${pm2Status.pid}`, { status: 409 });
  }

  const {
    model,
    draftModel,
    specType = 'draft-dflash',
    port = PORTS.LLAMA_SERVER,
    host = '127.0.0.1',
    ctxSize = 32768,
    nGpuLayers = 99,
    alias = 'dflash',
    parallel = 1,
    // Tuning knobs (`lib/localModelTuning.js`). Every one defaults to `null` =
    // NOT SET: the flag is left off the launch line entirely so llama.cpp
    // applies its own default. Substituting a number here would silently pin a
    // value the user never chose and make two "default" runs incomparable.
    batchSize = null,
    ubatchSize = null,
    threads = null,
    flashAttn = false,
    cacheTypeK = null,
    cacheTypeV = null,
    draftMax = null,
  } = options;

  if (!model || typeof model !== 'string') {
    throw new ServerError('model path is required to start llama-server', { status: 400 });
  }

  const endpoint = `http://${host}:${port}/v1`;
  const reachable = await probeEndpoint(endpoint);
  if (reachable) {
    throw new ServerError(`Port ${port} is already in use by an active server at ${endpoint}`, { status: 409 });
  }
  if (await isPortInUse(port)) {
    throw new ServerError(
      `Port ${port} is already in use on ${host}. Choose a different port under Advanced options before starting llama-server.`,
      { status: 409, code: 'LLAMA_SERVER_PORT_IN_USE' }
    );
  }

  // Validate the weights before building the launch line
  await assertModelFileExists('The base model', model.trim());
  const configuredDraftPath = typeof draftModel === 'string' && draftModel.trim()
    ? draftModel.trim()
    : null;

  // `--spec-type` is a comma-separated LIST, and only its `draft-*` entries want
  // a drafter GGUF — every `ngram-*` implementation speculates off the tokens
  // already in the context window. Emitting the flag only alongside a drafter
  // therefore threw away perfectly valid drafter-free launches
  // (`--spec-type ngram-map-k`) and silently ignored the ngram half of a mixed
  // one (`draft-dflash,ngram-map-k`).
  //
  // The two halves are resolved against each other, because the launcher card
  // seeds BOTH fields from a preset: switching Spec Type to an `ngram-*` leaves
  // the preset's drafter path sitting in the form, and passing that as
  // `--model-draft` would load weights the run can't use — or fail the
  // existence check below on a preset GGUF that was never downloaded. So a
  // drafter is only carried when some requested type actually drafts with one,
  // and drafter-based types are dropped (with a log line) when no drafter is
  // set, which keeps the card's documented "clear the field to run without it"
  // working. An EMPTY spec type deliberately still counts as wanting the
  // drafter: llama.cpp speculates off a bare `--model-draft`, so dropping it
  // there would silently disable a working configuration.
  const requestedSpecTypes = parseSpecTypes(specType);
  const drafterInUse = requestedSpecTypes.length === 0 || requestedSpecTypes.some(isDraftSpecType);
  const draftPath = drafterInUse ? configuredDraftPath : null;
  const effectiveSpecTypes = draftPath
    ? requestedSpecTypes
    : requestedSpecTypes.filter((type) => !isDraftSpecType(type));
  const droppedSpecTypes = requestedSpecTypes.filter((type) => !effectiveSpecTypes.includes(type));

  if (draftPath) await assertModelFileExists('The drafter model', draftPath);

  const args = ['-m', expandHome(model.trim())];
  if (draftPath) args.push('--model-draft', expandHome(draftPath));
  if (effectiveSpecTypes.length > 0) args.push('--spec-type', effectiveSpecTypes.join(','));
  if (port) args.push('--port', String(port));
  if (host) args.push('--host', host);
  if (ctxSize) args.push('--ctx-size', String(ctxSize));
  if (nGpuLayers !== undefined && nGpuLayers !== null) args.push('-ngl', String(nGpuLayers));
  // Always on the line — leaving it off reverts to llama.cpp's multi-slot
  // default, which is the VRAM tax this pin exists to avoid. `null` from a
  // recovered pre-flag launch still means 1, not "daemon default".
  const parallelSlots = Number.isFinite(parallel) && parallel >= 1 ? parallel : 1;
  args.push('--parallel', String(parallelSlots));
  if (Number.isFinite(batchSize)) args.push('-b', String(batchSize));
  if (Number.isFinite(ubatchSize)) args.push('-ub', String(ubatchSize));
  if (Number.isFinite(threads)) args.push('-t', String(threads));
  if (flashAttn) args.push('--flash-attn');
  if (cacheTypeK) args.push('--cache-type-k', String(cacheTypeK));
  if (cacheTypeV) args.push('--cache-type-v', String(cacheTypeV));
  // Only meaningful alongside a drafter — passing it without one makes
  // llama-server reject the launch line outright.
  if (Number.isFinite(draftMax) && draftPath) args.push('--spec-draft-n-max', String(draftMax));
  if (alias) args.push('--alias', alias);

  lastExitError = null;
  logs.reset();
  if (droppedSpecTypes.length > 0) {
    appendLog(`Ignoring spec-type ${droppedSpecTypes.join(',')} — no drafter model is set`);
    console.log(`🦙 llama-server dropping drafter-based spec types ${droppedSpecTypes.join(',')} (no --model-draft configured)`);
  }
  if (configuredDraftPath && !draftPath) {
    appendLog(`Ignoring drafter ${configuredDraftPath} — no requested spec type uses one`);
    console.log(`🦙 llama-server ignoring drafter ${configuredDraftPath} (spec types ${effectiveSpecTypes.join(',') || 'none'} need no drafter)`);
  }
  appendLog(`Starting: llama-server ${args.join(' ')}`);

  // A fresh launch line supersedes any baseline: whatever PortOS tuned is gone
  // with the process it tuned, and restoring the old daemon's configuration over
  // this one would undo a start the user just asked for. A relaunch re-arms this
  // AFTER the start returns, from the baseline it captured itself.
  preTuningConfig = null;
  currentConfig = {
    model,
    // The drafter actually on the launch line, so the status card reports what
    // is running rather than what the form happened to be holding.
    draftModel: draftPath,
    // The types actually on the launch line, so the status card reports what is
    // running rather than what was asked for.
    specType: effectiveSpecTypes.join(','),
    port,
    host,
    ctxSize,
    nGpuLayers,
    alias,
    parallel: parallelSlots,
    batchSize,
    ubatchSize,
    threads,
    flashAttn,
    cacheTypeK,
    cacheTypeV,
    draftMax,
  };

  // Delete stale PM2 entry so our own previous instance doesn't count as a collision
  await execPm2(['delete', LLAMA_APP]).catch(() => {});
  clearJlistCache();

  console.log(`🦙 llama-server starting on ${host}:${port} (model ${model}${draftPath ? `, drafter ${draftPath}` : ''})`);
  await execPm2([
    'start', binaryPath,
    '--name', LLAMA_APP,
    '--interpreter', 'none',
    '--no-autorestart',
    '--',
    ...args,
  ]);
  clearJlistCache();

  // Wait a short beat and verify probe
  const startTime = Date.now();
  let online = false;
  let currentProc = null;
  while (Date.now() - startTime < STARTUP_WAIT_TIMEOUT_MS) {
    await sleep(500);
    clearJlistCache();
    currentProc = await getAppStatusStrict(LLAMA_APP);
    if (currentProc && (currentProc.status === 'errored' || currentProc.status === 'stopped' || currentProc.status === 'not_found')) {
      break;
    }
    online = await probeEndpoint(endpoint);
    if (online) break;
  }

  if (currentProc && (currentProc.status === 'errored' || currentProc.status === 'stopped' || currentProc.status === 'not_found')) {
    const exitLogs = await execPm2(['logs', LLAMA_APP, '--nostream', '--lines', '15']).catch(() => null);
    const lines = (exitLogs?.stderr || exitLogs?.stdout || '').trim().split('\n').map((l) => l.trimEnd()).filter(Boolean);
    for (const line of lines) appendLog(line);
    const tail = (lines.length ? lines : logs.snapshot()).slice(-4).join(' | ');

    lastExitError = `PM2 status: ${currentProc.status}`;

    await execPm2(['delete', LLAMA_APP]).catch(() => {});
    clearJlistCache();
    throw new ServerError(
      `llama-server exited immediately${lastExitError ? ` (${lastExitError})` : ''}.${tail ? ` Last output: ${tail}` : ''}`,
      { status: 500, code: 'LLAMA_SERVER_EXITED' }
    );
  }

  const finalProc = await getAppStatusStrict(LLAMA_APP);

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

/**
 * Stops the managed llama-server process.
 */
export async function stopLlamaServer() {
  const pm2Status = await getAppStatusStrict(LLAMA_APP);
  const isManaged = Boolean(pm2Status && pm2Status.status === 'online');

  if (!isManaged) {
    const host = currentConfig?.host || '127.0.0.1';
    const port = currentConfig?.port ?? PORTS.LLAMA_SERVER;
    const endpoint = `http://${host}:${port}/v1`;
    const reachable = await probeEndpoint(endpoint);
    if (reachable) {
      return {
        success: false,
        message: `An external process is listening on ${endpoint}. It was not started by PortOS and cannot be stopped here.`,
      };
    }
    return { success: true, message: 'llama-server is not running' };
  }

  appendLog(`Stopping ${LLAMA_APP}`);
  try {
    await execPm2(['delete', LLAMA_APP]);
    clearJlistCache();
  } catch (err) {
    throw new ServerError(`Failed to stop llama-server: ${err.message}`, { status: 500 });
  }
  currentConfig = null;
  // The tuning died with the process, so there is no longer anything to clear.
  // A relaunch that stops the daemon itself re-establishes this from its own
  // captured baseline — see `relaunchLlamaServerWithTuning`.
  preTuningConfig = null;

  return { success: true, message: 'llama-server stopped' };
}

/**
 * Block until nothing is listening on `port`, or the timeout elapses.
 *
 * `startLlamaServer` refuses when the port is still bound, and PM2's delete
 * returns before the kernel has released the listener — without this a relaunch
 * loses a race with itself and reports "port already in use" for the server it
 * just stopped.
 */
async function waitForPortRelease(port) {
  const deadline = Date.now() + PORT_RELEASE_TIMEOUT_MS;
  while (Date.now() < deadline && await isPortInUse(port)) await sleep(200);
}

/**
 * Block until the endpoint answers, or the readiness budget elapses.
 * `false` means it never answered — which is a wedged process, not a slow one.
 */
async function waitForEndpoint(endpoint) {
  const deadline = Date.now() + relaunchReadyTimeoutMs;
  while (Date.now() < deadline) {
    if (await probeEndpoint(endpoint)) return true;
    await sleep(1000);
  }
  return false;
}

/**
 * Stop whatever is running and bring `next` up in its place, putting `previous`
 * back when the new launch line is rejected or never answers.
 *
 * Shared by the two relaunch paths below — both are "same weights, one field
 * changed", and this restore ceremony is the entire reason either of them is
 * safe to offer from a button: this daemon fronts the `llama` provider for the
 * whole install, so a relaunch that leaves it down breaks every later request,
 * not just the one that was being tuned or renamed.
 *
 * @returns {Promise<{ok: boolean, rejected: string|null, config: object|null}>}
 *   `ok: false` with `rejected: null` means the process came up but never
 *   answered on its port.
 */
async function relaunchWithConfig(next, previous) {
  // Both failure paths below land here: the port is free (or about to be), and
  // the known-good launch line goes back on it. Resolves to `null` rather than
  // throwing — a restore that fails is already the worst case, and replacing the
  // caller's own reason with a second error would hide why the relaunch failed.
  const restorePrevious = async () => {
    await waitForPortRelease(previous.port ?? PORTS.LLAMA_SERVER);
    const restored = await startLlamaServer(previous).catch((err) => {
      console.error(`❌ llama-server: could not restore the previous configuration: ${err.message}`);
      return null;
    });
    return restored?.config || null;
  };

  await stopLlamaServer();
  await waitForPortRelease(next.port ?? PORTS.LLAMA_SERVER);

  // A tuning sweep EXPECTS launch lines that don't work — `--flash-attn` on a
  // build without it, a `--cache-type-k` this build lacks, a `-ub` past what the
  // GPU can hold. llama-server exits immediately and `startLlamaServer` throws.
  const started = await startLlamaServer(next).catch(async (err) => {
    console.error(`❌ llama-server: relaunch failed (${err.message}) — restoring the previous configuration`);
    return { failure: err.message, config: await restorePrevious() };
  });
  if (started.failure) return { ok: false, rejected: started.failure, config: started.config };

  // PM2 reporting `online` is not the same as the server answering. But
  // `startLlamaServer` only polls for four seconds, and a large GGUF routinely
  // takes longer than that to load — so `online: false` is "not ready YET",
  // not "wedged". Give it a real readiness budget before judging.
  if (started.online || await waitForEndpoint(started.endpoint)) {
    return { ok: true, rejected: null, config: started.config };
  }

  // Still silent. Treat it exactly like a rejected launch line: put the previous
  // configuration back, so the install's llama provider is not left pointing at
  // a process that never serves.
  console.error('❌ llama-server: relaunched process never answered — restoring the previous configuration');
  await stopLlamaServer().catch(() => {});
  return { ok: false, rejected: null, config: await restorePrevious() };
}

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
  const pm2Status = await getAppStatusStrict(LLAMA_APP);
  if (pm2Status === null) return { managed: false, config: null, readFailed: true };
  if (pm2Status.status !== 'online') return { managed: false, config: null, readFailed: false };
  if (!currentConfig && pm2Status.args) currentConfig = parseConfigFromArgs(pm2Status.args);
  return { managed: true, config: currentConfig, readFailed: false };
}

/**
 * Relaunch llama-server serving the SAME weights under a different model id.
 *
 * llama.cpp answers `GET /v1/models` with exactly one entry, and that entry is
 * whatever `--alias` was on its launch line. So a provider pinned to
 * `qwen3.8-27b-dflash2` against a server started as `dflash` fails every request
 * even when the GGUF loaded IS Qwen3.8-27B + DFlash 2 — the ids simply never
 * matched. Nothing is missing and nothing needs downloading; the fix is a label.
 *
 * Refuses (never throws) when PortOS did not start the process: an
 * externally-launched llama-server belongs to whoever ran it, and stopping it to
 * change a name PortOS invented would kill a server the user owns.
 *
 * @param {string} alias the model id the provider will send
 * @returns {Promise<{applied: boolean|null, reason: string|null, config: object|null}>}
 *   `applied: null` means the daemon already answers under that id.
 */
export async function relaunchLlamaServerWithAlias(alias) {
  const wanted = String(alias ?? '').trim();
  if (!wanted) return { applied: false, reason: 'No model id was given to serve under.', config: null };

  const { managed, config, readFailed } = await readLlamaServerLaunch();
  if (readFailed) {
    return {
      applied: false,
      retryable: true,
      reason: 'PortOS could not read PM2 to find out what llama-server is running. Try again in a moment.',
      config: null,
    };
  }
  if (!managed || !config?.model) {
    return {
      applied: false,
      reason: `llama-server is not running under PortOS, so its launch line is not PortOS's to change. Start it from Models → LLMs, or add \`--alias ${wanted}\` to your own launch line.`,
      config: null,
    };
  }
  if (config.alias === wanted) return { applied: null, reason: null, config };

  // A rename carries the whole launch line forward, tuning flags included, so
  // the baseline PortOS displaced when it tuned this daemon is still the line to
  // put back later. `startLlamaServer` clears it on every fresh launch, so it is
  // captured here and re-armed on success.
  const baseline = preTuningConfig;
  console.log(`🦙 llama-server: relaunching to answer as ${wanted} (was ${config.alias || 'unset'})`);
  const outcome = await relaunchWithConfig({ ...config, alias: wanted }, config);
  // The baseline is the line a later untuned assessment RELAUNCHES, so it has to
  // carry the new id or that assessment silently renames the daemon back and
  // re-breaks the provider this button just fixed. Only the alias moves: every
  // other field of the baseline is the user's own launch line, which a rename
  // does not touch. On either failure path the original alias is what is back on
  // the port, so the baseline stays exactly as captured.
  preTuningConfig = outcome.ok && baseline ? { ...baseline, alias: wanted } : baseline;
  if (outcome.rejected) {
    return { applied: false, reason: `llama-server rejected the relaunch: ${outcome.rejected}`, config: outcome.config };
  }
  if (!outcome.ok) {
    return {
      applied: false,
      reason: 'llama-server relaunched but never answered on its port — the previous model id is back.',
      config: outcome.config,
    };
  }
  return { applied: true, reason: null, config: outcome.config };
}

/**
 * Relaunch llama-server with a different tuning, keeping the model/drafter it is
 * already serving.
 *
 * This is the "evaluate tuning parameters for launching these" half of the
 * measured-assessment feature: a sweep across micro-batch sizes or KV-cache
 * types is only possible if something can put those flags on the launch line
 * between runs.
 *
 * It refuses rather than guesses in the three cases where it cannot know what to
 * relaunch, or must not:
 *   - PM2 could not be read (even after `readLlamaServerStatusRetrying` asked
 *     again), so PortOS cannot prove it owns the process. Reported as its own
 *     `retryable` refusal, never as the external-ownership one below;
 *   - nothing is running, so there is no model path to reuse;
 *   - something IS listening but PortOS did not start it (an externally-launched
 *     llama-server), so stopping it would kill a process the user owns.
 *
 * Every one of those returns `{ applied: false, reason }` instead of throwing:
 * the caller (an assessment run) can still measure whatever is actually serving
 * and record that the requested tuning was NOT applied, which is far more useful
 * than failing the whole run. A launch line llama-server rejects, and a relaunch
 * that never answers on its port, land on the same shape — and the rejected case
 * puts the PREVIOUS configuration back, because a tuning sweep is expected to
 * produce launch lines that don't work and must not leave the daemon down.
 *
 * `reset` makes the request the COMPLETE tuning rather than a patch: every
 * sweepable knob it omits goes back to off. A SWEEP needs that — merging onto
 * the previous launch line is what made its second variant inherit the first
 * variant's flags (`-b 4096` then `-ub 1024` launching with both, while the
 * record's label claimed one knob and `deltaPercent` credited an accumulated
 * line to a single change) — and with `reset` an EMPTY tuning becomes a real
 * instruction, "run backend defaults", which is the baseline every variant is
 * compared against.
 *
 * It is OPT-IN, and must stay that way. The user's launch flags live only in the
 * running process (the LLMs page seeds its form from hardcoded defaults, not
 * from what is running), so a reset the caller did not ask for destroys the only
 * copy of a configuration they chose. Only a sweep — which captures the
 * configuration first and puts it back afterwards — may request one.
 *
 * The reset covers the knobs llama-server leaves OFF the launch line when they
 * are absent. `ctxSize`, `nGpuLayers` and `parallel` are deliberately excluded:
 * every one of them is emitted unconditionally with a real launcher default
 * rather than having an unset state, the user picks them on the LLMs page, and
 * no sweep varies them — "clearing" them would just substitute the default and
 * silently resize the window (or the slot count) out from under a running
 * server.
 *
 * An EMPTY tuning WITHOUT `reset` is the third request: an untuned measurement
 * asking to be taken at backend defaults. It restores the launch line PortOS
 * displaced when it first tuned this daemon — which undoes what PortOS applied
 * and leaves the user's own flags exactly where they were, so it needs none of
 * the capture/restore ceremony a `reset` does. When PortOS has tuned nothing,
 * nothing is relaunched.
 *
 * @param {object} tuning launch knobs from `lib/localModelTuning.js`
 * @param {{reset?: boolean}} [options] `reset` clears every sweepable knob the
 *   tuning does not name. Never pass it from an ordinary measurement.
 * @returns {Promise<{applied: boolean|null, reason: string|null, config: object|null}>}
 *   `applied: null` means nothing needed to change — the daemon already serves
 *   the requested configuration, which is not a refusal and must not be recorded
 *   as one.
 */
const LAUNCHER_OWNED_KNOBS = new Set(['ctxSize', 'nGpuLayers', 'parallel']);

// Derived from the catalog rather than listed again here, so a knob added to
// llama.cpp's spec list is reset by default instead of quietly persisting into
// the next variant of a sweep. The value each knob resets TO is the one
// `startLlamaServer` reads as "leave the flag off the launch line".
const CLEARED_TUNING = Object.freeze(Object.fromEntries(
  tuningSpecsFor('llama')
    .filter((spec) => spec.config && !LAUNCHER_OWNED_KNOBS.has(spec.id))
    .map((spec) => [spec.id, spec.type === 'boolean' ? false : null])
));

// `undefined`, `null`, and a false toggle all render the same launch line — the
// flag is simply absent — so they must compare equal, or every untuned run on an
// untuned server would look like a change and pay for a restart.
const asLaunched = (value) => (value === undefined || value === null || value === false ? null : value);

/**
 * The launch configuration currently in effect, or `null` when llama-server is
 * not running or is somebody else's (nothing to put back, and nothing PortOS may
 * touch). An unreadable PM2 is NOT one of those: see below.
 *
 * Paired with `restoreLlamaServerConfig`: a tuning sweep relaunches the daemon
 * once per variant and would otherwise leave the last variant's flags in place
 * with the user's own flags cleared — and the running process is the only record
 * of what they chose.
 */
export async function captureLlamaServerConfig() {
  const status = await readLlamaServerStatusRetrying();
  // `managed !== false`, not `managed`: capturing is a READ, and the only thing
  // a capture can cost is `restoreLlamaServerConfig` later refusing to act on
  // it — which does its own ownership check against a fresh status. Capturing
  // nothing because PM2 blipped is the expensive answer: the sweep then clears
  // the user's own launch flags with no record of what they were.
  return status.running && status.managed !== false && status.config?.model ? status.config : null;
}

/**
 * Put a captured launch configuration back, exactly as it was.
 *
 * A no-op for `null` (nothing was captured) and for a configuration already in
 * effect, so a sweep that never actually changed anything costs no restart.
 *
 * A daemon that is DOWN is the case a restore matters most, not one to decline:
 * a sweep is expected to produce launch lines that do not work, and when the
 * failing one's own fallback could not get the previous configuration up either,
 * llama-server is stopped and the install's `llama` provider is dead until
 * somebody notices. The captured configuration is a known-good launch line and
 * nothing holds the port (`startLlamaServer` refuses if anything does), so it is
 * started rather than refused. Only a RUNNING server PortOS does not own is off
 * limits — either because it belongs to somebody else (`managed: false`) or
 * because PM2 could not be read to find out (`managed: null`, reported as its
 * own retryable refusal rather than as somebody else's process).
 */
export async function restoreLlamaServerConfig(config) {
  if (!config?.model) return { restored: false, reason: 'nothing was captured' };
  const status = await readLlamaServerStatusRetrying();
  // Split from the refusal below, not folded into it: a server PortOS cannot
  // READ is not a server somebody else started. Both still refuse — PortOS must
  // not stop a process it cannot prove it owns — but only one of them is worth
  // trying again, and only one of them is true.
  if (status.running && status.managed === null) {
    return {
      restored: false,
      retryable: true,
      reason: 'PortOS could not read PM2, so it cannot tell whether this llama-server is its own to restart',
    };
  }
  if (status.running && status.managed === false) {
    return { restored: false, reason: 'llama-server is now running outside PortOS, so its launch line is not PortOS\'s to change' };
  }

  if (status.running) {
    const differs = Object.keys(CLEARED_TUNING).some((id) => asLaunched(status.config?.[id]) !== asLaunched(config[id]));
    if (!differs) return { restored: true, reason: null };
    await stopLlamaServer();
  }
  await waitForPortRelease(config.port ?? PORTS.LLAMA_SERVER);

  console.log('🦙 llama-server: restoring the launch configuration the sweep started from');
  const started = await startLlamaServer(config).catch((err) => {
    console.error(`❌ llama-server: could not restore the launch configuration: ${err.message}`);
    return null;
  });
  return {
    restored: Boolean(started),
    reason: started ? null : 'llama-server would not start with the captured configuration, and is now stopped',
  };
}

export async function relaunchLlamaServerWithTuning(tuning = {}, { reset = false } = {}) {
  const empty = Object.values(tuning).every((v) => v === null || v === undefined);
  // An empty tuning with no `reset` is an UNTUNED measurement asking to be taken
  // at backend defaults. If PortOS put a tuning on this daemon, it has to come
  // back off — the reading is stored as "Backend defaults" either way, and
  // `compareTunings` ranks every real tuning against it. Restoring the captured
  // pre-tuning line, NOT `CLEARED_TUNING`: the reset clears sweepable knobs the
  // user may have set themselves, which only a sweep is entitled to do.
  const clearing = empty && !reset && Boolean(preTuningConfig);
  // Nothing PortOS applied is outstanding, so an empty tuning asks for nothing —
  // and answering before touching PM2 keeps an ordinary untuned measurement free
  // of a status round trip.
  if (!reset && empty && !clearing) {
    return { applied: null, reason: null, config: currentConfig };
  }

  const status = await readLlamaServerStatusRetrying();
  // Checked BEFORE `running`, and before anything is discarded. `managed: null`
  // means the PM2 read failed even on retry, so PortOS knows neither what is
  // running nor whether it owns it — and the `!running` branch below would clear
  // `preTuningConfig`, throwing away the only record of the launch line PortOS
  // displaced, on the strength of a read that never happened.
  //
  // It still refuses: PortOS cannot confirm it may restart this daemon, and
  // filing the reading as a trustworthy baseline would be worse. But it refuses
  // as itself — "could not read PM2", retryable — rather than borrowing the
  // wording of an external-ownership refusal, which sends a user who owns the
  // daemon looking for a process that does not exist.
  if (status.managed === null) {
    return {
      applied: false,
      retryable: true,
      reason: 'PortOS could not read PM2, so it cannot tell whether it owns this llama-server. Try again in a moment.',
      config: status.config || null,
    };
  }
  if (!status.running) {
    // Whatever carried the tuning is gone; the next start is untuned by
    // construction, so there is nothing left to undo.
    preTuningConfig = null;
    if (clearing) return { applied: null, reason: null, config: null };
    return { applied: false, reason: 'llama-server is not running, so PortOS has no model path to relaunch with', config: null };
  }
  if (!status.managed || !status.config?.model) {
    return {
      applied: false,
      // Worded for the direction it was asked in. A clearing run requested NO
      // tuning, and its row already reads "backend defaults" — telling that user
      // their tuning could not be applied contradicts what they are looking at.
      reason: clearing
        ? 'llama-server was started outside PortOS, so PortOS cannot relaunch it without the tuning it is carrying'
        : 'llama-server was started outside PortOS — start it from the LLMs page to let PortOS apply tuning',
      config: status.config || null,
    };
  }

  const previous = status.config;
  // Captured before `stopLlamaServer` clears it, and put back explicitly on
  // every exit below — the stop is part of this relaunch, not the user ending
  // the tuning session.
  const baseline = preTuningConfig;
  const next = clearing ? baseline : { ...previous, ...(reset ? CLEARED_TUNING : {}), ...tuning };
  // Nothing to do when the daemon is ALREADY running this exact tuning — the
  // common case for an untuned measurement on an untuned server, and the reason
  // making an empty tuning meaningful costs a plain assessment nothing.
  //
  // Compared across the cleared set UNION whatever the request names, not the
  // cleared set alone: a request for a launcher-owned knob (`ctxSize`,
  // `nGpuLayers`) changes nothing in the cleared set, and judging on that would
  // report a context-size change as applied while the server kept serving the
  // old window.
  //
  // A CLEARING run compares the whole captured line, not just the knob set: the
  // baseline is a complete configuration, and any field of it that drifted is a
  // difference this relaunch exists to undo.
  const compared = clearing
    ? new Set([...Object.keys(baseline), ...Object.keys(previous)])
    : new Set([...Object.keys(CLEARED_TUNING), ...Object.keys(tuning || {})]);
  const changed = [...compared].some((id) => asLaunched(next[id]) !== asLaunched(previous[id]));
  if (!changed) {
    // The daemon already serves the pre-tuning line, so the tuning is gone.
    if (clearing) preTuningConfig = null;
    return { applied: clearing ? null : true, reason: null, config: previous };
  }

  const knobs = Object.entries(tuning).filter(([, v]) => v !== null && v !== undefined);
  console.log(clearing
    ? '🦙 llama-server: relaunching without the tuning PortOS applied'
    : `🦙 llama-server: relaunching to apply tuning (${knobs.length ? knobs.map(([k, v]) => `${k}=${v}`).join(', ') : 'backend defaults'})`);
  const outcome = await relaunchWithConfig(next, previous);
  if (outcome.rejected) {
    // `previous` is back on the port, so whatever tuning it carried is still in
    // effect and still needs undoing later.
    preTuningConfig = baseline;
    return {
      applied: false,
      reason: clearing
        ? `llama-server rejected its pre-tuning launch line: ${outcome.rejected}`
        : `llama-server rejected that tuning: ${outcome.rejected}`,
      config: outcome.config,
    };
  }
  if (!outcome.ok) {
    // The relaunched process never answered. `previous` is back, so the caller
    // measures a live endpoint rather than recording timeouts as evidence.
    preTuningConfig = baseline;
    return {
      applied: false,
      reason: 'llama-server relaunched but never answered on its port',
      config: outcome.config,
    };
  }
  // The daemon now serves `next`. Clearing leaves it untuned, so there is
  // nothing left to undo; a first tuning records the line it displaced, and a
  // second must NOT overwrite that with the line the first one left.
  preTuningConfig = clearing ? null : (baseline || previous);
  // `null`, not `true`, for a clear: there was no tuning to apply, and the
  // reading that follows describes backend defaults truthfully.
  return { applied: clearing ? null : true, reason: null, config: outcome.config };
}

/**
 * Runs `brew link --overwrite llama.cpp`, resolving `{ linked, output }` on exit
 * rather than rejecting — a failed link attempt should fall through to the
 * caller's own error message, not replace it with a `brew link` failure. The
 * captured output is what makes a failure diagnosable ("Could not symlink…",
 * a permissions error on the prefix); discarding it left the caller guessing.
 */
function linkLlamaCpp(env) {
  return new Promise((resolve) => {
    const spawnOpts = safeChildProcessOptions({
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const child = spawn('brew', ['link', '--overwrite', 'llama.cpp'], spawnOpts);
    let output = '';
    const collect = (chunk) => { output += chunk.toString(); };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    child.on('error', (err) => resolve({ linked: false, output: err.message }));
    // 'close' rather than 'exit': 'exit' fires the moment the process ends, with
    // stdio possibly still buffered, which would hand back a truncated (often
    // empty) `output` exactly when a failure needs explaining. `brew link` is a
    // short, single-process command, so waiting for the pipes to close is safe.
    child.on('close', (code) => resolve({ linked: code === 0, output: output.trim() }));
  });
}

/**
 * Installs llama.cpp via Homebrew.
 */
export async function installLlamaServer({ onProgress = () => {} } = {}) {
  const brewExists = await commandExists('brew', ['--version']);
  if (!brewExists) {
    throw new ServerError(
      'Homebrew was not found. Please install Homebrew from https://brew.sh or build llama.cpp from source.',
      { status: 400 }
    );
  }

  onProgress({ event: 'start', message: 'Installing llama.cpp via Homebrew…' });
  const env = safeChildProcessEnv();
  const spawnOpts = safeChildProcessOptions({
    env,
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const child = spawn('brew', ['install', 'llama.cpp'], spawnOpts);

  return new Promise((resolve, reject) => {
    child.stdout?.on('data', (d) => {
      onProgress({ event: 'progress', message: d.toString().trim() });
    });
    child.stderr?.on('data', (d) => {
      onProgress({ event: 'progress', message: d.toString().trim() });
    });
    // `error` and `exit` can both fire for one child (an `error` raised after a
    // successful spawn is followed by the process's own exit). Without this
    // guard the exit path would still emit a `complete` progress event to the
    // UI after the request had already been rejected — the client would render
    // "installed successfully" alongside a 500.
    let settled = false;
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(new ServerError(`Failed to run brew: ${err.message}`, { status: 500 }));
    });
    // Async listener on a child-process event: it runs outside the Express
    // lifecycle AND outside this Promise executor's own throw path, so an
    // unguarded throw here would surface as an unhandled rejection while the
    // install request hung forever. Route every failure to `reject`.
    child.on('exit', async (code) => {
      if (settled) return;
      settled = true;
      try {
        let binaryPath = resolveLlamaServerBinary();
        let linkOutput = '';

        // `brew install` exits 0 without linking when the keg is already
        // installed but unlinked ("Warning: llama.cpp X is already installed,
        // it's just not linked."). Link it explicitly rather than leaving that
        // warning as a dead end for the caller.
        if (!binaryPath && code === 0) {
          onProgress({ event: 'progress', message: 'llama.cpp keg is installed but not linked — linking…' });
          const { linked, output } = await linkLlamaCpp(env);
          linkOutput = output;
          if (linked) binaryPath = resolveLlamaServerBinary();
        }

        if (binaryPath) {
          onProgress({ event: 'complete', message: `llama.cpp installed successfully (${binaryPath})` });
          resolve({ success: true, message: 'llama.cpp installed successfully' });
          return;
        }

        // A `brew link` conflict can list every clashing file, so cap what
        // rides along into the error message.
        const hint = linkOutput
          ? `brew link said: ${linkOutput.slice(0, 500)}`
          : 'try running `brew link --overwrite llama.cpp` manually';
        const msg = code === 0
          ? `brew completed but llama-server was not found on PATH — ${hint}`
          : `brew install llama.cpp failed (exit code ${code})`;
        reject(new ServerError(msg, { status: 500 }));
      } catch (err) {
        reject(new ServerError(`Failed to verify the llama.cpp install: ${err.message}`, { status: 500 }));
      }
    });
  });
}

/**
 * Clears in-memory test state (used by test suites).
 */
export function _resetLlamaServerStateForTests({ relaunchReadyTimeout, pm2ReadRetryDelay } = {}) {
  currentConfig = null;
  preTuningConfig = null;
  logs.reset();
  lastExitError = null;
  // Restored to the production budget unless a suite asks for a shorter one.
  relaunchReadyTimeoutMs = Number.isFinite(relaunchReadyTimeout) ? relaunchReadyTimeout : 120000;
  pm2ReadRetryDelayMs = Number.isFinite(pm2ReadRetryDelay) ? pm2ReadRetryDelay : PM2_READ_RETRY_DELAY_MS;
}
