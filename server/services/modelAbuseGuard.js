/**
 * Local model-abuse screening service.
 *
 * This service is intentionally separate from the local chat completion path.
 * It runs deterministic checks and then a pinned Prompt Guard classifier in a
 * dedicated offline Python environment. The classifier receives no tools,
 * agent prompt, repository checkout, credentials, or network access.
 */

import { chmod, existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { execFile, spawn } from '../lib/childProcess.js';
import { promisify } from 'node:util';
import {
  atomicWrite,
  ensureDir,
  PATHS,
  safeJSONParse,
  tryReadFile,
} from '../lib/fileUtils.js';
import {
  MODEL_ABUSE_GUARD,
  MODEL_ABUSE_GUARD_CHUNK_OVERLAP,
  MODEL_ABUSE_GUARD_CHUNK_TOKENS,
  MODEL_ABUSE_GUARD_ID,
  MODEL_ABUSE_GUARD_MAX_INPUT_CHARS,
  MODEL_ABUSE_GUARD_MAX_OUTPUT_CHARS,
  MODEL_ABUSE_GUARD_MIN_BENIGN_SCORE,
  MODEL_ABUSE_GUARD_PYTHON_IMPORTS,
  MODEL_ABUSE_GUARD_REQUIRED_FILES,
  MODEL_ABUSE_GUARD_TIMEOUT_MS,
  detectDeterministicModelAbuseSignals,
  hasToolFreeTextCapability,
  normalizeModelAbuseGuardResult,
} from '../lib/modelAbuseGuard.js';
import { findCachedRepoFiles } from '../lib/hfCache.js';
import { localRuntimeForProvider } from '../lib/localProviderRuntime.js';
import { supportsPublicReviewProvider } from '../lib/providerVendors.js';
import { withSpawnCwdEnv } from '../lib/spawnCwd.js';
import { detectVenvBasePythonSync, createVenv, installPackages } from '../lib/pythonSetup.js';
import { safeChildProcessOptions } from '../lib/processEnv.js';
import { downloadHfRepo } from './hfDownload.js';
import { listModels } from './localLlm.js';
import * as ollamaManager from './ollamaManager.js';

const execFileAsync = promisify(execFile);
const IS_WIN = platform() === 'win32';
const GUARD_VENV_DIR = join(PATHS.data, 'python', 'venv-prompt-guard');
const GUARD_PYTHON = IS_WIN
  ? join(GUARD_VENV_DIR, 'Scripts', 'python.exe')
  : join(GUARD_VENV_DIR, 'bin', 'python3');
const FALLBACK_GUARD_PYTHON = IS_WIN
  ? join(homedir(), '.portos', 'venv-prompt-guard', 'Scripts', 'python.exe')
  : join(homedir(), '.portos', 'venv-prompt-guard', 'bin', 'python3');
const HELPER_SCRIPT = join(PATHS.root, 'scripts', 'run_prompt_guard.py');
const RUNTIME_PROBE_TIMEOUT_MS = 30_000;
const MAX_SCAN_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_INSTALL_EVENT_CHARS = 300;
const MAX_PUBLIC_REVIEW_SNAPSHOT_CHARS = MODEL_ABUSE_GUARD_MAX_INPUT_CHARS * 3;
const PUBLIC_REVIEW_INPUT_DIR = join(PATHS.cos, 'public-review-inputs');
export const PUBLIC_REVIEW_INPUT_FILENAME = 'PORTOS_PUBLIC_REVIEW_INPUT.json';

let cachedRuntime = null;
let installInFlight = null;
let installKill = null;

const failure = (code, extra = {}) => ({ ok: false, passed: false, safe: false, code, ...extra });
const publicReviewModelFailure = (code) => ({ ok: false, code });

const isSha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value);
const isScanKey = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
const publicReviewInputPath = (scanKey) => isScanKey(scanKey)
  ? join(PUBLIC_REVIEW_INPUT_DIR, `${scanKey}.json`)
  : null;

function normalizePublicReviewInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  if (!Number.isInteger(input.number) || input.number < 1 || !isSha(input.headSha)) return null;
  if (typeof input.title !== 'string' || typeof input.body !== 'string' || typeof input.diff !== 'string') return null;
  if (input.diff.length > MODEL_ABUSE_GUARD_MAX_INPUT_CHARS) return null;
  return {
    number: input.number,
    title: input.title,
    body: input.body,
    authorLogin: typeof input.authorLogin === 'string' ? input.authorLogin : null,
    url: typeof input.url === 'string' ? input.url : null,
    headSha: input.headSha,
    baseRefName: typeof input.baseRefName === 'string' ? input.baseRefName : null,
    behindBy: Number.isInteger(input.behindBy) ? input.behindBy : null,
    files: Array.isArray(input.files) ? input.files.filter((file) => typeof file === 'string').slice(0, 10_000) : [],
    additions: Number.isInteger(input.additions) ? input.additions : 0,
    deletions: Number.isInteger(input.deletions) ? input.deletions : 0,
    diff: input.diff,
  };
}

function normalizePublicReviewInputs(pullRequests) {
  if (!Array.isArray(pullRequests) || pullRequests.length > 200) return null;
  const normalized = pullRequests.map(normalizePublicReviewInput);
  if (normalized.some((item) => !item)) return null;
  const contentChars = normalized.reduce((total, item) => (
    total + item.title.length + item.body.length + item.diff.length
  ), 0);
  return contentChars <= MAX_PUBLIC_REVIEW_SNAPSHOT_CHARS ? normalized : null;
}

/**
 * Revalidate the Stage 2 model at spawn time.
 *
 * The picker is only a convenience boundary: schedules and API payloads can
 * be edited without the browser. A public-content review therefore cannot
 * rely on a provider/model choice that was previously accepted by the UI.
 * Require the maintained local Claude wrapper, an actually installed Ollama
 * model, and an authoritative text capability report with no `tools` entry.
 * Unknown, stale, or unprobeable capability state is rejected.
 */
export async function validatePublicReviewModel({ provider, model } = {}) {
  if (!supportsPublicReviewProvider(provider)) {
    return publicReviewModelFailure('public-review-provider-unsupported');
  }
  const modelId = typeof model === 'string' ? model.trim() : '';
  if (!modelId) return publicReviewModelFailure('public-review-model-required');

  const runtime = localRuntimeForProvider(provider);
  if (!runtime || runtime.kind !== 'ollama') {
    return publicReviewModelFailure('public-review-runtime-unsupported');
  }

  const installedModels = await listModels(runtime.kind, true).catch(() => null);
  if (!Array.isArray(installedModels)) {
    return publicReviewModelFailure('public-review-model-catalog-unavailable');
  }
  if (!installedModels.some((installed) => installed?.id === modelId)) {
    return publicReviewModelFailure('public-review-model-not-installed');
  }

  // `listModels` normalizes the catalog for presentation, but Ollama's
  // authoritative native capability vocabulary comes from `/api/show`.
  // Treat a failed or empty probe as unknown and fail closed.
  const capabilities = await ollamaManager.getModelCapabilities(modelId).catch(() => null);
  if (!hasToolFreeTextCapability(capabilities)) {
    return publicReviewModelFailure('public-review-model-not-tool-free');
  }
  return { ok: true, model: modelId, runtime: runtime.kind };
}

/**
 * Store only the already-screened PR material needed by the isolated review
 * stage. Flagged PRs are never accepted here, and the snapshot key is derived
 * from the complete preflight target set rather than a caller-supplied path.
 */
export async function writePublicReviewInputSnapshot({ scanKey, pullRequests } = {}) {
  const path = publicReviewInputPath(scanKey);
  const normalized = normalizePublicReviewInputs(pullRequests);
  if (!path || !normalized) return false;
  await atomicWrite(path, {
    schemaVersion: 1,
    scanKey,
    pullRequests: normalized,
  });
  return true;
}

/**
 * Read and validate the server-owned cleared snapshot. This is intentionally
 * separate from `materializePublicReviewInput`: the no-tools reviewer receives
 * the validated JSON in its prompt, while the read-only file remains an audit
 * copy and defense-in-depth fallback.
 */
