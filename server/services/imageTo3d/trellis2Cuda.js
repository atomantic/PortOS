/**
 * TRELLIS.2 (local NVIDIA / CUDA) target — install detection, pure command
 * builders, and a guarded generate runner.
 *
 * The CUDA sibling of `trellis2.js` (which drives the Apple-Silicon MPS port). Both
 * lanes are thin: the subprocess machinery they share — install-step sequencing with
 * transient retry, cancel, and the generate child driver — lives in `laneRunner.js`,
 * so this file is only what is genuinely CUDA-specific (paths, steps, args, error
 * classification). Everything here is either pure or exercised through injectable
 * `exists`/`spawnImpl`, so the wiring is unit-testable WITHOUT a 24 GB NVIDIA box, a
 * ~15 GB weight download, or a live render. `runTrellis2CudaGenerate` is the one real
 * subprocess boundary and NEVER auto-runs: it rejects unless the model is installed,
 * and is only reached from an explicit user action (CLAUDE.md no-cold-bootstrap policy).
 *
 * **Two things differ from the MPS lane, and both drive the design here:**
 *
 * 1. **Conda, not a venv.** Upstream's `setup.sh` creates and activates a conda
 *    environment named `trellis2` (PyTorch 2.6 / CUDA 12.4) rather than a `.venv`
 *    inside the clone. So "installed" is resolved by probing the usual conda roots
 *    for `envs/trellis2/bin/python` instead of a fixed path under the repo — via the
 *    shared `resolveCondaEnvPython` (`lib/condaEnv.js`), which the Pixal3D CUDA
 *    lane uses too. (Distinct from that file's venv resolvers like
 *    `resolveFlux2Python`, which probe a different layout entirely.)
 *
 * 2. **Upstream ships no CLI.** `microsoft/TRELLIS.2` has only `example.py`, a demo
 *    with hard-coded paths — there is no `generate.py` to shell into the way the mac
 *    port provides one. PortOS therefore ships its own entrypoint,
 *    `trellis2CudaGenerateRunner.py`, which drives the documented public API
 *    (`Trellis2ImageTo3DPipeline.from_pretrained` → `.run(image)` →
 *    `o_voxel.postprocess.to_glb` → `.export`) and prints the SAME stage banners the
 *    MPS lane emits, so `parseGenerateProgress` parses both lanes with no second
 *    vocabulary to maintain.
 *
 * Clone layout mirrors the MPS lane: the upstream repo lands at `~/.portos/trellis2-cuda`.
 */

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
  isTransientInstallError,
  parseGenerateProgress,
  trellis2OutputStem,
} from './trellis2.js';
import { textMatcher, runInstallSteps, runGenerateSubprocess } from './laneRunner.js';
import { renderOptionArgs } from './renderOptions.js';

const HOME = homedir();

/** Error-code namespace and user-facing name for this lane's subprocess failures. */
const CODE_PREFIX = 'TRELLIS2_CUDA';
const LABEL = 'TRELLIS.2 (CUDA)';

/** Upstream Microsoft TRELLIS.2 (CUDA). */
export const TRELLIS2_CUDA_REPO = 'https://github.com/microsoft/TRELLIS.2.git';

/** The conda environment name upstream's `setup.sh --new-env` creates. */
export const TRELLIS2_CUDA_CONDA_ENV = 'trellis2';

/** Clone/install root. `base` overridable for tests. */
export function trellis2CudaRoot(base = join(HOME, '.portos')) {
  return join(base, 'trellis2-cuda');
}

/** The upstream package directory inside the clone — the second half of "installed". */
function trellis2CudaPackageDir(base) {
  return join(trellis2CudaRoot(base), 'trellis2');
}

/**
 * The conda Python upstream's `setup.sh --new-env` built, or null when its env doesn't
 * exist. A one-line wrapper over the shared resolver (`lib/condaEnv.js`), which owns
 * the conda-root candidate list and the `CONDA_PREFIX` walk-up both CUDA lanes need.
 * `exists` is injectable so the probe is deterministic in tests.
 * @param {{exists?: (p: string) => boolean, env?: object}} [opts]
 * @returns {string|null}
 */
export function trellis2CudaPython({ exists = existsSync, env } = {}) {
  return resolveCondaEnvPython(TRELLIS2_CUDA_CONDA_ENV, { exists, env });
}

/** PortOS's own generate entrypoint (upstream ships only a hard-coded `example.py`). */
export function trellis2CudaGenerateRunnerScript() {
  return fileURLToPath(new URL('./trellis2CudaGenerateRunner.py', import.meta.url));
}

/**
 * Installed ⇔ the conda env's Python exists AND the upstream package is on disk.
 * Both halves matter: `setup.sh` can create the env and then fail while building the
 * CUDA extensions, which would otherwise read as a complete install.
 * @param {{base?: string, exists?: (p: string) => boolean, env?: object}} [opts]
 * @returns {boolean}
 */
export function isTrellis2CudaInstalled({ base, exists = existsSync, env } = {}) {
  if (!trellis2CudaPython({ exists, env })) return false;
  return exists(trellis2CudaPackageDir(base));
}

