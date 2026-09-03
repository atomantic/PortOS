import { describe, expect, it, beforeEach, vi } from 'vitest';
import {
  RIGGING_INSTALL_COMMAND,
  RIGGING_MODULE_REQUIREMENT,
  RIGGING_RUNTIME,
  resolveRiggingPython,
} from './runtime.js';
import {
  __resetRiggingReadinessCache,
  describeRiggingReadiness,
  getRiggingReadiness,
  probeRiggingReadiness,
  riggingUnavailableReason,
} from './readiness.js';

// Derived, not a forward-slash literal — `join()` emits backslashes on Windows.
const ENV = { CONDA_ROOT: '/opt/conda' };
const FAKE_PYTHON = resolveRiggingPython({ exists: () => true, env: ENV });
const READY_HOST = { supportedPlatform: true, platform: 'linux', python: FAKE_PYTHON, probe: { status: 'ok', version: '4.2.0' } };

describe('riggingUnavailableReason', () => {
  it('is null only when the module actually imported', () => {
    expect(riggingUnavailableReason(READY_HOST)).toBeNull();
  });

  it('reports an unsupported host before anything else, even with a runtime present', () => {
    expect(riggingUnavailableReason({ ...READY_HOST, supportedPlatform: false })).toBe('unsupported-platform');
  });

  it('separates "no env" from "env present, module broken"', () => {
    expect(riggingUnavailableReason({ supportedPlatform: true, python: null })).toBe('runtime-not-installed');
    expect(riggingUnavailableReason({ ...READY_HOST, probe: { status: 'unimportable', error: 'ImportError' } }))
      .toBe('module-unimportable');
  });

  it('never reads a failed probe as an absent runtime', () => {
    expect(riggingUnavailableReason({ ...READY_HOST, probe: { status: 'probe-failed' } })).toBe('runtime-probe-failed');
    expect(riggingUnavailableReason({ ...READY_HOST, probe: null })).toBe('runtime-probe-failed');
  });

  it('defaults to a named blocker rather than ready when handed nothing', () => {
    expect(riggingUnavailableReason()).toBe('unsupported-platform');
  });
});

describe('describeRiggingReadiness', () => {
  it('reports the interpreter and module version when ready, with no remedy to offer', () => {
    expect(describeRiggingReadiness(READY_HOST)).toMatchObject({
      ready: true,
      reason: null,
      interpreter: FAKE_PYTHON,
      module: RIGGING_RUNTIME.module,
      moduleVersion: '4.2.0',
      modulePin: RIGGING_MODULE_REQUIREMENT,
      installCommand: null,
    });
  });

  it('names the half-provisioned env, keeps the version blank, and offers the repair', () => {
    const result = describeRiggingReadiness({
      ...READY_HOST,
      probe: { status: 'unimportable', error: 'ImportError: bad magic number' },
    });
    expect(result.ready).toBe(false);
    expect(result.reason).toBe('module-unimportable');
    // The interpreter IS there — reporting the version as anything but unknown would
    // be the silent-ready failure this lane exists to prevent.
    expect(result.moduleVersion).toBeNull();
    expect(result.interpreter).toBe(FAKE_PYTHON);
    expect(result.detail).toContain('bad magic number');
    expect(result.installCommand).toBe(RIGGING_INSTALL_COMMAND);
  });

  it('says why an unsupported host is unsupported, and offers no command that cannot work', () => {
    const result = describeRiggingReadiness({
      supportedPlatform: false, platform: 'win32', python: null, probe: null,
    });
    expect(result).toMatchObject({ ready: false, reason: 'unsupported-platform', installCommand: null });
    expect(result.detail).toContain('win32');
    expect(result.detail).toMatch(/Apple Silicon/);
  });

  it('points an uninstalled host at the pinned install command', () => {
    const result = describeRiggingReadiness({
      supportedPlatform: true, platform: 'linux', python: null, probe: null,
    });
    expect(result).toMatchObject({ reason: 'runtime-not-installed', interpreter: null, moduleVersion: null });
    expect(result.installCommand).toBe(RIGGING_INSTALL_COMMAND);
  });

  it('says the state is unknown — not absent — when the probe could not run', () => {
    const result = describeRiggingReadiness({ ...READY_HOST, probe: { status: 'probe-failed' } });
    expect(result.reason).toBe('runtime-probe-failed');
    expect(result.detail).toContain('unknown');
  });
});

describe('probeRiggingReadiness', () => {
  it('short-circuits an unsupported host without touching the filesystem', async () => {
    let looked = false;
    const result = await probeRiggingReadiness({
      platform: 'win32',
      arch: 'x64',
      exists: () => { looked = true; return true; },
    });
    expect(result.reason).toBe('unsupported-platform');
    expect(looked).toBe(false);
  });

  it('resolves and probes a provisioned env end to end', async () => {
    const result = await probeRiggingReadiness({
      platform: 'linux',
      env: ENV,
      exists: (p) => p === FAKE_PYTHON,
      execFileImpl: (_file, _args, _opts, cb) => cb(null, '{"ok": true, "version": "4.2.0"}'),
    });
    expect(result).toMatchObject({ ready: true, interpreter: FAKE_PYTHON, moduleVersion: '4.2.0' });
  });

  it('does not spawn a probe when there is no interpreter to probe', async () => {
    let spawned = false;
    const result = await probeRiggingReadiness({
      platform: 'linux',
      env: ENV,
      exists: () => false,
      execFileImpl: () => { spawned = true; },
    });
    expect(result.reason).toBe('runtime-not-installed');
    expect(spawned).toBe(false);
  });
});

describe('getRiggingReadiness caching', () => {
  beforeEach(() => {
    __resetRiggingReadinessCache();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  // A real `import bpy` costs seconds, so the call count below is the contract that
  // keeps it off the per-page-load feature-detection path.
  const countingProbe = () => vi.fn(async () => ({ ready: false, reason: 'runtime-not-installed' }));

  it('reuses the answer inside the TTL and re-probes after it, so navigation never waits on a repeated Blender import', async () => {
    const probe = countingProbe();
    const first = await getRiggingReadiness({ now: () => 1_000, probe });
    const cachedHit = await getRiggingReadiness({ now: () => 2_000, probe });
    expect(cachedHit).toBe(first);
    expect(probe).toHaveBeenCalledTimes(1);

    const afterTtl = await getRiggingReadiness({ now: () => 121_000, probe });
    expect(afterTtl).not.toBe(first);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('bypasses the cache on an explicit refresh', async () => {
    const probe = countingProbe();
    const first = await getRiggingReadiness({ now: () => 1_000, probe });
    const refreshed = await getRiggingReadiness({ refresh: true, now: () => 1_500, probe });
    expect(refreshed).not.toBe(first);
    expect(probe).toHaveBeenCalledTimes(2);
  });
});
