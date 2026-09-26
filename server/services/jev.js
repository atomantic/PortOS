/**
 * Local entailment ("jev") scoring service.
 *
 * PortOS's decision primitive for CLOSED-SET questions over untrusted external
 * text. Where `untrustedContent.js` asks a chat model to generate an answer,
 * this hands a premise and a fixed list of hypotheses to a pinned NLI
 * cross-encoder and gets back a per-hypothesis entailment distribution. No text
 * generation, no tool surface, no provider quota.
 *
 * Two things distinguish it from `modelAbuseGuard.js`, which it otherwise
 * mirrors file for file:
 *
 *  1. The Python helper is a long-lived SIDECAR on a loopback port, not a
 *     process per item. A 9 GB checkpoint cannot be re-imported per call.
 *  2. It ABSTAINS. `decide()` returns `abstained: true` whenever the top two
 *     hypotheses are too close to separate, and a caller is required to treat
 *     that as "ask something else", never as "take the top one anyway".
 *
 * Nothing here runs at boot. The sidecar starts on the first `scoreHypotheses`
 * call and an idle timer reaps it — see the AI Provider Usage Policy in
 * AGENTS.md.
 */

import { notifyJevChanged } from './jevEvents.js';
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { execFile, spawn } from '../lib/childProcess.js';
import { ensureDir, PATHS, safeJSONParse } from '../lib/fileUtils.js';
import { findCachedRepoFiles, getHfCacheRoot } from '../lib/hfCache.js';
import {
  JEV_IDLE_UNLOAD_MS,
  JEV_MAX_RESPONSE_CHARS,
  JEV_MODEL,
  JEV_PYTHON_IMPORTS,
  JEV_PYTHON_PACKAGES,
  JEV_REQUEST_TIMEOUT_MS,
  JEV_REQUIRED_FILES,
  JEV_SIDECAR_FAILURE_CODES,
  JEV_START_TIMEOUT_MS,
  decideFromScores,
  jevScoreRequestSchema,
  jevStageReadiness,
  normalizeJevScores,
} from '../lib/jev.js';
import { PORTS } from '../lib/ports.js';
import { safeChildProcessOptions } from '../lib/processEnv.js';
import { diagnosePythonRuntimeText } from '../lib/pythonRuntimeDiagnosis.js';
import { createVenv, detectVenvBasePythonSync, installPackages } from '../lib/pythonSetup.js';
import { withSpawnCwdEnv } from '../lib/spawnCwd.js';
import { downloadHfRepo } from './hfDownload.js';
// One path helper, from the leaf that owns the directory. Re-deriving
// `data/jev/heads` here is how the sidecar's `--heads-dir` and the store's
// writes end up pointing at two different directories — and taking it from the
// STORE instead would drag the head schema into this module's static closure.
import { jevHeadsDir } from '../lib/jevPaths.js';

const execFileAsync = promisify(execFile);
const IS_WIN = platform() === 'win32';
// A SEPARATE virtualenv from Prompt Guard's, on purpose: two independent
// boundaries must not share one dependency resolution, and repairing one must
// never be able to break the other.
const JEV_VENV_DIR = join(PATHS.data, 'python', 'venv-jev');
const JEV_PYTHON = IS_WIN
  ? join(JEV_VENV_DIR, 'Scripts', 'python.exe')
  : join(JEV_VENV_DIR, 'bin', 'python3');
const FALLBACK_JEV_PYTHON = IS_WIN
  ? join(homedir(), '.portos', 'venv-jev', 'Scripts', 'python.exe')
  : join(homedir(), '.portos', 'venv-jev', 'bin', 'python3');
const HELPER_SCRIPT = join(PATHS.root, 'scripts', 'run_jev.py');
const SIDECAR_ORIGIN = `http://127.0.0.1:${PORTS.JEV}`;
const RUNTIME_PROBE_TIMEOUT_MS = 30_000;
const MAX_INSTALL_EVENT_CHARS = 300;
const HEALTH_POLL_INTERVAL_MS = 1_000;
const HEALTH_PROBE_TIMEOUT_MS = 5_000;

