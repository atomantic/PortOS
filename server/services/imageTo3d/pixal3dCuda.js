/** Pixal3D CUDA runtime detection, diagnostics and generation. */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from '../../lib/childProcess.js';
import { resolveCondaEnvPython } from '../../lib/condaEnv.js';
import { rewriteGlbMaterialsOpaque } from './glbMaterials.js';
import {
  hfGatedRepoHelp,
  isHfAuthError,
  parseGenerateProgress,
} from './trellis2.js';
import { isCudaOomError } from './trellis2Cuda.js';
import {
  textMatcher, runGenerateSubprocess, probePythonModules,
} from './laneRunner.js';
import { validateRenderOptions } from './renderOptions.js';

const HOME = homedir();

/** Error-code namespace and user-facing name for this lane's subprocess failures. */
const CODE_PREFIX = 'PIXAL3D_CUDA';
const LABEL = 'Pixal3D (CUDA)';

/** The conda environment this lane builds. Named to avoid colliding with `trellis2`. */
export const PIXAL3D_CONDA_ENV = 'pixal3d';

/** Clone/install root. `base` overridable for tests. */
export function pixal3dRoot(base = join(HOME, '.portos')) {
  return join(base, 'pixal3d');
}

/** Where Pixal3D itself is cloned — the code this lane actually runs. */
function pixal3dRepoDir(base) {
  return join(pixal3dRoot(base), 'Pixal3D');
}

/** Upstream's shipped entrypoint. */
function pixal3dInferenceScript(base) {
  return join(pixal3dRepoDir(base), 'inference.py');
}

/**
 * The conda Python for this lane, or null when its env doesn't exist. A one-line
 * wrapper over the shared resolver so the env name lives in exactly one place.
 * @param {{exists?: (p: string) => boolean, env?: object}} [opts]
 * @returns {string|null}
 */
export function pixal3dPython({ exists = existsSync, env } = {}) {
  return resolveCondaEnvPython(PIXAL3D_CONDA_ENV, { exists, env });
}

/**
 * Installed ⇔ the conda env's Python exists AND upstream's entrypoint is on disk.
 * Both halves matter: a legacy setup may have created the environment or cloned
 * the source before failing.
 * @param {{base?: string, exists?: (p: string) => boolean, env?: object}} [opts]
 * @returns {boolean}
 */
export function isPixal3dCudaInstalled({ base, exists = existsSync, env } = {}) {
  if (!pixal3dPython({ exists, env })) return false;
  return exists(pixal3dInferenceScript(base));
}

export const PIXAL3D_STANDARD_MODE_MIN_VRAM_GB = 36;
export const PIXAL3D_HIGH_RES_MIN_VRAM_GB = 24;
/** Upstream's two supported pipeline resolutions, low to high. */
export const PIXAL3D_RESOLUTIONS = [1024, 1536];
const [PIXAL3D_RES_FLOOR, PIXAL3D_RES_FULL] = PIXAL3D_RESOLUTIONS;

/**
 * Resolution / offload lane, picked from the card's VRAM.
 *
 * Upstream documents three usable combinations, and they are genuinely three tiers
 * rather than a single quality knob (Pixal3D issue #7 measured "18–36 GB depending on
 * settings"; the merged low-VRAM PR brings peak to ~10–12 GB by loading one pipeline
 * stage onto the GPU at a time):
 *
 *  - `>= PIXAL3D_STANDARD_MODE_MIN_VRAM_GB` → standard mode at full resolution. No
 *    offload, so it is also the fastest.
 *  - `>= PIXAL3D_HIGH_RES_MIN_VRAM_GB` → full resolution with `--low_vram`. Upstream
 *    explicitly supports forcing full resolution in low-VRAM mode; the stage-at-a-time
 *    offload pays for it in wall-clock rather than quality.
 *  - otherwise → the floor resolution with `--low_vram`, the least this lane supports.
 *
 * An unknown/unparseable VRAM reading degrades to the floor rather than overcommitting
 * a card we failed to size (AGENTS.md sentinel rule).
 *
 * @param {number|null} vramGb
 * @returns {{lowVram: boolean, resolution: number}}
 */
export function selectPixal3dRenderBudget(vramGb) {
  const gb = Number(vramGb);
  if (gb >= PIXAL3D_STANDARD_MODE_MIN_VRAM_GB) return { lowVram: false, resolution: PIXAL3D_RES_FULL };
  if (gb >= PIXAL3D_HIGH_RES_MIN_VRAM_GB) return { lowVram: true, resolution: PIXAL3D_RES_FULL };
  return { lowVram: true, resolution: PIXAL3D_RES_FLOOR };
}