export async function readPublicReviewInputSnapshot({ scanKey } = {}) {
  const sourcePath = publicReviewInputPath(scanKey);
  if (!sourcePath) return null;
  const raw = await tryReadFile(sourcePath);
  const parsed = safeJSONParse(raw, null, { allowArray: false, logError: false });
  if (!parsed || parsed.schemaVersion !== 1 || parsed.scanKey !== scanKey) return null;
  const pullRequests = normalizePublicReviewInputs(parsed.pullRequests);
  if (!pullRequests) return null;
  return { schemaVersion: 1, scanKey, pullRequests };
}

/**
 * Materialize a screened snapshot inside the throwaway Stage 2 worktree. The
 * review CLI can read this file in its enforced read-only posture; it never
 * needs network access or a contributor checkout to inspect the diff.
 */
export async function materializePublicReviewInput({ scanKey, workspacePath } = {}) {
  if (typeof workspacePath !== 'string' || !workspacePath) return false;
  const parsed = await readPublicReviewInputSnapshot({ scanKey });
  if (!parsed) return false;
  const destination = join(workspacePath, PUBLIC_REVIEW_INPUT_FILENAME);
  await atomicWrite(destination, parsed);
  return chmod(destination, 0o444).then(() => true).catch(() => false);
}

/**
 * Build the scanner's environment. This deliberately does not reuse the
 * normal CLI environment builder: that builder carries forge/provider auth so
 * an agent can work. Prompt Guard must receive no API keys, GitHub tokens,
 * MCP/Codex variables, provider settings, or arbitrary PYTHONPATH.
 */
