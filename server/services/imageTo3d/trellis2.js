/**
 * TRELLIS.2 (local Apple Silicon / MPS) target — install detection, pure command
 * builders, a robust progress parser, and a guarded generate runner.
 *
 * Phase 2a of #2951/#2952: the *scaffolding* the install SSE route and the 3D page
 * will drive. Everything here is either pure (path/arg/step builders, the progress
 * parser) or exercised only through injectable dependencies (`exists`, `spawnImpl`)
 * so the wiring is unit-testable **without** downloading the ~15 GB model or running
 * a live GPU render. `runTrellis2Generate` is the one real-subprocess boundary and
 * NEVER auto-runs — it throws unless the model is installed and is only reached from
 * an explicit user action (CLAUDE.md no-cold-bootstrap policy). The exact wording of
 * `generate.py`'s progress output is refined during hands-on validation, so the
 * parser keys on format-agnostic signals (a percentage, a `.glb` path) rather than
 * guessing internal stage names.
 *
 * Install layout mirrors the FLUX.2 venv convention in `pythonSetup.js`
 * (`~/.portos/...`): the `trellis-mac` repo is cloned to `~/.portos/trellis2` and its
 * `setup.sh` builds a `.venv` inside it.
 */

import { existsSync } from 'node:fs';
import { homedir, platform, totalmem } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from '../../lib/childProcess.js';
import { rewriteGlbMaterialsOpaque } from './glbMaterials.js';
import { getTarget } from './targets.js';
import {
  textMatcher,
  runInstallSteps,
  runGenerateSubprocess,
  probePythonModules,
} from './laneRunner.js';
import { renderOptionArgs } from './renderOptions.js';

const HOME = homedir();
const IS_WIN = platform() === 'win32';

/** Error-code namespace and user-facing name for this lane's subprocess failures. */
const CODE_PREFIX = 'TRELLIS2';
const LABEL = 'TRELLIS.2';

/** The Apple Silicon MPS port of Microsoft TRELLIS.2. */
export const TRELLIS2_REPO = 'https://github.com/shivampkumar/trellis-mac';

/**
 * The one upstream dep PortOS clones itself — not because it is the only one with a
 * submodule (`deps/mtlmesh` has two), but because it is the only one whose submodule is
 * load-bearing on Apple Silicon: `mtlmesh`'s `cubvh`/`mtlbvh` feed only its CUDA
 * extensions, so they stay empty here harmlessly. See `trellis2AppleDepsStep`.
 */
export const TRELLIS2_APPLE_REPO = 'https://github.com/pedronaugusto/trellis2-apple.git';

/** Clone/install root. `base` overridable for tests. */
export function trellis2Root(base = join(HOME, '.portos')) {
  return join(base, 'trellis2');
}

/**
 * Where `setup.sh` expects the `trellis2-apple` dep checkout. Its `deps/` is
 * gitignored in the port, so this is never a submodule of `TRELLIS2_REPO` — it is a
 * plain directory that upstream clones into, and that PortOS can therefore pre-fill.
 */
export function trellis2AppleDepDir(base) {
  return join(trellis2Root(base), 'deps', 'trellis2-apple');
}

/** The venv Python the `setup.sh` script builds inside the clone. */
export function trellis2VenvPython(base) {
  const root = trellis2Root(base);
  return IS_WIN
    ? join(root, '.venv', 'Scripts', 'python.exe')
    : join(root, '.venv', 'bin', 'python3');
}

/** The port's single-image entrypoint (`python generate.py <image>`). */
export function trellis2GenerateScript(base) {
  return join(trellis2Root(base), 'generate.py');
}

/** PortOS adapter that exposes the upstream exporter's supported 4K atlas size. */
export function trellis2GenerateRunnerScript() {
  return fileURLToPath(new URL('./trellis2GenerateRunner.py', import.meta.url));
}

/**
 * Installed ⇔ the venv Python AND the generate script both exist. `exists` is
 * injectable so the check is deterministic in tests.
 * @param {{base?: string, exists?: (p: string) => boolean}} [opts]
 * @returns {boolean}
 */
export function isTrellis2Installed({ base, exists = existsSync } = {}) {
  return exists(trellis2VenvPython(base)) && exists(trellis2GenerateScript(base));
}

/**
 * The Python modules `generate.py`'s Metal texture-baking path needs. It gates the
 * high-quality bake on `o_voxel.postprocess._BACKEND === 'metal' && _HAS_DR`, which
 * in turn requires `mtldiffrast` (the Metal rasterizer) and `mtlbvh` to have built.
 * When ANY is missing it silently falls back to a pure-Python KDTree/xatlas baker —
 * see `TRELLIS2_FALLBACK_BAKE_HELP` for why that fallback is unusable.
 */
export const TRELLIS2_METAL_BAKE_MODULES = ['o_voxel', 'mtldiffrast', 'mtlbvh'];

/**
 * `flex_gemm` (from `mtlgemm`) is not required for the Metal bake, but the baker
 * prefers its sparse grid-sample over a `torch.nn.functional` fallback — upstream
 * notes the fallback produces concentric ring artifacts on curved surfaces. Absent
 * ⇒ the bake still runs, just a notch lower quality.
 */
export const TRELLIS2_BAKE_QUALITY_MODULES = ['flex_gemm'];

