import { describe, expect, it, vi } from 'vitest';
import { autoStartLlamaServer, setLlamaServerAutoStart } from './llamaServerAutoStart.js';

const LAUNCH = { model: '~/.portos/models/voice.gguf', alias: 'voice-model', ctxSize: 4096, specType: 'none' };

const harness = ({ llama = {}, status = { installed: true, running: false }, start = vi.fn().mockResolvedValue({ online: true }) } = {}) => {
  let store = { localLlm: { llama } };
  const settings = {
    getSettings: vi.fn(async () => store),
    updateSettingsWith: vi.fn(async (mutate) => { store = await mutate(store); return store; }),
  };
  const manager = {
    getLlamaServerStatus: vi.fn().mockResolvedValue(status),
    startLlamaServer: start,
    persistRunningLlamaLaunch: vi.fn(async () => {
      store = { localLlm: { llama: { ...store.localLlm.llama, launch: LAUNCH } } };
      return true;
    }),
  };
  return { deps: { settings, manager }, manager, read: () => store };
};

describe('llamaServerAutoStart', () => {
  it('replays the saved launch line at boot when Start with PortOS is on and the server is down', async () => {
    const { deps, manager } = harness({ llama: { autoStart: true, launch: LAUNCH } });
    await expect(autoStartLlamaServer(deps)).resolves.toMatchObject({ started: true });
    expect(manager.startLlamaServer).toHaveBeenCalledWith(LAUNCH);
  });

  it.each([
    ['the toggle is off', { llama: { launch: LAUNCH } }, 'disabled'],
    ['nothing was ever started', { llama: { autoStart: true } }, 'no-launch'],
    ['llama.cpp is missing', { llama: { autoStart: true, launch: LAUNCH }, status: { installed: false } }, 'not-installed'],
    ['it is already running', { llama: { autoStart: true, launch: LAUNCH }, status: { installed: true, running: true } }, 'running'],
  ])('does not start when %s', async (_label, setup, reason) => {
    const { deps, manager } = harness(setup);
    await expect(autoStartLlamaServer(deps)).resolves.toEqual({ started: false, reason });
    expect(manager.startLlamaServer).not.toHaveBeenCalled();
  });

  it('keeps boot going when the start fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { deps } = harness({ llama: { autoStart: true, launch: LAUNCH }, start: vi.fn().mockRejectedValue(new Error('port busy')) });
    await expect(autoStartLlamaServer(deps)).resolves.toEqual({ started: false, reason: 'failed' });
  });

  it('saves the toggle and starts the server at once when switched on', async () => {
    const { deps, manager, read } = harness({ llama: { idleMinutes: 10, launch: LAUNCH } });
    await expect(setLlamaServerAutoStart(true, deps)).resolves.toMatchObject({ autoStart: true, started: true });
    expect(read().localLlm.llama).toMatchObject({ autoStart: true, idleMinutes: 10, launch: LAUNCH });
    expect(manager.startLlamaServer).toHaveBeenCalledTimes(1);
  });

  it('saves the running launch line when switched on while PortOS already serves it', async () => {
    const { deps, manager, read } = harness({ llama: {}, status: { installed: true, running: true, managed: true } });
    await expect(setLlamaServerAutoStart(true, deps)).resolves.toMatchObject({ autoStart: true, started: false, reason: 'running' });
    expect(read().localLlm.llama).toMatchObject({ autoStart: true, launch: LAUNCH });
    expect(manager.persistRunningLlamaLaunch).toHaveBeenCalledTimes(1);
    expect(manager.startLlamaServer).not.toHaveBeenCalled();
  });

  it('does not claim a server someone else runs', async () => {
    const { deps, manager } = harness({ llama: { launch: LAUNCH }, status: { installed: true, running: true, managed: false } });
    await setLlamaServerAutoStart(true, deps);
    expect(manager.persistRunningLlamaLaunch).not.toHaveBeenCalled();
  });

  it('leaves a running server alone when switched off', async () => {
    const { deps, manager, read } = harness({ llama: { autoStart: true, launch: LAUNCH }, status: { installed: true, running: true } });
    await expect(setLlamaServerAutoStart(false, deps)).resolves.toEqual({ autoStart: false, started: false, reason: 'disabled' });
    expect(read().localLlm.llama.autoStart).toBe(false);
    expect(manager.startLlamaServer).not.toHaveBeenCalled();
  });

  it('reports a failed toggle-time start to the caller', async () => {
    const { deps, read } = harness({ llama: { launch: LAUNCH }, start: vi.fn().mockRejectedValue(new Error('port busy')) });
    await expect(setLlamaServerAutoStart(true, deps)).rejects.toThrow('port busy');
    expect(read().localLlm.llama.autoStart).toBe(true);
  });
});
