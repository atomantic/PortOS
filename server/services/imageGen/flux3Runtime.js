import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { release } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from '../../lib/childProcess.js';
import { PATHS } from '../../lib/fileUtils.js';
import { isAppleSilicon } from '../../lib/platform.js';
import { safeChildProcessOptions } from '../../lib/processEnv.js';
import { runStreamingCommand } from '../../lib/streamingSpawn.js';
import { ServerError } from '../../lib/errorHandler.js';

const exec = promisify(execFile);
export const flux3Venv = () => join(PATHS.data, 'python', 'venv-flux3');
export const flux3Python = () => join(flux3Venv(), 'bin', 'python3');
// Every transitive package is version- and hash-pinned in the lock so a repair
// cannot resolve a newly published (or tampered) release. The probe asserts the
// whole locked set, not just the direct pins.
export const flux3LockPath = () => join(PATHS.root, 'scripts', 'requirements-flux3-mlx.lock.txt');
let lockedPins = null;
function flux3LockedPins() {
  lockedPins ??= readFileSync(flux3LockPath(), 'utf8').split('\n')
    .map(line => line.match(/^([A-Za-z0-9][A-Za-z0-9._-]*)==([^\s;\\]+)/)).filter(Boolean)
    .map(([, name, version]) => [name, version]);
  return lockedPins;
}
const probeScript = () => `import importlib.metadata as m, platform, sys
assert platform.machine() == 'arm64' and sys.version_info >= (3, 11)
for name, version in ${JSON.stringify(flux3LockedPins())}:
 assert m.version(name) == version, f"{name}=={version}"
from mflux.models.flux3.cli.flux3_generate import main
from mflux.models.flux3.cli.flux3_edit_generate import main
`;

// This venv deliberately cannot inherit the older shared mflux's user-site,
// PYTHONPATH or virtualenv. No weights are loaded by the readiness probe.
export function flux3Env(extra = {}) {
  return { ...process.env, ...extra, PYTHONPATH: undefined, PYTHONHOME: undefined, VIRTUAL_ENV: undefined, PYTHONNOUSERSITE: '1' };
}

function hostProblem() {
  if (process.platform !== 'darwin' || !isAppleSilicon()) return 'FLUX.3 MLX requires an Apple Silicon Mac.';
  if (Number(release().split('.')[0]) < 23) return 'FLUX.3 MLX requires macOS 14 or later.';
  return null;
}

async function probe() {
  await exec(flux3Python(), ['-I', '-c', probeScript()], safeChildProcessOptions({ timeout: 30_000, env: flux3Env() }));
}

export async function diagnoseFlux3Runtime() {
  const problem = hostProblem();
  if (problem) return { readiness: 'unavailable', reason: problem, remedy: { kind: 'choose-model', label: 'Choose a compatible model' } };
  try {
    await probe();
    return { readiness: 'ready' };
  } catch {
    return { readiness: 'unavailable', reason: 'The isolated FLUX.3 mflux runtime is missing or needs repair.',
      remedy: { kind: 'install-flux3', label: 'Install / repair FLUX.3 runtime', venvPath: flux3Venv() } };
  }
}