/**
 * The generate invocation:
 * `<conda-python> inference.py --image <src> --output <dst.glb> [--resolution N] [--low_vram] …`
 *
 * Pure. Throws on a missing image (a render with no input is a bug, not an empty run)
 * and on a resolution outside upstream's accepted set — better to fail here than to
 * have argparse abort a job we already queued.
 *
 * `outputPath` is passed THROUGH, not reduced to a stem: `inference.py --output` is a
 * full file path (see the file header).
 *
 * `steps`/`seed` are validated against the shared ranges so they cannot drift from the
 * TRELLIS.2 lanes — but upstream's `inference.py` exposes no per-phase step override, so
 * `steps` is validated and NOT emitted (an unrecognized flag would make argparse abort a
 * job we already queued). The target descriptor declares that with
 * `supportsRenderOptions.steps: false`, which is what stops the UI offering a control
 * that does nothing and stops the run ledger recording a value that never applied.
 *
 * @param {{imagePath: string, outputPath?: string, base?: string, python?: string,
 *          resolution?: number, lowVram?: boolean,
 *          steps?: number|null, seed?: number|null}} opts
 * @returns {{command: string, args: string[]}}
 */
export function buildPixal3dGenerateArgs({
  imagePath,
  outputPath,
  base,
  python,
  resolution = PIXAL3D_RES_FLOOR,
  lowVram = true,
  steps = null,
  seed = null,
} = {}) {
  if (!imagePath) throw new Error('buildPixal3dGenerateArgs: imagePath is required');
  if (!PIXAL3D_RESOLUTIONS.includes(resolution)) {
    throw new Error(
      `buildPixal3dGenerateArgs: resolution must be one of ${PIXAL3D_RESOLUTIONS.join(', ')}`,
    );
  }
  // Both are range-checked at the same boundary as the other lanes; only seed is emitted.
  validateRenderOptions('buildPixal3dGenerateArgs', { steps, seed });
  const args = [
    pixal3dInferenceScript(base),
    '--image', imagePath,
    '--resolution', String(resolution),
  ];
  if (outputPath) args.push('--output', outputPath);
  if (lowVram) args.push('--low_vram');
  if (seed !== null) args.push('--seed', String(seed));
  return { command: python || pixal3dPython({}) || 'python', args };
}

/**
 * Upstream's own progress banners, mapped to the shared stage/percent vocabulary.
 *
 * Pixal3D prints `[Pipeline]`/`[Inference]`/`[MoGe-2]`/`[NAF]`-prefixed lines rather
 * than the banners `parseGenerateProgress` was written for, so this table covers them
 * — kept HERE rather than added to `GENERATE_STAGE_SIGNATURES` so the two TRELLIS.2
 * lanes' parsing cannot regress from a Pixal3D change. Percents follow the same bands
 * (load < 10, sampling 10–50, texture ~65, export 92) so the bar stays monotonic.
 */
const PIXAL3D_STAGE_SIGNATURES = [
  { re: /^\[Pipeline\] Loading from/i, stage: 'loading', percent: 2 },
  { re: /^\[ImageCond\]/i, stage: 'loading', percent: 3 },
  { re: /^\[NAF\]/i, stage: 'loading', percent: 4 },
  { re: /^\[Pipeline\] (Low-VRAM|Standard) mode/i, stage: 'loading', percent: 5 },
  { re: /^\[Inference\] Processing image/i, stage: 'loading', percent: 6 },
  { re: /^\[MoGe-2\]/i, stage: 'loading', percent: 7 },
  { re: /^\[Inference\] (Estimating camera|Using manual FOV)/i, stage: 'loading', percent: 8 },
  { re: /^\[Inference\] Running 3D generation/i, stage: 'generating', percent: 10 },
  { re: /^\[Inference\] Using pipeline_type/i, stage: 'generating', percent: 11 },
  { re: /^\[Inference\] Extracting GLB/i, stage: 'texturing', percent: 65 },
];

/**
 * Parse one line of `inference.py` output into a progress frame, or null.
 *
 * Delegates to the shared `parseGenerateProgress` FIRST, which is what handles the two
 * signals both lanes share: a written `.glb` path (the terminal export frame, matched
 * by `[Done] GLB saved to: …`) and a bare `tqdm` percentage scaled into the sampling
 * band. Only lines it finds no signal in are matched against Pixal3D's own banners, so
 * the terminal export frame can never be shadowed by a banner rule.
 *
 * @param {string} line
 * @returns {{stage: string, percent?: number, assetPath?: string, message: string}|null}
 */
