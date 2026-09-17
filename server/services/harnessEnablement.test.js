/**
 * Per-harness enablement (#7564): the precedence between the user's explicit
 * setting and PATH detection, `direct` always on, and the boot reconcile that
 * prunes entries nothing reads — idempotent, so a second pass writes nothing.
 *
 * Settings and the runtime probe cache are doubled; nothing here reads disk or
 * spawns a probe.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const settingsState = vi.hoisted(() => ({ current: {} }));
const settingsMock = vi.hoisted(() => {
  // A minimal emitter: `vi.hoisted` runs before any import, so node's EventEmitter is not in scope yet.
  const listeners = new Map();
  const settingsEvents = {
    on: (event, fn) => listeners.set(event, [...(listeners.get(event) || []), fn]),
    emit: (event, ...args) => (listeners.get(event) || []).forEach((fn) => fn(...args)),
  };
  return {
    settingsEvents,
    getSettings: vi.fn(async () => structuredClone(settingsState.current)),
    updateSettingsWith: vi.fn(async (mutate) => {
      settingsState.current = await mutate(structuredClone(settingsState.current));
      settingsEvents.emit('settings:updated', settingsState.current);
      return settingsState.current;
    }),
  };
});
vi.mock('./settings.js', () => settingsMock);

const runtimeStatuses = vi.hoisted(() => ({ current: {} }));
vi.mock('./providerRuntimeInstaller.js', async (importOriginal) => ({
  ...(await importOriginal()),
  peekProviderRuntimeStatuses: () => runtimeStatuses.current,
}));

const enablement = await import('./harnessEnablement.js');

beforeEach(() => {
  settingsState.current = {};
  runtimeStatuses.current = {};
  settingsMock.updateSettingsWith.mockClear();
});

describe('harnessEnablementFrom', () => {
  it('reads the explicit setting first, then PATH detection, and enables an un-probed harness', () => {
    const runtimes = { pi: { installed: false, version: null }, claude: { installed: true, version: '2.0.0' } };
    expect(enablement.harnessEnablementFrom('pi', { settings: { harnesses: { pi: { enabled: true } } }, runtimes }))
      .toEqual({ enabled: true, source: 'setting', detected: false, version: null });
    expect(enablement.harnessEnablementFrom('claude', { settings: { harnesses: { claude: { enabled: false } } }, runtimes }))
      .toEqual({ enabled: false, source: 'setting', detected: true, version: '2.0.0' });
    expect(enablement.harnessEnablementFrom('pi', { settings: {}, runtimes })).toMatchObject({ enabled: false, source: 'detected' });
    expect(enablement.harnessEnablementFrom('claude', { settings: {}, runtimes })).toMatchObject({ enabled: true, source: 'detected' });
    // Not probed yet: route exactly as before the probe existed.
    expect(enablement.harnessEnablementFrom('codex', { settings: {}, runtimes })).toMatchObject({ enabled: true, source: 'default', detected: null });
  });

  it('keeps direct always enabled, and answers null for an unknown harness', () => {
    expect(enablement.harnessEnablementFrom('direct', { settings: { harnesses: { direct: { enabled: false } } }, runtimes: {} }))
      .toMatchObject({ enabled: true, source: 'always', detected: true });
    expect(enablement.harnessEnablementFrom('nope', { settings: {}, runtimes: {} })).toBeNull();
  });

  it('resolves the runtime by the harness id even when the binary is spelled differently', () => {
    // Antigravity's binary is `agy`; the runtime row is keyed by that binary.
    expect(enablement.harnessDetection('antigravity', { agy: { installed: true, version: '1.2.3' } }))
      .toEqual({ detected: true, version: '1.2.3' });
  });
});

describe('listHarnessEnablement / setHarnessEnabled', () => {
  it('lists every registry harness with its verdict and records an explicit flip', async () => {
    runtimeStatuses.current = { pi: { installed: true, version: '0.9.0' } };
    const before = await enablement.listHarnessEnablement();
    expect(before.map((row) => row.id)).toContain('direct');
    expect(before.find((row) => row.id === 'pi')).toMatchObject({ enabled: true, source: 'detected', version: '0.9.0', modes: ['cli', 'tui'] });

    await expect(enablement.setHarnessEnabled('pi', false)).resolves.toMatchObject({ enabled: false, source: 'setting' });
    expect(settingsState.current.harnesses).toEqual({ pi: { enabled: false } });
    expect((await enablement.listHarnessEnablement()).find((row) => row.id === 'pi')).toMatchObject({ enabled: false, source: 'setting' });
  });

  it('refuses to set direct or an unknown harness', async () => {
    await expect(enablement.setHarnessEnabled('direct', false)).rejects.toMatchObject({ status: 400, code: 'HARNESS_UNKNOWN' });
    await expect(enablement.setHarnessEnabled('gui-thing', true)).rejects.toMatchObject({ code: 'HARNESS_UNKNOWN' });
    expect(settingsMock.updateSettingsWith).not.toHaveBeenCalled();
  });
});

describe('reconcileHarnessEnablement', () => {
  it('drops entries nothing reads, keeps the rest, and is a no-op on the second pass', async () => {
    settingsState.current = { harnesses: { pi: { enabled: false, stray: 1 }, direct: { enabled: false }, bogus: { enabled: true }, codex: { enabled: 'yes' } } };
    await expect(enablement.reconcileHarnessEnablement()).resolves.toEqual({ changed: true, harnesses: { pi: { enabled: false } } });
    expect(settingsState.current.harnesses).toEqual({ pi: { enabled: false } });
    settingsMock.updateSettingsWith.mockClear();
    await expect(enablement.reconcileHarnessEnablement()).resolves.toEqual({ changed: false, harnesses: { pi: { enabled: false } } });
    expect(settingsMock.updateSettingsWith).not.toHaveBeenCalled();
  });

  it('writes nothing on an install that never set the slice, and removes an all-invalid slice', async () => {
    await expect(enablement.reconcileHarnessEnablement()).resolves.toEqual({ changed: false, harnesses: {} });
    expect(settingsMock.updateSettingsWith).not.toHaveBeenCalled();
    settingsState.current = { harnesses: { bogus: { enabled: true } }, other: 1 };
    await enablement.reconcileHarnessEnablement();
    expect(settingsState.current).toEqual({ other: 1 });
  });

  it('bumps the settings revision every time settings move, for the composite cache key', async () => {
    const before = enablement.harnessSettingsRevision();
    settingsMock.settingsEvents.emit('settings:updated', {});
    expect(enablement.harnessSettingsRevision()).toBe(before + 1);
  });
});