/**
 * Why a degraded install matters, in the user's terms. `setup.sh` installs the four
 * Metal packages with `|| echo "… continuing without …"` and still exits 0, so a
 * host missing the Xcode **Metal Toolchain** (the packages compile `.metal` sources)
 * completes the install "successfully" and every later render silently takes the
 * KDTree/xatlas fallback baker.
 *
 * That fallback is not merely lower quality — it is unusable on TRELLIS.2 output. It
 * UV-unwraps the mesh *after* decimating to 200k triangles, into a 1024² atlas: a
 * median of **~1.9 texels per triangle**, with a quarter of all triangles landing on
 * less than a single texel (measured on the #2952 reference render). Its hole-fill
 * then blurs unfilled black texels back over every chart edge. The geometry comes out
 * correct; the surface comes out as dark colored confetti.
 */
export const TRELLIS2_FALLBACK_BAKE_HELP = 'TRELLIS.2 is installed, but its Metal '
  + 'texture-baking backend is missing, so renders fall back to a low-resolution '
  + 'baker that produces correct geometry with a scrambled, speckled surface. Repair '
  + 'install fetches the missing build dependencies and rebuilds the Metal backends — '
  + 'your downloaded models are kept.';

/**
 * Probe whether the venv can take `generate.py`'s Metal texture-baking path.
 *
 * Uses `importlib.util.find_spec`, which resolves a module WITHOUT importing it — so
 * the probe costs ~20 ms and never pulls in torch. That is cheap enough to run on
 * every `/targets` request, and it keys on exactly the modules the `use_metal` gate
 * needs, so it cannot drift from what `generate.py` actually checks.
 *
 * Returns `quality: 'metal'` (good), `'fallback'` (installed but will produce the
 * confetti surface described in `TRELLIS2_FALLBACK_BAKE_HELP`), or `'unknown'` when
 * the probe itself could not run — deliberately distinct from `'fallback'` so a
 * broken probe never renders a scary warning about a possibly-fine install
 * (CLAUDE.md sentinel rule: "failed to determine" ≠ "determined to be bad").
 *
 * @param {{base?: string, execFileImpl?: Function, exists?: (p: string) => boolean}} [opts]
 * @returns {Promise<{quality: 'metal'|'fallback'|'unknown', modules: Record<string, boolean>,
 *                    missing: string[], degradedQuality: string[], help?: string}>}
 */
export async function probeTrellis2TextureBake({
  base,
  execFileImpl = execFile,
  exists = existsSync,
} = {}) {
  const python = trellis2VenvPython(base);
  if (!exists(python)) {
    return { quality: 'unknown', modules: {}, missing: [], degradedQuality: [] };
  }
  // Shared spawn + parse (`probePythonModules`). Was an inline copy whose `JSON.parse`
  // ran INSIDE the execFile callback, where a throw escapes the enclosing promise —
  // the `.catch()` fires on a later tick and cannot see it — and reaches the event
  // loop, killing the process. Any non-JSON on stdout from a healthy venv (a
  // `sitecustomize`/`.pth` print, a conda activation hook) turned a `/3d` page load
  // into a server restart. The shared helper parses after the callback resolves.
  const modules = await probePythonModules({
    python,
    modules: [...TRELLIS2_METAL_BAKE_MODULES, ...TRELLIS2_BAKE_QUALITY_MODULES],
    execFileImpl,
  });

  if (!modules) return { quality: 'unknown', modules: {}, missing: [], degradedQuality: [] };

  const missing = TRELLIS2_METAL_BAKE_MODULES.filter((m) => !modules[m]);
  const degradedQuality = TRELLIS2_BAKE_QUALITY_MODULES.filter((m) => !modules[m]);
  return {
    quality: missing.length ? 'fallback' : 'metal',
    modules,
    missing,
    degradedQuality,
    ...(missing.length ? { help: TRELLIS2_FALLBACK_BAKE_HELP } : {}),
  };
}

/**
 * Whether the Xcode Metal Toolchain is present — the prerequisite `setup.sh`
 * documents for building `mtldiffrast`/`mtlbvh`/`mtlgemm`. Checked BEFORE a ~15 GB
 * install so the user can fix it first, instead of discovering an hour later that
 * every render bakes garbage. Absent ⇒ the install still works, it just degrades.
 *
 * Non-macOS hosts report `available: null` (the check does not apply) rather than
 * `false`, so a Linux/Windows caller never sees a macOS-only warning.
 *
 * **Missing is not the same as unfixable.** `xcodebuild -downloadComponent` ships
 * with *full Xcode*; a host whose active developer dir is the Command Line Tools
 * has no `xcodebuild` to run it with. Those two cases get different answers —
 * `installable: true` means the install can just fetch it (see
 * `TRELLIS2_METAL_TOOLCHAIN_STEP`), while `blocker: 'requires-xcode'` means no
 * amount of retrying will help and the hint must name Xcode rather than a command
 * that is guaranteed to fail.
 *
 * @param {{execFileImpl?: Function, platformImpl?: () => string}} [opts]
 * @returns {Promise<{available: boolean|null, installable?: boolean,
 *                    blocker?: 'requires-xcode', hint?: string}>}
 */
