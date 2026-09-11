import { expect, it, vi } from 'vitest';

vi.mock('fs', () => ({ existsSync: vi.fn(() => false) }));
vi.mock('../../lib/processEnv.js', () => ({ whichFirst: vi.fn(async () => null) }));
vi.mock('../pm2.js', () => ({ execPm2: vi.fn(), getAppStatus: vi.fn() }));
vi.mock('./llm.js', () => ({ isToolCapable: vi.fn(), isReasoningModel: vi.fn() }));
vi.mock('../providers.js', () => ({ getProviderById: vi.fn() }));
vi.mock('../../lib/childProcess.js', () => ({ execFile: vi.fn() }));
vi.mock('../settings.js', () => ({ getSettings: vi.fn(), updateSettings: vi.fn() }));

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
