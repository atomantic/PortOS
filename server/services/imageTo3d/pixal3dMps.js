/**
 * Pixal3D (local Apple Silicon / MPS) target — install detection, pure command
 * builders, progress parsing, and a guarded generate runner.
 *
 * The official TencentARC/Pixal3D entrypoint is CUDA-only. This lane uses the
 * complete community Apple Silicon port, which replaces Pixal3D's CUDA extension
 * stack with vendored Metal packages and ships `generate_mps.py` as its own CLI.
 * It is deliberately isolated from both the TRELLIS.2 MPS environment and the
 * Pixal3D CUDA environment: the fork pins Python/dependency versions and compiles
 * native extensions into its own `.venv`.
 *
 * The subprocess machinery is shared through `laneRunner.js`. No install or render
 * starts at module load; both are reached only from explicit user actions.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from '../../lib/childProcess.js';
import { appendMissingModules, describeDegradedInstall } from './degradedInstall.js';
import { rewriteGlbMaterialsOpaque } from './glbMaterials.js';
import {
  hfGatedRepoHelp,
  isHfAuthError,
  isTransientInstallError,
  parseGenerateProgress,
} from './trellis2.js';
import {
  TRELLIS2_METAL_TOOLCHAIN_STEP,
  probeMetalToolchain,
} from './trellis2.js';
import {
  probePythonJson, runGenerateSubprocess, runInstallSteps, textMatcher,
} from './laneRunner.js';
import { renderOptionArgs, validateRenderOptions } from './renderOptions.js';

const HOME = homedir();
const CODE_PREFIX = 'PIXAL3D_MPS';
const LABEL = 'Pixal3D (Apple Silicon)';

/** The complete Apple Silicon / Metal port used by this target. */
export const PIXAL3D_MPS_REPO = 'https://github.com/pawel-mazurkiewicz/Pixal3D-mac.git';
export const PIXAL3D_MPS_REVISION = '0be9e69a729432323dfb60a418801e5e9e7a1437';

/** Interpreter and ABI validated with PortOS's locked Mac dependency set. */
export const PIXAL3D_MPS_PYTHON_VERSION = '3.13';

/** The wheel lock is installed before natten's build metadata imports torch. */
export const PIXAL3D_MPS_TORCH_VERSION = '2.15.0';
export const PIXAL3D_MPS_TORCHVISION_VERSION = '0.29.2';
export const PIXAL3D_MPS_NATTEN_VERSION = '0.21.0';

/** Clone/install root. `base` is overridable so the entire lane is unit-testable. */
export function pixal3dMpsRoot(base = join(HOME, '.portos')) {
  return join(base, 'pixal3d-mps');
}

/** The port's private virtual-environment interpreter. */
export function pixal3dMpsVenvPython(base) {
  return join(pixal3dMpsRoot(base), '.venv', 'bin', 'python');
}

/** The port's Apple-native inference entrypoint. */
export function pixal3dMpsGenerateScript(base) {
  return join(pixal3dMpsRoot(base), 'generate_mps.py');
}

/** Installed ⇔ the private venv and the port's entrypoint both exist. */
export function isPixal3dMpsInstalled({ base, exists = existsSync } = {}) {
  return exists(pixal3dMpsVenvPython(base)) && exists(pixal3dMpsGenerateScript(base));
}

/**
 * The MPS port's two supported pipeline types. PortOS starts at 1024: the fork's
 * 1536 cascade can take up to roughly an hour on a high-memory Mac, so exposing it
 * as an automatic default would turn a normal Generate click into an unexpectedly
 * long job. A future target-specific detail control can opt into 1536 explicitly.
 */
export const PIXAL3D_MPS_PIPELINE_TYPES = Object.freeze(['1024_cascade', '1536_cascade']);
export const PIXAL3D_MPS_DEFAULT_PIPELINE_TYPE = PIXAL3D_MPS_PIPELINE_TYPES[0];

/** Native packages the port's setup smoke check imports for the full Metal path. */
export const PIXAL3D_MPS_REQUIRED_MODULES = Object.freeze([
  'torch', 'moge', 'cumesh', 'flex_gemm', 'mtlbvh', 'mtldiffrast', 'o_voxel',
  'natten', 'natten_mps',
]);

