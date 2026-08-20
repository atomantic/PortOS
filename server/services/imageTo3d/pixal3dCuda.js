/**
 * Pixal3D (local NVIDIA / CUDA) target — install detection, pure command builders,
 * and a guarded generate runner.
 *
 * `TencentARC/Pixal3D` (SIGGRAPH 2026, MIT) is a pixel-aligned image→3D model built
 * on the TRELLIS.2 backbone: it back-projects pixel features into 3D instead of
 * injecting them through attention, which is what buys it near-reconstruction-level
 * geometry and PBR texture at 1536³. This lane is the CUDA sibling of
 * `trellis2Cuda.js` and deliberately mirrors its shape — the subprocess machinery
 * (install sequencing with transient retry, cancel, the generate child driver) is
 * shared through `laneRunner.js`, so this file is only what is Pixal3D-specific.
 * Everything is either pure or exercised through injectable `exists`/`spawnImpl`, so
 * the wiring is unit-testable WITHOUT an NVIDIA box, a ~40 GB install, or a live
 * render. `runPixal3dCudaGenerate` is the one real subprocess boundary and NEVER
 * auto-runs (CLAUDE.md no-cold-bootstrap policy).
 *
 * **Four things differ from the TRELLIS.2 CUDA lane, and each drives the design:**
 *
 * 1. **Upstream SHIPS a CLI.** Unlike `microsoft/TRELLIS.2` (whose `example.py` has
 *    hard-coded paths, forcing PortOS to ship `trellis2CudaGenerateRunner.py`),
 *    Pixal3D's `inference.py` is a real image→GLB entrypoint. So there is no PortOS
 *    Python runner here — re-implementing it would mean re-deriving its MoGe-2 camera
 *    estimation and FOV/distance solve, which is exactly the domain code most likely
 *    to be got subtly wrong.
 *
 * 2. **`--output` is a full path, NOT a stem.** TRELLIS.2's runners take a stem and
 *    append `.glb`; `inference.py` writes precisely the path it is given. So this lane
 *    must NOT route `outputPath` through `trellis2OutputStem` — doing so would silently
 *    produce `model` with no extension.
 *
 * 3. **Its own conda env, and its own TRELLIS.2 checkout.** Pixal3D's install is
 *    "set up TRELLIS.2's environment, then add our deps", and those deps pin
 *    `transformers`/`diffusers`/`pillow` versions. Installing them into the existing
 *    `trellis2` env would mutate a working target's dependency set — a change that
 *    degrades a *different* lane is the worst kind, so this lane pays ~15 GB of extra
 *    disk for isolation. Upstream's `setup.sh --new-env` hard-codes
 *    `conda create -n trellis2`, so the env is created here (named `pixal3d`) and
 *    `setup.sh` is sourced WITHOUT `--new-env` so it installs into the active env.
 *
 * 4. **No gated Hugging Face repos.** `trellis2Cuda` needs `facebook/dinov3` accepted;
 *    Pixal3D loads DINOv3 from the `camenduru/...` mirror and MoGe from
 *    `Ruicheng/moge-2-vitl`, both ungated. Its descriptor therefore declares no
 *    `gatedRepos` — a token still helps with rate limits, but nothing needs accepting.
 *
 * Clone layout: `~/.portos/pixal3d/{TRELLIS.2,Pixal3D}`, conda env `pixal3d`.
 */

import { existsSync } from 'node:fs';
import { cpus, homedir } from 'node:os';
import { join } from 'node:path';
import { execFile, spawn } from '../../lib/childProcess.js';
import { rewriteGlbMaterialsOpaque } from './glbMaterials.js';
import {
  hfGatedRepoHelp,
  isHfAuthError,
  isTransientInstallError,
  parseGenerateProgress,
} from './trellis2.js';
import { isCudaOomError, TRELLIS2_CUDA_REPO } from './trellis2Cuda.js';
import { textMatcher, runInstallSteps, runGenerateSubprocess } from './laneRunner.js';
import { renderOptionArgs } from './renderOptions.js';

const HOME = homedir();

/** Error-code namespace and user-facing name for this lane's subprocess failures. */
const CODE_PREFIX = 'PIXAL3D_CUDA';
const LABEL = 'Pixal3D (CUDA)';

