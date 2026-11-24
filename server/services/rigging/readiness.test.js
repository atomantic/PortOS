import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { RIGGING_UNAVAILABLE_REASONS, RIGGING_REASON_FALLBACK, riggingReasonLabel } from '../../lib/riggingReasons.js';
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

// A code is identified by its kebab shape: every OTHER single-quoted literal in the reducer is a dash-free
// probe-status token ('ok', 'unimportable'). Comments are stripped so a code named in prose can't count.
const KEBAB_CODE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/;

function reasonCodesInSource() {
  const src = readFileSync(fileURLToPath(new URL('./readiness.js', import.meta.url)), 'utf8');
  const start = src.indexOf('export function riggingUnavailableReason(');
  expect(start, 'riggingUnavailableReason() not found in readiness.js').toBeGreaterThan(-1);
  // Bounded by the function's own column-0 closing brace so a later declaration can't widen the window.
  const end = src.indexOf('\n}\n', start);
  expect(end, 'no column-0 closing brace found — cannot bound the reducer body').toBeGreaterThan(start);
  const body = src.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  return [...body.matchAll(/'([a-z][a-z0-9-]*)'/g)].map((m) => m[1]).filter((s) => KEBAB_CODE.test(s));
}

describe('rigging reason labels', () => {
  // Without this, a new code with no label renders as the generic fallback under a fully green suite.
  it('labels exactly the codes riggingUnavailableReason() can return, all kebab-case', () => {
    for (const code of Object.keys(RIGGING_UNAVAILABLE_REASONS)) {
      expect(code, `${code} must be kebab-case for the source guard to see it`).toMatch(KEBAB_CODE);
    }
    const codes = reasonCodesInSource();
    expect(codes.length).toBeGreaterThan(0);
    expect([...new Set(codes)].sort()).toEqual(Object.keys(RIGGING_UNAVAILABLE_REASONS).sort());
  });

  it('falls back for an unknown or absent code rather than rendering the raw code', () => {
    expect(riggingReasonLabel(null)).toBe(RIGGING_REASON_FALLBACK);
    expect(riggingReasonLabel('brand-new-code')).toBe(RIGGING_REASON_FALLBACK);
    expect(riggingReasonLabel('__proto__')).toBe(RIGGING_REASON_FALLBACK);
    expect(riggingReasonLabel('brand-new-code', 'custom')).toBe('custom');
    expect(riggingReasonLabel('unsupported-platform', 'custom')).toBe(RIGGING_UNAVAILABLE_REASONS['unsupported-platform']);
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

  it('shares a cold probe and starts the TTL when it resolves', async () => {
    const result = { ready: true, reason: null };
    const { promise, resolve } = Promise.withResolvers();
    const probe = vi.fn(() => promise);
    let time = 1_000;
    const options = { probe, now: () => time };
    const first = getRiggingReadiness(options);
    expect(getRiggingReadiness(options)).toBe(first);
    await Promise.resolve();
    expect(probe).toHaveBeenCalledTimes(1);

    time = 70_000;
    resolve(result);
    await expect(first).resolves.toBe(result);
    expect(await getRiggingReadiness(options)).toBe(result);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('probes again after a transient failure, even after a previously cached result', async () => {
    const failure = { ready: false, reason: 'runtime-probe-failed' };
    const probe = countingProbe().mockResolvedValueOnce({ ready: true, reason: null })
      .mockResolvedValueOnce(failure);
    const options = { probe, now: () => 1_000 };
    await getRiggingReadiness(options);
    await expect(getRiggingReadiness({ ...options, refresh: true })).resolves.toBe(failure);
    await expect(getRiggingReadiness(options)).resolves.toMatchObject({ reason: 'runtime-not-installed' });
    expect(probe).toHaveBeenCalledTimes(3);
  });

  it('lets a refresh supersede a slow probe without letting that probe overwrite the cache', async () => {
    const older = Promise.withResolvers();
    const ready = { ready: true, reason: null };
    const probe = vi.fn().mockReturnValueOnce(older.promise).mockResolvedValueOnce(ready);
    const first = getRiggingReadiness({ probe });
    const refresh = getRiggingReadiness({ probe, refresh: true });
    expect(getRiggingReadiness({ probe })).toBe(refresh);
    await expect(refresh).resolves.toBe(ready);
    older.resolve({ ready: false, reason: 'runtime-not-installed' });
    await first;
    expect(await getRiggingReadiness({ probe })).toBe(ready);
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
