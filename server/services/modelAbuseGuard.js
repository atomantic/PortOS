/**
 * Local model-abuse screening service.
 *
 * This service is intentionally separate from the local chat completion path.
 * It runs deterministic hidden-content and model-abuse checks first, then —
 * only when the operator installed it on Models → LLMs → Abuse Guard — the
 * pinned Prompt Guard classifier in a dedicated offline Python environment. The
 * classifier receives no tools, agent prompt, repository checkout,
 * credentials, or network access.
 */

import { existsSync } from 'node:fs';
import { chmod } from 'node:fs/promises';
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
  isSha256Hex,
  modelAbuseGuardStageReadiness,
  normalizeEligibilityFacts,
  normalizeLinkedIssues,
  normalizeModelAbuseGuardResult,
} from '../lib/modelAbuseGuard.js';
import { findCachedRepoFiles } from '../lib/hfCache.js';
import { localRuntimeForProvider } from '../lib/localProviderRuntime.js';
import { publicReviewProviderBlock, PUBLIC_REVIEW_NO_TOOL_POSTURE } from '../lib/providerVendors.js';
import { withSpawnCwdEnv } from '../lib/spawnCwd.js';
import { detectVenvBasePythonSync, createVenv, installPackages } from '../lib/pythonSetup.js';
import { safeChildProcessOptions } from '../lib/processEnv.js';
// Declared in lib/ so `classifyWorktreeDirt` can subtract this scratch without
// importing this module's provider/runtime graph — see agentScratchPaths.js.
import { PUBLIC_REVIEW_INPUT_FILENAME, PUBLIC_REVIEW_PATCH_DIRNAME } from '../lib/agentScratchPaths.js';
import { downloadHfRepo } from './hfDownload.js';
import { getHfToken } from './hfToken.js';
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
const STDERR_TAIL_CHARS = 2_000;
const MAX_SCAN_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_INSTALL_EVENT_CHARS = 300;
const MAX_PUBLIC_REVIEW_SNAPSHOT_CHARS = MODEL_ABUSE_GUARD_MAX_INPUT_CHARS * 3;
const PUBLIC_REVIEW_INPUT_DIR = join(PATHS.cos, 'public-review-inputs');
export const PUBLIC_REVIEW_PATCH_MANIFEST_FILENAME = 'PORTOS_PUBLIC_REVIEW_PATCHES.json';

let cachedRuntime = null;
let installInFlight = null;
let installKill = null;

const failure = (code, extra = {}) => ({ ok: false, passed: false, safe: false, code, ...extra });
// What a report names as its guard model when only the deterministic layer ran.
export const DETERMINISTIC_ONLY_GUARD_MODEL = 'Deterministic hidden-content checks (classifier not installed)';
const publicReviewModelFailure = (code) => ({ ok: false, code });

const isSha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/i.test(value);
const publicReviewInputPath = (scanKey) => isSha256Hex(scanKey)
  ? join(PUBLIC_REVIEW_INPUT_DIR, `${scanKey}.json`)
  : null;

export { normalizeEligibilityFacts, normalizeLinkedIssues };

export function normalizePublicReviewInput(input) {
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
    eligibilityFacts: normalizeEligibilityFacts(input.eligibilityFacts),
    // The filed issue's own words. Carried through the same validation
    // boundary as the diff so a reviewer can check the change against the
    // requirement instead of inferring intent from the PR's own description.
    linkedIssues: normalizeLinkedIssues(input.linkedIssues),
    diff: input.diff,
  };
}

function normalizePublicReviewInputs(pullRequests) {
  if (!Array.isArray(pullRequests) || pullRequests.length > 200) return null;
  const normalized = pullRequests.map(normalizePublicReviewInput);
  if (normalized.some((item) => !item)) return null;
  const contentChars = normalized.reduce((total, item) => (
    total + item.title.length + item.body.length + item.diff.length
    + item.linkedIssues.reduce((chars, issue) => chars + issue.title.length + issue.body.length, 0)
  ), 0);
  return contentChars <= MAX_PUBLIC_REVIEW_SNAPSHOT_CHARS ? normalized : null;
}