let cachedRuntime = null;
let installInFlight = null;
let installKill = null;
let runtimeIssue = null;
let lastInstallFailure = null;

// Sidecar state. `startInFlight` is the single-start guard: two concurrent
// first-callers must produce exactly ONE process, not two competing 9 GB loads.
let sidecar = null;
let startInFlight = null;
// Stop invalidates startup even before it has a child handle.
let startGeneration = 0;
let idleTimer = null;
// The child between spawn and its first healthy /health. `sidecar` is not set
// yet, so without this a stop during a cold start (an operator unload, a test
// teardown) would leave a 9 GB load running with nothing holding its handle.
let startingProc = null;

const failure = (code, extra = {}) => ({ ok: false, code, ...extra });

const setupIssue = (text, fallback = 'runtime-check-failed') => diagnosePythonRuntimeText(text, {
  subject: 'scorer',
  repairLabel: 'jev',
  imports: JEV_PYTHON_IMPORTS,
  fallback,
});

const emitInstall = (onEvent, event, message, stage) => {
  if (typeof onEvent !== 'function') return;
  onEvent({
    event,
    message: String(message || '').slice(0, MAX_INSTALL_EVENT_CHARS),
    ...(stage ? { stage } : {}),
  });
};

/**
 * Build the sidecar's environment.
 *
 * Deliberately not the normal CLI environment builder: that one carries
 * forge/provider auth so an agent can work. jev must receive no API keys,
 * GitHub tokens, MCP/Codex variables, provider settings, or arbitrary
 * PYTHONPATH — and must never reach the network.
 */