export async function probeMetalToolchain({
  execFileImpl = execFile,
  platformImpl = platform,
} = {}) {
  if (platformImpl() !== 'darwin') return { available: null };
  // Subprocess boundary outside the request lifecycle — every outcome resolves,
  // nothing throws into the route (CLAUDE.md child-process exception).
  const run = (command, args) => new Promise((resolve) => {
    execFileImpl(command, args, { timeout: 15000 }, (err, stdout) => {
      resolve(err ? null : String(stdout ?? ''));
    });
  }).catch(() => null);

  if (await run('xcrun', ['-sdk', 'macosx', 'metal', '--version']) !== null) {
    return { available: true };
  }
  // Only full Xcode carries `xcodebuild -downloadComponent`. `xcode-select -p`
  // under the Command Line Tools resolves to /Library/Developer/CommandLineTools.
  const developerDir = await run('xcode-select', ['-p']);
  const hasXcode = !!developerDir && /Xcode.*\.app/i.test(developerDir);
  return hasXcode
    ? { available: false, installable: true, hint: TRELLIS2_METAL_TOOLCHAIN_HINT }
    : { available: false, installable: false, blocker: 'requires-xcode', hint: TRELLIS2_REQUIRES_XCODE_HINT };
}

/** A missing-but-fetchable toolchain: the install can download it unattended. */
export const TRELLIS2_METAL_TOOLCHAIN_HINT = 'The Xcode Metal Toolchain is not '
  + 'installed, so TRELLIS.2\'s Metal texture-baking backends cannot build and renders '
  + 'would produce a scrambled surface. The install will download it automatically '
  + '(a one-time ~2 GB download, no password required).';

/**
 * A missing toolchain on a host with only the Command Line Tools. Nothing PortOS
 * can run fixes this, so the hint names the real prerequisite instead of a command
 * that would fail.
 */
export const TRELLIS2_REQUIRES_XCODE_HINT = 'The Xcode Metal Toolchain is not '
  + 'installed and cannot be downloaded, because only the Command Line Tools are '
  + 'active on this host. Install Xcode from the App Store and run `sudo xcode-select '
  + '--switch /Applications/Xcode.app`, then repair the TRELLIS.2 install. Until then '
  + 'renders will produce correct geometry with a scrambled surface.';

/**
 * The step that fetches the Metal Toolchain. Verified on-device during #3041: it
 * runs unattended — no sudo, no interactive prompt, exit 0 — and afterwards
 * `xcrun metal` resolves and the port's four Metal packages compile.
 *
 * Marked `optional` because a missing texture bake degrades output but does not
 * break it: geometry is unaffected, and the `verify` step reports the degraded
 * result. A host that cannot fetch the toolchain must still be able to install and
 * render, so this step warns and continues rather than aborting the install.
 */
export const TRELLIS2_METAL_TOOLCHAIN_STEP = Object.freeze({
  stage: 'metal-toolchain',
  command: 'xcodebuild',
  args: ['-downloadComponent', 'MetalToolchain'],
  optional: true,
});

/**
 * Pre-fetch `deps/trellis2-apple` **with its submodules**, which upstream's `setup.sh`
 * cannot do for itself.
 *
 * `o_voxel` — one of the three modules `TRELLIS2_METAL_BAKE_MODULES` gates the Metal
 * bake on — compiles against Eigen, which `trellis2-apple` carries as a git submodule
 * (`o-voxel/third_party/eigen`). Upstream's `clone_dep` runs a bare
 * `git clone --depth 1` with no `--recurse-submodules`, so `third_party/eigen` lands as
 * an EMPTY directory and the build dies on `fatal error: 'Eigen/Dense' file not found`.
 * `setup.sh` swallows that (`|| echo`) and still exits 0 — so the install "succeeds"
 * while permanently stuck on the confetti fallback baker of
 * `TRELLIS2_FALLBACK_BAKE_HELP`, and installing Xcode or the Metal Toolchain (what the
 * warning used to tell users to do) could never fix it.
 *
 * PortOS fixes it from outside upstream: `clone_dep`'s guard is a bare
 * `if [ ! -d "$DEPS_DIR/$dir" ]`, so a directory we cloned ourselves makes upstream skip
 * its own clone, and its unconditional `o-voxel` install then succeeds on the first
 * pass — no need to duplicate upstream's uv / `--no-build-isolation` flags here.
 *
 * Two shapes, because a repair has to fix an install that is already on disk:
 *  - **absent** → clone it, submodules and all.
 *  - **already cloned** by an older `setup.sh`, so Eigen is missing → initialize the
 *    submodules in place. `setup.sh` re-runs the `o-voxel` install unconditionally, so
 *    the rebuild follows in the same pass.
 *
 * **"Already cloned" needs `o-voxel/` present, not just `.git`.** A clone killed
 * partway (SIGKILL, power loss) can leave `.git` behind with no worktree. Keying only
 * on `.git` would then pick the update branch, whose `git submodule update` cannot
 * restore a missing superproject worktree — it would succeed as a no-op, upstream's
 * `! -d` guard would skip its own clone, and `pip install deps/trellis2-apple/o-voxel`
 * would fail on a path that does not exist: silent, permanent degradation, the exact
 * failure this step exists to remove. Requiring the directory upstream actually
 * installs from routes that state to the clone branch instead, which fails loudly on
 * the non-empty target and names the real problem in the log. It does not self-heal
 * (that needs a re-clone, so it is deliberately left to the operator) but it never
 * again reports success while leaving `o_voxel` unbuildable.
 *
 * `optional` for the same reason the toolchain step is: a host that cannot reach
 * gitlab.com for Eigen must still be able to install and render, degraded, rather than
 * fail the whole install.
 *
 * @param {string|undefined} base
 * @param {(p: string) => boolean} exists
 * @returns {{stage: string, command: string, args: string[], cwd?: string, optional: boolean}}
 */
