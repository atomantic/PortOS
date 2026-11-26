/** AuK-Flash MLX: explicit installation, lazy resident inference, bounded lifetime. */
import { access, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { spawn } from '../../lib/childProcess.js';
import { awaitWithAbort } from '../../lib/abortTimeout.js';
import { terminateWithEscalation } from '../../lib/bufferedSpawn.js';
import { trackDetachedGroup } from '../../lib/credentialBootstrap.js';
import { safeChildProcessOptions } from '../../lib/processEnv.js';
import { installLockedRuntime, resolvePatchedUv } from '../../lib/pythonSetup.js';
import { ServerError } from '../../lib/errorHandler.js';
import { withSpawnCwdEnv } from '../../lib/spawnCwd.js';
import { PATHS } from '../../lib/paths.js';
import { chunkRawText } from '../../lib/catalog/catalogChunking.js';
import { isAppleSilicon } from '../../lib/platform.js';

import { trackedRenderMap } from '../renderActivity.js';
const AUK_REVISION = '6943a1e967409e8c73139a7a345f2a611cfb3dd6';
// The runtime reads both of these at start (`config.yaml`, the Qwen preprocessor).
// Neither is prunable. The converted MLX files are a separate directory.
export const AUK_WEIGHT_SOURCES = Object.freeze([
  { directory: 'AuK-Flash', repo: 'tencent/AuK-Flash', revision: '575b92f0895f75180bf2cbd35f2e176c5732b8ed', prunable: false },
  { directory: 'Qwen2.5-Omni-3B', repo: 'Qwen/Qwen2.5-Omni-3B', revision: 'f75b40e3da2003cdd6e1829b1f420ca70797c34e', prunable: false },
]);
// scripts/ml/requirements/requirements-auk-mlx.lock.txt is resolved for CPython 3.11+ (3.10 would need a different filelock).
const AUK_PYTHON = '3.11';
const INSTALL_TIMEOUT_MS = 30 * 60_000;
const root = join(homedir(), '.portos', 'auk');
const python = join(root, '.venv', 'bin', 'python');
const incompleteSetup = join(root, '.setup-incomplete');
const setupJobs = trackedRenderMap('voice-auk-setup', { noun: 'AuK voice setup', link: () => '/voices' });
const supported = () => isAppleSilicon();
let setup = { state: 'idle', stage: null, error: null };
let worker = null;
let pending = null;
let idleTimer = null;
const present = path => access(path).then(() => true, () => false);
const required = ['.venv/bin/python', 'ckpts/AuK-Flash/config.yaml', 'ckpts/mlx/vae.safetensors',
  'ckpts/mlx/dit_flash.safetensors', 'ckpts/mlx/fusion_flash.safetensors',
  'ckpts/mlx/thinker/thinker.safetensors', 'ckpts/mlx/thinker/thinker_config.json',
  'ckpts/Qwen2.5-Omni-3B/preprocessor_config.json'];

const haveArtifacts = async () => (await Promise.all(required.map(file => present(join(root, file))))).every(Boolean);

export async function getAukStatus() {
  const ready = supported() && await haveArtifacts() && !(await present(incompleteSetup));
  return { supported: supported(), ready, loaded: Boolean(worker), busy: Boolean(pending), ...setup };
}

function runSetupCommand(command, args, cwd, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, safeChildProcessOptions({
      cwd, env: withSpawnCwdEnv(process.env, cwd), stdio: 'ignore', detached: true,
    }));
    trackDetachedGroup(child, true);
    let failure;
    let cancelEscalation;
    child.on('error', error => { failure = error; });
    child.once('close', (code, exitSignal) => {
      clearTimeout(timer);
      cancelEscalation?.();
      signal.removeEventListener('abort', stop);
      if (failure) reject(failure);
      else if (code === 0) resolve();
      else reject(Object.assign(new Error('AuK setup command failed'), { code, signal: exitSignal }));
    });
    // Give Git time to remove its lock files on SIGTERM, then force-stop the
    // process group if it is still running.
    const stop = () => {
      cancelEscalation ??= terminateWithEscalation(child, { graceMs: 1000, label: 'AuK setup command', processGroup: true });
    };
    const timer = setTimeout(stop, INSTALL_TIMEOUT_MS);
    signal.addEventListener('abort', stop, { once: true });
  });
}

