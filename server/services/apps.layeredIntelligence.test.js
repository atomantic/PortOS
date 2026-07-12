import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the file/PM2/port surface apps.js touches so the accessors run against an
// in-memory apps store. Mirrors apps.test.js's mock shape.
let store;
vi.mock('fs/promises', () => ({ writeFile: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../lib/fileUtils.js', () => ({
  tryReadFile: vi.fn().mockResolvedValue(null),
  atomicWrite: vi.fn(async (_path, data) => { store = data; }),
  ensureDir: vi.fn().mockResolvedValue(undefined),
  readJSONFile: vi.fn(async () => store),
  PATHS: { data: '/mock/data', root: '/mock/root', cos: '/mock/data/cos' },
  DAY: 24 * 60 * 60 * 1000
}));
vi.mock('../../lib/tailscale-https.js', () => ({ hasTailscaleCert: () => false }));
vi.mock('../../lib/certPaths.js', () => ({ certPaths: () => ({ dir: '/mock' }) }));
vi.mock('../lib/ports.js', () => ({ PORTS: { API: 5555, API_LOCAL: 5553, UI: 5554, COS: 5556, AUTOFIXER: 5557, AUTOFIXER_UI: 5558, CDP: 5559, CDP_HEALTH: 5560 } }));
vi.mock('./taskSchedule.js', () => ({ SELF_IMPROVEMENT_TASK_TYPES: [] }));
vi.mock('./pm2.js', () => ({ listProcessesStrict: vi.fn().mockResolvedValue([]) }));

import { getAppLayeredIntelligenceConfig, updateAppLayeredIntelligence, createApp, getAppById, invalidateCache, PORTOS_APP_ID } from './apps.js';

beforeEach(() => {
  invalidateCache();
  store = {
    apps: {
      'app-1': { name: 'App One', repoPath: '/repo', type: 'express', createdAt: '2024-01-01T00:00:00.000Z' }
    }
  };
});

describe('getAppLayeredIntelligenceConfig', () => {
  it('returns the default config for an app with no stored config', async () => {
    const c = await getAppLayeredIntelligenceConfig('app-1');
    expect(c.enabled).toBe(false);
    expect(c.allowedScopes).toEqual(['app-improvement', 'app-data-gap']); // non-PortOS
    expect(c.sources.goals).toBe(true);
  });

  it('gives the PortOS app the meta/self scopes even without a stored config', async () => {
    invalidateCache();
    const c = await getAppLayeredIntelligenceConfig(PORTOS_APP_ID);
    expect(c.allowedScopes).toContain('loop-meta');
    expect(c.allowedScopes).toContain('portos-self');
  });

  it('returns null for an unknown app', async () => {
    expect(await getAppLayeredIntelligenceConfig('nope')).toBe(null);
  });
});

describe('updateAppLayeredIntelligence', () => {
  it('merges a partial update over the defaults without wiping sources', async () => {
    await updateAppLayeredIntelligence('app-1', { enabled: true, sources: { goals: false } });
    invalidateCache();
    const c = await getAppLayeredIntelligenceConfig('app-1');
    expect(c.enabled).toBe(true);
    expect(c.sources.goals).toBe(false);
    expect(c.sources.appMetrics).toBe(true); // untouched default preserved
  });

  it('preserves lastRunAt bookkeeping across a config PATCH', async () => {
    // First a run-bookkeeping write, then a user config PATCH.
    await updateAppLayeredIntelligence('app-1', { lastRunAt: '2026-07-07T00:00:00Z' });
    invalidateCache();
    await updateAppLayeredIntelligence('app-1', { enabled: true });
    invalidateCache();
    const c = await getAppLayeredIntelligenceConfig('app-1');
    expect(c.enabled).toBe(true);
    expect(c.lastRunAt).toBe('2026-07-07T00:00:00Z');
  });

  it('returns null for an unknown app', async () => {
    expect(await updateAppLayeredIntelligence('nope', { enabled: true })).toBe(null);
  });
});

describe('createApp persists layeredIntelligence', () => {
  it('stores an explicitly-provided config on create', async () => {
    const created = await createApp({
      name: 'New App', repoPath: '/new', type: 'express',
      layeredIntelligence: { enabled: true, allowedScopes: ['app-improvement'] }
    });
    invalidateCache();
    const fetched = await getAppById(created.id);
    expect(fetched.layeredIntelligence).toEqual({ enabled: true, allowedScopes: ['app-improvement'] });
  });

  it('leaves no layeredIntelligence key when omitted (baseline resolves on read)', async () => {
    const created = await createApp({ name: 'Bare App', repoPath: '/bare', type: 'express' });
    invalidateCache();
    const fetched = await getAppById(created.id);
    expect(fetched.layeredIntelligence).toBeUndefined();
    // …and the accessor still supplies the baseline default.
    const cfg = await getAppLayeredIntelligenceConfig(created.id);
    expect(cfg.enabled).toBe(false);
  });
});
