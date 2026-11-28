import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('fs', () => ({ existsSync: vi.fn(() => false) }));
// These boot-flow tests model "the file is there" through the fs mock; asset
// completion has its own coverage in voiceModelAssets.test.js.
vi.mock('../../lib/voiceModelAssets.js', async (importOriginal) => {
  const { existsSync: exists } = await import('fs');
  return {
    ...(await importOriginal()),
    inspectVoiceAsset: (_kind, path) => (exists(path) ? { state: 'verified', reason: '' } : { state: 'missing', reason: '' }),
  };
});
vi.mock('../../lib/processEnv.js', () => ({ whichFirst: vi.fn(async () => null) }));
vi.mock('../pm2.js', () => ({
  clearJlistCache: vi.fn(),
  execPm2: vi.fn(async () => ({})),
  getAppStatusStrict: vi.fn(async () => ({ status: 'not_found' })),
}));
vi.mock('../../lib/fetchWithTimeout.js', () => ({ fetchWithTimeout: vi.fn(async () => ({})) }));
vi.mock('net', () => ({ createServer: () => {
  const handlers = {};
  const server = {
    once: (event, callback) => { handlers[event] = callback; },
    listen: () => { handlers.listening(); },
    close: (callback) => { callback?.(); },
  };
  return server;
} }));
vi.mock('./llm.js', () => ({ isToolCapable: vi.fn(), isReasoningModel: vi.fn() }));
vi.mock('./modelProvisioners.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, getVoiceProvisioner: vi.fn() };
});
vi.mock('../provider/providers.js', () => ({ getProviderById: vi.fn() }));
vi.mock('../../lib/childProcess.js', () => ({ execFile: vi.fn() }));
vi.mock('./realtimeRuntime.js', () => ({ stopRealtimeSidecar: vi.fn(async () => {}) }));
vi.mock('../settings.js', () => ({ getSettings: vi.fn(), updateSettings: vi.fn() }));

import { existsSync } from 'fs';
const { whichFirst } = await import('../../lib/processEnv.js');
const { clearJlistCache, execPm2, getAppStatusStrict } = await import('../pm2.js');
const { execFile } = await import('../../lib/childProcess.js');
const { fetchWithTimeout } = await import('../../lib/fetchWithTimeout.js');
const { getProviderById } = await import('../provider/providers.js');
const { VOICE_DEFAULTS } = await import('./config.js');
const { stopRealtimeSidecar } = await import('./realtimeRuntime.js');
const { getVoiceProvisioner } = await import('./modelProvisioners.js');
const { reconcile, startWhisper, stopWhisper, ensureToolCapableModel, preloadModel } = await import('./bootstrap.js');

// A provisioner double: every primitive is a spy so a test can assert that an
// unreachable backend short-circuits BEFORE any install is attempted.
const fakeBackend = (overrides = {}) => ({
  id: 'ollama', label: 'Ollama', remedy: 'start Ollama',
  listModels: vi.fn(async () => []),
  isToolCapable: vi.fn(async () => false),
  chain: vi.fn(() => ['small:1b', 'bigger:3b']),
  install: vi.fn(async () => ({ ok: true, reason: '' })),
  loadedModels: vi.fn(async () => new Set()),
  load: vi.fn(async () => ({ ok: true, reason: '' })),
  ...overrides,
});

const toolsOn = (cfg = {}) => ({
  ...VOICE_DEFAULTS, enabled: true, ...cfg,
  llm: { ...VOICE_DEFAULTS.llm, model: 'auto', tools: { enabled: true }, ...(cfg.llm || {}) },
});

it('does not download or preload anything when an upgraded install boots before Piper setup', async () => {
  const cfg = { ...VOICE_DEFAULTS, enabled: true, tts: { ...VOICE_DEFAULTS.tts, retiredEngine: 'kokoro' } };
  await expect(reconcile(cfg, { allowSetup: false })).resolves.toEqual({ setupRequired: 'piper' });
  expect(execFile).not.toHaveBeenCalled();
  expect(getProviderById).not.toHaveBeenCalled();
});

it('stops the realtime sidecar when voice or realtime voice is disabled during reconcile', async () => {
  vi.clearAllMocks();
  existsSync.mockReturnValue(true);
  await reconcile({ ...VOICE_DEFAULTS, enabled: false, realtime: { ...VOICE_DEFAULTS.realtime, enabled: true } });
  expect(stopRealtimeSidecar).toHaveBeenCalledWith('disabled');

  vi.clearAllMocks();
  existsSync.mockReturnValue(true);
  await reconcile({ ...VOICE_DEFAULTS, enabled: true, realtime: { ...VOICE_DEFAULTS.realtime, enabled: false } }, { allowSetup: false });
  expect(stopRealtimeSidecar).toHaveBeenCalledWith('disabled');

  vi.clearAllMocks();
  existsSync.mockReturnValue(true);
  await reconcile({ ...VOICE_DEFAULTS, enabled: true, realtime: { ...VOICE_DEFAULTS.realtime, enabled: true } }, { allowSetup: false });
  expect(stopRealtimeSidecar).not.toHaveBeenCalled();
});

