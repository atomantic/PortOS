import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// Stub every integration the aggregator reads. Defaults describe a fully
// configured, healthy install; individual tests override a single source.
vi.mock('../services/providers.js', () => ({
  getAllProviders: vi.fn(async () => [{ id: 'p1', enabled: true }]),
  getProviderById: vi.fn(async () => ({ id: 'lmstudio', endpoint: 'http://x/v1', enabled: true })),
}));
vi.mock('../services/providerStatus.js', () => ({
  getAllProviderStatuses: vi.fn(() => ({ providers: {} })),
}));
vi.mock('../services/calendarAccounts.js', () => ({
  listAccounts: vi.fn(async () => [{ enabled: true, lastSyncStatus: 'success' }]),
}));
vi.mock('../services/messageAccounts.js', () => ({
  listAccounts: vi.fn(async () => [{ enabled: true, lastSyncStatus: 'success' }]),
}));
vi.mock('../services/memory.js', () => ({
  // The real getMemories returns { total, memories } — NOT an array.
  getMemories: vi.fn(async () => ({ total: 7, memories: [] })),
}));
vi.mock('../services/cos.js', () => ({
  getConfig: vi.fn(async () => ({ embeddingProviderId: 'lmstudio' })),
}));
vi.mock('../services/voice/config.js', () => ({
  getVoiceConfig: vi.fn(async () => ({ enabled: true, tts: { engine: 'kokoro' }, stt: { engine: 'whisper' } })),
}));
vi.mock('../lib/networkExposure.js', () => ({
  getNetworkExposureStatus: vi.fn(() => ({ httpsEnabled: true, cert: { tailscaleHost: 'host.ts.net' } })),
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

const { getMemories } = await import('../services/memory.js');
const { getGenomeSummary } = await import('../services/genome.js');
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
    // every row is fully formed + deep-links to settings
    for (const c of res.body.capabilities) {
      expect(c.id).toBeTruthy();
      expect(typeof c.settingsPath).toBe('string');
      expect(c.settingsPath.startsWith('/')).toBe(true);
    }
  });

  it('reads the memory COUNT from getMemories().total, not the wrapper object', async () => {
    // Regression guard: getMemories returns { total, memories }; an Array.isArray
    // check would report 0 here. The brain row must reflect the real count.
    const res = await request(makeApp()).get('/api/capabilities');
    const brain = byId(res.body, 'brain');
    expect(brain.detail.memoryCount).toBe(7);
    expect(brain.summary).toContain('7 memories');
    expect(brain.status).toBe('ok');
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

  it('handles getMemories rejecting (memory count 0, page still renders)', async () => {
    getMemories.mockRejectedValueOnce(new Error('boom'));
    const res = await request(makeApp()).get('/api/capabilities');
    expect(res.status).toBe(200);
    expect(byId(res.body, 'brain').detail.memoryCount).toBe(0);
  });
});