/** Remedy text for a venv that exists but did not finish its native installs. */
export const PIXAL3D_MPS_INCOMPLETE_INSTALL_HELP = 'Pixal3D is installed but its '
  + 'Apple-native Python or Metal packages are incomplete. Repair install reruns the '
  + 'pinned setup and rebuilds the native packages; downloaded models are kept.';

const RUNTIME_UPDATE_HELP = `Pixal3D needs a runtime update. Install Python ${PIXAL3D_MPS_PYTHON_VERSION}, `
  + 'then choose Repair install to apply the patched runtime. Downloaded models are kept.';

const RUNTIME_PROBE_SOURCE = `
import importlib.metadata as metadata, importlib.util as util, json, sys
def version(name):
    try: return metadata.version(name)
    except metadata.PackageNotFoundError: return None
print(json.dumps({
    'modules': {name: util.find_spec(name) is not None for name in sys.argv[1:]},
    'python': f'{sys.version_info.major}.{sys.version_info.minor}',
    'torch': version('torch'),
    'torchvision': version('torchvision'),
}))`;

/**
 * PortOS owns setup: upstream setup_mac.sh reinstalls the vulnerable torch pair.
 * The script applies the wheel lock before the hashed source packages (natten's
 * metadata imports torch), then rebuilds the vendored extensions against that ABI.
 */
const SETUP_SCRIPT = fileURLToPath(new URL('../../../scripts/setup-pixal3d-mps.sh', import.meta.url));

/**
 * Build the idempotent install plan for the Apple port.
 *
 * Fresh install and Repair use the same immutable source and locked environment.
 * The optional toolchain download precedes compilation of the Metal packages.
 *
 * @param {string} [base]
 * @param {{exists?: (path: string) => boolean, installMetalToolchain?: boolean}} [opts]
 * @returns {Array<{stage: string, command: string, args: string[], cwd?: string, optional?: boolean}>}
 */
export function buildPixal3dMpsInstallSteps(
  base,
  { exists = existsSync, installMetalToolchain = false } = {},
) {
  const root = pixal3dMpsRoot(base);
  const steps = [];
  if (installMetalToolchain) {
    steps.push({
      ...TRELLIS2_METAL_TOOLCHAIN_STEP,
      args: [...TRELLIS2_METAL_TOOLCHAIN_STEP.args],
    });
  }
  if (!exists(join(root, '.git'))) {
    steps.push({
      stage: 'clone',
      command: 'git',
      args: ['clone', '--depth', '1', PIXAL3D_MPS_REPO, root],
    });
  }
  steps.push({
    stage: 'pin-source', command: 'git',
    args: ['fetch', '--depth', '1', 'origin', PIXAL3D_MPS_REVISION], cwd: root,
  });
  steps.push({
    stage: 'checkout-source', command: 'git',
    args: ['checkout', '--detach', PIXAL3D_MPS_REVISION], cwd: root,
  });
  steps.push({
    stage: 'bootstrap',
    command: 'bash',
    args: [SETUP_SCRIPT],
    cwd: root,
  });
  return steps;
}

/**
 * Probe the installed venv without importing torch or allocating Metal buffers.
 * `unknown: true` is distinct from an observed missing module so a failed probe does
 * not falsely label a possibly healthy install as broken.
 */
export async function probePixal3dMpsModules({
  base,
  exists = existsSync,
  execFileImpl = execFile,
} = {}) {
  const python = pixal3dMpsVenvPython(base);
  if (!exists(python)) return { unknown: true, missing: [] };
  const runtime = await probePythonJson({
    python,
    args: ['-c', RUNTIME_PROBE_SOURCE, ...PIXAL3D_MPS_REQUIRED_MODULES],
    execFileImpl,
  });
  if (!runtime?.modules || typeof runtime.python !== 'string') return { unknown: true, missing: [] };
  return {
    unknown: false,
    missing: PIXAL3D_MPS_REQUIRED_MODULES.filter((module) => !runtime.modules[module]),
    needsUpdate: runtime.python !== PIXAL3D_MPS_PYTHON_VERSION
      || runtime.torch !== PIXAL3D_MPS_TORCH_VERSION
      || runtime.torchvision !== PIXAL3D_MPS_TORCHVISION_VERSION,
  };
}

/**
 * Install the fork as a killable, event-emitting job. The setup script does not pull
 * model weights, so installation is expensive but does not cold-start inference; the
 * first explicit render downloads the Hugging Face models.
 */
