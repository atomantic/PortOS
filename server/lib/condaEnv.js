/**
 * Conda environment resolution.
 *
 * Where a NAMED conda environment's interpreter lives. Deliberately its own module
 * rather than part of `pythonSetup.js`: every resolver in that file probes *venv*
 * layouts (`~/.portos/venv-<name>/bin/python3`), and — more importantly — it computes
 * candidate lists from `PATHS` at MODULE LOAD time, so importing it just to resolve a
 * conda path drags that eager work (and its mock sensitivity) into every consumer.
 * This module imports nothing but `node:fs`/`node:os`/`node:path` and has no
 * load-time side effects.
 *
 * Consumed by the image-to-3D CUDA lanes (`trellis2Cuda.js`, `pixal3dCuda.js`), which
 * each own a separate conda env on purpose so one lane's pinned dependencies cannot
 * disturb the other's.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Ordered candidate paths for a named CONDA environment's python.
 *
 * Distinct from every other resolver in this file, which probe *venv* layouts
 * (`~/.portos/venv-<name>/bin/python3`). Conda puts its environments under
 * `<root>/envs/<name>`, and the root itself varies by installer — so the machine's own
 * answer comes first (`CONDA_PREFIX`, `CONDA_ROOT`) and the standard
 * miniconda/anaconda/miniforge/mamba locations follow.
 *
 * The subtle part, and the reason this is shared rather than copied per caller: when
 * PortOS is ITSELF running under some other conda env, `CONDA_PREFIX` points at
 * `<root>/envs/<that-env>` rather than at the root — so an `envs/<name>` prefix is
 * walked up two levels to recover the root. Getting that wrong makes the target look
 * uninstalled on exactly the machines most likely to have it.
 *
 * Linux/macOS paths (`bin/python`) only; every current caller gates itself to a POSIX
 * host, so there is no Windows branch here to bit-rot (WSL2 reports as Linux).
 *
 * @param {string} envName the conda environment name (e.g. `trellis2`).
 * @param {{env?: object}} [opts]
 * @returns {string[]}
 */
export function condaEnvPythonCandidates(envName, { env = process.env } = {}) {
  const roots = [
    env.CONDA_PREFIX && /[/\\]envs[/\\][^/\\]+$/.test(env.CONDA_PREFIX)
      ? join(env.CONDA_PREFIX, '..', '..')
      : env.CONDA_PREFIX,
    env.CONDA_ROOT,
    join(homedir(), 'miniconda3'),
    join(homedir(), 'anaconda3'),
    join(homedir(), 'miniforge3'),
    join(homedir(), 'mambaforge'),
    '/opt/conda',
  ].filter(Boolean);
  return roots.map((root) => join(root, 'envs', envName, 'bin', 'python'));
}

/**
 * The first existing candidate from `condaEnvPythonCandidates`, or null. `exists` is
 * injectable so callers stay unit-testable without a real conda install.
 * @param {string} envName
 * @param {{exists?: (p: string) => boolean, env?: object}} [opts]
 * @returns {string|null}
 */
export function resolveCondaEnvPython(envName, { exists = existsSync, env } = {}) {
  return condaEnvPythonCandidates(envName, { env }).find((p) => exists(p)) || null;
}