export function buildJevEnv(source = process.env) {
  const keys = ['PATH', 'Path', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL'];
  const env = Object.fromEntries(keys
    .filter((key) => source?.[key] != null)
    .map((key) => [key, String(source[key])]));
  return {
    ...env,
    PYTHONNOUSERSITE: '1',
    HF_HUB_OFFLINE: '1',
    TRANSFORMERS_OFFLINE: '1',
    HF_HUB_DISABLE_TELEMETRY: '1',
    TOKENIZERS_PARALLELISM: 'false',
    PYTHONWARNINGS: 'ignore',
  };
}

function availableJevPython() {
  if (existsSync(JEV_PYTHON)) return JEV_PYTHON;
  if (existsSync(FALLBACK_JEV_PYTHON)) return FALLBACK_JEV_PYTHON;
  return null;
}

/**
 * How to run Python inside the dedicated jev venv, or null when it is absent.
 *
 * Returns `{ pythonPath, options }` — the interpreter AND the hardened spawn
 * options together, because that pairing IS the guarantee: no API keys, no
 * forge token, no MCP or provider variables, no arbitrary PYTHONPATH, and
 * `HF_HUB_OFFLINE=1` so a missing file fails rather than downloading.
 *
 * One function rather than exporting `jevPythonPath` and `buildJevEnv` for a
 * caller to recompose: `startSidecar` below and `services/jevTraining.js` both
 * use it, so a future change to the hardening cannot land in one and leave the
 * other describing a process that is not the one running.
 */
export function jevVenvSpawnTarget(overrides = {}) {
  const pythonPath = availableJevPython();
  if (!pythonPath) return null;
  const cwd = dirname(pythonPath);
  return {
    pythonPath,
    options: safeChildProcessOptions({
      cwd,
      env: withSpawnCwdEnv(buildJevEnv(), cwd),
      ...overrides,
    }),
  };
}

async function isBasePythonSupported(pythonPath) {
  if (!pythonPath) return false;
  return execFileAsync(pythonPath, ['-c', 'import sys; print("supported" if sys.version_info >= (3, 10) else "unsupported")'],
    safeChildProcessOptions({ env: buildJevEnv(), timeout: 5_000, maxBuffer: 1000 }))
    .then(({ stdout }) => stdout.trim() === 'supported').catch(() => false);
}

function probeScript() {
  const imports = JEV_PYTHON_IMPORTS.map((name) => `import ${name}`).join('; ');
  const expected = Object.fromEntries(JEV_PYTHON_PACKAGES.map((spec) => spec.split('==')));
  return `${imports}; import importlib.metadata as metadata; expected = ${JSON.stringify(expected)}; ready = all(metadata.version(name).split('+')[0] == version for name, version in expected.items()); print('{"ready":true}' if ready else '{"ready":false}')`;
}

async function isRuntimeReady(pythonPath) {
  if (!pythonPath) { runtimeIssue = null; return false; }
  if (cachedRuntime?.pythonPath === pythonPath && Date.now() - cachedRuntime.checkedAt < 60_000) return true;
  runtimeIssue = null;
  const importsReady = await execFileAsync(
    pythonPath,
    ['-c', probeScript()],
    safeChildProcessOptions({ env: buildJevEnv(), timeout: RUNTIME_PROBE_TIMEOUT_MS, maxBuffer: 4_000 }),
  ).then(({ stdout }) => stdout.trim().split(/\r?\n/).pop() === '{"ready":true}')
    .catch((error) => { runtimeIssue = setupIssue(error.stderr || error.message); return false; });
  if (!importsReady && !runtimeIssue) {
    runtimeIssue = {
      code: 'package-version-mismatch',
      message: 'Installed scorer package versions do not match the pinned runtime.',
      action: 'Repair jev to install the expected versions.',
    };
  }
  if (importsReady) cachedRuntime = { pythonPath, checkedAt: Date.now() };
  return importsReady;
}

/**
 * Operator-safe status only. Runtime paths and exception text are
 * intentionally omitted from the API contract.
 *
 * Observational: importing packages is permitted here, but no model is loaded
 * and no download runs. A status refresh never starts the sidecar.
 */
export async function getJevStatus() {
  const files = await findCachedRepoFiles(JEV_MODEL.repository, JEV_REQUIRED_FILES, {
    revision: JEV_MODEL.revision,
  });
  const pythonPath = availableJevPython();
  const modelCached = Array.isArray(files);
  const venvReady = Boolean(pythonPath);
  const pythonAvailable = await isBasePythonSupported(detectVenvBasePythonSync());
  const runtimeReady = await isRuntimeReady(pythonPath);
  const { stages, ready } = jevStageReadiness({ pythonAvailable, venvReady, runtimeReady, modelCached });
  const installationPresent = modelCached || venvReady || existsSync(JEV_VENV_DIR)
    || existsSync(dirname(dirname(FALLBACK_JEV_PYTHON)))
    || existsSync(join(getHfCacheRoot(), `models--${JEV_MODEL.repository.replaceAll('/', '--')}`));
  return {
    ...JEV_MODEL,
    modelCached,
    runtimeReady,
    pythonAvailable,
    venvReady,
    stages,
    ready,
    runtimeIssue,
    lastInstallFailure,
    resident: sidecar !== null,
    port: PORTS.JEV,
    expectedPackages: [...JEV_PYTHON_PACKAGES],
    setupState: ready ? 'ready' : installationPresent ? 'incomplete' : 'not-installed',
  };
}

/**
 * Install the fixed scorer and its private runtime. There are no request
 * parameters for repository, revision, package, or destination: all of those
 * are owned by the static contract in `lib/jev.js`.
 */
export function installJev({ onEvent } = {}) {
  if (installInFlight) return installInFlight;
  lastInstallFailure = null;
  let activeStage = 'python';
  const failInstall = (code, diagnostic = setupIssue('', code)) => {
    lastInstallFailure = { ...diagnostic, stage: activeStage };
    return failure(code, { diagnostic: lastInstallFailure });
  };
  installInFlight = (async () => {
    // No token stage: openjev is ungated and MIT-licensed.
    const cachedFiles = await findCachedRepoFiles(JEV_MODEL.repository, JEV_REQUIRED_FILES, { revision: JEV_MODEL.revision });
    const basePython = detectVenvBasePythonSync();
    if (!await isBasePythonSupported(basePython)) return failInstall('jev-python-unavailable');

    activeStage = 'venv';
    await ensureDir(dirname(JEV_VENV_DIR));
    emitInstall(onEvent, 'stage', 'Preparing the dedicated jev runtime…', 'venv');
    const clear = existsSync(JEV_PYTHON) && !await isBasePythonSupported(JEV_PYTHON);
    const pythonPath = await createVenv(basePython, JEV_VENV_DIR, { clear });
    cachedRuntime = null;

    activeStage = 'packages';
    let packageIssue = null;
    emitInstall(onEvent, 'stage', 'Installing the fixed scorer runtime packages…', 'packages');
    const packageRun = installPackages(pythonPath, [...JEV_PYTHON_PACKAGES], ({ type, message }) => {
      const issue = setupIssue(message);
      if (issue.code !== 'runtime-check-failed' && !packageIssue) {
        packageIssue = issue;
        emitInstall(onEvent, 'stage', `${issue.message} ${issue.action}`, 'packages');
      }
      if (type === 'complete') emitInstall(onEvent, 'stage', 'Scorer runtime packages are ready.', 'packages');
      else if (type === 'error') emitInstall(onEvent, 'error', 'Scorer runtime package installation failed.', 'packages');
      else if (message && /install|uninstall/i.test(message)) emitInstall(onEvent, 'stage', 'Installing scorer runtime packages…', 'packages');
    }, { preferUv: true });
    installKill = packageRun.kill;
    const packageResult = await packageRun.promise;
    installKill = null;
    if (!packageResult?.ok) {
      return failInstall('jev-runtime-install-failed', {
        ...(packageIssue || setupIssue('', 'package-install-failed')),
        ...(Number.isInteger(packageResult?.code) ? { exitCode: packageResult.code } : {}),
      });
    }

    activeStage = 'model';
    if (!cachedFiles) {
      emitInstall(onEvent, 'stage', 'Downloading the pinned jev model snapshot…', 'model');
      // `only` keeps this in single-file mode: the repository also carries a
      // 35B variant, trained MLP heads, and a `code/` directory, none of which
      // are ever fetched and none of which are ever executed.
      const download = downloadHfRepo({
        repo: JEV_MODEL.repository,
        revision: JEV_MODEL.revision,
        only: [...JEV_REQUIRED_FILES],
        pythonPath,
        onEvent: (event) => {
          if (event?.type === 'error') emitInstall(onEvent, 'error', 'jev model download failed.', 'model');
          else if (event?.type === 'progress') emitInstall(onEvent, 'progress', event.stage || 'Downloading jev…', 'model');
          else if (event?.type === 'complete') emitInstall(onEvent, 'stage', 'Pinned jev model snapshot downloaded.', 'model');
        },
      });
      installKill = download.kill;
      const downloadResult = await download.promise;
      installKill = null;
      if (!downloadResult?.ok) {
        return failInstall('jev-model-download-failed', setupIssue(downloadResult?.errorMessage, 'model-download-failed'));
      }
    }

    activeStage = 'verification';
    const status = await getJevStatus();
    if (!status.ready) return failInstall('jev-install-incomplete', runtimeIssue || undefined);
    emitInstall(onEvent, 'complete', 'jev is ready for closed-set scoring.');
    return { ok: true, ...status };
  })()
    .catch((error) => failInstall('jev-install-failed', setupIssue(error.stderr || error.message)))
    .finally(() => {
      installKill = null;
      installInFlight = null;
      notifyJevChanged('status');
    });
  return installInFlight;
}

export function cancelJevInstall() {
  if (typeof installKill === 'function') installKill();
}

// ── Sidecar lifecycle ─────────────────────────────────────────────────────

function clearIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
}