// Log the stage and bounded diagnostic codes. Child output, command arguments
// and exception messages may contain private paths or authenticated URLs.
function setupFailureDetail(error) {
  if (Number.isInteger(error?.code)) return `exit code ${error.code}`;
  if (['SIGKILL', 'SIGTERM', 'SIGINT'].includes(error?.signal)) return error.signal;
  if (['ENOENT', 'EACCES', 'EPERM', 'ENOSPC', 'EIO', 'EROFS', 'EEXIST', 'ENOTEMPTY'].includes(error?.code)) return error.code;
  return error instanceof ServerError ? `status ${error.status}` : 'unexpected error';
}

export function startAukSetup(notify = () => {}) {
  if (!supported()) throw new ServerError('AuK local setup requires Apple Silicon macOS.', { status: 409 });
  if (setup.state === 'running' || pending) throw new ServerError('AuK is busy.', { status: 409 });
  if (worker) unloadAuk();
  const controller = new AbortController();
  const { signal } = controller;
  let notifyFailed = false;
  const logNotifyFailure = () => {
    if (notifyFailed) return;
    notifyFailed = true;
    console.error('❌ AuK setup status notification failed.');
  };
  const publish = () => {
    try { Promise.resolve(notify()).catch(logNotifyFailure); }
    catch { logNotifyFailure(); }
  };
  setup = { state: 'running', stage: 'Preparing isolated runtime', error: null };
  const reportStage = label => {
    signal.throwIfAborted();
    setup = { ...setup, stage: label };
    publish();
    signal.throwIfAborted();
  };
  const stage = (label, command, args, cwd = root) => {
    reportStage(label);
    return runSetupCommand(command, args, cwd, signal);
  };
  const install = async () => {
    signal.throwIfAborted();
    // The private uv bootstrap is shared by several installers. Stop this
    // caller's wait on cancel; the bootstrap may still serve another caller.
    const resolved = await awaitWithAbort(resolvePatchedUv(() => {}), signal);
    if (!resolved.ok) throw new ServerError(`${resolved.reason} Then retry AuK setup.`, { status: 503 });
    const uv = resolved.uv;
    await mkdir(root, { recursive: true });
    if (!(await present(join(root, '.git')))) {
      // An interrupted clone must leave the runtime retryable and preserve
      // any weights already present in the runtime root.
      signal.throwIfAborted();
      const checkout = await mkdtemp(join(root, '.setup-'));
      try {
        await stage('Downloading AuK source', 'git', ['clone', '--no-checkout', '--depth', '1', '--branch', 'feat/mlx-apple-silicon',
          'https://github.com/Tencent-Hunyuan/AuK.git', checkout], homedir());
        signal.throwIfAborted();
        await rename(join(checkout, '.git'), join(root, '.git'));
      } finally {
        await rm(checkout, { recursive: true, force: true });
      }
    }
    await stage('Pinning compatible AuK backend', 'git', ['fetch', '--depth', '1', 'origin', AUK_REVISION]);
    signal.throwIfAborted();
    // A repair can leave the old weights in place while replacing code and
    // dependencies. File presence alone cannot prove that runtime is usable.
    await writeFile(incompleteSetup, '');
    await stage('Checking out compatible backend', 'git', ['checkout', '--detach', AUK_REVISION]);
    // Always rebuilt: the lock is the whole environment, so a reused venv could keep
    // stale or unverified packages (including one older than the lock's CPython floor).
    await stage('Creating Python environment', uv, ['venv', '--clear', '--python', AUK_PYTHON, join(root, '.venv')]);
    reportStage('Installing MLX dependencies');
    // Hash-pinned closure first, then the pinned checkout itself editable with no
    // resolution and its (locked) build backend: nothing unpinned is fetched.
    const locked = installLockedRuntime(python, 'auk-mlx', () => {}, {
      verifiedUv: uv, processGroup: true, env: withSpawnCwdEnv(process.env, root),
      sourceInstalls: [['install', '--no-deps', '--no-build-isolation', '-e', root]],
    });
    signal.addEventListener('abort', locked.kill, { once: true });
    const timer = setTimeout(locked.kill, INSTALL_TIMEOUT_MS);
    try {
      const installed = await locked.promise;
      if (!installed.ok) throw Object.assign(new Error('Dependency installation failed'), { code: installed.code });
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', locked.kill);
    }
    for (const { repo, directory, revision } of AUK_WEIGHT_SOURCES) {
      await stage(`Downloading ${directory} weights`, python, ['-c',
        'from huggingface_hub import snapshot_download; import json, sys; from pathlib import Path; '
        + 'repo, dest, rev = sys.argv[1], Path(sys.argv[2]), sys.argv[3]; '
        + 'snapshot_download(repo_id=repo, revision=rev, local_dir=str(dest)); '
        + '(dest / "portos-source.json").write_text(json.dumps({"sourceRepo": repo, "sourceRevision": rev, "prunable": False}))',
        repo, join(root, 'ckpts', directory), revision]);
    }
    for (const args of [
      ['vae', 'ckpts/AuK-Flash/vae.safetensors', 'ckpts/mlx/vae.safetensors'],
      ['dit', 'ckpts/AuK-Flash/auk_flash.safetensors', 'ckpts/mlx/dit_flash.safetensors'],
      ['thinker', 'ckpts/Qwen2.5-Omni-3B', 'ckpts/mlx/thinker'],
    ]) await stage(`Converting ${args[0]} for Apple Silicon`, python, ['-m', 'auk_mlx.convert', ...args]);
    reportStage('Verifying installed runtime');
    if (!await haveArtifacts()) throw new Error('Required model artifacts are missing');
    signal.throwIfAborted();
    await rm(incompleteSetup, { force: true });
  };
  const job = { controller, done: null };
  setupJobs.set('auk', job);
  const canceled = { state: 'canceled', stage: 'Setup canceled', error: null };
  const finish = status => {
    setup = status;
    setupJobs.delete('auk');
    publish();
  };
  job.done = Promise.resolve().then(install).then(() => {
    finish(signal.aborted ? canceled : { state: 'complete', stage: 'Ready', error: null });
  }, error => {
    if (signal.aborted) {
      finish(canceled);
      return;
    }
    console.error(`❌ AuK setup failed during ${setup.stage}: ${setupFailureDetail(error)}.`);
    finish({ state: 'failed', stage: setup.stage, error: error instanceof ServerError
      ? error.message : 'AuK setup failed. Check network access, free disk space, and retry.' });
  }).catch(() => console.error('❌ AuK setup completion failed.'));
  publish();
  return { ...setup };
}

