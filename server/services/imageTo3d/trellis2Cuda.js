/** TRELLIS.2 CUDA runtime detection and generation. */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from '../../lib/childProcess.js';
import { resolveCondaEnvPython } from '../../lib/condaEnv.js';
import { rewriteGlbMaterialsOpaque } from './glbMaterials.js';
import {
  hfGatedRepoHelp,
  isHfAuthError,
  parseGenerateProgress,
  trellis2OutputStem,
} from './trellis2.js';
import { textMatcher, runGenerateSubprocess, runInstallSteps } from './laneRunner.js';
import { renderOptionArgs } from './renderOptions.js';

const HOME = homedir();

/** Error-code namespace and user-facing name for this lane's subprocess failures. */
const CODE_PREFIX = 'TRELLIS2_CUDA';
const LABEL = 'TRELLIS.2 (CUDA)';

/** The conda environment name upstream's `setup.sh --new-env` creates. */
export const TRELLIS2_CUDA_CONDA_ENV = 'trellis2';

/** Clone/install root. `base` overridable for tests. */
export function trellis2CudaRoot(base = join(HOME, '.portos')) {
  return join(base, 'trellis2-cuda');
}

/**
 * Prefer the completed private profile. Intact legacy named Conda environments
 * remain usable until Repair; an incomplete private rebuild cannot fall back.
 * `exists` is injectable so the probe is deterministic in tests.
 * @param {{base?: string, exists?: (p: string) => boolean, env?: object}} [opts]
 * @returns {string|null}
 */
export function trellis2CudaPython({ base, exists = existsSync, env } = {}) {
  const root = trellis2CudaRoot(base);
  const prefix = join(root, '.conda');
  if (exists(join(root, 'portos-installing'))) return null;
  if (exists(prefix)) {
    const python = join(prefix, 'bin', 'python');
    return exists(python) && exists(join(prefix, 'portos-profile.json')) ? python : null;
  }
  return resolveCondaEnvPython(TRELLIS2_CUDA_CONDA_ENV, { exists, env });
}

function cudaSourceRoot(base, exists = existsSync) {
  const root = trellis2CudaRoot(base);
  return exists(join(root, '.conda')) ? join(root, '.conda', 'portos-source') : root;
}

/** Both Install and Repair rebuild only the private environment, retaining model assets. */
export function installTrellis2Cuda({ base, onEvent, env, spawnImpl = spawn } = {}) {
  const script = fileURLToPath(new URL('../../../scripts/setup-trellis2-cuda.py', import.meta.url));
  return runInstallSteps({
    steps: [{ stage: 'bootstrap', command: 'python3', args: [script, trellis2CudaRoot(base)] }],
    label: LABEL,
    codePrefix: CODE_PREFIX,
    isTransient: () => false,
    onEvent,
    env,
    spawnImpl,
  });
}

/** PortOS's own generate entrypoint (upstream ships only a hard-coded `example.py`). */
export function trellis2CudaGenerateRunnerScript() {
  return fileURLToPath(new URL('./trellis2CudaGenerateRunner.py', import.meta.url));
}

/**
 * A new profile needs its completion record and source snapshot. Preserve the
 * existing interpreter/package detection for untouched legacy environments.
 * @param {{base?: string, exists?: (p: string) => boolean, env?: object}} [opts]
 * @returns {boolean}
 */
export function isTrellis2CudaInstalled({ base, exists = existsSync, env } = {}) {
  if (!trellis2CudaPython({ base, exists, env })) return false;
  return exists(join(cudaSourceRoot(base, exists), 'trellis2'));
}

/**
 * Texture-atlas / decimation lanes for the CUDA exporter.
 *
 * Upstream's `example.py` bakes a 4096 atlas at a 1,000,000-triangle decimation
 * target — tuned for the H100 it benchmarks on. On the 24 GB floor this target
 * supports, that combination is the difference between a render and an OOM, so
 * PortOS scales both to the card: the supported-floor lane stays at a 2K atlas /
 * 200k triangles (matching what the MPS lane proved usable), and only a card with
 * real headroom gets upstream's full-fat settings.
 */