/**
 * Upstream TencentARC/Pixal3D.
 *
 * **Cloned at its DEFAULT branch (`master`), deliberately not `main`.** Upstream's
 * README carries a "Branches" table naming `main` as the TRELLIS.2-backbone version
 * and `paper` as the Direct3D-S2 original — but there is no `main` branch on the
 * remote (only `master`, `paper`, `pr-12`), and `master` is the TRELLIS.2-backbone
 * code. Pinning `-b main` from the README would make the clone step fail outright.
 */
export const PIXAL3D_REPO = 'https://github.com/TencentARC/Pixal3D.git';

/** The conda environment this lane builds. Named to avoid colliding with `trellis2`. */
export const PIXAL3D_CONDA_ENV = 'pixal3d';

/** Python the env is created with — matches what TRELLIS.2's `setup.sh` uses. */
export const PIXAL3D_PYTHON_VERSION = '3.10';

/** NATTEN pin from upstream's install guide (neighborhood attention for the NAF upsampler). */
export const PIXAL3D_NATTEN_VERSION = '0.21.0';

/** The `utils3d` wheel upstream pins by URL (not on PyPI at this version). */
export const PIXAL3D_UTILS3D_WHEEL = 'https://github.com/LDYang694/Storages/releases/download/20260430/utils3d-0.0.2-py3-none-any.whl';

/** Clone/install root. `base` overridable for tests. */
export function pixal3dRoot(base = join(HOME, '.portos')) {
  return join(base, 'pixal3d');
}

/** Where TRELLIS.2 is cloned — sourced only for its `setup.sh` + extension submodules. */
export function pixal3dTrellisDir(base) {
  return join(pixal3dRoot(base), 'TRELLIS.2');
}

/** Where Pixal3D itself is cloned — the code this lane actually runs. */
export function pixal3dRepoDir(base) {
  return join(pixal3dRoot(base), 'Pixal3D');
}

/** Upstream's shipped entrypoint. */
export function pixal3dInferenceScript(base) {
  return join(pixal3dRepoDir(base), 'inference.py');
}

/**
 * Where the `pixal3d` conda environment may live. Same ordered candidate probe as
 * `trellis2CudaPythonCandidates` (and `resolveFlux2Python` before it): the machine's
 * own answer first (`CONDA_PREFIX`/`CONDA_ROOT`), then the standard install roots.
 *
 * Linux-only paths (`bin/python`) — the descriptor gates this lane to a Linux host, and
 * a Windows machine reaches it through WSL2, which reports as Linux.
 *
 * @param {{env?: object}} [opts]
 * @returns {string[]}
 */
export function pixal3dPythonCandidates({ env = process.env } = {}) {
  const roots = [
    env.CONDA_PREFIX && /[/\\]envs[/\\][^/\\]+$/.test(env.CONDA_PREFIX)
      ? join(env.CONDA_PREFIX, '..', '..')
      : env.CONDA_PREFIX,
    env.CONDA_ROOT,
    join(HOME, 'miniconda3'),
    join(HOME, 'anaconda3'),
    join(HOME, 'miniforge3'),
    join(HOME, 'mambaforge'),
    '/opt/conda',
  ].filter(Boolean);
  return roots.map((root) => join(root, 'envs', PIXAL3D_CONDA_ENV, 'bin', 'python'));
}

/**
 * The conda Python for this lane, or null when no candidate exists. `exists` is
 * injectable so the probe is deterministic in tests.
 * @param {{exists?: (p: string) => boolean, env?: object}} [opts]
 * @returns {string|null}
 */
export function pixal3dPython({ exists = existsSync, env } = {}) {
  return pixal3dPythonCandidates({ env }).find((p) => exists(p)) || null;
}

/**
 * Installed ⇔ the conda env's Python exists AND upstream's entrypoint is on disk.
 * Both halves matter: the env can be created and then the dependency build can fail,
 * which would otherwise read as a complete install (the lesson `trellis2Cuda`'s verify
 * step encodes).
 * @param {{base?: string, exists?: (p: string) => boolean, env?: object}} [opts]
 * @returns {boolean}
 */
export function isPixal3dCudaInstalled({ base, exists = existsSync, env } = {}) {
  if (!pixal3dPython({ exists, env })) return false;
  return exists(pixal3dInferenceScript(base));
}