/**
 * Stop the sidecar and free its weights. Safe to call when nothing is running.
 *
 * Exported because the idle reaper, an explicit operator unload, and test
 * teardown all need exactly this, and a module that keeps a 9 GB process alive
 * with no way to end it is a resource leak with a UI.
 */
export function stopJevSidecar() {
  startGeneration += 1;
  clearIdleTimer();
  const running = sidecar;
  const starting = startingProc;
  sidecar = null;
  startingProc = null;
  startInFlight = null;
  for (const proc of [running?.proc, starting]) {
    if (proc && proc.exitCode === null && !proc.killed) proc.kill('SIGTERM');
  }
  if (running !== null || starting !== null) notifyJevChanged('status');
  return running !== null || starting !== null;
}

export const isJevSidecarRunning = () => sidecar !== null;

function armIdleReaper() {
  clearIdleTimer();
  // Outside the request lifecycle: an uncaught throw here would take the whole
  // Node process down, so the callback owns its failures (Code Conventions).
  idleTimer = setTimeout(() => {
    try {
      stopJevSidecar();
      console.log('💤 jev sidecar unloaded after idle timeout');
    } catch (error) {
      console.error(`❌ jev idle unload failed: ${error.message}`);
    }
  }, JEV_IDLE_UNLOAD_MS);
  if (typeof idleTimer.unref === 'function') idleTimer.unref();
}