function trellis2AppleDepsStep(base, exists) {
  const dir = trellis2AppleDepDir(base);
  // Both halves required — see "Already cloned" above. `o-voxel` is the subdirectory
  // upstream's `setup.sh` pip-installs, so its absence means the checkout is unusable
  // no matter what `.git` says.
  const cloned = exists(join(dir, '.git')) && exists(join(dir, 'o-voxel'));
  return {
    stage: 'apple-deps',
    command: 'git',
    args: cloned
      ? ['submodule', 'update', '--init', '--recursive', '--depth', '1']
      : ['clone', '--depth', '1', '--recurse-submodules', '--shallow-submodules',
        TRELLIS2_APPLE_REPO, dir],
    // Only the in-place update needs a cwd; the clone creates `dir` itself.
    ...(cloned ? { cwd: dir } : {}),
    optional: true,
  };
}

/**
 * The install as an ordered list of `{stage, command, args, cwd?}` steps: shallow-
 * clone the port, then run its `setup.sh` (which builds the venv + fetches weights).
 * Keeping the plan a data structure makes it assertable without running it.
 *
 * **The clone step is skipped when the repo is already present** (`<root>/.git`
 * exists). This is load-bearing for resume: if a prior install cloned the top-level
 * repo but failed inside `setup.sh` (the common #2952 case — a dep clone dropped),
 * re-running with an unconditional `git clone … <root>` would abort ("destination
 * path already exists and is not an empty directory") and never reach the idempotent
 * `setup.sh`. `exists` is injectable so the skip is deterministic in tests.
 *
 * **The Metal Toolchain step leads when `installMetalToolchain` is set.** Order is
 * load-bearing: `setup.sh` compiles the Metal texture-baking packages from `.metal`
 * sources, so the toolchain has to be on disk BEFORE it runs or those builds fail
 * (silently — `setup.sh` swallows them and still exits 0) and the install completes
 * with a bake that renders scrambled surfaces (#2952). The caller passes the flag
 * from `probeMetalToolchain()`; a host that already has it, can't have it (Command
 * Line Tools only), or isn't macOS gets no step.
 *
 * **The `apple-deps` step sits between the clone and `setup.sh`.** Both sides of that
 * are load-bearing: AFTER the root clone, for the non-empty-target reason above (this
 * step creates `<root>/deps/…`); and BEFORE `setup.sh`, because that is what makes
 * upstream's `clone_dep` skip its own submodule-less clone. See
 * `trellis2AppleDepsStep`.
 *
 * @param {string} [base]
 * @param {{exists?: (p: string) => boolean, installMetalToolchain?: boolean}} [opts]
 * @returns {Array<{stage: string, command: string, args: string[], cwd?: string, optional?: boolean}>}
 */
export function buildInstallSteps(base, { exists = existsSync, installMetalToolchain = false } = {}) {
  const root = trellis2Root(base);
  const steps = [];
  // Copy `args` too — a spread alone would share the frozen template's array across
  // every call, so one caller mutating it would corrupt every later install plan.
  if (installMetalToolchain) {
    steps.push({ ...TRELLIS2_METAL_TOOLCHAIN_STEP, args: [...TRELLIS2_METAL_TOOLCHAIN_STEP.args] });
  }
  if (!exists(join(root, '.git'))) {
    steps.push({ stage: 'clone', command: 'git', args: ['clone', '--depth', '1', TRELLIS2_REPO, root] });
  }
  steps.push(trellis2AppleDepsStep(base, exists));
  steps.push({ stage: 'setup', command: 'bash', args: ['setup.sh'], cwd: root });
  return steps;
}

/**
 * The port's `--output` is a filename **stem**, NOT a full path — `generate.py`
 * appends the extension itself (`glb_path = f"{args.output}.glb"`, plus sibling
 * `.obj` / `_basecolor.png`). Callers hand us the real disk path they want the GLB
 * at (`…/model.glb`), so strip a single trailing `.glb` before it reaches the CLI —
 * otherwise the port writes `…/model.glb.glb` and PortOS serves a 404 at `…/model.glb`.
 * Confirmed against the real `generate.py` during #2952 hands-on validation.
 * @param {string} outputPath
 * @returns {string}
 */
export function trellis2OutputStem(outputPath) {
  return String(outputPath).replace(/\.glb$/i, '');
}

/**
 * trellis-mac exposes the first three sizes directly. For high-memory machines,
 * PortOS's runner also exposes the underlying TRELLIS.2 exporter's supported 4K
 * bake without forking the generation pipeline.
 */
export const TRELLIS2_TEXTURE_SIZES = [512, 1024, 2048, 4096];

/**
 * `generate.py` supports a fast 512 pipeline and two higher-resolution variants.
 * 1024-cascade keeps the proven 512 sparse-structure pass, then refines shape and
 * surface attributes against 1024px image conditioning. That is the useful quality
 * step for details landing on the right parts of a generated object.
 */
