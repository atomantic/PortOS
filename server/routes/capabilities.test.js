import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// Stub every integration the aggregator reads. Defaults describe a fully
// configured, healthy install; individual tests override a single source.
vi.mock('../services/providers.js', () => ({
  getAllProviders: vi.fn(async () => ({ activeProvider: 'p1', providers: [{ id: 'p1', enabled: true }] })),
  getProviderById: vi.fn(async () => ({ id: 'lmstudio', endpoint: 'http://x/v1', enabled: true })),
}));
vi.mock('../services/providerStatus.js', () => ({
  getAllProviderStatuses: vi.fn(() => ({ providers: {} })),
}));
vi.mock('../services/providerPrerequisites.js', () => ({
  getProviderPrerequisiteReadinessMap: vi.fn(async () => ({
    p1: { status: 'ready', reasonCodes: [] },
  })),
}));
vi.mock('../services/providerReadiness.js', () => ({
  getProviderReadinessMap: vi.fn(async () => ({})),
}));
vi.mock('../services/calendarAccounts.js', () => ({
  listAccounts: vi.fn(async () => [{ enabled: true, lastSyncStatus: 'success' }]),
}));
vi.mock('../services/messageAccounts.js', () => ({
  listAccounts: vi.fn(async () => [{ enabled: true, lastSyncStatus: 'success' }]),
}));
vi.mock('../services/memoryBackend.js', () => ({
  countMemories: vi.fn(async () => 7),
}));
vi.mock('../services/cos.js', () => ({
  getConfig: vi.fn(async () => ({ embeddingProviderId: 'lmstudio' })),
}));
vi.mock('../services/voice/config.js', () => ({
  getVoiceConfig: vi.fn(async () => ({ enabled: true, tts: { engine: 'kokoro' }, stt: { engine: 'whisper' } })),
}));
vi.mock('../lib/networkExposure.js', () => ({
  getNetworkExposureSetupStatus: vi.fn(async () => ({
    httpsEnabled: true,
    bind: { port: 5555 },
    cert: { mode: 'tailscale', tailscaleHost: 'host.example.ts.net', provisioned: true },
    tailscale: { available: true, running: true },
    setup: {
      complete: true,
      trustedUrl: 'https://host.example.ts.net:5555',
      summary: 'Trusted Tailscale HTTPS is active',
      nextStep: null,
      steps: [],
    },
  })),
}));
vi.mock('../services/genome.js', () => ({
  getGenomeSummary: vi.fn(async () => ({ uploaded: true, markerCount: 10, statusCounts: {} })),
}));
vi.mock('../services/settings.js', () => ({
  getSettings: vi.fn(async () => ({ telegram: { method: 'manual', chatId: 'c1' }, secrets: { telegram: { token: 't1' } } })),
}));
vi.mock('../services/telegram.js', () => ({
  getStatus: vi.fn(() => ({ connected: true })),
}));
vi.mock('../services/telegramBridge.js', () => ({
  getStatus: vi.fn(() => ({ connected: false, hasBotToken: false, hasChatId: false })),
}));
vi.mock('../services/apps.js', () => ({
  getAppStatusSummary: vi.fn(async () => ({ total: 2, online: 2, stopped: 0, notStarted: 0, unmanaged: 0 })),
}));

const { countMemories } = await import('../services/memoryBackend.js');
const { getGenomeSummary } = await import('../services/genome.js');
const { getAllProviders } = await import('../services/providers.js');
const { getProviderPrerequisiteReadinessMap } = await import('../services/providerPrerequisites.js');
const { getProviderReadinessMap } = await import('../services/providerReadiness.js');
const { default: capabilitiesRoutes } = await import('./capabilities.js');

const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/capabilities', capabilitiesRoutes);
  app.use(errorMiddleware);
  return app;
};

const byId = (body, id) => body.capabilities.find((c) => c.id === id);

