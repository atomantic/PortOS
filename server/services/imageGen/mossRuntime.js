import { join } from 'node:path';
import { release, totalmem } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from '../../lib/childProcess.js';
import { PATHS } from '../../lib/fileUtils.js';
import { isAppleSilicon } from '../../lib/platform.js';
import { safeChildProcessOptions } from '../../lib/processEnv.js';
import { assertMossInputs } from '../../lib/localImageModelInputs.js';
import { getHfCacheRoot, repoToDirName } from '../../lib/hfCache.js';
import manifest from './moss-manifest.json' with { type: 'json' };

export { assertMossInputs };
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
  assertMossInputs({
    negativePrompt, width, height, steps, guidance, seed,
    loraCount: loraPaths.length, hasInitImage: Boolean(initImagePath), referenceCount: referenceImagePaths.length,
  });
  return {
    bin: mossBinary(),
    args: ['--snapshot', mossSnapshot(), '--prompt', prompt, '--negative', negativePrompt,
      '--width', String(width), '--height', String(height), '--steps', String(steps),
      '--guidance', String(guidance), '--seed', String(seed), '--output', outputPath],
    providerInputs: { initImagePath: null, referenceImagePaths: [] },
  };
}