export const TRELLIS2_PIPELINE_TYPES = ['512', '1024', '1024_cascade'];
export const TRELLIS2_BASELINE_PIPELINE_TYPE = '512';
export const TRELLIS2_HIGH_QUALITY_PIPELINE_TYPE = '1024_cascade';

/**
 * The Apple port documents an ~18 GB peak for its benchmarked 512 lane and does
 * not publish a 1024-cascade memory ceiling. Keep the supported 24 GB floor on the
 * known lane, and opt into the higher-resolution texture model only with a
 * conservative second 24 GB of headroom.
 */
export const TRELLIS2_HIGH_QUALITY_MIN_MEMORY_GB = 48;

/**
 * Pick the texture-generation lane from physical unified memory.
 *
 * @param {number} unifiedMemoryGb
 * @returns {'512'|'1024_cascade'}
 */
export function selectTrellis2PipelineType(unifiedMemoryGb) {
  return Number(unifiedMemoryGb) >= TRELLIS2_HIGH_QUALITY_MIN_MEMORY_GB
    ? TRELLIS2_HIGH_QUALITY_PIPELINE_TYPE
    : TRELLIS2_BASELINE_PIPELINE_TYPE;
}

/**
 * PortOS asks for at least a 2K atlas, overriding `generate.py`'s 1K default. The
 * bake UV-unwraps a 200k-triangle mesh into a single atlas, so texel budget per
 * triangle is the binding constraint on surface quality. Hosts with the same
 * conservative memory headroom used for 1024-cascade get a 4K bake (four times
 * the 2K texel budget); supported 24 GB hosts stay on the proven 2K path.
 */
export const TRELLIS2_DEFAULT_TEXTURE_SIZE = 2048;
export const TRELLIS2_HIGH_QUALITY_TEXTURE_SIZE = 4096;

/**
 * Pick the UV-atlas resolution from physical unified memory.
 *
 * @param {number} unifiedMemoryGb
 * @returns {2048|4096}
 */
export function selectTrellis2TextureSize(unifiedMemoryGb) {
  return Number(unifiedMemoryGb) >= TRELLIS2_HIGH_QUALITY_MIN_MEMORY_GB
    ? TRELLIS2_HIGH_QUALITY_TEXTURE_SIZE
    : TRELLIS2_DEFAULT_TEXTURE_SIZE;
}

/**
 * The generate invocation:
 * `<venv-python> [4k-adapter] generate.py <image> [--output <stem>] --texture-size <n>
 *  [--seed <n>] [--steps <n>]`.
 *
 * Pure. Throws when no source image is given (a render with no input is a bug, not
 * an empty run), and when `textureSize` is not one of PortOS's accepted values
 * — better to fail here than to have argparse abort a job we already queued.
 * `outputPath` is the desired `.glb` disk path; it is reduced to the stem the port
 * expects (see `trellis2OutputStem`).
 *
 * `seed` is passed only when provided — callers that care about reproducible runs
 * (models.js resolves one per run) always pass it; a bare CLI-style call keeps the
 * port's own default. `steps: null` deliberately omits `--steps` so the pipeline's
 * per-phase default (12) applies — see renderOptions.js for the sentinel contract.
 *
 * @param {{imagePath: string, outputPath?: string, base?: string, textureSize?: number,
 *          pipelineType?: string, steps?: number|null, seed?: number|null}} opts
 * @returns {{command: string, args: string[]}}
 */
export function buildGenerateArgs({
  imagePath,
  outputPath,
  base,
  textureSize = TRELLIS2_DEFAULT_TEXTURE_SIZE,
  pipelineType = TRELLIS2_BASELINE_PIPELINE_TYPE,
  steps = null,
  seed = null,
} = {}) {
  if (!imagePath) throw new Error('buildGenerateArgs: imagePath is required');
  if (!TRELLIS2_TEXTURE_SIZES.includes(textureSize)) {
    throw new Error(
      `buildGenerateArgs: textureSize must be one of ${TRELLIS2_TEXTURE_SIZES.join(', ')}`,
    );
  }
  if (!TRELLIS2_PIPELINE_TYPES.includes(pipelineType)) {
    throw new Error(
      `buildGenerateArgs: pipelineType must be one of ${TRELLIS2_PIPELINE_TYPES.join(', ')}`,
    );
  }
  // Validates steps/seed and emits their flags — shared with the CUDA lane so
  // neither the ranges nor the flag names can drift (renderOptions.js).
  const optionArgs = renderOptionArgs('buildGenerateArgs', { steps, seed });
  const generateScript = trellis2GenerateScript(base);
  const args = textureSize === TRELLIS2_HIGH_QUALITY_TEXTURE_SIZE
    ? [trellis2GenerateRunnerScript(), generateScript, imagePath]
    : [generateScript, imagePath];
  if (outputPath) args.push('--output', trellis2OutputStem(outputPath));
  args.push('--pipeline-type', pipelineType);
  args.push('--texture-size', String(textureSize));
  args.push(...optionArgs);
  return { command: trellis2VenvPython(base), args };
}

/**
 * The port's real progress vocabulary, confirmed against `generate.py` during #2952
 * hands-on validation. `generate.py` prints **no overall percentage** — it emits an
 * ordered sequence of stage banners (plus per-phase `tqdm` sampling bars). Each
 * banner maps to a fixed, monotonically-increasing whole-render percent so the UI
 * advances through a multi-minute render instead of sitting at 0 until the final
 * `Saved:` line. Order is roughly: load model → sample (the long phase) → decode
 * mesh → bake textures → export. Ordered most-specific first.
 */
