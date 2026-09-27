/** AuK-Flash MLX: explicit installation, lazy resident inference, bounded lifetime. */
import { access, mkdir, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline';
import { execFile, spawn } from '../../lib/childProcess.js';
import { safeChildProcessOptions, whichFirst } from '../../lib/processEnv.js';
import { ServerError } from '../../lib/errorHandler.js';
import { withSpawnCwdEnv } from '../../lib/spawnCwd.js';
import { PATHS } from '../../lib/paths.js';
import { chunkRawText } from '../../lib/catalogChunking.js';

const run = promisify(execFile);
const AUK_REVISION = '6943a1e967409e8c73139a7a345f2a611cfb3dd6';
const root = join(homedir(), '.portos', 'auk');
const python = join(root, '.venv', 'bin', 'python');
const supported = () => process.platform === 'darwin' && process.arch === 'arm64';
let setup = { state: 'idle', stage: null, error: null };
let worker = null;
let pending = null;
let idleTimer = null;
const present = path => access(path).then(() => true, () => false);
const required = ['.venv/bin/python', 'ckpts/AuK-Flash/config.yaml', 'ckpts/mlx/vae.safetensors',
  'ckpts/mlx/dit_flash.safetensors', 'ckpts/mlx/fusion_flash.safetensors',
  'ckpts/mlx/thinker/thinker.safetensors', 'ckpts/mlx/thinker/thinker_config.json',
  'ckpts/Qwen2.5-Omni-3B/preprocessor_config.json'];

export async function getAukStatus() {
  const ready = supported() && (await Promise.all(required.map(file => present(join(root, file))))).every(Boolean);
  return { supported: supported(), ready, loaded: Boolean(worker), busy: Boolean(pending), ...setup };
}

export function startAukSetup(notify = () => {}) {
  if (!supported()) throw new ServerError('AuK local setup requires Apple Silicon macOS.', { status: 409 });
  if (setup.state === 'running' || pending) throw new ServerError('AuK is busy.', { status: 409 });
  if (worker) unloadAuk();
  setup = { state: 'running', stage: 'Preparing isolated runtime', error: null };
  notify();
  const stage = async (label, command, args, cwd = root) => {
    setup = { ...setup, stage: label };
    notify();
    await run(command, args, safeChildProcessOptions({ cwd, env: withSpawnCwdEnv(process.env, cwd), timeout: 30 * 60_000, killSignal: 'SIGKILL', maxBuffer: 2 * 1024 * 1024 }));
  };
  const install = async () => {
    const uv = await whichFirst('uv');
    if (!uv) throw new ServerError('Install uv, then retry AuK setup.', { status: 503 });
    await mkdir(root, { recursive: true });
    if (!(await present(join(root, '.git')))) {
      await stage('Downloading AuK source', 'git', ['clone', '--depth', '1', '--branch', 'feat/mlx-apple-silicon',
        'https://github.com/Tencent-Hunyuan/AuK.git', root], homedir());
    }
    await stage('Pinning compatible AuK backend', 'git', ['fetch', '--depth', '1', 'origin', AUK_REVISION]);
    await stage('Checking out compatible backend', 'git', ['checkout', '--detach', AUK_REVISION]);
    if (!(await present(python))) await stage('Creating Python environment', uv, ['venv', '--python', '3.10', join(root, '.venv')]);
    await stage('Installing MLX dependencies', uv, ['pip', 'install', '--python', python, '-e', `${root}[mlx]`, 'huggingface_hub']);
    for (const [repo, directory] of [['tencent/AuK-Flash', 'AuK-Flash'], ['Qwen/Qwen2.5-Omni-3B', 'Qwen2.5-Omni-3B']]) {
      await stage(`Downloading ${directory} weights`, python, ['-c',
        'from huggingface_hub import snapshot_download; import sys; snapshot_download(repo_id=sys.argv[1], local_dir=sys.argv[2])',
        repo, join(root, 'ckpts', directory)]);
    }
    for (const args of [
      ['vae', 'ckpts/AuK-Flash/vae.safetensors', 'ckpts/mlx/vae.safetensors'],
      ['dit', 'ckpts/AuK-Flash/auk_flash.safetensors', 'ckpts/mlx/dit_flash.safetensors'],
      ['thinker', 'ckpts/Qwen2.5-Omni-3B', 'ckpts/mlx/thinker'],
    ]) await stage(`Converting ${args[0]} for Apple Silicon`, python, ['-m', 'auk_mlx.convert', ...args]);
    if (!(await getAukStatus()).ready) throw new Error('Required model artifacts are missing');
  };
  install().then(() => {
    setup = { state: 'complete', stage: 'Ready', error: null };
    notify();
  }, error => {
    setup = { state: 'failed', stage: setup.stage, error: error instanceof ServerError
      ? error.message : 'AuK setup failed. Check network access, free disk space, and retry.' };
    notify();
  });
  return { ...setup };
}

export function unloadAuk() {
  if (pending) throw new ServerError('Wait for the current voice render before unloading.', { status: 409 });
  clearTimeout(idleTimer);
  worker?.kill('SIGKILL');
  worker = null;
}

function ensureWorker() {
  if (worker) return worker;
  const child = spawn(python, [join(PATHS.root, 'scripts', 'auk_voice_worker.py'), root],
    safeChildProcessOptions({ cwd: root, env: withSpawnCwdEnv(process.env, root), stdio: ['pipe', 'pipe', 'pipe'] }));
  worker = child;
  // Drain diagnostics without copying prompts, paths, or model data into shared logs.
  child.stderr.on('data', () => {});
  child.stdin.on('error', () => { if (pending?.child === child) pending.reject(new ServerError('AuK input stream closed.', { status: 502 })); });
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    if (!pending || pending.child !== child) return;
    let response;
    try { response = JSON.parse(line); } catch { pending.reject(new Error('Invalid AuK worker response')); return; }
    if (response.ok) pending.resolve(response);
    else pending.reject(new ServerError(`AuK inference failed (${response.error || 'runtime error'}).`, { status: 502 }));
  });
  child.on('error', () => pending?.child === child && pending.reject(new ServerError('AuK could not start. Run setup again.', { status: 503 })));
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
      if (error) reject(new ServerError('AuK request could not be sent.', { status: 502 }));
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
