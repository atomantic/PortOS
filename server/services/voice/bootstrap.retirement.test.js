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
vi.mock('../providers.js', () => ({ getProviderById: vi.fn() }));
vi.mock('../../lib/childProcess.js', () => ({ execFile: vi.fn() }));
vi.mock('../settings.js', () => ({ getSettings: vi.fn(), updateSettings: vi.fn() }));

import { existsSync } from 'fs';
import { whichFirst } from '../../lib/processEnv.js';
import { execPm2 } from '../pm2.js';
import { execFile } from '../../lib/childProcess.js';
import { getProviderById } from '../providers.js';
import { VOICE_DEFAULTS } from './config.js';
import { reconcile } from './bootstrap.js';

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