// The whole-render percent lives across three schemes that must stay mutually
// ordered: these banner percents, the tqdm sampling band's [10,50] ceiling
// (TQDM_BAND below), and the export percent (92). Invariant: sampling-ceiling (50)
// < first post-sampling banner (55) < … < export (92). The monotonicity unit test
// guards it — keep these ordered if you retune the curve.
const GENERATE_STAGE_SIGNATURES = [
  { re: /loading pipeline/i, stage: 'loading', percent: 3 },
  { re: /^device:/i, stage: 'loading', percent: 5 },
  { re: /generating 3d model/i, stage: 'generating', percent: 10 },
  { re: /^mesh:\s/i, stage: 'meshing', percent: 55 },
  { re: /generation time/i, stage: 'meshing', percent: 58 },
  { re: /baking .*textures?/i, stage: 'texturing', percent: 65 },
  { re: /(uv unwrap|simplifying mesh)/i, stage: 'texturing', percent: 72 },
];

/** A written `.glb` path — the terminal export signal (captures the asset path). */
const GLB_PATH_RE = /(\S+\.glb)\b/i;
/** A bare `tqdm` percentage (per-phase sampling bar). */
const TQDM_PCT_RE = /(\d{1,3})\s*%/;
/** Map a raw per-phase tqdm percent (0–100) into the sampling band [10,50]. */
const TQDM_BAND = { base: 10, span: 40 };

/**
 * Parse one line of `generate.py` output into a progress frame, or null when the
 * line carries no signal. The port has no single overall percentage, so this maps
 * its real stage banners to monotonic percents (see `GENERATE_STAGE_SIGNATURES`),
 * treats a written `.glb` path as the terminal export signal (carrying the asset
 * path), and scales a bare `tqdm` percentage into the sampling band `[10,50]` — a
 * per-phase bar hits 100% three times, so a raw pass-through would prematurely fill
 * the whole render's bar during the first phase; scaling keeps it inside the sampler
 * stage while the later banners carry it home.
 * @param {string} line
 * @returns {{stage: string, percent?: number, assetPath?: string, message: string}|null}
 */
export function parseGenerateProgress(line) {
  const text = String(line ?? '').trim();
  if (!text) return null;

  // A written .glb is the terminal export signal — it carries the produced asset path.
  const glb = text.match(GLB_PATH_RE);
  if (glb) return { stage: 'export', percent: 92, assetPath: glb[1], message: text };

  // Named stage banners drive the whole-render percent.
  for (const sig of GENERATE_STAGE_SIGNATURES) {
    if (sig.re.test(text)) return { stage: sig.stage, percent: sig.percent, message: text };
  }

  // A bare percentage is a per-phase tqdm sampling bar — scale into the sampling band.
  const pct = text.match(TQDM_PCT_RE);
  if (pct) {
    const raw = Math.min(100, Number(pct[1]));
    const percent = TQDM_BAND.base + Math.round((raw / 100) * TQDM_BAND.span);
    return { stage: 'generating', percent, message: text };
  }
  return null;
}

/**
 * Signatures of a *transient* network failure during the install's git clones /
 * pip fetches — the kind that self-heals on a retry rather than indicating a real
 * config/hardware problem. The reference failure (#2952) was a mid-clone
 * `curl 56 Recv failure: Connection reset by peer` → `early EOF` →
 * `fetch-pack: invalid index-pack output` → git exiting 128 while cloning one of
 * `setup.sh`'s ~half-dozen deps. Kept broad (git-over-HTTPS, DNS, TLS, pip) because
 * every match only *earns a retry* of an idempotent step — a false positive costs
 * one extra attempt, never a wrong install.
 */
/**
 * Whether a captured chunk of install output looks like a transient network error.
 * Exported so the route/UI and tests share the exact classification instead of
 * re-implementing the pattern.
 * @type {(text: string) => boolean}
 */
export const isTransientInstallError = textMatcher([
  'curl\\s+\\d+', 'RPC failed', 'early EOF', 'fetch-pack', 'index-pack',
  'unexpected disconnect', 'Connection reset', 'Recv failure', 'Send failure',
  'Could not resolve host', 'Failed to connect', 'Operation timed out',
  'Connection timed out', 'timed out', 'TLS', 'SSL', 'gnutls', 'GnuTLS',
  'Temporary failure in name resolution', 'Broken pipe', 'ECONNRESET', 'ETIMEDOUT',
  'Read error', 'transfer closed', 'Network is unreachable',
  'Retrieving .* failed', 'Connection aborted', 'IncompleteRead',
]);