export const TRELLIS2_CUDA_TEXTURE_SIZES = [2048, 4096];
export const TRELLIS2_CUDA_DEFAULT_TEXTURE_SIZE = 2048;
export const TRELLIS2_CUDA_HIGH_QUALITY_TEXTURE_SIZE = 4096;
export const TRELLIS2_CUDA_DEFAULT_DECIMATION = 200_000;
export const TRELLIS2_CUDA_HIGH_QUALITY_DECIMATION = 1_000_000;

/**
 * VRAM at which the high-quality lane turns on. 24 GB is the *minimum* to render at
 * all; doubling the atlas (4× the texel budget) and 5×-ing the triangle target needs
 * genuine headroom, so it is gated at 40 GB — the next real card tier (A100 40 GB,
 * L40S/A6000 48 GB) rather than a fractional bump over the floor.
 */
export const TRELLIS2_CUDA_HIGH_QUALITY_MIN_VRAM_GB = 40;

/**
 * Pick the whole export budget from the card's VRAM. Pure.
 *
 * Atlas size and decimation target move together by design — a 4K atlas over a 200k
 * mesh (or the reverse) is a combination nothing intends — so they are chosen once
 * rather than by two selectors that could be retuned apart. An unknown/unparseable
 * VRAM reading degrades to the conservative floor lane rather than overcommitting a
 * card we failed to size.
 *
 * @param {number|null} vramGb
 * @returns {{textureSize: number, decimationTarget: number}}
 */
export function selectTrellis2CudaExportBudget(vramGb) {
  return Number(vramGb) >= TRELLIS2_CUDA_HIGH_QUALITY_MIN_VRAM_GB
    ? {
      textureSize: TRELLIS2_CUDA_HIGH_QUALITY_TEXTURE_SIZE,
      decimationTarget: TRELLIS2_CUDA_HIGH_QUALITY_DECIMATION,
    }
    : {
      textureSize: TRELLIS2_CUDA_DEFAULT_TEXTURE_SIZE,
      decimationTarget: TRELLIS2_CUDA_DEFAULT_DECIMATION,
    };
}

/**
 * The generate invocation:
 * `<conda-python> trellis2CudaGenerateRunner.py <image> --repo-root <root> [--output <stem>] …`
 *
 * Pure. Throws on a missing image (a render with no input is a bug, not an empty
 * run) and on a texture size outside the accepted set — better to fail here than to
 * have argparse abort a job we already queued. `outputPath` is the desired `.glb`
 * disk path, reduced to the stem the runner appends `.glb` to (shared with the MPS
 * lane via `trellis2OutputStem`).
 *
 * `seed`/`steps` mirror the MPS lane's contract (see `buildGenerateArgs` in
 * trellis2.js): both optional, `steps: null` omits the flag so the pipeline's
 * per-phase default applies.
 *
 * @param {{imagePath: string, outputPath?: string, base?: string, python?: string,
 *          textureSize?: number, decimationTarget?: number,
 *          steps?: number|null, seed?: number|null}} opts
 * @returns {{command: string, args: string[]}}
 */
export function buildCudaGenerateArgs({
  imagePath,
  outputPath,
  base,
  python,
  repoRoot,
  textureSize = TRELLIS2_CUDA_DEFAULT_TEXTURE_SIZE,
  decimationTarget = TRELLIS2_CUDA_DEFAULT_DECIMATION,
  steps = null,
  seed = null,
} = {}) {
  if (!imagePath) throw new Error('buildCudaGenerateArgs: imagePath is required');
  if (!TRELLIS2_CUDA_TEXTURE_SIZES.includes(textureSize)) {
    throw new Error(
      `buildCudaGenerateArgs: textureSize must be one of ${TRELLIS2_CUDA_TEXTURE_SIZES.join(', ')}`,
    );
  }
  // Shared validate-and-emit with the MPS lane — see renderOptions.js.
  const optionArgs = renderOptionArgs('buildCudaGenerateArgs', { steps, seed });
  const args = [
    trellis2CudaGenerateRunnerScript(),
    imagePath,
    '--repo-root', repoRoot || cudaSourceRoot(base),
    '--texture-size', String(textureSize),
    '--decimation-target', String(decimationTarget),
  ];
  if (outputPath) args.push('--output', trellis2OutputStem(outputPath));
  args.push(...optionArgs);
  return { command: python || trellis2CudaPython({ base }) || 'python', args };
}