/**
 * The upstream setup flags, verbatim from TRELLIS.2's README:
 * `. ./setup.sh --new-env --basic --flash-attn --nvdiffrast --nvdiffrec --cumesh --o-voxel --flexgemm`
 *
 * Every extension is load-bearing for the image→GLB path this target exposes:
 * `--o-voxel` provides `o_voxel.postprocess.to_glb` (the exporter the runner calls),
 * `--nvdiffrast`/`--nvdiffrec` the texture baking, `--cumesh` the mesh ops, and
 * `--flash-attn`/`--flexgemm` the attention/GEMM kernels the 4B model samples with.
 * Trimming the list produces an install that imports and then fails mid-render.
 */
export const TRELLIS2_CUDA_SETUP_FLAGS = Object.freeze([
  '--new-env', '--basic', '--flash-attn', '--nvdiffrast', '--nvdiffrec',
  '--cumesh', '--o-voxel', '--flexgemm',
]);

/**
 * The install as an ordered list of `{stage, command, args, cwd?}` steps: recursive
 * clone (upstream vendors its extensions as submodules — a non-recursive clone
 * silently yields empty extension dirs and a setup that fails deep in a compile),
 * then its `setup.sh`.
 *
 * **The clone step is skipped when the repo is already present** (`<root>/.git`),
 * the same resume property the MPS lane relies on: a run that cloned but died
 * inside `setup.sh` must re-reach the idempotent setup rather than abort on
 * "destination path already exists".
 *
 * **`setup.sh` is SOURCED inside a login shell**, not executed. Upstream documents
 * `. ./setup.sh` because the script calls `conda activate` and then installs into the
 * activated env; running it as `bash setup.sh` gives `conda activate` no shell hooks
 * and the packages land in the wrong interpreter (or the script aborts). `bash -lc`
 * loads the profile that `conda init` wrote, which is what makes `conda activate`
 * work in a non-interactive child.
 *
 * @param {string} [base]
 * @param {{exists?: (p: string) => boolean}} [opts]
 * @returns {Array<{stage: string, command: string, args: string[], cwd?: string}>}
 */
export function buildCudaInstallSteps(base, { exists = existsSync } = {}) {
  const root = trellis2CudaRoot(base);
  const steps = [];
  if (!exists(join(root, '.git'))) {
    steps.push({
      stage: 'clone',
      command: 'git',
      args: ['clone', '-b', 'main', '--recursive', TRELLIS2_CUDA_REPO, root],
    });
  }
  steps.push({
    stage: 'setup',
    command: 'bash',
    args: ['-lc', `. ./setup.sh ${TRELLIS2_CUDA_SETUP_FLAGS.join(' ')}`],
    cwd: root,
  });
  return steps;
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
    '--repo-root', trellis2CudaRoot(base),
    '--texture-size', String(textureSize),
    '--decimation-target', String(decimationTarget),
  ];
  if (outputPath) args.push('--output', trellis2OutputStem(outputPath));
  args.push(...optionArgs);
  return { command: python || trellis2CudaPython({}) || 'python', args };
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
 * Run the install as a killable, event-emitting job: recursive clone → upstream
 * `setup.sh` (~15 GB plus a long CUDA extension build). Real subprocesses —
 * user-triggered only. Retry/cancel/backoff semantics come from the shared
 * `runInstallSteps`, so both lanes stay in lockstep by construction.
 *
 * @param {{base?: string, onEvent?: (ev: object) => void, spawnImpl?: Function,
 *          maxRetries?: number, sleep?: (ms: number) => Promise<void>,
 *          exists?: (p: string) => boolean, env?: NodeJS.ProcessEnv}} [opts]
 * @returns {{promise: Promise<{ok: true}>, kill: () => void}}
 */
export function installTrellis2Cuda({
  base,
  onEvent = () => {},
  spawnImpl = spawn,
  maxRetries = 3,
  sleep,
  exists = existsSync,
  env,
} = {}) {
  return runInstallSteps({
    steps: buildCudaInstallSteps(base, { exists }),
    label: LABEL,
    codePrefix: CODE_PREFIX,
    isTransient: isTransientInstallError,
    onEvent,
    spawnImpl,
    maxRetries,
    sleep,
    env,
    // `setup.sh` can leave a usable conda env behind while an extension build failed,
    // so confirm what actually landed rather than trusting exit 0 — the same lesson
    // the MPS lane's verify step encodes (#2952).
    verify: (emit) => {
      if (!isTrellis2CudaInstalled({ base, exists, env })) {
        const err = new Error(
          `${LABEL} setup finished but its conda environment or upstream package is `
          + 'missing — check the setup log above for a failed extension build.',
        );
        err.code = `${CODE_PREFIX}_INSTALL_INCOMPLETE`;
        err.stage = 'verify';
        throw err;
      }
      emit({ type: 'log', stage: 'verify', message: '✅ TRELLIS.2 CUDA environment is present.' });
    },
  });
}

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
  const python = trellis2CudaPython({ exists, env });
  if (!python || !exists(trellis2CudaPackageDir(base))) {
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
    textureSize: textureSize ?? budget.textureSize,
    decimationTarget: decimationTarget ?? budget.decimationTarget,
    steps,
    seed,
  });
  return runGenerateSubprocess({
    command,
    args,
    cwd: trellis2CudaRoot(base),
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