/**
 * Run the install as a killable, event-emitting job: execute `buildInstallSteps()`
 * sequentially (clone the MPS port → run its `setup.sh`, ~15 GB), emitting a
 * `{ type:'stage' }` per step, `{ type:'log' }` for subprocess output, and a
 * terminal `{ type:'complete' }` on success (it throws on a failed/canceled step so
 * the SSE route can emit `{ type:'error' }`). Real subprocesses — user-triggered
 * only. `spawnImpl` injectable so the step sequencing / cancel / failure paths are
 * unit-testable without a real 15 GB install.
 *
 * **Transient-failure retry.** A multi-GB install over `setup.sh`'s ~half-dozen git
 * clones routinely eats a mid-transfer `Connection reset` / `early EOF` (#2952) that
 * exits git 128. Both steps are *idempotent* — git removes a failed clone's target
 * dir, our top-level clone re-clones cleanly, and `setup.sh`'s `if [ ! -d ]` guards
 * skip already-cloned deps and resume from the one that dropped — so a step whose
 * output matches a transient-network signature is retried in place up to `maxRetries`
 * times with a short backoff, rather than aborting the whole install on one blip.
 * A non-transient failure (bad config, unsupported host, real setup error) is NOT
 * retried — it fails fast. `sleep` is injectable so tests don't wait on real backoff.
 *
 * **`env`** (optional) is the child environment to spawn under — the caller resolves
 * it (PortOS passes `await hfChildEnv()` so a token stored in
 * settings reaches the child, not just one exported into the server's own env).
 * Omitted → the child inherits `process.env` as before.
 *
 * **Metal Toolchain step.** `setup.sh` compiles the Metal texture-baking packages
 * from `.metal` sources, so when `installMetalToolchain` is set the install downloads
 * the toolchain FIRST (#3041). Verified on-device: that download runs unattended (no
 * sudo, no prompt), which is what makes auto-install viable instead of printing a
 * command for the user to run. The step is `optional` — see
 * `TRELLIS2_METAL_TOOLCHAIN_STEP`. The caller resolves the flag from
 * `probeMetalToolchain()` (the route does, so this stays synchronous).
 *
 * **Post-install verification.** After the last step the install probes whether the
 * Metal texture-baking backends actually built (`probeBake`, injectable) and emits a
 * `verify` log frame before the terminal `complete`. This is load-bearing, not
 * cosmetic: `setup.sh` installs those packages with `|| echo "… continuing without …"`
 * and still exits 0, so without it a host lacking the Xcode Metal Toolchain gets a
 * clean "installed" and every later render bakes a scrambled surface (#2952).
 *
 * @param {{base?: string, onEvent?: (ev: object) => void, spawnImpl?: Function,
 *          maxRetries?: number, sleep?: (ms: number) => Promise<void>,
 *          env?: NodeJS.ProcessEnv, probeBake?: Function, installMetalToolchain?: boolean}} [opts]
 * @returns {{promise: Promise<{ok: true}>, kill: () => void}}
 */
export function installTrellis2({
  base,
  onEvent = () => {},
  spawnImpl = spawn,
  maxRetries = 3,
  sleep,
  exists = existsSync,
  env,
  probeBake = probeTrellis2TextureBake,
  installMetalToolchain = false,
} = {}) {
  // `exists` lets the clone step self-skip when the repo is already on disk (resume
  // after a setup-stage failure); `installMetalToolchain` is resolved by the CALLER
  // from `probeMetalToolchain()` and passed in as a plain boolean, so this function
  // keeps returning `{ promise, kill }` synchronously — see buildInstallSteps.
  return runInstallSteps({
    steps: buildInstallSteps(base, { exists, installMetalToolchain }),
    label: LABEL,
    codePrefix: CODE_PREFIX,
    isTransient: isTransientInstallError,
    onEvent,
    spawnImpl,
    maxRetries,
    sleep,
    env,
    // `setup.sh` exits 0 even when its Metal texture-baking backends failed to
    // build, so a bare success would report an install that silently renders
    // scrambled surfaces (#2952). Report what actually landed.
    verify: async (emit) => {
      const bake = await probeBake({ base });
      if (bake.quality === 'fallback') {
        emit({ type: 'log', stage: 'verify', message: `⚠️ ${bake.help}` });
      } else if (bake.quality === 'metal') {
        emit({ type: 'log', stage: 'verify', message: '✅ Metal texture baking is available.' });
      }
    },
  });
}

/**
 * Signatures of a Hugging Face **auth / gated-repo** failure during a render. The
 * TRELLIS.2 pipeline pulls a gated dependency model (`facebook/dinov3-…`) at load
 * time; on a host with no `HF_TOKEN` (or one whose account hasn't accepted that
 * model's terms) `from_pretrained` raises `GatedRepoError` / a `401` and the render
 * exits non-zero — which is otherwise indistinguishable from a real crash. Detecting
 * it lets the runner surface an actionable "authenticate with Hugging Face" message
 * instead of a bare "exited 1". Confirmed against the real failure during #2952
 * on-device validation (gated `facebook/dinov3-vitl16-pretrain-lvd1689m`).
 */
/**
 * Whether a captured chunk of render output looks like a Hugging Face auth/gated-repo
 * failure (see the signature list above). Exported so the runner and tests share one
 * classification.
 * @type {(text: string) => boolean}
 */
export const isHfAuthError = textMatcher([
  'GatedRepoError', 'gated repo', 'access to model .* is restricted',
  'You must have access to it', 'must be authenticated to access',
  'Please log in', 'RepositoryNotFoundError',
  '401 Client Error', 'Invalid user token', 'Repo .* is gated',
]);

/**
 * Human-actionable guidance for the gated-dependency failure above. Points at the
 * in-app token field first — PortOS injects its stored Hugging Face token into the
 * render's environment (see `runTrellis2Generate`'s `env`), so pasting one on the 3D
 * page is the fix; the CLI/env route is the fallback for someone already set up that
 * way. Terms acceptance is a separate step a token alone doesn't cover.
 */