async function probeHealth(timeoutMs = HEALTH_PROBE_TIMEOUT_MS) {
  const response = await fetch(`${SIDECAR_ORIGIN}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    .catch(() => null);
  if (!response?.ok) return null;
  const parsed = await response.json().catch(() => null);
  return parsed?.ready === true ? parsed : null;
}

const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); });

/**
 * Spawn the sidecar and wait for it to report a loaded model.
 *
 * Wrapped by `ensureSidecar`'s single-flight promise, so this never runs twice
 * concurrently — two 9 GB loads racing for the same port would leave one of
 * them bound to nothing and the other reaped by a caller that never saw it.
 */
async function startSidecar(generation) {
  const target = jevVenvSpawnTarget({ stdio: ['ignore', 'pipe', 'pipe'] });
  if (!target) return failure('jev-not-installed');
  const files = await findCachedRepoFiles(JEV_MODEL.repository, JEV_REQUIRED_FILES, { revision: JEV_MODEL.revision });
  if (generation !== startGeneration) return failure('jev-start-failed');
  if (!files?.[0]) return failure('jev-not-installed');
  // Every required file sits in the pinned subfolder, so its parent IS the
  // directory `from_pretrained` loads.
  const modelDir = dirname(files[0]);
  // Where adopted project heads live. Passed as a path, never created here: the
  // head store owns that directory, and the sidecar resolves a head inside it
  // per request rather than latching its existence at start-up — so a head
  // adopted while the sidecar is resident is reachable without a cold start.
  const headsDir = jevHeadsDir();

  const proc = spawn(
    target.pythonPath,
    [
      HELPER_SCRIPT,
      '--model-dir', modelDir,
      '--port', String(PORTS.JEV),
      '--host', '127.0.0.1',
      '--model-id', JEV_MODEL.id,
      '--revision', JEV_MODEL.revision,
      '--heads-dir', headsDir,
    ],
    target.options,
  );
  startingProc = proc;
  let exited = false;
  // Outside the request lifecycle: these handlers must not throw.
  proc.on('error', () => { exited = true; });
  proc.on('close', (code) => {
    exited = true;
    if (startingProc === proc) startingProc = null;
    if (sidecar?.proc === proc) {
      sidecar = null;
      clearIdleTimer();
      notifyJevChanged('status');
    }
    if (code) console.error(`❌ jev sidecar exited with code ${code}`);
  });
  // Drained, never retained: a dependency exception can carry the premise or a
  // private path, and stderr would otherwise fill the pipe buffer and wedge
  // the child once it exceeded it.
  proc.stdout?.resume();
  proc.stderr?.resume();

  const deadline = Date.now() + JEV_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    // `startingProc` moving off this child means a stop landed mid-start.
    if (exited || generation !== startGeneration || startingProc !== proc) return failure('jev-start-failed');
    const health = await probeHealth();
    // Stop, exit, or a replacement start may have won while health was pending.
    if (exited || generation !== startGeneration || startingProc !== proc) return failure('jev-start-failed');
    if (health) {
      startingProc = null;
      sidecar = { proc, device: typeof health.device === 'string' ? health.device : null };
      armIdleReaper();
      notifyJevChanged('status');
      console.log(`🧮 jev sidecar ready on 127.0.0.1:${PORTS.JEV} (${sidecar.device || 'unknown device'})`);
      return { ok: true };
    }
    await delay(HEALTH_POLL_INTERVAL_MS);
  }
  if (startingProc === proc) startingProc = null;
  if (proc.exitCode === null && !proc.killed) proc.kill('SIGTERM');
  return failure('jev-start-failed');
}

function ensureSidecar() {
  if (sidecar) { armIdleReaper(); return Promise.resolve({ ok: true }); }
  // Single in-flight start. Cleared in `finally` so a failed start does not
  // pin every later caller to the same rejection.
  if (!startInFlight) {
    const pending = startSidecar(startGeneration).finally(() => {
      if (startInFlight === pending) startInFlight = null;
    });
    startInFlight = pending;
  }
  return startInFlight;
}

// ── Scoring ───────────────────────────────────────────────────────────────

/**
 * Score a premise against a list of hypotheses.
 *
 * Returns the per-hypothesis entailment distribution in REQUEST ORDER, or a
 * failure code. Never a Python traceback, never the premise, never a path.
 *
 * `head` names an adopted project-specific head (`services/jevHeads.js`) to
 * apply in place of the checkpoint's own classifier, on the SAME frozen
 * encoder. It is a slug the server resolved, never a caller-supplied path, and
 * it is deliberately absent from `jevScoreRequestSchema`: which classifier
 * answers a decision is an install-level adoption, not something an HTTP body
 * may choose. The response shape is identical either way, so everything
 * downstream — margins, abstention floors — is unchanged.
 */
export async function scoreHypotheses({ premise, hypotheses, head = null, timeoutMs = JEV_REQUEST_TIMEOUT_MS } = {}) {
  const parsed = jevScoreRequestSchema.safeParse({ premise, hypotheses });
  if (!parsed.success) {
    // The one length failure an operator can act on gets its own code; every
    // other malformed input is a caller bug.
    const tooLarge = typeof premise === 'string' && parsed.error.issues.some((issue) => issue.path[0] === 'premise' && issue.code === 'too_big');
    return failure(tooLarge ? 'jev-premise-too-large' : 'jev-request-invalid');
  }

  const started = await ensureSidecar();
  if (!started.ok) return started;

  const response = await fetch(`${SIDECAR_ORIGIN}/score`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      premise: parsed.data.premise,
      hypotheses: parsed.data.hypotheses,
      ...(typeof head === 'string' && head ? { head } : {}),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  }).catch((error) => (error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timeout' : null));

  if (response === 'timeout') return failure('jev-timeout');
  if (!response) return failure('jev-start-failed');
  armIdleReaper();

  const body = await response.text().catch(() => null);
  if (typeof body !== 'string' || body.length > JEV_MAX_RESPONSE_CHARS) return failure('jev-response-invalid');
  // The sidecar's own codes are already operator-safe; anything else it could
  // say is not, so an unrecognized body collapses to one code.
  if (!response.ok) return failure(safeErrorCode(body));
  const wire = safeJSONParse(body, null, { allowArray: false, logError: false });
  return normalizeJevScores(wire, { hypotheses: parsed.data.hypotheses });
}

function safeErrorCode(body) {
  const parsed = safeJSONParse(body, null, { allowArray: false, logError: false });
  return JEV_SIDECAR_FAILURE_CODES.includes(parsed?.error) ? parsed.error : 'jev-response-invalid';
}

/**
 * Ask the scorer to pick one of `options`, or to abstain.
 *
 * `abstained: true` means the top two options were within `minMargin` of each
 * other. The caller MUST fall back (ask a chat model, do nothing) — picking
 * the top option anyway discards the only signal this service adds over a
 * coin flip.
 */
export async function decide({ premise, options, minMargin, head = null } = {}) {
  // Checked BEFORE scoring: a single option has no runner-up, so there is no
  // margin to compute and no reason to pay for a forward pass to learn that.
  if (!Array.isArray(options) || options.length < 2) return failure('jev-request-invalid');
  const scored = await scoreHypotheses({ premise, hypotheses: options, head });
  if (!scored.ok) return scored;
  return decideFromScores(scored.scores, minMargin);
}
