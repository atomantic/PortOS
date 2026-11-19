/** TRELLIS.2 Metal runtime detection, diagnostics and generation. */

import { existsSync } from 'node:fs';
import { homedir, platform, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
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

/** A known locked profile always uses its pinned entrypoint; intact legacy installs keep theirs. */
export function trellis2GenerateScript(base, exists = existsSync) {
  const root = trellis2Root(base);
  const pinned = join(root, '.venv', 'portos-source', 'generate.py');
  const locked = exists(join(root, '.venv', 'portos-profile.json')) || exists(join(root, 'portos-installing'));
  return locked || exists(pinned) ? pinned : join(root, 'generate.py');
}

/** PortOS adapter that exposes the upstream exporter's supported 4K atlas size. */
export function trellis2GenerateRunnerScript() {
  return fileURLToPath(new URL('./trellis2GenerateRunner.py', import.meta.url));
}

/**
 * Locked installs need Python, the pinned entrypoint and completed verification.
 * Legacy installs remain usable until a rebuild starts. `exists` is injectable.
 * @param {{base?: string, exists?: (p: string) => boolean}} [opts]
 * @returns {boolean}
 */
export function isTrellis2Installed({ base, exists = existsSync } = {}) {
  const root = trellis2Root(base);
  if (!exists(trellis2VenvPython(base)) || exists(join(root, 'portos-installing'))) return false;
  const script = trellis2GenerateScript(base, exists);
  const completed = script === join(root, 'generate.py') || exists(join(root, '.venv', 'portos-profile.json'));
  return completed && exists(script);
}

/**
/** Modules the Metal bake gate needs; any missing silently falls back to the KDTree/xatlas baker (see `TRELLIS2_FALLBACK_BAKE_HELP`). */
export const TRELLIS2_METAL_BAKE_MODULES = ['o_voxel', 'mtldiffrast', 'mtlbvh'];

/**
/** Optional: `flex_gemm` provides sparse grid-sample; without it the bake still runs at slightly lower quality (ring artifacts). */
export const TRELLIS2_BAKE_QUALITY_MODULES = ['flex_gemm'];

/**
/**
 * `setup.sh` exits 0 even when the Metal packages fail to build (e.g. no Xcode Metal Toolchain), so later renders
 * silently take the fallback baker. That baker is unusable on TRELLIS.2 output: it unwraps after decimating to
 * 200k triangles into a 1024² atlas (~1.9 texels/triangle), producing a speckled surface.
 */
export const TRELLIS2_FALLBACK_BAKE_HELP = 'TRELLIS.2 is installed, but its Metal '
  + 'texture-baking backend is missing, so renders fall back to a low-resolution '
  + 'baker that produces correct geometry with a scrambled, speckled surface.';

/**
/**
 * Probe whether the venv can take the Metal bake path via `importlib.util.find_spec` (no import, ~20 ms, no torch),
 * keyed on the modules the `use_metal` gate checks. `'unknown'` means the probe could not run; it stays distinct
 * from `'fallback'` so a broken probe never warns about a possibly-fine install.
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
  // The helper parses after the execFile callback resolves; a throw inside that callback escapes the
  // promise and kills the process.
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
/**
 * Whether the Xcode Metal Toolchain (needed to build `mtldiffrast`/`mtlbvh`/`mtlgemm`) is present, checked before
 * the ~15 GB install. Absent only degrades output. Non-macOS hosts report `available: null`, never `false`.
 * `installable: true` means the install can fetch it (`TRELLIS2_METAL_TOOLCHAIN_STEP`); `blocker: 'requires-xcode'`
 * means only the Command Line Tools are active, so `xcodebuild -downloadComponent` is absent and the hint must name Xcode.
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
  // Every outcome resolves; nothing throws into the route.
  const run = (command, args) => new Promise((resolve) => {
    execFileImpl(command, args, { timeout: 15000 }, (err, stdout) => {
      resolve(err ? null : String(stdout ?? ''));
    });
  }).catch(() => null);

  if (await run('xcrun', ['-sdk', 'macosx', 'metal', '--version']) !== null) {
    return { available: true };
  }
  // Only full Xcode ships `xcodebuild -downloadComponent`; the Command Line Tools resolve to /Library/Developer/CommandLineTools.
  const developerDir = await run('xcode-select', ['-p']);
  const hasXcode = !!developerDir && /Xcode.*\.app/i.test(developerDir);
  return hasXcode
    ? { available: false, installable: true, hint: TRELLIS2_METAL_TOOLCHAIN_HINT }
    : { available: false, installable: false, blocker: 'requires-xcode', hint: TRELLIS2_REQUIRES_XCODE_HINT };
}

/** A missing-but-fetchable toolchain: the install can download it unattended. */
export const TRELLIS2_METAL_TOOLCHAIN_HINT = 'The Xcode Metal Toolchain is required '
  + 'to compile the Metal extensions. Setup will download it automatically.';

/** Only the Command Line Tools are active: nothing PortOS can run fixes it, so the hint names the real prerequisite. */
export const TRELLIS2_REQUIRES_XCODE_HINT = 'The Xcode Metal Toolchain is not '
  + 'installed and cannot be downloaded, because only the Command Line Tools are '
  + 'active on this host. Install Xcode from the App Store and run `sudo xcode-select '
  + '--switch /Applications/Xcode.app`, then retry setup.';

/**
 * Fetches the Metal Toolchain unattended (no sudo, no prompt). `optional`: a missing bake degrades output, so the
 * step warns and continues rather than aborting the install.
 */
export const TRELLIS2_METAL_TOOLCHAIN_STEP = Object.freeze({
  stage: 'metal-toolchain',
  command: 'xcodebuild',
  args: ['-downloadComponent', 'MetalToolchain'],
  optional: true,
});

/**
 * The port's `--output` is a filename stem; `generate.py` appends `.glb` itself, so strip one trailing `.glb`
 * or the port writes `model.glb.glb` and `model.glb` 404s.
 * @param {string} outputPath
 * @returns {string}
 */
export function trellis2OutputStem(outputPath) {
  return String(outputPath).replace(/\.glb$/i, '');
}

/** The first three are trellis-mac's; PortOS's runner adds the exporter's 4K bake. */
export const TRELLIS2_TEXTURE_SIZES = [512, 1024, 2048, 4096];

/** Fast 512 pipeline plus higher-resolution variants; 1024-cascade refines shape and attributes against 1024px conditioning. */
export const TRELLIS2_PIPELINE_TYPES = ['512', '1024', '1024_cascade'];
export const TRELLIS2_BASELINE_PIPELINE_TYPE = '512';
export const TRELLIS2_HIGH_QUALITY_PIPELINE_TYPE = '1024_cascade';

/** The port publishes ~18 GB peak for 512 and no 1024-cascade ceiling; the high lane requires a conservative second 24 GB. */
export const TRELLIS2_HIGH_QUALITY_MIN_MEMORY_GB = 48;

/** Pick the texture-generation lane from physical unified memory. */
export function selectTrellis2PipelineType(unifiedMemoryGb) {
  return Number(unifiedMemoryGb) >= TRELLIS2_HIGH_QUALITY_MIN_MEMORY_GB
    ? TRELLIS2_HIGH_QUALITY_PIPELINE_TYPE
    : TRELLIS2_BASELINE_PIPELINE_TYPE;
}

/**
 * Resolve a request's detail tier to `--pipeline-type`. `'auto'` is hardware-derived; other tiers come from the
 * target descriptor's `detailTiers`. An unmapped tier degrades to the hardware choice rather than failing a render
 * the user already waited on (`targets.test.js` cross-validates, so it means a registry edit went wrong).
 * The descriptor is read at call time: resolving at module scope would make importing this file depend on
 * `targets.js` being materialized, which partial test mocks break.
 * @param {string} detail one of DETAIL_TIERS
 * @param {number} unifiedMemoryGb
 * @returns {string} a value from TRELLIS2_PIPELINE_TYPES
 */
export function resolveTrellis2PipelineType(detail, unifiedMemoryGb) {
  if (!detail || detail === 'auto') return selectTrellis2PipelineType(unifiedMemoryGb);
  const mapped = getTarget('trellis2')?.detailTiers?.[detail];
  if (mapped && TRELLIS2_PIPELINE_TYPES.includes(mapped)) {
    // Exceeding the host's memory-derived tier is intentional (the 48 GB threshold is a conservative guess),
    // but log it: an OOM or watchdog kill minutes in is otherwise unexplained.
    const hostChoice = selectTrellis2PipelineType(unifiedMemoryGb);
    if (mapped !== hostChoice) {
      console.log(`🎚️ TRELLIS.2 detail '${detail}' → pipeline ${mapped} (host default for ${unifiedMemoryGb} GB is ${hostChoice})`);
    }
    return mapped;
  }
  console.warn(`⚠️ TRELLIS.2 detail tier '${detail}' is unmapped — falling back to the host-derived pipeline`);
  return selectTrellis2PipelineType(unifiedMemoryGb);
}

/** At least a 2K atlas (generate.py defaults to 1K): texels per triangle bound quality on a 200k-triangle mesh. Hosts with 1024-cascade headroom get 4K. */
export const TRELLIS2_DEFAULT_TEXTURE_SIZE = 2048;
export const TRELLIS2_HIGH_QUALITY_TEXTURE_SIZE = 4096;

/** Pick the UV-atlas resolution from physical unified memory. */
export function selectTrellis2TextureSize(unifiedMemoryGb) {
  return Number(unifiedMemoryGb) >= TRELLIS2_HIGH_QUALITY_MIN_MEMORY_GB
    ? TRELLIS2_HIGH_QUALITY_TEXTURE_SIZE
    : TRELLIS2_DEFAULT_TEXTURE_SIZE;
}

/**
 * `<venv-python> [4k-adapter] generate.py <image> [--output <stem>] --texture-size <n> [--seed <n>] [--steps <n>]`.
 * Pure. Throws on a missing image or unsupported `textureSize` (better than argparse aborting a queued job).
 * `outputPath` is reduced to the port's stem. `seed` is passed only when provided; `steps: null` omits `--steps` so the
 * per-phase default applies (renderOptions.js). `meshQuality` goes to `trellis2MeshQualityArgs`; empty emits only `--`.
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
  exists = existsSync,
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
  // Shared with the CUDA lane so ranges and flag names can't drift (renderOptions.js).
  const optionArgs = renderOptionArgs('buildGenerateArgs', { steps, seed });
  const generateScript = trellis2GenerateScript(base, exists);
  // The runner adapter is on every invocation: it carries the mesh-quality overrides. Its flags end at `--`,
  // after which upstream's argv follows verbatim.
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
 * Progress banners from `generate.py`, which prints no overall percentage: each banner maps to a fixed, increasing
 * whole-render percent. Most-specific first.
 */
// Invariant: sampling ceiling (50, TQDM_BAND) < first post-sampling banner (55) < … < export (92); keep ordered when retuning.
const GENERATE_STAGE_SIGNATURES = [
  { re: /loading pipeline/i, stage: 'loading', percent: 3 },
  { re: /^loading weights:/i, stage: 'loading', percent: 3 },
  { re: /^device:/i, stage: 'loading', percent: 5 },
  { re: /generating 3d model/i, stage: 'generating', percent: 10 },
  { re: /^mesh:\s/i, stage: 'meshing', percent: 55 },
  { re: /generation time/i, stage: 'meshing', percent: 58 },
  { re: /baking .*textures?/i, stage: 'texturing', percent: 65 },
  { re: /uv unwrap|^simplifying(?:\s|:)|^(?:gathering results from )?xatlas:/i, stage: 'texturing', percent: 72 },
];

/** A written `.glb` path — the terminal export signal (captures the asset path). */
const GLB_PATH_RE = /(\S+\.glb)\b/i;
/** A bare `tqdm` percentage (per-phase sampling bar). */
const TQDM_PCT_RE = /(\d{1,3})\s*%/;
/** Map a raw per-phase tqdm percent (0–100) into the sampling band [10,50]. */
const TQDM_BAND = { base: 10, span: 40 };

/**
/**
 * Parse one `generate.py` line into a progress frame, or null. Banners map to monotonic percents, a written `.glb` is
 * the terminal export signal, and a bare tqdm percent is scaled into `[10,50]` (each phase bar hits 100% three times).
 * @param {string} line
 * @returns {{stage: string, percent?: number, assetPath?: string, message: string}|null}
 */
export function parseGenerateProgress(line) {
  const text = String(line ?? '').trim();
  if (!text) return null;

  const glb = text.match(GLB_PATH_RE);
  if (glb) return { stage: 'export', percent: 92, assetPath: glb[1], message: text };

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
 * Whether install output looks like a transient network error (git clone / pip), which self-heals on retry. Kept broad:
 * a false positive costs one extra attempt of an idempotent step. Shared by route/UI and tests.
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
 * Hugging Face auth / gated-repo failure: the pipeline pulls a gated model (`facebook/dinov3-…`) at load, and without
 * an accepted token `from_pretrained` raises `GatedRepoError`/401, which exits non-zero like any crash. Shared with tests.
 * @type {(text: string) => boolean}
 */
export const isHfAuthError = textMatcher([
  'GatedRepoError', 'gated repo', 'access to model .* is restricted',
  'You must have access to it', 'must be authenticated to access',
  'Please log in', 'RepositoryNotFoundError',
  '401 Client Error', 'Invalid user token', 'Repo .* is gated',
]);

/**
 * Actionable guidance for the gated-dependency failure: the in-app token field first (PortOS injects its stored HF token
 * into the render env), then terms acceptance, which a token alone doesn't cover. Names the target's own gated repos.
 * Resolved at failure time, not module scope: reading a descriptor at import would make loading this file depend on
 * `targets.js` being materialized, which partial test mocks break.
 * @param {string} targetId
 * @returns {string}
 */
export function hfGatedRepoHelp(targetId) {
  const target = getTarget(targetId);
  const name = target?.label || 'This model';
  const repos = target?.gatedRepos ?? [];
  // No gated repos: "accept the terms" is unactionable; the realistic cause is an unauthenticated rate limit.
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
 * macOS GPU watchdog killing a long Metal dispatch in the SLat decoder: it prints
 * `kIOGPUCommandBufferCallbackErrorImpactingInteractivity` to stderr without a Python exception, so the render dies later
 * with a bare non-zero exit. Keyed on the port's help banner and downstream exception texts (printed last, so still in
 * `appendTail`'s 4000-char window) and on phrases that cannot appear in a healthy render.
 * @type {(text: string) => boolean}
 */
export const isMpsWatchdogError = textMatcher([
  'decoder produced an empty mesh',
  'macOS GPU watchdog',
  'kIOGPUCommandBufferCallbackErrorImpactingInteractivity',
  'BVH needs at least 8 triangles',
]);

/**
 * Watchdog guidance. Omits the port's own suggestions reported not to work (headless SSH, `SPARSE_CONV_BACKEND=none`,
 * per-block synchronize; trellis-mac#8). Sleeping the panel is what is reported to clear it (mlx#3267). Does not suggest
 * fewer steps: the kill is per long dispatch, so only a lower pipeline tier shortens it. Never sets
 * `AGX_RELAX_CDM_CTXSTORE_TIMEOUT=1`: with the panel awake it turned a kernel kill into a hard reboot.
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
 * Which GLB post-process a run applies. Three layers can flatten alpha (exporter `alpha_mode`, this rewrite, the viewer's
 * `forceOpaque`) and must agree, or a BLEND mesh still renders solid.
 *  - `override !== undefined` wins, so an explicit `null` means "run nothing" (`??` would turn it back into force-opaque).
 *  - Otherwise force-opaque applies unless the exporter was asked for transparency; it defaults on because older o_voxel
 *    promoted to BLEND off a single low-alpha texel.
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
 * Run one image→GLB generation: the real-subprocess boundary, GUARDED (throws `TRELLIS2_NOT_INSTALLED` unless present,
 * so it never runs from a cold boot). `spawnImpl`/`exists` are injectable.
 * Returns `{ promise, kill }`; `kill` routes through `killWithEscalation` (SIGTERM, then SIGKILL).
 * `env` is the child environment (omitted → inherits `process.env`); the caller resolves the HF token env
 * (`hfChildEnv()` in `models.js#executeRender`) so this stays synchronous.
 * A successful render is normalized to opaque: the Apple port auto-enables BLEND from isolated low-alpha texels.
 * `decimationTarget` defaults to the memory-derived tier (see `trellis2MeshQuality.js`); pass
 * `TRELLIS2_DECIMATION_UPSTREAM_CLAMP` to reproduce upstream. `alphaMode` asking for transparency suppresses the
 * force-opaque post-process, which would otherwise undo the exporter's BLEND.
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
  // Explicit `pipelineType` wins over the detail tier.
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
    exists,
    meshQuality: {
      decimationTarget: resolvedDecimationTarget,
      fillHoles,
      remesh,
      alphaMode,
      normalMap,
      // Always passed with --normal-map so the JS constant is live config rather than shadowed by the Python default.
      ...(normalMap ? { normalMapMaxSourceFaces } : {}),
    },
  });
  // Skipped when the caller asked the exporter for a transparent material (see `alphaMode` above).
  const resolvedPostprocess = resolveGlbPostprocess(alphaMode, postprocessGlb);
  return runGenerateSubprocess({
    command,
    args,
    cwd: dirname(trellis2GenerateScript(base, exists)),
    env,
    label: LABEL,
    codePrefix: CODE_PREFIX,
    parseProgress: parseGenerateProgress,
    assetPath: outputPath || null,
    onProgress,
    spawnImpl,
    postprocessGlb: resolvedPostprocess,
    // A gated-dependency / HF-auth failure is a setup problem, not a crash.
    classifiers: [
      { test: isHfAuthError, code: `${CODE_PREFIX}_HF_AUTH_REQUIRED`, help: () => hfGatedRepoHelp('trellis2') },
      // MPS-only: the watchdog exits non-zero with no exception.
      { test: isMpsWatchdogError, code: `${CODE_PREFIX}_MPS_WATCHDOG`, help: TRELLIS2_WATCHDOG_HELP },
    ],
  });
}