/**
 * Build that guidance for a target, naming its own gated repos so the registry stays
 * the single source and the two lanes can't drift on the wording.
 *
 * Resolved lazily, at failure time, rather than at module scope: this module is in the
 * import graph of every registry consumer, and reading a descriptor at import time
 * makes merely LOADING it depend on `targets.js` being fully materialized — which a
 * partial test mock of that module breaks, taking the whole graph down with it.
 * @param {string} targetId
 * @returns {string}
 */
export function hfGatedRepoHelp(targetId) {
  const target = getTarget(targetId);
  const name = target?.label || 'This model';
  const repos = target?.gatedRepos ?? [];
  // A target with NO gated repos still reaches here on an auth failure — but telling
  // that user to "accept the terms" for an unnamed model is advice they cannot act on.
  // For those targets the realistic cause is an unauthenticated rate limit, so say so.
  if (!repos.length) {
    return `${name} could not download a model from Hugging Face. It has no gated `
      + 'dependencies, so this is most likely an unauthenticated rate limit — add your '
      + 'Hugging Face token on the 3D page (or set HF_TOKEN / run `huggingface-cli login`) '
      + 'and try again.';
  }
  const repoHelp = repos.map(({ label, url }) => `${label} at ${url}`).join(' and ');
  return `${name} could not download a gated model dependency from `
    + `Hugging Face. Accept the terms for ${repoHelp}, then add your `
    + 'Hugging Face token on the 3D page (or set HF_TOKEN / run `huggingface-cli login`) '
    + 'and try again.';
}

/**
 * Run a single image→GLB generation. The one real-subprocess boundary — GUARDED:
 * throws `TRELLIS2_NOT_INSTALLED` unless the model is present, so it can never run
 * from a cold boot. `spawnImpl`/`exists` are injectable so the wiring (right command,
 * progress streaming, resolve-with-asset) is unit-testable without a real render.
 *
 * Returns `{ promise, kill }` (mirroring `installTrellis2`) so a caller can
 * terminate the render mid-flight — e.g. when the user deletes the record while
 * its GLB is still rendering. `kill` routes through the shared
 * `killWithEscalation` (SIGTERM, then SIGKILL after a grace window if the child
 * ignored it), the same cancel convention every other spawn-based media job uses.
 *
 * **`env`** (optional) is the child environment to spawn under. The pipeline pulls
 * gated Hugging Face repos at load time, so the caller resolves the token env
 * (`await hfChildEnv()` in `models.js#executeRender`) and passes
 * it in — this function stays synchronous so its `{ promise, kill }` contract holds.
 * Omitted → the child inherits `process.env` as before.
 *
 * A successful render is normalized to opaque before it resolves. The Apple port
 * auto-enables BLEND from isolated low-alpha texels, while upstream TRELLIS
 * documents OPAQUE as the default; leaving BLEND active turns prediction noise
 * into visible holes in both PortOS and downloaded GLBs.
 *
 * @param {{imagePath: string, outputPath?: string, base?: string, textureSize?: number,
 *          pipelineType?: string, unifiedMemoryGb?: number,
 *          steps?: number|null, seed?: number|null,
 *          onProgress?: (frame: object) => void,
 *          spawnImpl?: Function, exists?: (p: string) => boolean,
 *          env?: NodeJS.ProcessEnv, postprocessGlb?: (path: string) => void|Promise<void>}} opts
 * @returns {{promise: Promise<{assetPath: string}>, kill: () => void}}
 */
export function runTrellis2Generate({
  imagePath,
  outputPath,
  base,
  textureSize,
  pipelineType,
  unifiedMemoryGb = Math.round(totalmem() / 1024 ** 3),
  steps = null,
  seed = null,
  onProgress,
  spawnImpl = spawn,
  exists = existsSync,
  env,
  postprocessGlb = rewriteGlbMaterialsOpaque,
} = {}) {
  if (!isTrellis2Installed({ base, exists })) {
    const err = new Error('TRELLIS.2 is not installed — install it before generating.');
    err.code = 'TRELLIS2_NOT_INSTALLED';
    return { promise: Promise.reject(err), kill: () => {} };
  }
  const resolvedPipelineType = pipelineType ?? selectTrellis2PipelineType(unifiedMemoryGb);
  const resolvedTextureSize = textureSize ?? selectTrellis2TextureSize(unifiedMemoryGb);
  const { command, args } = buildGenerateArgs({
    imagePath,
    outputPath,
    base,
    textureSize: resolvedTextureSize,
    pipelineType: resolvedPipelineType,
    steps,
    seed,
  });
  return runGenerateSubprocess({
    command,
    args,
    cwd: trellis2Root(base),
    env,
    label: LABEL,
    codePrefix: CODE_PREFIX,
    parseProgress: parseGenerateProgress,
    assetPath: outputPath || null,
    onProgress,
    spawnImpl,
    postprocessGlb,
    // A gated-dependency / HF-auth failure is a user-fixable setup problem, not a
    // crash — surface it as such with actionable guidance instead of "exited N".
    classifiers: [
      { test: isHfAuthError, code: `${CODE_PREFIX}_HF_AUTH_REQUIRED`, help: () => hfGatedRepoHelp('trellis2') },
    ],
  });
}