export async function cancelAukSetup() {
  const job = setupJobs.get('auk');
  if (job) {
    job.controller.abort();
    await job.done;
  }
  return getAukStatus();
}

export function unloadAuk() {
  if (pending) throw new ServerError('Wait for the current voice render before unloading.', { status: 409 });
  clearTimeout(idleTimer);
  worker?.kill('SIGKILL');
  worker = null;
}

function ensureWorker() {
  if (worker) return worker;
  const child = spawn(python, [join(PATHS.root, 'scripts', 'ml', 'auk_voice_worker.py'), root],
    safeChildProcessOptions({ cwd: root, env: withSpawnCwdEnv(process.env, root), stdio: ['pipe', 'pipe', 'pipe'] }));
  worker = child;
  // Drain diagnostics without copying prompts, paths, or model data into shared logs.
  child.stderr.on('data', () => {});
  const lines = createInterface({ input: child.stdout });
  // A broken stdin or failed spawn leaves a dead handle; tear it down so the next call re-spawns.
  const teardown = (message, status) => {
    lines.close();
    if (worker === child) worker = null;
    if (pending?.child === child) pending.reject(new ServerError(message, { status }));
    child.kill('SIGKILL');
  };
  child.stdin.on('error', () => teardown('AuK input stream closed.', 502));
  lines.on('line', line => {
    if (!pending || pending.child !== child) return;
    let response;
    try { response = JSON.parse(line); } catch { pending.reject(new Error('Invalid AuK worker response')); return; }
    if (response.ok) pending.resolve(response);
    else pending.reject(new ServerError(`AuK inference failed (${response.error || 'runtime error'}).`, { status: 502 }));
  });
  child.on('error', () => teardown('AuK could not start. Run setup again.', 503));
  child.on('close', () => {
    lines.close();
    if (worker === child) worker = null;
    if (pending?.child === child) pending.reject(new ServerError('AuK worker stopped before producing audio.', { status: 502 }));
  });
  return child;
}