/**
 * TRELLIS.2 `setup.sh` flags for this lane — the same extension set the
 * `trellis2Cuda` lane builds, MINUS `--new-env` (see the file header: the env is
 * created separately so it can be named `pixal3d`).
 *
 * Pixal3D imports `o_voxel` (the GLB exporter) and `flex_gemm` directly, and defaults
 * `ATTN_BACKEND` to `flash_attn`, so `--o-voxel`, `--flexgemm` and `--flash-attn` are
 * load-bearing rather than optional; `--nvdiffrast`/`--nvdiffrec`/`--cumesh` back the
 * texture bake and mesh ops the exporter calls.
 */
export const PIXAL3D_SETUP_FLAGS = Object.freeze([
  '--basic', '--flash-attn', '--nvdiffrast', '--nvdiffrec',
  '--cumesh', '--o-voxel', '--flexgemm',
]);

/** Build workers for the NATTEN compile — bounded so it can't monopolize the box. */
export function nattenWorkerCount(cpuCount = cpus().length) {
  const n = Number.isFinite(cpuCount) && cpuCount > 0 ? cpuCount : 4;
  return Math.max(1, Math.min(8, Math.floor(n / 2)));
}

/**
 * The install as an ordered list of `{stage, command, args, cwd?, optional?}` steps.
 *
 * Every step is skippable/idempotent so a run that died partway re-reaches the rest
 * rather than aborting on "already exists" — the resume property both TRELLIS.2 lanes
 * rely on. `conda create` is skipped when the env's Python is already present, and
 * each clone is skipped when its `.git` is there.
 *
 * **`setup.sh` is SOURCED in a login shell after activating our env.** Upstream
 * documents `. ./setup.sh` because the script installs into the *active* conda env;
 * `bash setup.sh` would give `conda activate` no shell hooks and land the packages in
 * the wrong interpreter. `bash -lc` loads the profile `conda init` wrote, which is
 * what makes `conda activate` work in a non-interactive child.
 *
 * **The NATTEN step is `optional`.** It compiles CUDA kernels for a specific arch, and
 * a failure there is survivable: without NATTEN the pipeline takes upstream's
 * documented NAF fallback path — slower and lower quality, but it renders. Failing the
 * whole ~40 GB install over it would be a worse outcome than a degraded one the
 * install-state probe then reports. `computeCap` comes from
 * `detectCudaComputeCapability()`; when it could not be determined the env var is
 * omitted entirely rather than guessed, letting NATTEN pick its own default.
 *
 * @param {string} [base]
 * @param {{exists?: (p: string) => boolean, computeCap?: string|null, workers?: number}} [opts]
 * @returns {Array<{stage: string, command: string, args: string[], cwd?: string, optional?: boolean}>}
 */
export function buildPixal3dInstallSteps(base, { exists = existsSync, computeCap = null, workers } = {}) {
  const root = pixal3dRoot(base);
  const trellisDir = pixal3dTrellisDir(base);
  const repoDir = pixal3dRepoDir(base);
  const steps = [];

  if (!pixal3dPython({ exists })) {
    steps.push({
      stage: 'env',
      command: 'conda',
      args: ['create', '-n', PIXAL3D_CONDA_ENV, `python=${PIXAL3D_PYTHON_VERSION}`, '-y'],
    });
  }
  // Recursive: TRELLIS.2 vendors its CUDA extensions as submodules, and a shallow
  // clone yields empty extension dirs and a setup that fails deep in a compile.
  if (!exists(join(trellisDir, '.git'))) {
    steps.push({
      stage: 'clone-trellis',
      command: 'git',
      args: ['clone', '--recursive', TRELLIS2_CUDA_REPO, trellisDir],
    });
  }
  if (!exists(join(repoDir, '.git'))) {
    steps.push({ stage: 'clone', command: 'git', args: ['clone', PIXAL3D_REPO, repoDir] });
  }
  steps.push({
    stage: 'setup',
    command: 'bash',
    args: ['-lc', `conda activate ${PIXAL3D_CONDA_ENV} && . ./setup.sh ${PIXAL3D_SETUP_FLAGS.join(' ')}`],
    cwd: trellisDir,
  });
  steps.push({
    stage: 'deps',
    command: 'bash',
    args: ['-lc', `conda activate ${PIXAL3D_CONDA_ENV} && pip install -r requirements.txt`],
    cwd: repoDir,
  });
  const nattenEnv = [
    ...(computeCap ? [`NATTEN_CUDA_ARCH=${computeCap}`] : []),
    `NATTEN_N_WORKERS=${workers ?? nattenWorkerCount()}`,
  ].join(' ');
  steps.push({
    stage: 'natten',
    command: 'bash',
    args: ['-lc',
      `conda activate ${PIXAL3D_CONDA_ENV} && ${nattenEnv} `
      + `pip install natten==${PIXAL3D_NATTEN_VERSION} --no-build-isolation`],
    cwd: repoDir,
    optional: true,
  });
  steps.push({
    stage: 'utils3d',
    command: 'bash',
    args: ['-lc', `conda activate ${PIXAL3D_CONDA_ENV} && pip install ${PIXAL3D_UTILS3D_WHEEL}`],
    cwd: repoDir,
  });
  return steps;
}

