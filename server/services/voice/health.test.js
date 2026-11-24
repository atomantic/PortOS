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
  isInstanceFeatureEnabled: vi.fn(async () => false),
  inspectVoiceAsset: vi.fn(() => ({ state: 'verified', reason: '' })),
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
vi.mock('./facetimeBridge.js', () => ({
  checkSetup: mocks.checkSetup,
  blockingSetupFailure: (report) => Object.entries(report)
    .find(([key, value]) => key !== 'accessibility' && value.ok !== 'ok')?.[0] || null,
}));
vi.mock('../instanceFeatures.js', () => ({ isInstanceFeatureEnabled: mocks.isInstanceFeatureEnabled }));
vi.mock('../../lib/voiceModelAssets.js', () => ({
  inspectVoiceAsset: mocks.inspectVoiceAsset,
  isVoiceAssetUsable: (state) => state === 'verified' || state === 'unverified',
}));

const { checkAll, invalidateHealthCache } = await import('./health.js');

describe('voice health Piper probe', () => {
  beforeEach(() => {
    invalidateHealthCache();
    vi.clearAllMocks();
    mocks.existsSync.mockReturnValue(true);
    mocks.inspectVoiceAsset.mockReturnValue({ state: 'verified', reason: '' });
  });

  const piperCfg = () => ({
    stt: { engine: 'web-speech', endpoint: '' },
    llm: { provider: 'lmstudio' },
    tts: { engine: 'piper', piper: { voicePath: '/voice/en.onnx' } },
  });

  it('does not report Piper ready for a voice whose download is incomplete', async () => {
    mocks.inspectVoiceAsset.mockReturnValue({ state: 'incomplete', reason: 'sidecar config missing' });
    const result = await checkAll(piperCfg());
    expect(mocks.inspectVoiceAsset).toHaveBeenCalledWith('piper', '/voice/en.onnx');
    expect(result.piper).toEqual({ ok: false, state: 'voice incomplete' });
  });

  it('uses the platform-specific Piper binary name for local detection', async () => {
    const result = await checkAll({
      stt: { engine: 'web-speech', endpoint: '' },
      llm: { provider: 'lmstudio' },
      tts: { engine: 'piper', piper: { voicePath: '/voice/en.onnx' } },
    });

    expect(mocks.existsSync).toHaveBeenCalledWith(join('/voice', 'piper', 'piper.exe'));
    expect(result.piper).toEqual({ ok: true, state: 'ready' });
  });
});

describe('voice health FaceTime probe', () => {
  const cfg = () => ({
    stt: { engine: 'web-speech', endpoint: '' },
    llm: { provider: 'lmstudio' },
    tts: { engine: 'piper', piper: { voicePath: '/voice/en.onnx' } },
  });
  beforeEach(() => {
    invalidateHealthCache();
    vi.clearAllMocks();
    mocks.isInstanceFeatureEnabled.mockResolvedValue(false);
    mocks.checkSetup.mockResolvedValue({ helper: { ok: 'ok' }, accessibility: { ok: false } });
  });

  it('omits facetime from services when the feature is disabled', async () => {
    const result = await checkAll(cfg());
    expect(result).not.toHaveProperty('facetime');
    expect(mocks.checkSetup).not.toHaveBeenCalled();
  });

  it('summarizes a passing setup into the standard probe shape', async () => {
    mocks.isInstanceFeatureEnabled.mockResolvedValue(true);
    expect((await checkAll(cfg())).facetime).toEqual({ ok: true, state: 'ready' });
  });

  it('reports the blocking failure as a not-ok probe', async () => {
    mocks.isInstanceFeatureEnabled.mockResolvedValue(true);
    mocks.checkSetup.mockResolvedValue({ helper: { ok: 'ok' }, identity: { ok: 'missing' } });
    expect((await checkAll(cfg())).facetime).toEqual({ ok: false, state: 'identity' });
  });
});