export function installPixal3dMps({
  base,
  onEvent = () => {},
  spawnImpl = spawn,
  maxRetries = 3,
  sleep,
  exists = existsSync,
  env,
  installMetalToolchain = false,
  probeModules = probePixal3dMpsModules,
} = {}) {
  const installEnv = {
    ...(env ?? process.env),
    PIP_NO_BUILD_ISOLATION: '1',
  };
  return runInstallSteps({
    steps: buildPixal3dMpsInstallSteps(base, { exists, installMetalToolchain }),
    label: LABEL,
    codePrefix: CODE_PREFIX,
    isTransient: isTransientInstallError,
    onEvent,
    spawnImpl,
    maxRetries,
    sleep,
    env: installEnv,
    verify: async (emit) => {
      if (!isPixal3dMpsInstalled({ base, exists })) {
        const error = new Error(
          `${LABEL} setup finished but its Python environment or generate_mps.py is missing.`,
        );
        error.code = `${CODE_PREFIX}_INSTALL_INCOMPLETE`;
        error.stage = 'verify';
        throw error;
      }
      const probe = await probeModules({ base, exists });
      if (probe.needsUpdate) {
        const error = new Error(RUNTIME_UPDATE_HELP);
        error.code = `${CODE_PREFIX}_INSTALL_INCOMPLETE`;
        error.stage = 'verify';
        throw error;
      }
      if (probe.missing?.length) {
        emit({
          type: 'log',
          stage: 'verify',
          message: `⚠️ ${appendMissingModules(PIXAL3D_MPS_INCOMPLETE_INSTALL_HELP, probe.missing)}`,
        });
      } else if (!probe.unknown) {
        emit({ type: 'log', stage: 'verify', message: '✅ Pixal3D Apple Silicon environment is present.' });
      }
    },
  });
}

/**
 * Build the Apple-port CLI invocation. The fork accepts a full output path and
 * exposes the shared seed/steps controls directly, unlike the CUDA-only entrypoint.
 */
export function buildPixal3dMpsGenerateArgs({
  imagePath,
  outputPath,
  base,
  python,
  pipelineType = PIXAL3D_MPS_DEFAULT_PIPELINE_TYPE,
  steps = null,
  seed = null,
} = {}) {
  if (!imagePath) throw new Error('buildPixal3dMpsGenerateArgs: imagePath is required');
  if (!PIXAL3D_MPS_PIPELINE_TYPES.includes(pipelineType)) {
    throw new Error(
      `buildPixal3dMpsGenerateArgs: pipelineType must be one of ${PIXAL3D_MPS_PIPELINE_TYPES.join(', ')}`,
    );
  }
  validateRenderOptions('buildPixal3dMpsGenerateArgs', { steps, seed });
  const args = [
    pixal3dMpsGenerateScript(base),
    imagePath,
    '--device', 'mps',
    '--pipeline-type', pipelineType,
  ];
  if (outputPath) args.push('--output', outputPath);
  args.push(...renderOptionArgs('buildPixal3dMpsGenerateArgs', { steps, seed }));
  return { command: python || pixal3dMpsVenvPython(base) || 'python3', args };
}

/** Apple-port stage banners, mapped into PortOS's shared progress vocabulary. */
const PIXAL3D_MPS_STAGE_SIGNATURES = [
  { re: /^\[Pipeline\] Loading/i, stage: 'loading', percent: 2 },
  { re: /^\[ImageCond\]/i, stage: 'loading', percent: 3 },
  { re: /^\[NAF\]/i, stage: 'loading', percent: 4 },
  { re: /^\[MoGe\]/i, stage: 'loading', percent: 7 },
  { re: /^\[Generate\]/i, stage: 'generating', percent: 10 },
  { re: /^\[Mesh\]/i, stage: 'meshing', percent: 55 },
  { re: /^\[Export\]/i, stage: 'texturing', percent: 65 },
  { re: /^\[Timing\]/i, stage: 'texturing', percent: 72 },
];

/** Parse one line of `generate_mps.py` output, or return null when it carries no signal. */
export function parsePixal3dMpsProgress(line) {
  const shared = parseGenerateProgress(line);
  if (shared) return shared;
  const text = String(line ?? '').trim();
  if (!text) return null;
  for (const signature of PIXAL3D_MPS_STAGE_SIGNATURES) {
    if (signature.re.test(text)) {
      return {
        stage: signature.stage,
        percent: signature.percent,
        message: text,
      };
    }
  }
  return null;
}

