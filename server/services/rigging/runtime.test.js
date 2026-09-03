import { describe, expect, it } from 'vitest';
import { posixPath } from '../../lib/testHelper.js';
import {
  BLENDER_MODULE_PROBE_SOURCE,
  RIGGING_INSTALL_COMMAND,
  RIGGING_MODULE_REQUIREMENT,
  RIGGING_RUNTIME,
  isRiggingPlatformSupported,
  probeBlenderModule,
  resolveRiggingPython,
} from './runtime.js';

// A conda root that exists only in this test's `exists` predicate — no real install is
// consulted, so the resolver's behavior is the same on any developer's machine and CI.
// The interpreter path is DERIVED rather than written as a forward-slash literal: the
// resolver composes it with `join()`, which emits backslashes on Windows (the same trap
// `condaEnv.test.js` documents).
const ENV = { CONDA_ROOT: '/opt/conda' };
const FAKE_PYTHON = resolveRiggingPython({ exists: () => true, env: ENV });

describe('rigging runtime — install descriptor', () => {
  it('pins the Blender module to an exact version in the install command', () => {
    expect(RIGGING_MODULE_REQUIREMENT).toBe(`${RIGGING_RUNTIME.module}==${RIGGING_RUNTIME.moduleVersion}`);
    expect(RIGGING_INSTALL_COMMAND).toContain(`"${RIGGING_MODULE_REQUIREMENT}"`);
    expect(RIGGING_INSTALL_COMMAND).toContain(`python=${RIGGING_RUNTIME.pythonVersion}`);
    expect(RIGGING_INSTALL_COMMAND).toContain(`-n ${RIGGING_RUNTIME.condaEnv}`);
  });
});

describe('isRiggingPlatformSupported', () => {
  it('supports Linux and Apple Silicon macOS', () => {
    expect(isRiggingPlatformSupported({ platform: 'linux' })).toBe(true);
    expect(isRiggingPlatformSupported({ platform: 'darwin', arch: 'arm64' })).toBe(true);
    // An x64 darwin process may still be arm64 hardware under Rosetta.
    expect(isRiggingPlatformSupported({ platform: 'darwin', arch: 'x64', probe: () => true })).toBe(true);
  });

  it('rejects Intel macOS and every non-POSIX host by name', () => {
    expect(isRiggingPlatformSupported({ platform: 'darwin', arch: 'x64', probe: () => false })).toBe(false);
    expect(isRiggingPlatformSupported({ platform: 'win32', arch: 'x64' })).toBe(false);
    expect(isRiggingPlatformSupported({ platform: 'freebsd', arch: 'x64' })).toBe(false);
  });
});

describe('resolveRiggingPython', () => {
  it('resolves the named env from an injected filesystem', () => {
    expect(resolveRiggingPython({ exists: (p) => p === FAKE_PYTHON, env: ENV })).toBe(FAKE_PYTHON);
  });

  it('returns null when the env has not been created', () => {
    expect(resolveRiggingPython({ exists: () => false, env: ENV })).toBeNull();
  });

  it('uses its own env name, not another heavy lane’s', () => {
    const seen = [];
    resolveRiggingPython({ exists: (p) => { seen.push(p); return false; }, env: ENV });
    expect(seen.every((p) => posixPath(p).includes(`/envs/${RIGGING_RUNTIME.condaEnv}/`))).toBe(true);
  });
});

// Every case drives the classifier through an injected `execFile` — no interpreter is
// spawned, so the half-provisioned case is covered on a host with no Blender at all.
const execFileReturning = (err, stdout) => (_file, _args, _opts, cb) => cb(err, stdout);

describe('probeBlenderModule', () => {
  it('reports the module version when the import succeeds', async () => {
    const result = await probeBlenderModule({
      python: FAKE_PYTHON,
      execFileImpl: execFileReturning(null, '{"ok": true, "version": "4.2.0"}\n'),
    });
    expect(result).toEqual({ status: 'ok', version: '4.2.0' });
  });

  it('stays ok, with a null version, when the module reports none', async () => {
    const result = await probeBlenderModule({
      python: FAKE_PYTHON,
      execFileImpl: execFileReturning(null, '{"ok": true, "version": null}'),
    });
    expect(result).toEqual({ status: 'ok', version: null });
  });

  // The half-provisioned env: the interpreter runs, the module does not import. The
  // probe one-liner catches that itself and still exits 0, which is what keeps it
  // distinct from "we could not run the interpreter".
  it('names an import failure rather than reporting the runtime absent', async () => {
    const result = await probeBlenderModule({
      python: FAKE_PYTHON,
      execFileImpl: execFileReturning(null, '{"ok": false, "error": "ImportError: bad magic number"}'),
    });
    expect(result).toEqual({ status: 'unimportable', error: 'ImportError: bad magic number' });
  });

  it('truncates a runaway error message', async () => {
    const result = await probeBlenderModule({
      python: FAKE_PYTHON,
      execFileImpl: execFileReturning(null, JSON.stringify({ ok: false, error: 'x'.repeat(5000) })),
    });
    expect(result.error).toHaveLength(300);
  });

  it('reports probe-failed — never "absent" — when the interpreter cannot be run', async () => {
    const spawnFailed = await probeBlenderModule({
      python: FAKE_PYTHON,
      execFileImpl: execFileReturning(new Error('ENOENT'), ''),
    });
    expect(spawnFailed).toEqual({ status: 'probe-failed', error: null });
  });

  it('reports probe-failed on unparseable or non-object output', async () => {
    for (const stdout of ['', 'not json', '[1,2]', 'null']) {
      const result = await probeBlenderModule({ python: FAKE_PYTHON, execFileImpl: execFileReturning(null, stdout) });
      expect(result, `stdout ${JSON.stringify(stdout)}`).toEqual({ status: 'probe-failed', error: null });
    }
  });

  it('reports probe-failed with no interpreter, without spawning anything', async () => {
    let spawned = false;
    const result = await probeBlenderModule({
      python: null,
      execFileImpl: () => { spawned = true; },
    });
    expect(result).toEqual({ status: 'probe-failed', error: null });
    expect(spawned).toBe(false);
  });

  it('does a real import, not a spec lookup, so a half-built env cannot read as ready', () => {
    expect(BLENDER_MODULE_PROBE_SOURCE).toContain(`import ${RIGGING_RUNTIME.module}`);
    expect(BLENDER_MODULE_PROBE_SOURCE).not.toContain('find_spec');
    // It must swallow the failure itself; a raised ImportError would exit non-zero and
    // become indistinguishable from a broken interpreter.
    expect(BLENDER_MODULE_PROBE_SOURCE).toContain('except BaseException');
  });
});