describe('GET /api/capabilities', () => {
  it('returns one row per integration plus a rollup summary', async () => {
    const res = await request(makeApp()).get('/api/capabilities');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.capabilities)).toBe(true);
    expect(res.body.capabilities).toHaveLength(9);
    expect(res.body.summary).toMatchObject({ overall: expect.any(String), total: 9 });
    expect(res.body.optionalSummary).toMatchObject({ overall: expect.any(String), total: 7 });
    expect(res.body.setup).toEqual({ total: 2, ready: 2, remaining: 0, complete: true });
    expect(res.body.network.setup.complete).toBe(true);
    // every row is fully formed + deep-links to settings
    for (const c of res.body.capabilities) {
      expect(c.id).toBeTruthy();
      expect(typeof c.settingsPath).toBe('string');
      expect(c.settingsPath.startsWith('/')).toBe(true);
    }
  });

  it('reads the active memory count from the lightweight count helper', async () => {
    const res = await request(makeApp()).get('/api/capabilities');
    const brain = byId(res.body, 'brain');
    expect(brain.detail.memoryCount).toBe(7);
    expect(brain.summary).toContain('7 memories');
    expect(brain.status).toBe('ok');
    expect(countMemories).toHaveBeenCalledWith({ status: 'active' });
  });

  it('degrades to fail-soft (200) when a single source throws', async () => {
    getGenomeSummary.mockRejectedValueOnce(new Error('disk gone'));
    const res = await request(makeApp()).get('/api/capabilities');
    expect(res.status).toBe(200);
    // the failed source falls back to "not set up" rather than 500-ing the page
    expect(byId(res.body, 'genome').status).toBe('unconfigured');
    // unrelated rows are unaffected
    expect(byId(res.body, 'providers').configured).toBe(true);
  });

  it('handles countMemories rejecting (memory count 0, page still renders)', async () => {
    countMemories.mockRejectedValueOnce(new Error('boom'));
    const res = await request(makeApp()).get('/api/capabilities');
    expect(res.status).toBe(200);
    expect(byId(res.body, 'brain').detail.memoryCount).toBe(0);
  });

  it('keeps provider setup incomplete when strict prerequisite probing fails', async () => {
    getProviderPrerequisiteReadinessMap.mockRejectedValueOnce(new Error('probe unavailable'));
    const res = await request(makeApp()).get('/api/capabilities');

    expect(res.status).toBe(200);
    expect(byId(res.body, 'providers')).toMatchObject({
      status: 'warn',
      setupComplete: false,
      detail: { available: 0, unknown: 1, setupReady: 0 },
    });
    expect(res.body.setup).toMatchObject({ complete: false, remaining: 1 });
  });

  it('keeps local provider setup unknown when daemon readiness probing fails', async () => {
    getProviderReadinessMap.mockRejectedValueOnce(new Error('daemon probe unavailable'));
    const res = await request(makeApp()).get('/api/capabilities');

    expect(res.status).toBe(200);
    // The default fixture is not local-daemon backed, so an unrelated local
    // probe outage must not invalidate its proven CLI/API prerequisites.
    expect(byId(res.body, 'providers')).toMatchObject({ setupComplete: true });
  });

  it('requires an enabled local provider daemon and selected model to be ready', async () => {
    getAllProviders.mockResolvedValueOnce({
      activeProvider: 'local',
      providers: [{
        id: 'local',
        enabled: true,
        type: 'api',
        endpoint: 'http://localhost:11434/v1',
        defaultModel: 'example-model',
      }],
    });
    getProviderPrerequisiteReadinessMap.mockResolvedValueOnce({
      local: { status: 'ready', reasonCodes: [] },
    });
    getProviderReadinessMap.mockResolvedValueOnce({
      local: { ready: false, checks: [{ id: 'model', ok: false }] },
    });

    const res = await request(makeApp()).get('/api/capabilities');
    expect(res.status).toBe(200);
    expect(byId(res.body, 'providers')).toMatchObject({
      status: 'error',
      setupComplete: false,
      detail: { blocked: 1, setupReady: 0 },
    });
  });

  it('does not degrade runnable providers when installed llama.cpp providers are in standby', async () => {
    getAllProviders.mockResolvedValueOnce({
      activeProvider: 'cloud',
      providers: [
        { id: 'cloud', enabled: true, type: 'api', endpoint: 'https://api.example.com/v1', hasApiKey: true },
        { id: 'llama-cli', enabled: true, type: 'cli', command: 'opencode', llamaBacked: true, endpoint: 'http://127.0.0.1:5568/v1' },
        { id: 'llama-tui', enabled: true, type: 'tui', command: 'opencode', llamaBacked: true, endpoint: 'http://127.0.0.1:5568/v1' },
      ],
    });
    getProviderPrerequisiteReadinessMap.mockResolvedValueOnce({
      cloud: { status: 'ready', reasonCodes: [] },
      'llama-cli': { status: 'ready', reasonCodes: [] },
      'llama-tui': { status: 'ready', reasonCodes: [] },
    });
    getProviderReadinessMap.mockResolvedValueOnce({
      'llama-cli': { ready: false, standby: true },
      'llama-tui': { ready: false, standby: true },
    });

    const res = await request(makeApp()).get('/api/capabilities');

    expect(res.status).toBe(200);
    expect(byId(res.body, 'providers')).toMatchObject({
      status: 'ok',
      summary: '3 enabled · 1 ready · 2 standby',
      setupComplete: true,
      detail: { available: 1, blocked: 0, standby: 2, setupReady: 1 },
    });
  });
});