it('starts provisioned Whisper while deferring missing Piper setup and LLM preload at upgrade boot', async () => {
  vi.clearAllMocks();
  existsSync.mockImplementation(path => String(path).endsWith('.bin'));
  whichFirst.mockImplementation(async bin => bin === 'whisper-server' ? '/usr/bin/whisper-server' : null);
  const cfg = { ...VOICE_DEFAULTS, enabled: true,
    stt: { ...VOICE_DEFAULTS.stt, engine: 'whisper' },
    tts: { ...VOICE_DEFAULTS.tts, retiredEngine: 'kokoro' } };
  const result = await reconcile(cfg, { allowSetup: false });
  expect(result).toMatchObject({ name: 'portos-whisper', setupRequired: 'piper' });
  expect(execPm2).toHaveBeenCalledWith(expect.arrayContaining(['start', '/usr/bin/whisper-server']));
  expect(execFile).not.toHaveBeenCalled();
  expect(getProviderById).not.toHaveBeenCalled();
});

describe('Voice reconciliation model provisioning', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    existsSync.mockReturnValue(true);
    whichFirst.mockImplementation(async (bin) => `/usr/bin/${bin}`);
  });

  const cfg = toolsOn({ stt: { ...VOICE_DEFAULTS.stt, engine: 'whisper' } });

  it.each([
    { scenario: 'cold model', installed: ['small:1b'] },
    { scenario: 'no models', installed: [] },
  ])(
    'starts installed Whisper at boot without probing the provider ($scenario)',
    async ({ installed }) => {
      const backend = fakeBackend({
        listModels: vi.fn(async () => installed),
        isToolCapable: vi.fn(async () => true),
      });
      getVoiceProvisioner.mockReturnValue(backend);

      await expect(reconcile(cfg, { allowSetup: false })).resolves.toMatchObject({ name: 'portos-whisper' });

      expect(execPm2).toHaveBeenCalledWith(expect.arrayContaining(['start', '/usr/bin/whisper-server']));
      expect(execFile).not.toHaveBeenCalled();
      expect(getVoiceProvisioner).not.toHaveBeenCalled();
    },
  );

  it('installs and preloads a model when Save & Reconcile requests setup', async () => {
    const backend = fakeBackend({
      listModels: vi.fn().mockResolvedValueOnce([]).mockResolvedValue(['small:1b']),
      isToolCapable: vi.fn(async () => true),
    });
    getVoiceProvisioner.mockReturnValue(backend);

    await expect(reconcile(cfg)).resolves.toMatchObject({ name: 'portos-whisper' });

    await vi.waitFor(() => expect(backend.load).toHaveBeenCalledExactlyOnceWith('small:1b'));
    expect(backend.install).toHaveBeenCalledExactlyOnceWith('small:1b');
  });
});

// Voice OFF must never reach `lms get`. `reconcile` already returns early, so
// this pins the guard on ensureToolCapableModel ITSELF — the export is what
// shells out to a multi-GB download, and a future caller that forgets the
// reconcile gate would otherwise arm it on an install that never opted in.
it('does not probe or download a tool-capable model when voice is disabled', async () => {
  vi.clearAllMocks();
  const cfg = { ...VOICE_DEFAULTS, enabled: false, llm: { ...VOICE_DEFAULTS.llm, provider: 'lmstudio', model: 'auto', tools: { enabled: true } } };
  await expect(ensureToolCapableModel(cfg)).resolves.toEqual({ skipped: 'voice-disabled' });
  expect(execFile).not.toHaveBeenCalled();
  expect(getProviderById).not.toHaveBeenCalled();
});

// #7541: an unreachable backend is ONE shared cause. Walking the whole install
// chain against it spawned four futile multi-GB downloads on every boot.
it('stops at one message instead of walking the chain when the backend is unreachable', async () => {
  vi.clearAllMocks();
  const backend = fakeBackend({ listModels: vi.fn(async () => null) });
  getVoiceProvisioner.mockReturnValue(backend);
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

  await expect(ensureToolCapableModel(toolsOn())).resolves.toEqual({ skipped: 'backend-unreachable', backend: 'ollama' });

  expect(backend.install).not.toHaveBeenCalled();
  expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls[0][0]).toContain('not reachable');
  warn.mockRestore();
});

