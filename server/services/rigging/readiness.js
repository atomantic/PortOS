/**
 * Character rigging: the honest readiness answer, shipped BEFORE any rigging behavior so a
 * host with no Blender runtime says so by name instead of a mysterious spawn error.
 *
 * Mirrors the image-to-3D lane's vocabulary (`imageTo3d/targets.js`, `degradedInstall.js`):
 * stable kebab-case codes here, labels mirrored to `client/src/lib/riggingReasons.js`, drift
 * pinned by `unavailableReasons.parity.test.js`. `riggingUnavailableReason` is a PURE reducer
 * over a collected host picture, so every branch is unit-testable with no real install.
 */

import { ServerError } from '../../lib/errorHandler.js';
import {
  RIGGING_INSTALL_COMMAND,
  RIGGING_MODULE_REQUIREMENT,
  RIGGING_RUNTIME,
  isRiggingPlatformSupported,
  probeBlenderModule,
  resolveRiggingPython,
} from './runtime.js';

/**
 * Every reason code `riggingUnavailableReason` can return, mapped to its user-facing label.
 * MIRRORED verbatim to `client/src/lib/riggingReasons.js` (the client cannot import this
 * module); the parity test pins drift and that the key set EQUALS the returned codes.
 * Labels are never interpolated: machine-specific values travel in `detail`.
 */
export const RIGGING_UNAVAILABLE_REASONS = Object.freeze({
  'unsupported-platform': 'Rigging needs macOS on Apple Silicon, or Linux',
  'runtime-not-installed': 'The Blender rigging runtime is not installed yet',
  // The failure this phase exists to name: the env resolved, the module did not import.
  // Reporting it as ready would trade a named blocker for a render-time crash.
  'module-unimportable': 'The rigging runtime is only half installed',
  // "We could not look" is not "there is nothing there" — never report an absent
  // runtime we failed to probe (AGENTS.md sentinel rule).
  'runtime-probe-failed': 'Could not check the rigging runtime on this host',
});

/** Label for a reason code the map doesn't know (or a null/absent code). */
export const RIGGING_REASON_FALLBACK = 'Rigging is unavailable on this host';

/**
 * User-facing label for a reason code. Own-property lookup only, so a code that
 * happens to name an Object.prototype key can't render as a function/object.
 * @param {string|null} [reason]
 * @param {string} [fallback]
 * @returns {string}
 */
export function riggingReasonLabel(reason, fallback = RIGGING_REASON_FALLBACK) {
  return Object.hasOwn(RIGGING_UNAVAILABLE_REASONS, reason ?? '') ? RIGGING_UNAVAILABLE_REASONS[reason] : fallback;
}

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
 * labels from its mirror (`client/src/lib/riggingReasons.js`).
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

// A real `import bpy` costs seconds and this answer is read on every `GET /api/settings/features`;
// memoize briefly. The Settings card's explicit recheck passes `refresh` to bypass it.
const CACHE_TTL_MS = 60_000;
let cached = null;

/** Drop the memoized readiness answer. Test-only seam. */
export const __resetRiggingReadinessCache = () => { cached = null; };

/**
 * The cached readiness answer; `probe`/`now` are injectable so the cache is testable without Blender.
 * @param {{refresh?: boolean, now?: () => number, probe?: () => Promise<object>}} [opts]
 * @returns {Promise<object>}
 */
export async function getRiggingReadiness({ refresh = false, now = Date.now, probe = probeRiggingReadiness } = {}) {
  const at = now();
  if (!refresh && cached && at - cached.at < CACHE_TTL_MS) return cached.value;
  const value = await probe();
  cached = { at, value };
  console.log(`🦴 Rigging readiness: ${value.ready ? 'ready' : value.reason}`);
  return value;
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
