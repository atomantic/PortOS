/** TRELLIS.2 Metal runtime detection, diagnostics and generation. */

import { existsSync } from 'node:fs';
import { homedir, platform, totalmem } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from '../../lib/childProcess.js';
import { rewriteGlbMaterialsOpaque } from './glbMaterials.js';
import { getTarget } from './targets.js';
import {
  textMatcher,
  runGenerateSubprocess,
  probePythonModules,
} from './laneRunner.js';
import { renderOptionArgs } from './renderOptions.js';
import {
  selectTrellis2DecimationTarget,
  trellis2MeshQualityArgs,
  trellis2FillHolesStep,
  TRELLIS2_NORMAL_SOURCE_FACE_CAP,
} from './trellis2MeshQuality.js';

const HOME = homedir();
const IS_WIN = platform() === 'win32';

/** Error-code namespace and user-facing name for this lane's subprocess failures. */
const CODE_PREFIX = 'TRELLIS2';
const LABEL = 'TRELLIS.2';

/** Clone/install root. `base` overridable for tests. */
export function trellis2Root(base = join(HOME, '.portos')) {
  return join(base, 'trellis2');
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
  + 'baker that produces correct geometry with a scrambled, speckled surface.';

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
 * (AGENTS.md sentinel rule: "failed to determine" ≠ "determined to be bad").
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
  // nothing throws into the route (AGENTS.md child-process exception).
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
export const TRELLIS2_METAL_TOOLCHAIN_HINT = 'The Xcode Metal Toolchain is required '
  + 'to compile the Metal extensions. Setup will download it automatically.';

/**
 * A missing toolchain on a host with only the Command Line Tools. Nothing PortOS
 * can run fixes this, so the hint names the real prerequisite instead of a command
 * that would fail.
 */
export const TRELLIS2_REQUIRES_XCODE_HINT = 'The Xcode Metal Toolchain is not '
  + 'installed and cannot be downloaded, because only the Command Line Tools are '
  + 'active on this host. Install Xcode from the App Store and run `sudo xcode-select '
  + '--switch /Applications/Xcode.app`, then retry setup.';

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
 * Resolve a request's abstract detail tier to this port's `--pipeline-type`.
 *
 * `'auto'` (the default) keeps the historical hardware-derived behaviour; any other
 * tier is looked up in the target descriptor's `detailTiers`, so the tier vocabulary
 * lives in the registry rather than being restated here.
 *
 * An unmapped tier falls back to the hardware-derived choice rather than throwing.
 * That is deliberate: the route enum and the descriptor are validated against each
 * other by `targets.test.js`, so reaching this branch means a registry edit went
 * wrong — and degrading to the tier the host would have picked anyway is a far better
 * outcome than failing a render the user already waited on.
 *
 * The descriptor is read lazily, at call time, for the same reason `hfGatedRepoHelp`
 * does: resolving it at module scope would make merely importing this file depend on
 * `targets.js` being fully materialized, which a partial test mock of that module
 * breaks.
 *
 * @param {string} detail one of DETAIL_TIERS
 * @param {number} unifiedMemoryGb
 * @returns {string} a value from TRELLIS2_PIPELINE_TYPES
 */
export function resolveTrellis2PipelineType(detail, unifiedMemoryGb) {
  if (!detail || detail === 'auto') return selectTrellis2PipelineType(unifiedMemoryGb);
  const mapped = getTarget('trellis2')?.detailTiers?.[detail];
  if (mapped && TRELLIS2_PIPELINE_TYPES.includes(mapped)) {
    // A tier ABOVE what this host's memory would have chosen is allowed on purpose:
    // overriding the hardware heuristic is the point of the knob, and PortOS's
    // 48 GB threshold is explicitly a conservative guess (the port publishes no
    // 1024-cascade memory ceiling). But say so in the log, because the likely
    // failure on an undersized host is an OOM or a watchdog kill many minutes in,
    // and this line is what connects that to the choice.
    const hostChoice = selectTrellis2PipelineType(unifiedMemoryGb);
    if (mapped !== hostChoice) {
      console.log(`🎚️ TRELLIS.2 detail '${detail}' → pipeline ${mapped} (host default for ${unifiedMemoryGb} GB is ${hostChoice})`);
    }
    return mapped;
  }
  console.warn(`⚠️ TRELLIS.2 detail tier '${detail}' is unmapped — falling back to the host-derived pipeline`);
  return selectTrellis2PipelineType(unifiedMemoryGb);
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
 * `meshQuality` is forwarded verbatim to `trellis2MeshQualityArgs` (decimation
 * target, hole filling, exporter knobs) — an empty object emits only the `--`
 * separator, i.e. exactly upstream's behaviour.
 *
 * @param {{imagePath: string, outputPath?: string, base?: string, textureSize?: number,
 *          pipelineType?: string, steps?: number|null, seed?: number|null,
 *          meshQuality?: object}} opts
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
  meshQuality = {},
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
  // The runner adapter is now on EVERY invocation, not just the 4K one. It used
  // to be conditional because widening `--texture-size` was its only job; it now
  // also carries the mesh-quality overrides (decimation target, hole filling,
  // exporter knobs), which apply at every memory tier. Its own flags come first
  // and are terminated by `--`, after which upstream's argv begins verbatim.
  const args = [
    trellis2GenerateRunnerScript(),
    ...trellis2MeshQualityArgs(meshQuality),
    generateScript,
    imagePath,
  ];
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
 * Signatures of the macOS **GPU watchdog** killing a long-running Metal kernel
 * mid-render — the one MPS-only failure mode that is neither a crash nor a setup
 * problem, and the reason it needs its own classifier.
 *
 * The mechanism (documented by the port itself, in `generate.py`'s
 * `_watchdog_help_message`): when a single Metal dispatch in the SLat decoder runs
 * long enough, macOS kills the command buffer and prints
 * `kIOGPUCommandBufferCallbackErrorImpactingInteractivity` to **stderr without
 * raising a Python exception**. Execution continues over empty tensors and dies
 * downstream, so the user-visible symptom is a bare non-zero exit after a render
 * that had already run for many minutes.
 *
 * Keyed on the port's own help banner and the two downstream exception texts rather
 * than on the Metal error itself: the Metal line is emitted early and
 * `appendTail`'s 4000-char window has usually evicted it by the time the process
 * exits, whereas the banner is the last thing printed before `sys.exit(2)`. Kept to
 * phrases that cannot appear in a healthy render, since a false positive would
 * mislabel an unrelated crash.
 * @type {(text: string) => boolean}
 */
export const isMpsWatchdogError = textMatcher([
  'decoder produced an empty mesh',
  'macOS GPU watchdog',
  'kIOGPUCommandBufferCallbackErrorImpactingInteractivity',
  'BVH needs at least 8 triangles',
]);

/**
 * What the user can actually do about a watchdog kill.
 *
 * Deliberately does NOT repeat the port's own suggestions from
 * `generate.py:_watchdog_help_message`, two of which are now known not to work.
 * trellis-mac#8 (M2 Ultra / macOS 26.4.1) records headless-over-SSH with displays
 * physically unplugged, `SPARSE_CONV_BACKEND=none`, and per-block
 * `torch.mps.synchronize()` as all TESTED AND FAILED; `MTL_CAPTURE_ENABLED=1` is a
 * single-source claim that in that same report completed with a shattered mesh. What
 * is reported to clear it is sleeping the *panel* — mlx#3267, where the env-var-plus-
 * `pmset displaysleepnow` combination worked and the env var alone did not.
 *
 * Also deliberately does NOT tell the user to reduce steps: the watchdog fires on a
 * single long *dispatch*, not on total render time, so fewer sampler steps shortens
 * the run without making the offending kernel any shorter. Lowering the pipeline tier
 * is the knob that actually shrinks the dispatch, which is why that is the one named.
 *
 * PortOS does not set `AGX_RELAX_CDM_CTXSTORE_TIMEOUT=1` on the user's behalf: in the
 * mlx#3267 A/B, relaxing the timeout with the panel awake turned a clean kernel kill
 * into a hard reboot. Trading a failed render for a lost session is not a default we
 * get to pick for someone.
 */
export const TRELLIS2_WATCHDOG_HELP = 'The macOS GPU watchdog stopped this render: a '
  + 'single Metal kernel in the shape decoder ran long enough for macOS to kill the '
  + 'command buffer, which leaves an empty mesh rather than an error. Nothing is wrong '
  + 'with your install. The mitigation that is actually reported to work is to put the '
  + 'display to sleep (`pmset displaysleepnow`) and re-run — the watchdog tightens with '
  + 'window-server load. Merely unplugging external displays, running headless over '
  + 'SSH, or lowering sampler steps are all reported NOT to help, because the kill '
  + 'targets one long dispatch rather than the render as a whole. Dropping to a lower '
  + 'Detail tier does shorten that dispatch. One caveat: a blank or over-keyed source '
  + 'image also decodes to an empty mesh and prints the same message, so if this fails '
  + 'immediately rather than minutes in, check the input before the GPU.'

/**
 * Which GLB post-process a run should apply — extracted so the decision is testable
 * on its own rather than as a side effect of a spawn.
 *
 * Three layers can flatten alpha (the exporter's `alpha_mode`, this rewrite, and the
 * viewer's `forceOpaque` prop). They have to agree, or a mesh exported as BLEND still
 * renders solid and reads as a broken exporter.
 *
 *  - `override !== undefined` wins outright, and **an explicit `null` therefore means
 *    "run nothing"**. That is not incidental: a parameter default only applies to
 *    `undefined`, so `null` already meant this before the fallback became computed,
 *    and using `??` here would quietly turn it back into force-opaque — absent vs.
 *    explicitly-empty, per AGENTS.md.
 *  - Otherwise force-opaque applies unless the caller asked the exporter for a
 *    transparent material. The rewrite still defaults on because an older o_voxel
 *    promoted to BLEND off a single low-alpha texel, which is what it was written for.
 *
 * @param {string|null} alphaMode
 * @param {Function|null|undefined} override
 * @returns {Function|undefined}
 */
export function resolveGlbPostprocess(alphaMode, override) {
  if (override !== undefined) return override ?? undefined;
  const wantsTransparency = alphaMode !== null && alphaMode !== undefined && alphaMode !== 'OPAQUE';
  return wantsTransparency ? undefined : rewriteGlbMaterialsOpaque;
}

/**
 * Run a single image→GLB generation. The one real-subprocess boundary — GUARDED:
 * throws `TRELLIS2_NOT_INSTALLED` unless the model is present, so it can never run
 * from a cold boot. `spawnImpl`/`exists` are injectable so the wiring (right command,
 * progress streaming, resolve-with-asset) is unit-testable without a real render.
 *
 * Returns `{ promise, kill }` so a caller can
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
 * **`decimationTarget`** defaults to the memory-derived tier rather than upstream's
 * 200K clamp — see `trellis2MeshQuality.js` for why that clamp is now wrong. Pass an
 * explicit value to override; pass `TRELLIS2_DECIMATION_UPSTREAM_CLAMP` to reproduce
 * upstream output exactly.
 *
 * **`alphaMode`** suppresses the force-opaque post-process when it asks for
 * transparency. Those two would otherwise fight: telling the exporter to emit BLEND
 * and then rewriting every BLEND material back to OPAQUE is a silent no-op that
 * looks like a broken exporter. `null` keeps the historical behaviour (exporter
 * default + force-opaque normalization).
 *
 * @param {{imagePath: string, outputPath?: string, base?: string, textureSize?: number,
 *          pipelineType?: string, unifiedMemoryGb?: number,
 *          steps?: number|null, seed?: number|null,
 *          decimationTarget?: number|null, fillHoles?: boolean, remesh?: boolean,
 *          alphaMode?: string|null,
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
  detail = 'auto',
  decimationTarget = null,
  fillHoles = false,
  remesh = false,
  alphaMode = null,
  normalMap = false,
  normalMapMaxSourceFaces = TRELLIS2_NORMAL_SOURCE_FACE_CAP,
  onProgress,
  spawnImpl = spawn,
  exists = existsSync,
  env,
  postprocessGlb,
} = {}) {
  if (!isTrellis2Installed({ base, exists })) {
    const err = new Error('TRELLIS.2 is not installed — install it before generating.');
    err.code = 'TRELLIS2_NOT_INSTALLED';
    return { promise: Promise.reject(err), kill: () => {} };
  }
  // An explicit `pipelineType` still wins (direct callers and tests use it); a
  // request expresses itself as a detail tier instead.
  const resolvedPipelineType = pipelineType ?? resolveTrellis2PipelineType(detail, unifiedMemoryGb);
  const resolvedTextureSize = textureSize ?? selectTrellis2TextureSize(unifiedMemoryGb);
  const resolvedDecimationTarget = decimationTarget
    ?? selectTrellis2DecimationTarget(unifiedMemoryGb, TRELLIS2_HIGH_QUALITY_MIN_MEMORY_GB);
  const { command, args } = buildGenerateArgs({
    imagePath,
    outputPath,
    base,
    textureSize: resolvedTextureSize,
    pipelineType: resolvedPipelineType,
    steps,
    seed,
    meshQuality: {
      decimationTarget: resolvedDecimationTarget,
      fillHoles,
      remesh,
      alphaMode,
      normalMap,
      // Emitted only alongside --normal-map, but ALWAYS passed when it is: the Python
      // side has its own default, and leaving this unset meant the JS constant was
      // dead config — lowering it in response to a crash report would have changed
      // nothing while its tests kept passing.
      ...(normalMap ? { normalMapMaxSourceFaces } : {}),
    },
  });
  // Force-opaque normalization is skipped exactly when the caller asked the
  // exporter for a transparent material — see the `alphaMode` note above. The
  // default (`null`) keeps the historical force-opaque behaviour, which still
  // matters for installs carrying an older o_voxel that auto-promoted to BLEND
  // off a single low-alpha texel.
  const resolvedPostprocess = resolveGlbPostprocess(alphaMode, postprocessGlb);
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
    postprocessGlb: resolvedPostprocess,
    // A gated-dependency / HF-auth failure is a user-fixable setup problem, not a
    // crash — surface it as such with actionable guidance instead of "exited N".
    classifiers: [
      { test: isHfAuthError, code: `${CODE_PREFIX}_HF_AUTH_REQUIRED`, help: () => hfGatedRepoHelp('trellis2') },
      // MPS-only: the watchdog exits non-zero with no exception, so without this it
      // reads as a generic crash after a render the user already waited minutes for.
      { test: isMpsWatchdogError, code: `${CODE_PREFIX}_MPS_WATCHDOG`, help: TRELLIS2_WATCHDOG_HELP },
    ],
  });
}