export function parsePixal3dProgress(line) {
  const shared = parseGenerateProgress(line);
  if (shared) return shared;
  const text = String(line ?? '').trim();
  if (!text) return null;
  for (const sig of PIXAL3D_STAGE_SIGNATURES) {
    if (sig.re.test(text)) return { stage: sig.stage, percent: sig.percent, message: text };
  }
  return null;
}

/**
 * Modules Pixal3D imports directly — absent means the install did not complete, not
 * that quality degrades. `o_voxel` is the GLB exporter and `flex_gemm` the sparse GEMM
 * its autotuner configures on import. Upstream's own `pixal3d` package is deliberately
 * NOT probed: it resolves only with the clone root on `sys.path`, which the render
 * subprocess gets from its `cwd` and this probe does not, so it would always read as
 * missing.
 */
export const PIXAL3D_REQUIRED_MODULES = ['o_voxel', 'flex_gemm'];

/** NATTEN backs the NAF upsampler. Absent ⇒ renders take upstream's fallback path. */
export const PIXAL3D_NAF_MODULES = ['natten'];

/**
 * Explain the effect of a missing required extension. The adapter names the
 * specific modules separately.
 */
export const PIXAL3D_INCOMPLETE_INSTALL_HELP = 'Pixal3D is installed but not every required '
  + 'CUDA extension built, so renders will fail in the mesh exporter.';

export const PIXAL3D_NAF_FALLBACK_HELP = 'Pixal3D is installed, but NATTEN is missing, '
  + 'so its NAF refinement step falls back to DINO projection features — slower, and '
  + 'geometry and texture detail are lower.';

/**
 * Probe which of the env's modules resolve, for the install-state card. The spawn and
 * its find_spec one-liner are shared (`probePythonModules`); only the classification
 * below is Pixal3D-specific.
 *
 * **`naf: 'available'` means the NATTEN PACKAGE resolves — it does NOT prove the CUDA
 * `libnatten` kernels built.** Confirming that needs `import natten` to read
 * `HAS_LIBNATTEN`, which costs a torch import; paying that per `/targets` request is
 * not worth it, so the deep check is left to render time, where
 * `isPixal3dNafError` classifies the failure into an actionable message. Reported as
 * `'unknown'` when the probe itself could not run — deliberately distinct from
 * `'unavailable'`, so a broken probe never renders a warning about a fine install
 * (AGENTS.md sentinel rule: "failed to determine" ≠ "determined to be bad").
 *
 * @param {{execFileImpl?: Function, exists?: (p: string) => boolean,
 *          env?: NodeJS.ProcessEnv}} [opts]
 * @returns {Promise<{naf: 'available'|'unavailable'|'unknown', missing: string[], help?: string}>}
 */
export async function probePixal3dModules({
  execFileImpl,
  exists = existsSync,
  env,
} = {}) {
  const modules = await probePythonModules({
    python: pixal3dPython({ exists, env }),
    modules: [...PIXAL3D_REQUIRED_MODULES, ...PIXAL3D_NAF_MODULES],
    execFileImpl,
  });
  if (!modules) return { naf: 'unknown', missing: [] };
  const nafPresent = PIXAL3D_NAF_MODULES.every((m) => modules[m]);
  return {
    naf: nafPresent ? 'available' : 'unavailable',
    missing: PIXAL3D_REQUIRED_MODULES.filter((m) => !modules[m]),
    ...(nafPresent ? {} : { help: PIXAL3D_NAF_FALLBACK_HELP }),
  };
}

/**
 * A NATTEN / NAF-upsampler failure. Distinct from a generic crash because it is
 * identifies a problem with the existing NATTEN build.
 */
export const isPixal3dNafError = textMatcher([
  'libnatten', 'HAS_LIBNATTEN', "No module named 'natten'", 'NATTEN was not compiled',
]);

const NAF_ERROR_HELP = 'This render failed inside Pixal3D\'s NAF upsampler, which needs '
  + 'NATTEN built with CUDA kernels for this GPU.';

/**
 * The WSL2 NAF crash. Upstream issue #31 reports a reproducible
 * `CUDA driver error: device not ready` inside the NAF upsampler's encoder on WSL2,
 * on passes where `use_naf_upsample=True` — while the same NATTEN build works in
 * isolation. It is classified separately from a NATTEN *build* problem because the
 * remedy is different and Repair install will not help: PortOS points Windows users at
 * WSL2 for the TRELLIS.2 CUDA lane, and that advice does not carry over here.
 */
export const isPixal3dWslNafError = textMatcher(['CUDA driver error: device not ready']);

