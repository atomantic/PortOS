import { join } from 'node:path';
import { release, totalmem } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from '../../lib/childProcess.js';
import { PATHS } from '../../lib/fileUtils.js';
import { isAppleSilicon } from '../../lib/platform.js';
import { safeChildProcessOptions } from '../../lib/processEnv.js';
import { ServerError } from '../../lib/errorHandler.js';
import { getHfCacheRoot, repoToDirName } from '../../lib/hfCache.js';
import manifest from './moss-manifest.json' with { type: 'json' };

export const MOSS_MANIFEST = manifest;
export const mossRuntimeRoot = () => join(PATHS.data, 'repos', 'moss-swift-runtime');
export const mossRuntimeDirectory = () => join(mossRuntimeRoot(), `v${manifest.adapterVersion}-${manifest.sourceRevision}`);
export const mossBinary = () => join(mossRuntimeDirectory(), 'moss-image');
export const mossSnapshot = () => join(getHfCacheRoot(), repoToDirName(manifest.repo), 'snapshots', manifest.revision);
const exec = promisify(execFile);

export function mossChildEnv(env = process.env) {
  const clean = { ...env };
  for (const key of Object.keys(clean)) {
    if (key.startsWith('MOSS_') || key.startsWith('FLUX2VAE_') || key === 'MLX_ENABLE_TF32') clean[key] = undefined;
  }
  return clean;
}

export function mossHostProblem({
  platform = process.platform, arch = process.arch, osRelease = release(), memory = totalmem(), appleSilicon,
} = {}) {
  // Pass appleSilicon to skip the hardware probe. Rosetta reports arch x64.
  const silicon = appleSilicon ?? isAppleSilicon({ platform, arch });
  if (platform !== 'darwin' || !silicon) return 'MOSS Swift requires native Apple Silicon macOS.';
  if (Number(osRelease.split('.')[0]) < 25) return 'MOSS Swift requires macOS 26 or later.';
  if (memory < 48 * 1024 ** 3) return 'MOSS SFT bf16 requires at least 48 GB unified memory (about 27 GB measured model footprint plus system headroom).';
  return null;
}

export async function probeMossBinary(binary = mossBinary()) {
  const { stdout } = await exec(binary, ['--probe'], safeChildProcessOptions({
    timeout: 30_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024, env: mossChildEnv(), cwd: '/',
  }));
  const probe = JSON.parse(stdout);
  if (probe.runtime !== 'moss-swift' || probe.sourceRevision !== manifest.sourceRevision
    || probe.adapterVersion !== manifest.adapterVersion || probe.metal !== true) {
    throw new Error('Installed MOSS adapter does not match the pinned runtime. Reinstall it.');
  }
  return probe;
}

export async function diagnoseMossRuntime() {
  const problem = mossHostProblem();
  if (problem) return { readiness: 'unavailable', reason: problem, remedy: { kind: 'choose-model', label: 'Choose a compatible model' } };
  try {
    await probeMossBinary();
    return { readiness: 'ready' };
  } catch (error) {
    return {
      readiness: 'unavailable',
      reason: error.code === 'ENOENT' ? 'MOSS Swift runtime is not installed.' : `MOSS Swift runtime failed its Metal probe: ${error.message}`,
      remedy: { kind: 'install-moss-swift', label: 'Install MOSS Swift runtime' },
    };
  }
}

export function mossRenderArgs({ prompt, negativePrompt = '', width, height, steps, guidance, seed, outputPath,
  loraPaths = [], initImagePath, referenceImagePaths = [] }) {
  const reject = message => { throw new ServerError(message, { status: 400, code: 'MOSS_INPUT_UNSUPPORTED' }); };
  if (loraPaths.length || initImagePath || referenceImagePaths.length) reject('MOSS SFT supports text-to-image only; remove LoRAs and input images.');
  if (![width, height].every(n => Number.isInteger(n) && n >= 256 && n <= 1024 && n % 16 === 0)) {
    reject('MOSS dimensions must be multiples of 16 between 256 and 1024.');
  }
  if (!Number.isInteger(steps) || steps < 1 || steps > 100) reject('MOSS steps must be an integer between 1 and 100.');
  if (!Number.isFinite(guidance) || guidance < 0 || guidance > 10) reject('MOSS guidance must be between 0 and 10.');
  if (guidance === 1 && negativePrompt) reject('MOSS negative prompts require guidance other than 1.');
  if (!Number.isSafeInteger(seed) || seed < 0) reject('MOSS seed must be a nonnegative safe integer.');
  return {
    bin: mossBinary(),
    args: ['--snapshot', mossSnapshot(), '--prompt', prompt, '--negative', negativePrompt,
      '--width', String(width), '--height', String(height), '--steps', String(steps),
      '--guidance', String(guidance), '--seed', String(seed), '--output', outputPath],
    providerInputs: { initImagePath: null, referenceImagePaths: [] },
  };
}
