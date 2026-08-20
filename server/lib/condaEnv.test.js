import { describe, it, expect } from 'vitest';
import { posixPath } from './testHelper.js';
import { condaEnvPythonCandidates, resolveCondaEnvPython } from './condaEnv.js';

describe('conda environment python resolution', () => {
  const CONDA = '/opt/conda';
  const envPy = (root, name) => `${root}/envs/${name}/bin/python`;

  it('probes the machine-declared roots first, then the standard install locations', () => {
    const candidates = condaEnvPythonCandidates('trellis2', { env: { CONDA_ROOT: CONDA } });
    expect(candidates[0]).toBe(envPy(CONDA, 'trellis2'));
    // Every candidate targets the requested env, never another one.
    expect(candidates.every((p) => posixPath(p).includes('/envs/trellis2/'))).toBe(true);
    expect(candidates.some((p) => posixPath(p).startsWith('/opt/conda/'))).toBe(true);
  });

  it('walks up from an active envs/<name> CONDA_PREFIX to recover the root', () => {
    // The subtle case this helper exists to centralize: PortOS itself running under a
    // DIFFERENT conda env must still locate the target env, not look inside its own.
    const candidates = condaEnvPythonCandidates('pixal3d', {
      env: { CONDA_PREFIX: `${CONDA}/envs/portos` },
    }).map(posixPath);
    expect(candidates).toContain(envPy(CONDA, 'pixal3d'));
    expect(candidates.some((p) => p.includes('/envs/portos/'))).toBe(false);
  });

  it('uses a base-install CONDA_PREFIX as the root directly', () => {
    const candidates = condaEnvPythonCandidates('trellis2', { env: { CONDA_PREFIX: CONDA } });
    expect(candidates.map(posixPath)).toContain(envPy(CONDA, 'trellis2'));
  });

  it('keeps each env name separate', () => {
    const a = condaEnvPythonCandidates('trellis2', { env: { CONDA_ROOT: CONDA } });
    const b = condaEnvPythonCandidates('pixal3d', { env: { CONDA_ROOT: CONDA } });
    // Two lanes with diverged dependency sets must never resolve to one interpreter.
    expect(a.filter((p) => b.includes(p))).toEqual([]);
  });

  it('resolves the first existing candidate, or null when none exist', () => {
    const target = condaEnvPythonCandidates('pixal3d', { env: { CONDA_ROOT: CONDA } })[0];
    expect(resolveCondaEnvPython('pixal3d', {
      exists: (p) => p === target, env: { CONDA_ROOT: CONDA },
    })).toBe(target);
    expect(resolveCondaEnvPython('pixal3d', {
      exists: () => false, env: { CONDA_ROOT: CONDA },
    })).toBeNull();
  });
});