/**
 * A CUDA out-of-memory failure — user-actionable (free the card, or render smaller),
 * so it must not surface as a bare "exited 1" the way a real crash does.
 */
export const isCudaOomError = textMatcher([
  'CUDA out of memory', 'CUBLAS_STATUS_ALLOC_FAILED', 'CUDNN_STATUS_ALLOC_FAILED',
]);

const CUDA_OOM_HELP = 'The GPU ran out of memory during this render. Close other '
  + 'GPU workloads and try again — TRELLIS.2 needs most of a 24 GB card to itself.';

/**
 * Run a single image→GLB generation on CUDA. The one real-subprocess boundary —
 * GUARDED: rejects `TRELLIS2_CUDA_NOT_INSTALLED` unless the environment is present,
 * so it can never run from a cold boot. `spawnImpl`/`exists` are injectable so the
 * wiring is unit-testable without a real render.
 *
 * Returns `{ promise, kill }` so a caller can terminate the render mid-flight — e.g.
 * when the user deletes the record while its GLB is still rendering.
 *
 * `vramGb` is the size of the card this host will render on, passed down from the
 * host capabilities resolved at the request boundary; it selects the export budget.
 * Null/unknown degrades to the conservative floor lane.
 *
 * A successful render is normalized to opaque before it resolves, for the same reason
 * the MPS lane does it: prediction noise in low-alpha texels otherwise turns into
 * visible holes in both PortOS and downloaded GLBs.
 *
 * @param {{imagePath: string, outputPath?: string, base?: string, textureSize?: number,
 *          decimationTarget?: number, vramGb?: number|null,
 *          steps?: number|null, seed?: number|null,
 *          onProgress?: (frame: object) => void, spawnImpl?: Function,
 *          exists?: (p: string) => boolean, env?: NodeJS.ProcessEnv,
 *          postprocessGlb?: (path: string) => void|Promise<void>}} opts
 * @returns {{promise: Promise<{assetPath: string}>, kill: () => void}}
 */
export function runTrellis2CudaGenerate({
  imagePath,
  outputPath,
  base,
  textureSize,
  decimationTarget,
  vramGb = null,
  steps = null,
  seed = null,
  onProgress,
  spawnImpl = spawn,
  exists = existsSync,
  env,
  postprocessGlb = rewriteGlbMaterialsOpaque,
} = {}) {
  // Resolve the interpreter once and reuse it as the "is the env there?" answer —
  // `isTrellis2CudaInstalled` would re-walk the same candidate list on the next line.
  const python = trellis2CudaPython({ base, exists, env });
  const repoRoot = cudaSourceRoot(base, exists);
  if (!python || !exists(join(repoRoot, 'trellis2'))) {
    const err = new Error(`${LABEL} is not installed — install it before generating.`);
    err.code = `${CODE_PREFIX}_NOT_INSTALLED`;
    return { promise: Promise.reject(err), kill: () => {} };
  }
  const budget = selectTrellis2CudaExportBudget(vramGb);
  const { command, args } = buildCudaGenerateArgs({
    imagePath,
    outputPath,
    base,
    python,
    repoRoot,
    textureSize: textureSize ?? budget.textureSize,
    decimationTarget: decimationTarget ?? budget.decimationTarget,
    steps,
    seed,
  });
  return runGenerateSubprocess({
    command,
    args,
    cwd: repoRoot,
    env,
    label: LABEL,
    codePrefix: CODE_PREFIX,
    parseProgress: parseGenerateProgress,
    assetPath: outputPath || null,
    onProgress,
    spawnImpl,
    postprocessGlb,
    classifiers: [
      { test: isHfAuthError, code: `${CODE_PREFIX}_HF_AUTH_REQUIRED`, help: () => hfGatedRepoHelp('trellis2Cuda') },
      { test: isCudaOomError, code: `${CODE_PREFIX}_OUT_OF_MEMORY`, help: CUDA_OOM_HELP },
    ],
  });
}