/**
 * Resolution / offload lanes, picked from the card's VRAM.
 *
 * Upstream documents three usable combinations, and they are genuinely three tiers
 * rather than a single quality knob (Pixal3D issue #7 measured "18–36 GB depending on
 * settings"; the merged low-VRAM PR brings peak down to ~10–12 GB by loading one
 * pipeline stage onto the GPU at a time):
 *
 *  - `>= 36 GB` → standard mode at 1536. No offload, so it is also the fastest.
 *  - `>= 24 GB` → 1536 with `--low_vram`. Upstream explicitly supports forcing the
 *    full resolution in low-VRAM mode; the stage-at-a-time offload pays for it in
 *    wall-clock rather than quality.
 *  - otherwise  → 1024 with `--low_vram`, the floor this lane supports at all.
 *
 * An unknown/unparseable VRAM reading degrades to the floor rather than overcommitting
 * a card we failed to size (CLAUDE.md sentinel rule).
 *
 * @param {number|null} vramGb
 * @returns {{lowVram: boolean, resolution: number}}
 */
export const PIXAL3D_STANDARD_MODE_MIN_VRAM_GB = 36;
export const PIXAL3D_HIGH_RES_MIN_VRAM_GB = 24;
export const PIXAL3D_RESOLUTIONS = [1024, 1536];