export function buildModelAbuseGuardEnv(source = process.env) {
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

const emitInstall = (onEvent, event, message) => {
  if (typeof onEvent !== 'function') return;
  onEvent({ event, message: String(message || '').slice(0, MAX_INSTALL_EVENT_CHARS) });
};

function availableGuardPython() {
  if (existsSync(GUARD_PYTHON)) return GUARD_PYTHON;
  if (existsSync(FALLBACK_GUARD_PYTHON)) return FALLBACK_GUARD_PYTHON;
  return null;
}

function probeScript() {
  const imports = MODEL_ABUSE_GUARD_PYTHON_IMPORTS
    .map((name) => `import ${name}`)
    .join('; ');
  return `${imports}; print('{"ready":true}')`;
}

async function isRuntimeReady(pythonPath) {
  if (!pythonPath) return false;
  if (cachedRuntime?.pythonPath === pythonPath && cachedRuntime.ready === true) return true;
  const ready = await execFileAsync(
    pythonPath,
    ['-c', probeScript()],
    safeChildProcessOptions({
      env: buildModelAbuseGuardEnv(),
      timeout: RUNTIME_PROBE_TIMEOUT_MS,
      maxBuffer: 4_000,
    }),
  ).then(({ stdout }) => stdout.trim().split(/\r?\n/).pop() === '{"ready":true}')
    .catch(() => false);
  if (ready) cachedRuntime = { pythonPath, ready: true };
  return ready;
}

/**
 * Return operator-safe status only. Runtime paths, tokens, and exception text
 * are intentionally omitted from the API contract.
 */
export async function getModelAbuseGuardStatus() {
  const [files, pythonPath] = await Promise.all([
    findCachedRepoFiles(MODEL_ABUSE_GUARD.repository, MODEL_ABUSE_GUARD_REQUIRED_FILES, {
      revision: MODEL_ABUSE_GUARD.revision,
    }),
    Promise.resolve(availableGuardPython()),
  ]);
  const modelCached = Array.isArray(files);
  const runtimeReady = await isRuntimeReady(pythonPath);
  return {
    ...MODEL_ABUSE_GUARD,
    modelCached,
    runtimeReady,
    ready: modelCached && runtimeReady,
  };
}

/**
 * Install the fixed classifier and its private runtime. There are no request
 * parameters for repository, revision, package, or destination: all of those
 * are owned by the static contract above.
 */
export function installModelAbuseGuard({ onEvent } = {}) {
  if (installInFlight) return installInFlight;
  installInFlight = (async () => {
    const basePython = detectVenvBasePythonSync();
    if (!basePython) return failure('security-guard-python-unavailable');
    await ensureDir(dirname(GUARD_VENV_DIR));
    emitInstall(onEvent, 'stage', 'Preparing the dedicated Prompt Guard runtime…');
    const pythonPath = await createVenv(basePython, GUARD_VENV_DIR);
    cachedRuntime = null;

    emitInstall(onEvent, 'stage', 'Installing the fixed classifier runtime packages…');
    const packageRun = installPackages(pythonPath, [...MODEL_ABUSE_GUARD_PYTHON_IMPORTS], ({ type, message }) => {
      if (type === 'complete') emitInstall(onEvent, 'stage', 'Classifier runtime packages are ready.');
      else if (type === 'error') emitInstall(onEvent, 'error', 'Classifier runtime package installation failed.');
      else if (message && /install|uninstall/i.test(message)) emitInstall(onEvent, 'stage', 'Installing classifier runtime packages…');
    });
    installKill = packageRun.kill;
    const packageResult = await packageRun.promise;
    installKill = null;
    if (!packageResult?.ok) return failure('security-guard-runtime-install-failed');

    emitInstall(onEvent, 'stage', 'Downloading the pinned Prompt Guard model snapshot…');
    const download = downloadHfRepo({
      repo: MODEL_ABUSE_GUARD.repository,
      revision: MODEL_ABUSE_GUARD.revision,
      only: [...MODEL_ABUSE_GUARD_REQUIRED_FILES],
      pythonPath,
      onEvent: (event) => {
        if (event?.type === 'error') emitInstall(onEvent, 'error', 'Prompt Guard model download failed.');
        else if (event?.type === 'progress') emitInstall(onEvent, 'progress', event.stage || 'Downloading Prompt Guard…');
        else if (event?.type === 'complete') emitInstall(onEvent, 'stage', 'Pinned Prompt Guard model snapshot downloaded.');
      },
    });
    installKill = download.kill;
    const downloadResult = await download.promise;
    installKill = null;
    if (!downloadResult?.ok) return failure(downloadResult?.errorKind === 'gated_repo'
      ? 'security-guard-huggingface-access-required'
      : 'security-guard-model-download-failed');

    const status = await getModelAbuseGuardStatus();
    if (!status.ready) return failure('security-guard-install-incomplete');
    emitInstall(onEvent, 'complete', 'Prompt Guard is ready for model-abuse screening.');
    return { ok: true, ...status };
  })()
    .catch(() => failure('security-guard-install-failed'))
    .finally(() => {
      installKill = null;
      installInFlight = null;
    });
  return installInFlight;
}

export function cancelModelAbuseGuardInstall() {
  if (typeof installKill === 'function') installKill();
}

function runClassifier({ pythonPath, modelDir, content, timeoutMs }) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderrSize = 0;
    let settled = false;
    let timer = null;
    const proc = spawn(
      pythonPath,
      [HELPER_SCRIPT, '--model-dir', modelDir],
      safeChildProcessOptions({
        cwd: PATHS.root,
        env: withSpawnCwdEnv(buildModelAbuseGuardEnv(), PATHS.root),
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    );
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const appendStdout = (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > MODEL_ABUSE_GUARD_MAX_OUTPUT_CHARS) {
        proc.kill('SIGTERM');
        finish({ ok: false, code: 'security-guard-output-too-large' });
      }
    };
    proc.stdout.on('data', appendStdout);
    proc.stderr.on('data', (chunk) => {
      stderrSize += chunk.length;
      if (stderrSize > MODEL_ABUSE_GUARD_MAX_OUTPUT_CHARS) {
        proc.kill('SIGTERM');
        finish({ ok: false, code: 'security-guard-output-too-large' });
      }
    });
    proc.stdin.on('error', () => finish({ ok: false, code: 'security-guard-input-failed' }));
    proc.on('error', () => finish({ ok: false, code: 'security-guard-process-failed' }));
    proc.on('close', (code) => {
      if (settled) return;
      if (code !== 0) {
        finish({ ok: false, code: 'security-guard-process-failed' });
        return;
      }
      const parsed = safeJSONParse(stdout, null, { allowArray: false, logError: false });
      finish(parsed ? { ok: true, parsed } : { ok: false, code: 'security-guard-verdict-invalid' });
    });
    timer = setTimeout(() => {
      if (settled) return;
      proc.kill('SIGTERM');
      finish({ ok: false, code: 'security-guard-timeout' });
    }, timeoutMs);
    proc.stdin.end(JSON.stringify({ text: content }));
  });
}