/** Apple Metal watchdog / empty-mesh failure signatures from the port's own help. */
export const isPixal3dMpsWatchdogError = textMatcher([
  'decoder produced an empty mesh',
  'macOS GPU watchdog',
  'kIOGPUCommandBufferCallbackErrorImpactingInteractivity',
  'BVH needs at least 8 triangles',
]);

export const PIXAL3D_MPS_WATCHDOG_HELP = 'The macOS GPU watchdog stopped this Pixal3D '
  + 'render during a long Metal dispatch. Nothing is wrong with the install. Put the '
  + 'display to sleep, close display-heavy apps, or retry at a lower pipeline tier.';

export const isPixal3dMpsOutOfMemoryError = textMatcher([
  'MPS backend out of memory',
  'MPSAllocator',
  'out of memory',
  'not enough memory',
]);

export const PIXAL3D_MPS_OUT_OF_MEMORY_HELP = 'Pixal3D ran out of Apple unified memory '
  + 'during this render. Close other GPU-heavy apps and retry; use the 1024 cascade '
  + 'rather than the 1536 cascade if you are running it directly.';

/**
 * Run one Apple-native image→GLB generation. This is guarded on the private venv and
 * entrypoint so a fresh boot cannot silently install or invoke the model.
 */
export function runPixal3dMpsGenerate({
  imagePath,
  outputPath,
  base,
  pipelineType,
  steps = null,
  seed = null,
  onProgress,
  spawnImpl = spawn,
  exists = existsSync,
  env,
  postprocessGlb = rewriteGlbMaterialsOpaque,
} = {}) {
  const python = pixal3dMpsVenvPython(base);
  if (!exists(python) || !exists(pixal3dMpsGenerateScript(base))) {
    const error = new Error(`${LABEL} is not installed — install it before generating.`);
    error.code = `${CODE_PREFIX}_NOT_INSTALLED`;
    return { promise: Promise.reject(error), kill: () => {} };
  }
  const { command, args } = buildPixal3dMpsGenerateArgs({
    imagePath,
    outputPath,
    base,
    python,
    pipelineType,
    steps,
    seed,
  });
  // `generate_mps.py` uses tqdm and plain prints; without this flag a pipe buffers
  // the first several minutes of progress, leaving the shared render card looking
  // idle while MPS is actively sampling.
  const renderEnv = {
    ...(env ?? process.env),
    PYTHONUNBUFFERED: '1',
  };
  return runGenerateSubprocess({
    command,
    args,
    cwd: pixal3dMpsRoot(base),
    env: renderEnv,
    label: LABEL,
    codePrefix: CODE_PREFIX,
    parseProgress: parsePixal3dMpsProgress,
    assetPath: outputPath || null,
    onProgress,
    spawnImpl,
    postprocessGlb,
    classifiers: [
      { test: isPixal3dMpsWatchdogError, code: `${CODE_PREFIX}_MPS_WATCHDOG`, help: PIXAL3D_MPS_WATCHDOG_HELP },
      { test: isHfAuthError, code: `${CODE_PREFIX}_HF_AUTH_REQUIRED`, help: () => hfGatedRepoHelp('pixal3dMps') },
      { test: isPixal3dMpsOutOfMemoryError, code: `${CODE_PREFIX}_OUT_OF_MEMORY`, help: PIXAL3D_MPS_OUT_OF_MEMORY_HELP },
    ],
  });
}

/**
 * Resolve the card's extra install diagnostics for the generic target card.
 * Kept as a helper for the adapter and direct tests; it never imports the native
 * packages itself.
 */
export async function describePixal3dMpsInstallState({
  base,
  exists = existsSync,
  execFileImpl = execFile,
} = {}) {
  const probe = await probePixal3dMpsModules({ base, exists, execFileImpl });
  const projection = probe.needsUpdate || probe.missing?.length
    ? describeDegradedInstall({
      label: probe.needsUpdate ? 'runtime update needed' : 'incomplete install',
      help: probe.needsUpdate ? RUNTIME_UPDATE_HELP : PIXAL3D_MPS_INCOMPLETE_INSTALL_HELP,
      missing: probe.missing,
    })
    : null;
  return {
    fields: {
      ...(projection ? { degraded: projection.degraded } : {}),
    },
    warnings: projection?.warnings ?? [],
  };
}

/** Exported for the adapter's async preflight. */
export { probeMetalToolchain };