export function selectPixal3dRenderBudget(vramGb) {
  const gb = Number(vramGb);
  if (gb >= PIXAL3D_STANDARD_MODE_MIN_VRAM_GB) return { lowVram: false, resolution: 1536 };
  if (gb >= PIXAL3D_HIGH_RES_MIN_VRAM_GB) return { lowVram: true, resolution: 1536 };
  return { lowVram: true, resolution: 1024 };
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
 * `steps`/`seed` reuse the shared `renderOptionArgs` contract so the ranges and flag
 * names cannot drift from the TRELLIS.2 lanes — but note upstream's `inference.py`
 * exposes no per-phase step override, so a non-null `steps` is validated and then
 * dropped rather than being emitted as an unrecognized flag.
 *
 * @param {{imagePath: string, outputPath?: string, base?: string, python?: string,
 *          resolution?: number, lowVram?: boolean, fov?: number|null,
 *          steps?: number|null, seed?: number|null}} opts
 * @returns {{command: string, args: string[]}}
 */
export function buildPixal3dGenerateArgs({
  imagePath,
  outputPath,
  base,
  python,
  resolution = 1024,
  lowVram = true,
  fov = null,
  steps = null,
  seed = null,
} = {}) {
  if (!imagePath) throw new Error('buildPixal3dGenerateArgs: imagePath is required');
  if (!PIXAL3D_RESOLUTIONS.includes(resolution)) {
    throw new Error(
      `buildPixal3dGenerateArgs: resolution must be one of ${PIXAL3D_RESOLUTIONS.join(', ')}`,
    );
  }
  // Validate BOTH against the shared ranges (throws on an out-of-range value, so a
  // mistyped steps count is still rejected at the same boundary as the other lanes) …
  renderOptionArgs('buildPixal3dGenerateArgs', { steps, seed });
  // … but emit only `--seed`: upstream's `inference.py` has no per-phase step override,
  // and passing an unrecognized flag would make argparse abort a queued job.
  const seedArgs = seed !== null ? ['--seed', String(seed)] : [];
  const args = [
    pixal3dInferenceScript(base),
    '--image', imagePath,
    '--resolution', String(resolution),
  ];
  if (outputPath) args.push('--output', outputPath);
  if (lowVram) args.push('--low_vram');
  if (fov !== null) args.push('--fov', String(fov));
  args.push(...seedArgs);
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
 * that quality degrades. `pixal3d` is upstream's own package (it runs from the clone,
 * so this resolves only with the repo root on `sys.path`); `o_voxel` is the GLB
 * exporter and `flex_gemm` the sparse GEMM its autotuner configures on import.
 */
export const PIXAL3D_REQUIRED_MODULES = ['o_voxel', 'flex_gemm'];

/** NATTEN backs the NAF upsampler. Absent ⇒ renders take upstream's fallback path. */
export const PIXAL3D_NAF_MODULES = ['natten'];

/** The shell probe that reports which modules resolve inside the env. */
const MODULE_PROBE_SOURCE = 'import importlib.util as u,json,sys;'
  + 'print(json.dumps({m: u.find_spec(m) is not None for m in sys.argv[1:]}))';

export const PIXAL3D_NAF_FALLBACK_HELP = 'Pixal3D is installed, but NATTEN is missing, '
  + 'so its NAF refinement step falls back to DINO projection features — slower, and '
  + 'geometry/texture detail is a notch lower than upstream. Repair install rebuilds '
  + 'NATTEN for this GPU; your downloaded models are kept.';

/**
 * Probe which of the env's modules resolve, for the install-state card.
 *
 * Uses `importlib.util.find_spec`, which resolves a module WITHOUT importing it — so
 * the probe costs ~20 ms and never pulls in torch, which is what makes it safe to run
 * on every `/targets` request (the same reason `probeTrellis2TextureBake` uses it).
 *
 * **`naf: 'available'` means the NATTEN PACKAGE resolves — it does NOT prove the CUDA
 * `libnatten` kernels built.** Confirming that needs `import natten` to read
 * `HAS_LIBNATTEN`, which costs a torch import; paying that per `/targets` request is
 * not worth it, so the deep check is left to render time, where
 * `isPixal3dNafError` classifies the failure into an actionable message. Reported as
 * `'unknown'` when the probe itself could not run — deliberately distinct from
 * `'unavailable'`, so a broken probe never renders a warning about a fine install
 * (CLAUDE.md sentinel rule: "failed to determine" ≠ "determined to be bad").
 *
 * @param {{base?: string, execFileImpl?: Function, exists?: (p: string) => boolean,
 *          env?: NodeJS.ProcessEnv}} [opts]
 * @returns {Promise<{naf: 'available'|'unavailable'|'unknown', modules: Record<string, boolean>,
 *                    missing: string[], help?: string}>}
 */
export async function probePixal3dModules({
  base,
  execFileImpl = execFile,
  exists = existsSync,
  env,
} = {}) {
  const python = pixal3dPython({ exists, env });
  if (!python) return { naf: 'unknown', modules: {}, missing: [] };
  const probed = [...PIXAL3D_REQUIRED_MODULES, ...PIXAL3D_NAF_MODULES];
  // Subprocess boundary outside the request lifecycle — a probe failure must degrade
  // to 'unknown', never reject into the route (CLAUDE.md child-process exception).
  const modules = await new Promise((resolve) => {
    execFileImpl(python, ['-c', MODULE_PROBE_SOURCE, ...probed], { timeout: 15000 }, (err, stdout) => {
      if (err) return resolve(null);
      const parsed = JSON.parse(String(stdout || '').trim() || 'null');
      resolve(parsed && typeof parsed === 'object' ? parsed : null);
    });
  }).catch(() => null);

  if (!modules) return { naf: 'unknown', modules: {}, missing: [] };
  const missing = PIXAL3D_REQUIRED_MODULES.filter((m) => !modules[m]);
  const nafPresent = PIXAL3D_NAF_MODULES.every((m) => modules[m]);
  return {
    naf: nafPresent ? 'available' : 'unavailable',
    modules,
    missing,
    ...(nafPresent ? {} : { help: PIXAL3D_NAF_FALLBACK_HELP }),
  };
}

/**
 * A NATTEN / NAF-upsampler failure. Distinct from a generic crash because it is
 * user-actionable: repair the install to rebuild NATTEN for this card.
 */
export const isPixal3dNafError = textMatcher([
  'libnatten', 'HAS_LIBNATTEN', "No module named 'natten'", 'NATTEN was not compiled',
]);

const NAF_ERROR_HELP = 'This render failed inside Pixal3D\'s NAF upsampler, which needs '
  + 'NATTEN built with CUDA kernels for this GPU. Run Repair install to rebuild it.';

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
 * Run the install as a killable, event-emitting job: conda env → TRELLIS.2 clone +
 * `setup.sh` → Pixal3D clone → deps → NATTEN → utils3d (~40 GB and a long CUDA
 * extension build). Real subprocesses — user-triggered only. Retry/cancel/backoff
 * semantics come from the shared `runInstallSteps`.
 *
 * `computeCap` is resolved by the caller (the adapter, via
 * `detectCudaComputeCapability`) rather than probed here, keeping this function's
 * inputs explicit and its steps deterministic in tests.
 *
 * @param {{base?: string, onEvent?: (ev: object) => void, spawnImpl?: Function,
 *          maxRetries?: number, sleep?: (ms: number) => Promise<void>,
 *          exists?: (p: string) => boolean, env?: NodeJS.ProcessEnv,
 *          computeCap?: string|null, workers?: number}} [opts]
 * @returns {{promise: Promise<{ok: true}>, kill: () => void}}
 */
export function installPixal3dCuda({
  base,
  onEvent = () => {},
  spawnImpl = spawn,
  maxRetries = 3,
  sleep,
  exists = existsSync,
  env,
  computeCap = null,
  workers,
} = {}) {
  return runInstallSteps({
    steps: buildPixal3dInstallSteps(base, { exists, computeCap, workers }),
    label: LABEL,
    codePrefix: CODE_PREFIX,
    isTransient: isTransientInstallError,
    onEvent,
    spawnImpl,
    maxRetries,
    sleep,
    env,
    // Steps can leave a usable env behind while a build failed, so confirm what
    // actually landed rather than trusting exit 0 (#2952's lesson).
    verify: (emit) => {
      if (!isPixal3dCudaInstalled({ base, exists, env })) {
        const err = new Error(
          `${LABEL} setup finished but its conda environment or the Pixal3D checkout is `
          + 'missing — check the setup log above for a failed extension build.',
        );
        err.code = `${CODE_PREFIX}_INSTALL_INCOMPLETE`;
        err.stage = 'verify';
        throw err;
      }
      emit({ type: 'log', stage: 'verify', message: '✅ Pixal3D CUDA environment is present.' });
    },
  });
}

/**
 * Run a single image→GLB generation. The one real-subprocess boundary — GUARDED:
 * rejects `PIXAL3D_CUDA_NOT_INSTALLED` unless the environment is present, so it can
 * never run from a cold boot. `spawnImpl`/`exists` are injectable so the wiring is
 * unit-testable without a real render.
 *
 * Returns `{ promise, kill }` so a caller can terminate the render mid-flight — e.g.
 * when the user deletes the record while its GLB is still rendering. That matters more
 * here than on the TRELLIS.2 lanes: a full-quality Pixal3D render is measured in
 * minutes, not seconds.
 *
 * `vramGb` is the size of the card this host will render on, passed down from the host
 * capabilities resolved at the request boundary; it selects the resolution/offload
 * tier. Null/unknown degrades to the floor.
 *
 * `cwd` is the Pixal3D checkout, which is load-bearing rather than tidiness: upstream's
 * `inference.py` imports its own `pixal3d` package relative to the checkout and writes
 * its `flex_gemm` autotune cache next to the script.
 *
 * A successful render is normalized to opaque before it resolves, for the same reason
 * both TRELLIS.2 lanes do it: prediction noise in low-alpha texels otherwise turns
 * into visible holes in PortOS and in downloaded GLBs.
 *
 * @param {{imagePath: string, outputPath?: string, base?: string, resolution?: number,
 *          lowVram?: boolean, vramGb?: number|null, fov?: number|null,
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
  fov = null,
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
    fov,
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
