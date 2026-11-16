/**
 * Conda environment resolution: where a NAMED conda environment's interpreter lives.
 *
 * Separate from `pythonSetup.js` to avoid its module-load-time work.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * Ordered candidate paths for a named CONDA environment's python.
 *
 * Environment roots vary by installer: `CONDA_PREFIX`/`CONDA_ROOT` first, then
 * standard locations. Under another conda env `CONDA_PREFIX` is
 * `<root>/envs/<that-env>`, so it is walked up two levels to recover the root.
 * POSIX only (`bin/python`).
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
 * The first existing candidate, or null; `exists` is injectable for tests.
 * @param {string} envName
 * @param {{exists?: (p: string) => boolean, env?: object}} [opts]
 * @returns {string|null}
 */
export function resolveCondaEnvPython(envName, { exists = existsSync, env } = {}) {
  return condaEnvPythonCandidates(envName, { env }).find((p) => exists(p)) || null;
}