// A chain entry that will not install is the designed fallback to the next entry, not a fault.
it('moves to the next chain entry on stdout when an install does not take', async () => {
  vi.clearAllMocks();
  const backend = fakeBackend({
    listModels: vi.fn(async () => []),
    install: vi.fn(async () => ({ ok: false, reason: 'registry refused' })),
  });
  getVoiceProvisioner.mockReturnValue(backend);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

  const outcome = await ensureToolCapableModel(toolsOn());

  expect(outcome).toHaveProperty('failed');
  expect(log).toHaveBeenCalledWith(expect.stringContaining('unavailable (registry refused) — trying next'));
  expect(warn.mock.calls.some(([line]) => line.includes('trying next'))).toBe(false);
  // Exhausting the whole chain is a real failure and still reaches stderr.
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('exhausted'));
  vi.restoreAllMocks();
});

it('installs from the chain when the backend is reachable with nothing capable', async () => {
  vi.clearAllMocks();
  const backend = fakeBackend({
    listModels: vi.fn().mockResolvedValueOnce([]).mockResolvedValue(['small:1b']),
    isToolCapable: vi.fn(async () => true),
  });
  getVoiceProvisioner.mockReturnValue(backend);
  await expect(ensureToolCapableModel(toolsOn())).resolves.toEqual({ installed: 'small:1b' });
  expect(backend.install).toHaveBeenCalledWith('small:1b');
});

it('aborts the chain when the backend disappears mid-install', async () => {
  vi.clearAllMocks();
  const backend = fakeBackend({
    listModels: vi.fn().mockResolvedValueOnce([]).mockResolvedValue(null),
  });
  getVoiceProvisioner.mockReturnValue(backend);
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  await expect(ensureToolCapableModel(toolsOn())).resolves.toEqual({ skipped: 'backend-unreachable', backend: 'ollama' });
  // One attempt, then stop — not one per remaining chain entry.
  expect(backend.install).toHaveBeenCalledTimes(1);
  vi.restoreAllMocks();
});

// A remote OpenAI-compatible provider serves its own models: nothing to pull,
// nothing to pre-warm, and certainly nothing to provision on a local daemon.
it('provisions nothing for a remote API provider', async () => {
  vi.clearAllMocks();
  getVoiceProvisioner.mockReturnValue(null);
  getProviderById.mockResolvedValue({ id: 'openai', type: 'api', endpoint: 'https://api.openai.com/v1' });
  const cfg = toolsOn({ llm: { provider: 'openai' } });
  await expect(ensureToolCapableModel(cfg)).resolves.toEqual({ skipped: 'remote-provider', provider: 'openai' });
  await expect(preloadModel(cfg)).resolves.toEqual({ skipped: 'remote-provider', provider: 'openai' });
});

it('skips the preload when the chosen model is already resident', async () => {
  vi.clearAllMocks();
  const backend = fakeBackend({
    listModels: vi.fn(async () => ['small:1b']),
    isToolCapable: vi.fn(async () => true),
    loadedModels: vi.fn(async () => new Set(['small:1b'])),
  });
  getVoiceProvisioner.mockReturnValue(backend);
  await expect(preloadModel(toolsOn())).resolves.toEqual({ skipped: 'already-loaded', model: 'small:1b' });
  expect(backend.load).not.toHaveBeenCalled();
});

