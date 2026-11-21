/**
 * Character rigging: Blender-module runtime resolution and probe.
 *
 * `bpy` needs its own conda env (like the image-to-3D CUDA lanes) because it pins one CPython
 * minor and a large native tree. Everything here is PURE or INJECTABLE (`exists`, `env`,
 * `execFileImpl`), so tests need no Blender; only the no-override caller touches the machine,
 * on request, never at boot. The probe does a REAL `import`, not `find_spec`
 * (`imageTo3d/laneRunner.js#probePythonModules`): a half-provisioned env has a resolvable spec
 * and an unimportable module, which this lane must NAME, not report ready. The readiness
 * caller memoizes the cost.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from '../../lib/childProcess.js';
import { resolveCondaEnvPython } from '../../lib/condaEnv.js';
import { isAppleSilicon } from '../../lib/platform.js';

/**
 * The install descriptor. `moduleVersion` is a hard PIN: `bpy` wheels pair one Blender release
 * with one CPython minor, and an unpinned install can yield an env that cannot import it.
 */
export const RIGGING_RUNTIME = Object.freeze({
  condaEnv: 'rigging',
  module: 'bpy',
  moduleVersion: '5.2.3',
  pythonVersion: '3.13',
});

/** `bpy==5.2.3` — the pinned requirement, assembled once from the descriptor. */
export const RIGGING_MODULE_REQUIREMENT = `${RIGGING_RUNTIME.module}==${RIGGING_RUNTIME.moduleVersion}`;

/**
 * The one command that provisions the env, printed verbatim in Settings so the UI remedy cannot drift.
 */
export const RIGGING_INSTALL_COMMAND = 'python3 scripts/ml/setup-rigging.py';

/**
 * Can this host run the rigging runtime? macOS on Apple Silicon and Linux; not Intel Mac or
 * Windows (`condaEnv.js` only knows POSIX `bin/python` layouts). Pure; platform/arch injectable.
 *
 * @param {{platform?: string, arch?: string, probe?: () => boolean}} [opts]
 * @returns {boolean}
 */
export function isRiggingPlatformSupported({ platform = process.platform, arch, probe } = {}) {
  if (platform === 'linux') return true;
  return isAppleSilicon({ platform, arch, probe });
}

/**
 * Prefer the reviewed private prefix; retain named Conda discovery for existing installs.
 * `exists`/`env` are injectable so tests need no conda.
 *
 * @param {{exists?: (p: string) => boolean, env?: NodeJS.ProcessEnv, home?: string}} [opts]
 * @returns {string|null}
 */
export function resolveRiggingPython({ exists = existsSync, env, home = homedir() } = {}) {
  const reviewed = join(home, '.portos', 'envs', RIGGING_RUNTIME.condaEnv, 'bin', 'python');
  if (exists(reviewed)) return reviewed;
  return resolveCondaEnvPython(RIGGING_RUNTIME.condaEnv, { exists, env });
}

/**
 * The probe one-liner. It catches the import failure ITSELF and exits 0 with `{"ok": false, …}`,
 * so the classifier can tell "module would not import" from "interpreter could not run" (sentinel rule).
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
 * Classify one probe run. Every failure path RESOLVES, and the JSON parse happens after the
 * callback settles: a throw inside an `execFile` callback would crash the process.
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
