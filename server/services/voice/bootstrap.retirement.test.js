import { expect, it, vi } from 'vitest';

vi.mock('fs', () => ({ existsSync: vi.fn(() => false) }));
vi.mock('../../lib/processEnv.js', () => ({ whichFirst: vi.fn(async () => null) }));
vi.mock('../pm2.js', () => ({ execPm2: vi.fn(async () => ({})), getAppStatus: vi.fn(async () => null) }));
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
vi.mock('../providers.js', () => ({ getProviderById: vi.fn() }));
vi.mock('../../lib/childProcess.js', () => ({ execFile: vi.fn() }));
vi.mock('../settings.js', () => ({ getSettings: vi.fn(), updateSettings: vi.fn() }));

import { existsSync } from 'fs';
const { whichFirst } = await import('../../lib/processEnv.js');
const { execPm2 } = await import('../pm2.js');
const { execFile } = await import('../../lib/childProcess.js');
const { getProviderById } = await import('../providers.js');
const { VOICE_DEFAULTS } = await import('./config.js');
const { getVoiceProvisioner } = await import('./modelProvisioners.js');
const { reconcile, ensureToolCapableModel, preloadModel } = await import('./bootstrap.js');

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