describe('Whisper shutdown', () => {
  beforeEach(() => vi.clearAllMocks());

  it('rejects a failed status read without issuing a delete', async () => {
    getAppStatusStrict.mockResolvedValueOnce(null);
    await expect(stopWhisper()).rejects.toMatchObject({
      code: 'WHISPER_PM2_UNAVAILABLE',
      message: expect.stringContaining('Check that the PM2 daemon is running and retry'),
    });
    expect(execPm2).not.toHaveBeenCalled();
  });

  it('skips a delete when Whisper is confirmed absent', async () => {
    await expect(stopWhisper()).resolves.toEqual({ skipped: true });
    expect(execPm2).not.toHaveBeenCalled();
  });

  it('deletes a registered Whisper process when disabling Voice', async () => {
    getAppStatusStrict.mockResolvedValueOnce({ status: 'waiting restart' });
    await expect(reconcile({ enabled: false })).resolves.toEqual({ stopped: true });
    expect(execPm2).toHaveBeenCalledExactlyOnceWith(['delete', 'portos-whisper']);
  });

  it.each([{ status: 'online' }, null])('rejects disabling Voice after an unconfirmed delete (%j)', async (after) => {
    getAppStatusStrict.mockResolvedValueOnce({ status: 'online' }).mockResolvedValueOnce(after);
    execPm2.mockRejectedValueOnce(new Error('PM2 delete failed'));
    await expect(reconcile({ enabled: false })).rejects.toMatchObject({
      code: 'WHISPER_STOP_FAILED',
      message: expect.stringContaining('Check PM2 logs for portos-whisper and retry'),
    });
    expect(getAppStatusStrict).toHaveBeenCalledTimes(2);
    expect(clearJlistCache.mock.invocationCallOrder[1]).toBeLessThan(getAppStatusStrict.mock.invocationCallOrder[1]);
  });

  it('accepts confirmed absence after an ambiguous delete', async () => {
    getAppStatusStrict.mockResolvedValueOnce({ status: 'online' });
    execPm2.mockRejectedValueOnce(new Error('PM2 delete timed out'));
    await expect(stopWhisper()).resolves.toEqual({ stopped: true });
    expect(getAppStatusStrict).toHaveBeenCalledTimes(2);
  });

  it('propagates a shutdown error when Web Speech replaces Whisper during reconciliation', async () => {
    getAppStatusStrict.mockResolvedValueOnce(null);
    const cfg = {
      ...VOICE_DEFAULTS, enabled: true,
      stt: { ...VOICE_DEFAULTS.stt, engine: 'web-speech' },
      tts: { ...VOICE_DEFAULTS.tts, engine: 'qwen3-tts' },
    };
    await expect(reconcile(cfg)).rejects.toMatchObject({ code: 'WHISPER_PM2_UNAVAILABLE' });
  });
});

it('finishes Whisper readiness before overlapping stop and reconcile requests mutate PM2', async () => {
  vi.clearAllMocks();
  existsSync.mockImplementation(() => true);
  whichFirst.mockResolvedValue('/usr/bin/whisper-server');
  const cfg = toolsOn({
    stt: { ...VOICE_DEFAULTS.stt, engine: 'whisper' },
    llm: { model: 'explicit' },
    tts: { ...VOICE_DEFAULTS.tts, engine: 'qwen3-tts' },
  });
  getAppStatusStrict.mockResolvedValueOnce({ status: 'online' });
  const probeStarted = Promise.withResolvers();
  const finishProbe = Promise.withResolvers();
  fetchWithTimeout.mockImplementationOnce(() => {
    probeStarted.resolve();
    return finishProbe.promise;
  });

  const start = startWhisper(cfg);
  await probeStarted.promise;
  const stop = stopWhisper();
  const reconciled = reconcile(cfg);
  await new Promise(setImmediate);
  const commandsWhileProbing = execPm2.mock.calls.map(([[command]]) => command);
  finishProbe.resolve({});

  await expect(Promise.all([start, stop, reconciled])).resolves.toMatchObject([
    { name: 'portos-whisper' }, { stopped: true }, { name: 'portos-whisper' },
  ]);
  expect(commandsWhileProbing).toEqual(['delete', 'start']);
  expect(execPm2.mock.calls.map(([[command]]) => command)).toEqual(['delete', 'start', 'delete', 'delete', 'start']);
});

it('coalesces overlapping reconciles to the latest config while the model load is in flight', async () => {
  vi.clearAllMocks();
  const loadStarted = Promise.withResolvers();
  const finishLoad = Promise.withResolvers();
  const resident = new Set();
  const backend = fakeBackend({
    id: 'lmstudio',
    listModels: vi.fn(async () => ['small:1b']),
    isToolCapable: vi.fn(async () => true),
    loadedModels: vi.fn(async () => resident),
    load: vi.fn(async (model) => {
      loadStarted.resolve();
      await finishLoad.promise;
      resident.add(model);
      return { ok: true };
    }),
  });
  getVoiceProvisioner.mockReturnValue(backend);
  const cfg = toolsOn({
    stt: { ...VOICE_DEFAULTS.stt, engine: 'web-speech' },
    tts: { ...VOICE_DEFAULTS.tts, engine: 'qwen3-tts' },
    llm: { provider: 'lmstudio' },
  });

  await reconcile(cfg);
  await loadStarted.promise;
  await Promise.all([reconcile(toolsOn({ ...cfg, llm: { provider: 'ollama' } })), reconcile(cfg)]);
  const providersWhileLoading = getVoiceProvisioner.mock.calls.map(([provider]) => provider);
  finishLoad.resolve();

  await vi.waitFor(() => expect(backend.loadedModels).toHaveBeenCalledTimes(2));
  expect(providersWhileLoading).toEqual(['lmstudio', 'lmstudio']);
  expect(getVoiceProvisioner.mock.calls).toEqual([['lmstudio'], ['lmstudio'], ['lmstudio'], ['lmstudio']]);
  expect(backend.load).toHaveBeenCalledExactlyOnceWith('small:1b');
});