let installing = false;
export function installFlux3Runtime(emit) {
  if (installing) throw new ServerError('A FLUX.3 runtime install is already running.', { status: 409, code: 'FLUX3_INSTALL_BUSY' });
  const problem = hostProblem();
  if (problem) throw new ServerError(problem, { status: 400, code: 'MODEL_HARDWARE_UNAVAILABLE' });
  installing = true;
  let cancelled = false;
  const command = async args => {
    if (cancelled) throw new Error('FLUX.3 installation cancelled.');
    // uv supplies a native standalone Python, including when Node runs under Rosetta.
    const native = process.arch !== 'arm64';
    const result = await runStreamingCommand(native ? '/usr/bin/arch' : 'uv', native ? ['-arm64', 'uv', ...args] : args,
      line => emit({ type: 'log', message: line }), {
        timeoutMs: 30 * 60_000, env: flux3Env(), isCancelled: () => cancelled, processGroup: true,
      });
    if (!result.success) throw new Error(`FLUX.3 install failed: ${result.error}. Install uv and retry the runtime repair.`);
    if (cancelled) throw new Error('FLUX.3 installation cancelled.');
  };
  const promise = (async () => {
    try {
      emit({ type: 'stage', stage: 'venv', message: 'Creating isolated Python 3.12 environment. No model weights are downloaded.' });
      await command(['venv', '--python', '3.12', '--python-preference', 'only-managed', '--allow-existing', flux3Venv()]);
      const mflux = flux3LockedPins().find(([name]) => name === 'mflux')?.[1];
      emit({ type: 'stage', stage: 'install', message: `Installing hash-locked mflux ${mflux} and MLX dependencies.` });
      await command(['pip', 'sync', '--require-hashes', '--reinstall', '--python', flux3Python(), flux3LockPath()]);
      emit({ type: 'stage', stage: 'verify', message: 'Checking both FLUX.3 CLI modules without loading weights.' });
      await probe();
      if (cancelled) throw new Error('FLUX.3 installation cancelled.');
      emit({ type: 'complete', message: 'FLUX.3 runtime ready. Model weights download separately.' });
    } finally { installing = false; }
  })();
  return { promise, kill: () => { cancelled = true; } };
}

export function assertFlux3Inputs({ negativePrompt, width, height, initImagePath, referenceImagePaths = [], referenceImageStrengths = [], loraPaths = [], hasInitImage = Boolean(initImagePath), referenceCount = referenceImagePaths.length, loraCount = loraPaths.length }) {
  const reject = message => { throw new ServerError(message, { status: 400, code: 'FLUX3_INPUT_UNSUPPORTED' }); };
  if (negativePrompt) reject('FLUX.3 Klein has no negative prompt. Describe the desired scene in the prompt.');
  if (hasInitImage) reject('FLUX.3 edits use reference images. Move the init image into a reference slot; image strength is unavailable.');
  if (loraCount) reject('This FLUX.3 integration does not support LoRAs. Remove them before rendering.');
  if (referenceCount > 10) reject('FLUX.3 accepts at most 10 reference images.');
  if (referenceImageStrengths.some(value => Number(value) !== 1)) reject('FLUX.3 reference strength is fixed. Remove per-reference strength overrides.');
  if (![width, height].every(n => Number.isInteger(n) && n >= 256 && n <= 1024 && n % 16 === 0)) {
    reject('FLUX.3 dimensions must be multiples of 16 between 256 and 1024.');
  }
}

export function flux3RenderArgs(inputs) {
  assertFlux3Inputs(inputs);
  const { model, prompt, width, height, steps, seed, outputPath, referenceImagePaths = [], stepwiseDir } = inputs;
  if (!model?.repo) throw new ServerError('FLUX.3 model is missing its Hugging Face repo.', { status: 500, code: 'FLUX3_MISCONFIGURED' });
  const module = referenceImagePaths.length ? 'flux3_edit_generate' : 'flux3_generate';
  // Quantization is embedded in the community checkpoint. A request's global
  // quantize/guidance controls cannot change those weights or distilled CFG.
  const args = ['-I', '-m', `mflux.models.flux3.cli.${module}`, '--model', model.repo,
    '--base-model', 'flux3-image-klein', '--prompt', prompt, '--width', String(width), '--height', String(height),
    '--steps', String(steps), '--seed', String(seed), '--output', outputPath, '--metadata', '--low-ram'];
  if (referenceImagePaths.length) args.push('--image-paths', ...referenceImagePaths);
  if (stepwiseDir) args.push('--stepwise-image-output-dir', stepwiseDir);
  return { bin: flux3Python(), args, providerInputs: { initImagePath: null, referenceImagePaths } };
}