const WSL_NAF_HELP = 'The GPU driver reported "device not ready" inside Pixal3D\'s NAF '
  + 'upsampler. This is a known upstream failure under WSL2 (Pixal3D issue #31) that a '
  + 'reinstall does not fix — render on a native Linux host, or use the TRELLIS.2 (CUDA) '
  + 'target on this machine instead.';

const CUDA_OOM_HELP = 'The GPU ran out of memory during this render. Close other GPU '
  + 'workloads and try again, or render at a lower resolution — Pixal3D needs ~12 GB at '
  + '1024 and up to ~36 GB for full-quality 1536.';

/**
 * Run a single image→GLB generation. Same contract as `runTrellis2CudaGenerate`: the one
 * real-subprocess boundary, GUARDED (rejects `PIXAL3D_CUDA_NOT_INSTALLED` unless the
 * environment is present, so it can never run from a cold boot), returning
 * `{ promise, kill }` so a caller can terminate the render mid-flight, and normalizing
 * the result to opaque so low-alpha prediction noise doesn't become visible holes.
 * `spawnImpl`/`exists` are injectable so the wiring is unit-testable without a render.
 *
 * Cancellation matters more here than on the TRELLIS.2 lanes: a full-quality Pixal3D
 * render is measured in minutes, not seconds.
 *
 * `vramGb` is the size of the card this host will render on, passed down from the host
 * capabilities resolved at the request boundary; it selects the resolution/offload
 * tier. Null/unknown degrades to the floor.
 *
 * `cwd` is the Pixal3D checkout, which is load-bearing rather than tidiness: upstream's
 * `inference.py` imports its own `pixal3d` package relative to the checkout and writes
 * its `flex_gemm` autotune cache next to the script.
 *
 * @param {{imagePath: string, outputPath?: string, base?: string, resolution?: number,
 *          lowVram?: boolean, vramGb?: number|null,
 *          steps?: number|null, seed?: number|null,
 *          onProgress?: (frame: object) => void, spawnImpl?: Function,
 *          exists?: (p: string) => boolean, env?: NodeJS.ProcessEnv,
 *          postprocessGlb?: (path: string) => void|Promise<void>}} opts
 * @returns {{promise: Promise<{assetPath: string}>, kill: () => void}}
 */
export function runPixal3dCudaGenerate({
  imagePath,
  outputPath,
  base,
  resolution,
  lowVram,
  vramGb = null,
  steps = null,
  seed = null,
  onProgress,
  spawnImpl = spawn,
  exists = existsSync,
  env,
  postprocessGlb = rewriteGlbMaterialsOpaque,
} = {}) {
  // Resolve the interpreter once and reuse it as the "is the env there?" answer.
  const python = pixal3dPython({ exists, env });
  if (!python || !exists(pixal3dInferenceScript(base))) {
    const err = new Error(`${LABEL} is not installed — install it before generating.`);
    err.code = `${CODE_PREFIX}_NOT_INSTALLED`;
    return { promise: Promise.reject(err), kill: () => {} };
  }
  const budget = selectPixal3dRenderBudget(vramGb);
  const { command, args } = buildPixal3dGenerateArgs({
    imagePath,
    outputPath,
    base,
    python,
    resolution: resolution ?? budget.resolution,
    lowVram: lowVram ?? budget.lowVram,
    steps,
    seed,
  });
  return runGenerateSubprocess({
    command,
    args,
    cwd: pixal3dRepoDir(base),
    env,
    label: LABEL,
    codePrefix: CODE_PREFIX,
    parseProgress: parsePixal3dProgress,
    assetPath: outputPath || null,
    onProgress,
    spawnImpl,
    postprocessGlb,
    // Order matters: the WSL2 driver fault and a missing NATTEN build both surface from
    // the NAF stage but have different remedies, so the more specific one is tested
    // first and never collapses into "rebuild NATTEN" (which would not help).
    classifiers: [
      { test: isPixal3dWslNafError, code: `${CODE_PREFIX}_NAF_DEVICE_NOT_READY`, help: WSL_NAF_HELP },
      { test: isPixal3dNafError, code: `${CODE_PREFIX}_NAF_UNAVAILABLE`, help: NAF_ERROR_HELP },
      { test: isHfAuthError, code: `${CODE_PREFIX}_HF_AUTH_REQUIRED`, help: () => hfGatedRepoHelp('pixal3dCuda') },
      { test: isCudaOomError, code: `${CODE_PREFIX}_OUT_OF_MEMORY`, help: CUDA_OOM_HELP },
    ],
  });
}
