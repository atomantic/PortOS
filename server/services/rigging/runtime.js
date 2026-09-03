/**
 * Character rigging — Blender-module runtime resolution and probe.
 *
 * The rigging lane needs Blender's Python module (`bpy`) importable from a dedicated
 * interpreter. It gets its own conda environment for the same reason the image-to-3D
 * CUDA lanes each get one (`trellis2`, `pixal3d`): `bpy` pins an exact CPython minor
 * and drags a large native tree with it, so sharing an env with another heavy lane
 * would let one lane's upgrade silently break the other.
 *
 * Everything here is PURE or INJECTABLE — `exists`, `env` and `execFileImpl` are all
 * parameters — so the resolver and the probe classifier are unit-testable on a host
 * with no Blender install at all. Only the caller that passes no overrides touches the
 * real machine, and it does so on request (never from `server/index.js` boot).
 *
 * The probe deliberately does a REAL `import`, not `importlib.util.find_spec` the way
 * `imageTo3d/laneRunner.js#probePythonModules` does. A half-provisioned env — the
 * interpreter created, the wheel half-unpacked or built against the wrong CPython — has
 * a resolvable spec and an unimportable module. That is exactly the failure this lane
 * must NAME rather than report as ready, so it is worth the seconds a real import costs
 * (the readiness caller memoizes the answer so it is not paid per request).
 */

import { existsSync } from 'node:fs';
import { execFile } from '../../lib/childProcess.js';
import { resolveCondaEnvPython } from '../../lib/condaEnv.js';
import { isAppleSilicon } from '../../lib/platform.js';

/**
 * The install descriptor. `moduleVersion` is a hard PIN, not a floor: `bpy` wheels are
 * published per Blender release against one CPython minor, and an unpinned install
 * resolves to whichever pairing PyPI happens to serve — which is how an env ends up
 * with an interpreter that cannot import the module it just installed.
 */
export const RIGGING_RUNTIME = Object.freeze({
  condaEnv: 'rigging',
  module: 'bpy',
  moduleVersion: '4.2.0',
  pythonVersion: '3.11',
});

/** `bpy==4.2.0` — the pinned requirement, assembled once from the descriptor. */
export const RIGGING_MODULE_REQUIREMENT = `${RIGGING_RUNTIME.module}==${RIGGING_RUNTIME.moduleVersion}`;

/**
 * The one command that provisions the env. Surfaced verbatim in the Settings card so
 * the remedy the UI prints and the remedy this module resolves against cannot drift.
 */
export const RIGGING_INSTALL_COMMAND = `conda create -y -n ${RIGGING_RUNTIME.condaEnv} `
  + `python=${RIGGING_RUNTIME.pythonVersion} && `
  + `conda run -n ${RIGGING_RUNTIME.condaEnv} pip install "${RIGGING_MODULE_REQUIREMENT}"`;

/**
 * Can this host run the rigging runtime at all? macOS on Apple Silicon and Linux are
 * the supported pairings; an Intel Mac and Windows are not (the conda-env resolver in
 * `condaEnv.js` only knows POSIX `bin/python` layouts, and the lane's downstream
 * tooling follows). Pure — platform/arch are injectable.
 *
 * @param {{platform?: string, arch?: string, probe?: () => boolean}} [opts]
 * @returns {boolean}
 */
export function isRiggingPlatformSupported({ platform = process.platform, arch, probe } = {}) {
  if (platform === 'linux') return true;
  return isAppleSilicon({ platform, arch, probe });
}

/**
 * The rigging env's interpreter, or `null` when the env has not been created.
 * `exists`/`env` are injectable exactly as `resolveCondaEnvPython` makes them, so this
 * resolves deterministically in tests with no conda on the machine.
 *
 * @param {{exists?: (p: string) => boolean, env?: NodeJS.ProcessEnv}} [opts]
 * @returns {string|null}
 */
export function resolveRiggingPython({ exists = existsSync, env } = {}) {
  return resolveCondaEnvPython(RIGGING_RUNTIME.condaEnv, { exists, env });
}

/**
 * The probe one-liner. It catches the import failure ITSELF and still exits 0, printing
 * `{"ok": false, …}`. That is what lets the classifier below tell "python ran and the
 * module would not import" apart from "the interpreter could not be run at all" — two
 * states a non-zero exit would collapse into one (AGENTS.md sentinel rule).
 */
export const BLENDER_MODULE_PROBE_SOURCE = [
  'import json',
  'try:',
  `    import ${RIGGING_RUNTIME.module} as _m`,
  '    _v = getattr(getattr(_m, "app", None), "version_string", None)',
  '    print(json.dumps({"ok": True, "version": _v if isinstance(_v, str) else None}))',
  'except BaseException as exc:',
  '    print(json.dumps({"ok": False, "error": "%s: %s" % (type(exc).__name__, exc)}))',
].join('\n');

/** Keep a runtime error message short enough to render in a card line. */
const MAX_ERROR_CHARS = 300;

const parseProbeJson = (stdout) => {
  try {
    const parsed = JSON.parse(String(stdout).trim() || 'null');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
};

/**
 * Classify one probe run.
 *
 * Child-process boundary outside the request lifecycle, so every failure path RESOLVES
 * — and, as in `probePythonModules`, the JSON parse happens after the callback settles:
 * a throw inside an `execFile` callback escapes the enclosing promise and reaches the
 * event loop, crashing the process instead of degrading the probe.
 *
 * @param {{python: string|null, execFileImpl?: Function, timeoutMs?: number}} [opts]
 * @returns {Promise<{status: 'ok'|'unimportable'|'probe-failed', version?: string|null, error?: string|null}>}
 */
export async function probeBlenderModule({ python, execFileImpl = execFile, timeoutMs = 60000 } = {}) {
  if (!python) return { status: 'probe-failed', error: null };
  const stdout = await new Promise((resolve) => {
    execFileImpl(python, ['-c', BLENDER_MODULE_PROBE_SOURCE], { timeout: timeoutMs },
      (err, out) => resolve(err ? null : String(out ?? '')));
  }).catch(() => null);
  if (stdout === null) return { status: 'probe-failed', error: null };

  const parsed = parseProbeJson(stdout);
  if (!parsed) return { status: 'probe-failed', error: null };
  if (parsed.ok !== true) {
    const error = typeof parsed.error === 'string' ? parsed.error.slice(0, MAX_ERROR_CHARS) : null;
    return { status: 'unimportable', error };
  }
  return { status: 'ok', version: typeof parsed.version === 'string' ? parsed.version : null };
}