/**
 * Revalidate a public-review stage's provider + model at spawn time.
 *
 * The picker is only a convenience boundary: schedules and API payloads can
 * be edited without the browser. A public-content stage therefore cannot rely
 * on a provider/model choice that was previously accepted by the UI.
 *
 * Two independent controls apply, and which one is authoritative depends on
 * where the model runs:
 *
 *  - Every provider must carry a maintained vendor recipe for the requested
 *    posture. That argv (codex `--sandbox read-only`, grok
 *    `--permission-mode plan --tools ''`, claude `--restricted --tools ''`, …)
 *    is what actually denies tools to a CLOUD model, which PortOS cannot probe.
 *  - A LOCAL runtime can be probed, so it gets the stricter check it always
 *    had: the model must be installed and its authoritative capability report
 *    must contain no `tools` entry. Unknown or unprobeable state fails closed.
 *
 * A model id is required only where PortOS picks one. Vendors that select
 * their own model (grok, antigravity) legitimately run with no `--model` pin.
 */
export async function validatePublicReviewModel({ provider, model, posture = PUBLIC_REVIEW_NO_TOOL_POSTURE } = {}) {
  // Reuse the gate's own descriptor rather than re-deriving it. This takes a
  // `posture` but hardcoded the NO-TOOL category, so a sandboxed-actions
  // failure reported `public-review-provider-unsupported` for every provider.
  // Latent today (the one caller passes the no-tool literal), but it fails
  // closed with a plausible-looking wrong code, which is harder to diagnose
  // than the outage #5866 fixed.
  const postureBlock = publicReviewProviderBlock(provider, posture);
  if (postureBlock) return publicReviewModelFailure(postureBlock.category);
  const modelId = typeof model === 'string' ? model.trim() : '';
  const runtime = localRuntimeForProvider(provider);
  if (!runtime) return { ok: true, model: modelId || null, runtime: null };

  // Local runtimes are probeable, so the capability report is authoritative
  // and a model id is mandatory — there is no server-side default to fall back
  // to for an Ollama/LM Studio wrapper.
  if (!modelId) return publicReviewModelFailure('public-review-model-required');
  if (runtime.kind !== 'ollama') {
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
 * separate from `materializePublicReviewInput`: the reviewer receives the
 * validated JSON in its prompt, while the read-only file remains an audit copy
 * and defense-in-depth fallback. An optional allowlist is applied only after
 * the complete snapshot has been validated, so Stage 3 cannot widen its input.
 */
export async function readPublicReviewInputSnapshot({ scanKey, allowedPullRequestNumbers = null } = {}) {
  const sourcePath = publicReviewInputPath(scanKey);
  if (!sourcePath) return null;
  const raw = await tryReadFile(sourcePath);
  const parsed = safeJSONParse(raw, null, { allowArray: false, logError: false });
  if (!parsed || parsed.schemaVersion !== 1 || parsed.scanKey !== scanKey) return null;
  const pullRequests = normalizePublicReviewInputs(parsed.pullRequests);
  if (!pullRequests) return null;
  const allowed = Array.isArray(allowedPullRequestNumbers)
    ? new Set(allowedPullRequestNumbers.filter((number) => Number.isInteger(number) && number > 0))
    : null;
  return {
    schemaVersion: 1,
    scanKey,
    pullRequests: allowed ? pullRequests.filter((pullRequest) => allowed.has(pullRequest.number)) : pullRequests,
  };
}

/**
 * Materialize a screened snapshot inside the throwaway review worktree. The
 * review CLI can read this file in its enforced posture; it never
 * needs network access or a contributor checkout to inspect the diff.
 */
export async function materializePublicReviewInput({ scanKey, workspacePath, allowedPullRequestNumbers = null } = {}) {
  if (typeof workspacePath !== 'string' || !workspacePath) return false;
  const parsed = await readPublicReviewInputSnapshot({ scanKey, allowedPullRequestNumbers });
  if (!parsed) return false;
  const destination = join(workspacePath, PUBLIC_REVIEW_INPUT_FILENAME);
  await atomicWrite(destination, parsed);
  return chmod(destination, 0o444).then(() => true).catch(() => false);
}

/**
 * Materialize one screened unified diff per eligible PR for the final review
 * stage. The files live only in that stage's disposable worktree and are
 * read-only, so the sandboxed reviewer can apply them with `git apply` and run
 * tests without fetching a contributor branch or contacting the forge. The
 * manifest contains only safe identities and relative paths; source text stays
 * in the patch files and the already-validated input envelope.
 */
export async function materializePublicReviewPatches({ scanKey, workspacePath, allowedPullRequestNumbers = null } = {}) {
  if (typeof workspacePath !== 'string' || !workspacePath) return false;
  const parsed = await readPublicReviewInputSnapshot({ scanKey, allowedPullRequestNumbers });
  if (!parsed) return false;

  const patchDir = join(workspacePath, PUBLIC_REVIEW_PATCH_DIRNAME);
  await ensureDir(patchDir);
  const patches = [];
  for (const pullRequest of parsed.pullRequests) {
    const filename = `PR-${pullRequest.number}.patch`;
    const relativePath = `${PUBLIC_REVIEW_PATCH_DIRNAME}/${filename}`;
    const destination = join(patchDir, filename);
    // The gh wrapper trims stdout, which drops the diff's final newline; git
    // apply then rejects the file as "corrupt patch at line N". Restore it so
    // the reviewer can apply the patch verbatim (the fingerprint is computed
    // on the trimmed text upstream and is unaffected).
    await atomicWrite(destination, pullRequest.diff.endsWith('\n') ? pullRequest.diff : `${pullRequest.diff}\n`);
    const restricted = await chmod(destination, 0o444).then(() => true).catch(() => false);
    if (!restricted) return false;
    patches.push({
      number: pullRequest.number,
      headSha: pullRequest.headSha,
      contentFingerprint: pullRequest.contentFingerprint || null,
      path: relativePath,
    });
  }

  const manifest = join(patchDir, PUBLIC_REVIEW_PATCH_MANIFEST_FILENAME);
  await atomicWrite(manifest, {
    schemaVersion: 1,
    scanKey,
    patches,
  });
  return chmod(manifest, 0o444).then(() => true).catch(() => false);
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

const emitInstall = (onEvent, event, message, stage) => {
  if (typeof onEvent !== 'function') return;
  onEvent({
    event,
    message: String(message || '').slice(0, MAX_INSTALL_EVENT_CHARS),
    ...(stage ? { stage } : {}),
  });
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

// A benign sentence the helper must classify end to end before the guard
// reports ready. Importing the packages proves the venv, not the classifier:
// a helper that loads the model and then dies on the first window (the
// unbatched-tensor bug that failed every Stage 1 scan on transformers 4.57)
// passed the import probe and only surfaced as a bare
// `security-guard-process-failed` at scan time.
const RUNTIME_CANARY_TEXT = 'The quick brown fox jumps over the lazy dog.';

async function isRuntimeReady(pythonPath, modelDir = null) {
  if (!pythonPath) return false;
  if (cachedRuntime?.pythonPath === pythonPath && cachedRuntime.modelDir === modelDir && cachedRuntime.ready === true) return true;
  const importsReady = await execFileAsync(
    pythonPath,
    ['-c', probeScript()],
    safeChildProcessOptions({
      env: buildModelAbuseGuardEnv(),
      timeout: RUNTIME_PROBE_TIMEOUT_MS,
      maxBuffer: 4_000,
    }),
  ).then(({ stdout }) => stdout.trim().split(/\r?\n/).pop() === '{"ready":true}')
    .catch(() => false);
  const ready = importsReady && (!modelDir || await canaryPasses(pythonPath, modelDir));
  if (ready) cachedRuntime = { pythonPath, modelDir, ready: true };
  return ready;
}

async function canaryPasses(pythonPath, modelDir) {
  const result = await runClassifier({ pythonPath, modelDir, content: RUNTIME_CANARY_TEXT, timeoutMs: RUNTIME_PROBE_TIMEOUT_MS })
    .catch(() => ({ ok: false }));
  if (!result.ok) return false;
  const verdict = normalizeModelAbuseGuardResult(result.parsed, { minBenignScore: MODEL_ABUSE_GUARD_MIN_BENIGN_SCORE });
  return verdict.ok === true && verdict.safe === true;
}

/**
 * Return operator-safe status only. Runtime paths, tokens, and exception text
 * are intentionally omitted from the API contract.
 */
export async function getModelAbuseGuardStatus() {
  const [files, pythonPath, huggingfaceTokenPresent] = await Promise.all([
    findCachedRepoFiles(MODEL_ABUSE_GUARD.repository, MODEL_ABUSE_GUARD_REQUIRED_FILES, {
      revision: MODEL_ABUSE_GUARD.revision,
    }),
    Promise.resolve(availableGuardPython()),
    getHfToken().then((token) => Boolean(token)).catch(() => false),
  ]);
  const modelCached = Array.isArray(files);
  const venvReady = Boolean(pythonPath);
  const pythonAvailable = Boolean(detectVenvBasePythonSync());
  const runtimeReady = await isRuntimeReady(pythonPath, modelCached && files[0] ? dirname(files[0]) : null);
  const { stages, ready } = modelAbuseGuardStageReadiness({
    huggingfaceTokenPresent,
    pythonAvailable,
    venvReady,
    runtimeReady,
    modelCached,
  });
  return {
    ...MODEL_ABUSE_GUARD,
    modelCached,
    runtimeReady,
    pythonAvailable,
    venvReady,
    stages,
    ready,
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
    // Do this before creating a venv or installing packages. The model is gated
    // on Hugging Face, so a missing token is an operator prerequisite—not a
    // reason to leave a half-useful runtime behind and discover the problem
    // only after setup has changed the install.
    if (!(await getHfToken())) return failure('security-guard-huggingface-token-required');
    const basePython = detectVenvBasePythonSync();
    if (!basePython) return failure('security-guard-python-unavailable');
    await ensureDir(dirname(GUARD_VENV_DIR));
    emitInstall(onEvent, 'stage', 'Preparing the dedicated Prompt Guard runtime…', 'venv');
    const pythonPath = await createVenv(basePython, GUARD_VENV_DIR);
    cachedRuntime = null;

    emitInstall(onEvent, 'stage', 'Installing the fixed classifier runtime packages…', 'packages');
    const packageRun = installPackages(pythonPath, [...MODEL_ABUSE_GUARD_PYTHON_IMPORTS], ({ type, message }) => {
      if (type === 'complete') emitInstall(onEvent, 'stage', 'Classifier runtime packages are ready.', 'packages');
      else if (type === 'error') emitInstall(onEvent, 'error', 'Classifier runtime package installation failed.', 'packages');
      else if (message && /install|uninstall/i.test(message)) emitInstall(onEvent, 'stage', 'Installing classifier runtime packages…', 'packages');
    });
    installKill = packageRun.kill;
    const packageResult = await packageRun.promise;
    installKill = null;
    if (!packageResult?.ok) return failure('security-guard-runtime-install-failed');

    emitInstall(onEvent, 'stage', 'Downloading the pinned Prompt Guard model snapshot…', 'model');
    const download = downloadHfRepo({
      repo: MODEL_ABUSE_GUARD.repository,
      revision: MODEL_ABUSE_GUARD.revision,
      only: [...MODEL_ABUSE_GUARD_REQUIRED_FILES],
      pythonPath,
      onEvent: (event) => {
        if (event?.type === 'error') emitInstall(onEvent, 'error', 'Prompt Guard model download failed.', 'model');
        else if (event?.type === 'progress') emitInstall(onEvent, 'progress', event.stage || 'Downloading Prompt Guard…', 'model');
        else if (event?.type === 'complete') emitInstall(onEvent, 'stage', 'Pinned Prompt Guard model snapshot downloaded.', 'model');
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
    let stderr = '';
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
      // Keep only a bounded tail: the helper never echoes its input, and the
      // last line is the `Prompt Guard failed: <reason>` the operator needs.
      stderr = (stderr + chunk.toString()).slice(-STDERR_TAIL_CHARS);
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
        const reason = stderr.trim().split('\n').filter(Boolean).pop() || 'no stderr';
        console.error(`❌ Prompt Guard helper exited with code ${code}: ${reason.slice(0, 300)}`);
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
 * A validated verdict from the deterministic layer alone — either it blocked
 * (so the classifier was never asked) or the classifier is not installed.
 */
const deterministicVerdict = (findings, classifier) => ({
  ok: true,
  passed: findings.length === 0,
  safe: findings.length === 0,
  code: findings.length ? 'security-guard-deterministic-findings' : 'security-guard-passed',
  guardId: MODEL_ABUSE_GUARD_ID,
  model: DETERMINISTIC_ONLY_GUARD_MODEL,
  revision: null,
  findings,
  chunkCount: null,
  minBenignScore: null,
  layers: { deterministic: findings.length ? 'blocked' : 'passed', classifier, verdict: 'validated' },
});

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
    return deterministicVerdict(deterministicFindings, 'not-run');
  }

  // The classifier is an OPTIONAL second layer, managed on Models → LLMs →
  // Abuse Guard. The deterministic checks above are the boundary Stage 1
  // exists for (content hidden from a human reader, obvious model-directed
  // harm); an install that never provisioned the gated Prompt Guard weights
  // still gets that boundary instead of a scan that can never complete.
  const status = await getModelAbuseGuardStatus();
  if (!status.ready) return deterministicVerdict([], 'not-installed');
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
