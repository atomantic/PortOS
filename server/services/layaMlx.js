/** Explicit, experimental Laya execution. No boot hooks, automatic routing or prompt persistence. */
import { notifyLayaStatus } from './layaMlxEvents.js';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from '../lib/childProcess.js';
import { PATHS } from '../lib/paths.js';
import { isAppleSilicon } from '../lib/platform.js';
import { LAYA_MLX, layaScoreRequestSchema, normalizeLayaResult } from '../lib/layaMlx.js';

const execFileAsync = promisify(execFile);
const root = () => join(PATHS.data, 'python', 'laya-mlx');
const python = () => join(root(), 'venv', 'bin', 'python3');
const model = () => join(root(), 'model');
const marker = () => join(root(), 'installed.json');
const script = () => join(PATHS.root, 'scripts', 'run_laya_mlx.py');
let installation = null;
let stage = null;
let installError = null;
let scoring = false;
const failure = code => ({ ok: false, code });

// These processes receive neither provider credentials nor arbitrary Python paths.
function environment(offline = true) {
  const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL']
    .filter(key => process.env[key] != null).map(key => [key, process.env[key]]));
  return { ...env, PYTHONNOUSERSITE: '1', HF_HUB_DISABLE_TELEMETRY: '1',
    TOKENIZERS_PARALLELISM: 'false', ...(offline ? { HF_HUB_OFFLINE: '1' } : {}) };
}

export async function getLayaStatus() {
  const supported = isAppleSilicon();
  const installed = await readFile(marker(), 'utf8').then(JSON.parse).catch(() => null);
  const ready = supported && installed?.revision === LAYA_MLX.revision
    && installed?.runtimeRevision === LAYA_MLX.runtimeRevision
    && existsSync(python()) && ['model.safetensors', 'rl_agent_config.json', 'encoder/config.json', 'tokenizer/tokenizer.json']
      .every(file => existsSync(join(model(), file)));
  return { ...LAYA_MLX, supported, ready: !!ready, installing: !!installation, stage, installError, scoring };
}

async function performInstall() {
  const { detectVenvBasePythonSync } = await import('../lib/pythonSetup.js');
  stage = 'python';
  notifyLayaStatus();
  const base = detectVenvBasePythonSync();
  if (!base) throw new Error('python');
  await execFileAsync(base, ['-c', 'import sys,platform; assert sys.version_info >= (3,11) and platform.machine() == "arm64" and int(platform.mac_ver()[0].split(".")[0]) >= 14'],
    { env: environment(), timeout: 10000, maxBuffer: 4096 });
  await mkdir(root(), { recursive: true });
  await unlink(marker()).catch(error => { if (error.code !== 'ENOENT') throw error; });
  stage = 'runtime';
  notifyLayaStatus();
  await execFileAsync(base, ['-m', 'venv', join(root(), 'venv')], { env: environment(), timeout: 120000, maxBuffer: 4096 });
  await execFileAsync(python(), ['-m', 'pip', 'install', '--force-reinstall', '--disable-pip-version-check',
    `https://github.com/mizorewww/laya-mlx/archive/${LAYA_MLX.runtimeRevision}.zip`],
  { env: environment(false), timeout: 600000, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL' });
  stage = 'model';
  notifyLayaStatus();
  await execFileAsync(python(), [script(), 'download', model(), LAYA_MLX.repository, LAYA_MLX.revision],
    { env: environment(false), timeout: 1200000, maxBuffer: 1024 * 1024, killSignal: 'SIGKILL' });
  stage = 'verify';
  notifyLayaStatus();
  await execFileAsync(python(), [script(), 'verify', model()],
    { env: environment(), timeout: 120000, maxBuffer: 4096, killSignal: 'SIGKILL' });
  await writeFile(`${marker()}.tmp`, JSON.stringify(LAYA_MLX));
  await rename(`${marker()}.tmp`, marker());
}

export async function installLaya() {
  if (!isAppleSilicon()) return failure('laya-unsupported');
  if (scoring) return failure('laya-busy');
  if (!installation) {
    installError = null;
    installation = performInstall().catch(() => { installError = `laya-install-${stage}-failed`; })
      .finally(() => { installation = null; stage = null; notifyLayaStatus(); });
    notifyLayaStatus();
  }
  return { ok: true, installing: true };
}

export async function scoreLaya(input, signal) {
  const parsed = layaScoreRequestSchema.safeParse(input);
  if (!parsed.success) return failure('laya-request-invalid');
  const { isInstanceFeatureEnabled } = await import('./instanceFeatures.js');
  if (!await isInstanceFeatureEnabled('laya-mlx')) return failure('laya-disabled');
  if (installation || scoring) return failure('laya-busy');
  // Reserve before the first asynchronous readiness check: overlapping requests
  // must not each load a separate copy of the model into unified memory.
  scoring = true;
  notifyLayaStatus();
  const started = Date.now();
  return (async () => {
    const status = await getLayaStatus();
    if (!status.supported) return failure('laya-unsupported');
    if (!status.ready) return failure('laya-not-ready');
    const task = execFileAsync(python(), [script(), 'score', model()], {
      env: environment(), timeout: 120000, maxBuffer: 65536, killSignal: 'SIGKILL', signal,
    });
    // Never place the premise in argv, a temporary file, a log, or an error.
    task.child.stdin.on('error', () => {});
    task.child.stdin.end(JSON.stringify(parsed.data));
    const { stdout } = await task;
    const raw = JSON.parse(stdout);
    if (raw.code === 'laya-context-too-long') return failure(raw.code);
    const result = normalizeLayaResult(raw, parsed.data.options, parsed.data.minMargin);
    return result ? { ...result, elapsedMs: Date.now() - started } : failure('laya-response-invalid');
  })().catch(() => failure(signal?.aborted ? 'laya-cancelled' : 'laya-scoring-failed'))
    .finally(() => { scoring = false; notifyLayaStatus(); });
}
