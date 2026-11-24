/**
 * Character rigging: the honest readiness answer, shipped BEFORE any rigging behavior so a
 * host with no Blender runtime says so by name instead of a mysterious spawn error.
 *
 * Mirrors the image-to-3D lane's vocabulary (`imageTo3d/targets.js`, `degradedInstall.js`):
 * stable kebab-case codes here, labels in the browser-safe leaf `lib/riggingReasons.js` that the client
 * re-exports. `riggingUnavailableReason` is a PURE reducer over a collected host picture, so every branch
 * is unit-testable with no real install.
 */

import { ServerError } from '../../lib/errorHandler.js';
import { riggingReasonLabel } from '../../lib/riggingReasons.js';
import {
  RIGGING_INSTALL_COMMAND,
  RIGGING_MODULE_REQUIREMENT,
  RIGGING_RUNTIME,
  isRiggingPlatformSupported,
  probeBlenderModule,
  resolveRiggingPython,
} from './runtime.js';

/**
 * Why rigging can't run, or `null` when it can. Pure: the host picture is passed in.
 * Order matters: platform gate first (final), interpreter before module (different
 * remedies), and an unanswered probe falls to `runtime-probe-failed`, not "not installed".
 *
 * @param {{supportedPlatform?: boolean, python?: string|null,
 *          probe?: {status?: string}|null}} [host]
 * @returns {string|null}
 */
export function riggingUnavailableReason({ supportedPlatform, python, probe } = {}) {
  if (!supportedPlatform) return 'unsupported-platform';
  if (!python) return 'runtime-not-installed';
  if (probe?.status === 'ok') return null;
  if (probe?.status === 'unimportable') return 'module-unimportable';
  return 'runtime-probe-failed';
}

// The machine-specific half of the answer, split from the labels (as `degradedInstall.js` does) because the labels are mirrored to the client.
const detailFor = (reason, { platform, python, probe }) => {
  switch (reason) {
    case null:
      return `${RIGGING_RUNTIME.module} ${probe?.version || '(version unreported)'} imports from ${python}.`;
    case 'unsupported-platform':
      return `Rigging runs on macOS (Apple Silicon) and Linux; this host reports "${platform}".`;
    case 'runtime-not-installed':
      return `No "${RIGGING_RUNTIME.condaEnv}" conda environment was found. Run the install command to create it.`;
    case 'module-unimportable':
      return `${python} exists, but importing ${RIGGING_RUNTIME.module} failed`
        + `${probe?.error ? `: ${probe.error}` : '.'}`
        + ` Re-run the install command to reprovision ${RIGGING_MODULE_REQUIREMENT}.`;
    default:
      return `${python} could not be run, so the state of ${RIGGING_RUNTIME.module} in the `
        + `"${RIGGING_RUNTIME.condaEnv}" environment is unknown.`;
  }
};

/**
 * Assemble the readiness payload from an already-collected host picture. Pure.
 * `installCommand` is omitted for `unsupported-platform` (a remedy that cannot work is worse
 * than none). The payload carries the reason CODE, never its label: the client renders
 * labels from `lib/riggingReasons.js`.
 *
 * @param {{supportedPlatform: boolean, platform: string, python: string|null,
 *          probe: {status?: string, version?: string|null, error?: string|null}|null}} host
 * @returns {{ready: boolean, reason: string|null, detail: string,
 *   interpreter: string|null, module: string, moduleVersion: string|null,
 *   modulePin: string, installCommand: string|null}}
 */
export function describeRiggingReadiness({ supportedPlatform, platform, python, probe }) {
  const reason = riggingUnavailableReason({ supportedPlatform, python, probe });
  return {
    ready: reason === null,
    reason,
    detail: detailFor(reason, { platform, python, probe }),
    interpreter: python || null,
    module: RIGGING_RUNTIME.module,
    moduleVersion: probe?.status === 'ok' ? (probe.version || null) : null,
    modulePin: RIGGING_MODULE_REQUIREMENT,
    installCommand: reason === null || reason === 'unsupported-platform' ? null : RIGGING_INSTALL_COMMAND,
  };
}

/**
 * Collect the host picture and describe it. The one impure export: it resolves a path and
 * may spawn the import probe. Runs ON REQUEST, never from boot.
 *
 * @param {{exists?: Function, env?: NodeJS.ProcessEnv, execFileImpl?: Function,
 *          platform?: string, arch?: string}} [opts]
 * @returns {Promise<object>}
 */
export async function probeRiggingReadiness({ exists, env, execFileImpl, platform = process.platform, arch } = {}) {
  const supportedPlatform = isRiggingPlatformSupported({ platform, arch });
  if (!supportedPlatform) {
    return describeRiggingReadiness({ supportedPlatform, platform, python: null, probe: null });
  }
  const python = resolveRiggingPython({ exists, env });
  const probe = python ? await probeBlenderModule({ python, execFileImpl }) : null;
  return describeRiggingReadiness({ supportedPlatform, platform, python, probe });
}

// Importing bpy costs seconds. Reuse recent answers and share work across callers.
const CACHE_TTL_MS = 60_000;
let cached = null;
let inflight = null;

/** Reset readiness state. Test-only seam. */
export const __resetRiggingReadinessCache = () => {
  cached = null;
  inflight = null;
};

/**
 * The cached readiness answer; `probe`/`now` are injectable so the cache is testable without Blender.
 * @param {{refresh?: boolean, now?: () => number, probe?: () => Promise<object>}} [opts]
 * @returns {Promise<object>}
 */
export function getRiggingReadiness({ refresh = false, now = Date.now, probe = probeRiggingReadiness } = {}) {
  if (!refresh && inflight) return inflight;
  if (!refresh && cached && now() - cached.at < CACHE_TTL_MS) return Promise.resolve(cached.value);

  const pending = Promise.resolve().then(() => probe()).then((value) => {
    // A superseded probe still answers its caller, but only the latest can update the cache.
    if (inflight === pending) {
      cached = value.reason === 'runtime-probe-failed' ? null : { at: now(), value };
    }
    console.log(`🦴 Rigging readiness: ${value.ready ? 'ready' : value.reason}`);
    return value;
  }).finally(() => {
    if (inflight === pending) inflight = null;
  });
  inflight = pending;
  return pending;
}

/**
 * The interpreter a rigging run may spawn, or a named 409 explaining why it may not.
 * Fails CLOSED on the readiness verdict and on a ready answer naming no interpreter.
 * `readiness` is injectable so a run can reuse an answer it already has.
 *
 * @param {{readiness?: object, python?: string|null}} [opts]
 * @returns {Promise<string>} The interpreter path.
 */
export async function requireRiggingInterpreter({ readiness, python } = {}) {
  const ready = readiness ?? await getRiggingReadiness();
  if (!ready.ready) {
    throw new ServerError(riggingReasonLabel(ready.reason), {
      status: 409,
      code: 'RIGGING_RUNTIME_UNAVAILABLE',
      context: { reason: ready.reason, detail: ready.detail },
    });
  }
  const interpreter = python ?? ready.interpreter ?? resolveRiggingPython();
  if (!interpreter) {
    throw new ServerError(riggingReasonLabel('runtime-not-installed'), {
      status: 409, code: 'RIGGING_RUNTIME_UNAVAILABLE', context: { reason: 'runtime-not-installed' },
    });
  }
  return interpreter;
}