export async function synthesizeAuk(text, opts = {}, signal) {
  if (pending || setup.state === 'running') throw new ServerError('AuK is busy. Wait for the current operation.', { status: 409 });
  if (!(await getAukStatus()).ready) throw new ServerError('Set up AuK in Voice Studio before generating speech.', { status: 503 });
  if (signal?.aborted) throw new ServerError('Voice render canceled.', { status: 409 });
  // Reserve after the asynchronous readiness check as well.
  if (pending || setup.state === 'running') throw new ServerError('AuK is busy.', { status: 409 });
  const rate = opts.rate || 1;
  const duration = value => Math.max(2, Math.max(value.trim().split(/\s+/).length,
    (value.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/gu) || []).length / 2) / (2.5 * rate));
  const split = value => {
    const seconds = duration(value);
    if (seconds <= 12) return [{ text: value, seconds }];
    return chunkRawText(value, { maxChars: Math.max(1, Math.floor(value.length * 10 / seconds)), maxChunks: 1000 }).flatMap(split);
  };
  const segments = opts.genSeconds ? [{ text, seconds: opts.genSeconds }] : split(text);
  if (segments.length > 32 || segments.some(segment => segment.seconds > 12)) {
    throw new ServerError('This voice render is too long. Split it into shorter dialogue turns.', { status: 400 });
  }
  const output = join(tmpdir(), `portos-auk-${randomUUID()}.wav`);
  const child = ensureWorker();
  clearTimeout(idleTimer);
  let timer;
  const abort = () => { child.kill('SIGKILL'); };
  const result = new Promise((resolve, reject) => {
    pending = { child, resolve, reject };
    timer = setTimeout(abort, 180_000);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdin.write(`${JSON.stringify({ segments, instructions: opts.instructions || 'Natural, clear speaking voice',
      referenceAudio: opts.referenceAudio || null, seed: opts.seed ?? 42,
      pitchSemitones: opts.pitchSemitones || 0, output })}\n`, error => {
      if (!error) return;
      if (worker === child) worker = null;
      reject(new ServerError('AuK request could not be sent.', { status: 502 }));
      child.kill('SIGKILL');
    });
  });
  return result.then(async meta => ({ ...meta, wav: await readFile(output), engine: 'auk',
    modelRevision: 'tencent/AuK-Flash:mlx-8bit',
    effectiveControls: { rate: opts.rate || 1, pitchSemitones: opts.pitchSemitones || 0, seed: opts.seed ?? 42 },
  })).finally(async () => {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    pending = null;
    idleTimer = setTimeout(() => { if (!pending) unloadAuk(); }, 10 * 60_000);
    idleTimer.unref?.();
    await Promise.all([output, `${output}.source.wav`, `${output}.reference.wav`].map(file => rm(file, { force: true })));
  });
}
