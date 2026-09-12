import { beforeEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(() => true),
  getVoiceConfig: vi.fn(),
  expandPath: vi.fn((value) => value),
  voiceHome: vi.fn(() => '/voice'),
  readyState: vi.fn(() => 'loaded'),
  which: vi.fn(),
  resolveLlmEndpoint: vi.fn(async () => ({ apiBase: 'http://llm.test/v1', apiKey: '' })),
  authHeaders: vi.fn(() => ({})),
  fetchWithTimeout: vi.fn(async () => ({ ok: true, status: 200 })),
  checkSetup: vi.fn(async () => ({})),
}));

vi.mock('fs', () => ({ existsSync: mocks.existsSync }));
vi.mock('./config.js', () => ({
  getVoiceConfig: mocks.getVoiceConfig,
  expandPath: mocks.expandPath,
  voiceHome: mocks.voiceHome,
  PIPER_BIN_NAME: 'piper.exe',
}));
vi.mock('./bootstrap.js', () => ({ which: mocks.which }));
vi.mock('./llm.js', () => ({ resolveLlmEndpoint: mocks.resolveLlmEndpoint, authHeaders: mocks.authHeaders }));
vi.mock('../../lib/fetchWithTimeout.js', () => ({ fetchWithTimeout: mocks.fetchWithTimeout }));
vi.mock('./facetimeBridge.js', () => ({ checkSetup: mocks.checkSetup }));

const { checkAll, invalidateHealthCache } = await import('./health.js');

describe('voice health Piper probe', () => {
  beforeEach(() => {
    invalidateHealthCache();
    vi.clearAllMocks();
    mocks.existsSync.mockReturnValue(true);
  });

  it('uses the platform-specific Piper binary name for local detection', async () => {
    await checkAll({
      stt: { engine: 'web-speech', endpoint: '' },
      llm: { provider: 'lmstudio' },
      tts: { engine: 'piper', piper: { voicePath: '/voice/en.onnx' } },
    });

    expect(mocks.existsSync).toHaveBeenCalledWith(join('/voice', 'piper', 'piper.exe'));
  });
});