/**
 * Screen one untrusted external-content item. The return value is safe to
 * persist in a report or pass as metadata: it contains no source text and no
 * raw subprocess/model response.
 */
export async function runModelAbuseScan({ content, timeoutMs = MODEL_ABUSE_GUARD_TIMEOUT_MS } = {}) {
  if (typeof content !== 'string' || !content.trim()) return failure('security-guard-empty-input');
  if (content.length > MODEL_ABUSE_GUARD_MAX_INPUT_CHARS) return failure('security-guard-input-too-large');

  const deterministicFindings = detectDeterministicModelAbuseSignals(content);
  if (deterministicFindings.length > 0) {
    return {
      ok: true,
      passed: false,
      safe: false,
      code: 'security-guard-deterministic-findings',
      guardId: MODEL_ABUSE_GUARD_ID,
      model: MODEL_ABUSE_GUARD.name,
      revision: MODEL_ABUSE_GUARD.revision,
      findings: deterministicFindings,
      chunkCount: null,
      minBenignScore: null,
      layers: { deterministic: 'blocked', classifier: 'not-run', verdict: 'validated' },
    };
  }

  const status = await getModelAbuseGuardStatus();
  if (!status.ready) return failure('security-guard-not-ready', {
    guardId: MODEL_ABUSE_GUARD_ID,
    model: MODEL_ABUSE_GUARD.name,
    revision: MODEL_ABUSE_GUARD.revision,
  });
  const modelFiles = await findCachedRepoFiles(
    MODEL_ABUSE_GUARD.repository,
    MODEL_ABUSE_GUARD_REQUIRED_FILES,
    { revision: MODEL_ABUSE_GUARD.revision },
  );
  const modelDir = modelFiles?.[0] ? dirname(modelFiles[0]) : null;
  const pythonPath = availableGuardPython();
  if (!modelDir || !pythonPath) return failure('security-guard-not-ready');

  const boundedTimeout = Number.isInteger(timeoutMs)
    ? Math.min(Math.max(timeoutMs, 1_000), MAX_SCAN_TIMEOUT_MS)
    : MODEL_ABUSE_GUARD_TIMEOUT_MS;
  const processResult = await runClassifier({ pythonPath, modelDir, content, timeoutMs: boundedTimeout })
    .catch(() => ({ ok: false, code: 'security-guard-process-failed' }));
  if (!processResult.ok) return failure(processResult.code || 'security-guard-process-failed', {
    guardId: MODEL_ABUSE_GUARD_ID,
    model: MODEL_ABUSE_GUARD.name,
    revision: MODEL_ABUSE_GUARD.revision,
  });
  const verdict = normalizeModelAbuseGuardResult(processResult.parsed, {
    minBenignScore: MODEL_ABUSE_GUARD_MIN_BENIGN_SCORE,
  });
  if (!verdict.ok) return failure(verdict.code, {
    guardId: MODEL_ABUSE_GUARD_ID,
    model: MODEL_ABUSE_GUARD.name,
    revision: MODEL_ABUSE_GUARD.revision,
  });
  return {
    ...verdict,
    passed: verdict.safe,
    guardId: MODEL_ABUSE_GUARD_ID,
    model: MODEL_ABUSE_GUARD.name,
    revision: MODEL_ABUSE_GUARD.revision,
    layers: {
      deterministic: 'passed',
      classifier: verdict.safe ? 'passed' : 'blocked',
      verdict: 'validated',
    },
  };
}

export const MODEL_ABUSE_GUARD_RUNTIME = Object.freeze({
  chunkTokens: MODEL_ABUSE_GUARD_CHUNK_TOKENS,
  chunkOverlap: MODEL_ABUSE_GUARD_CHUNK_OVERLAP,
  timeoutMs: MODEL_ABUSE_GUARD_TIMEOUT_MS,
});
