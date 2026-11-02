import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/usage.js', () => ({
  getUsageSummary: vi.fn(),
  getUsage: vi.fn(),
  getFirstActivityDay: vi.fn(() => '2026-01-01'),
  recordSession: vi.fn(),
  recordMessages: vi.fn(),
  recordTokens: vi.fn(),
  resetUsage: vi.fn()
}));

vi.mock('../services/peerUsage.js', () => ({
  getFleetUsage: vi.fn(),
  getFleetRollingCost: vi.fn(async () => ({ windowDays: 30, instanceCount: 1, points: [] }))
}));

vi.mock('../services/usageFleetBilling.js', () => ({
  getApiBilledInstanceIds: vi.fn(async () => []),
  setInstanceUsesSubscriptions: vi.fn(async () => []),
}));

vi.mock('../services/subscriptionCosts.js', () => ({
  saveSubscriptionCosts: vi.fn(async (costs) => costs),
  getSubscriptionSavings: vi.fn(async () => ({ configured: false, families: [] }))
}));

vi.mock('../services/subscriptions.js', () => ({
  getSubscriptionOverview: vi.fn(async () => ({ families: [{ family: 'claude' }] })),
  savePlanTiers: vi.fn(async (tiers) => tiers),
  setSubscriptionEnabled: vi.fn(async (family, enabled) => ({ family, enabled, applied: true, changed: [] })),
}));

vi.mock('../services/providers.js', () => ({
  // getAllProviders returns the wrapped { activeProvider, providers } shape —
  // the route must unwrap `.providers` before passing to getUsageSummary.
  getAllProviders: vi.fn().mockResolvedValue({ activeProvider: null, providers: [] })
}));

vi.mock('../services/providerUsage.js', () => ({
  getProviderQuotas: vi.fn()
}));

vi.mock('../services/claudeCodeUsage.js', () => ({
  getClaudeCodeUsage: vi.fn()
}));

vi.mock('../services/usageBackfill.js', () => ({
  getHistoricalUsageBackfillStatus: vi.fn(),
  startHistoricalUsageBackfill: vi.fn()
}));

import * as usage from '../services/usage.js';
import { getAllProviders } from '../services/providers.js';
import { getProviderQuotas } from '../services/providerUsage.js';
import { getHistoricalUsageBackfillStatus, startHistoricalUsageBackfill } from '../services/usageBackfill.js';
import { getSubscriptionSavings, saveSubscriptionCosts } from '../services/subscriptionCosts.js';
import { getSubscriptionOverview, savePlanTiers, setSubscriptionEnabled } from '../services/subscriptions.js';
import { getFleetUsage, getFleetRollingCost } from '../services/peerUsage.js';
import { getApiBilledInstanceIds, setInstanceUsesSubscriptions } from '../services/usageFleetBilling.js';
import usageRoutes from './usage.js';

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/usage', usageRoutes);
  app.use(errorMiddleware);
  return app;
};

const fleetResult = (overrides = {}) => ({
  instances: [], totals: null,
  report: { providers: [], totals: { sessions: 0, messages: 0, tokensIn: 0, tokensOut: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCost: 12 } },
  subscriptionReport: { providers: [], totals: { estimatedCost: 12 } },
  firstActivityDay: '2026-01-01', subscriptionFirstActivityDay: '2026-01-01', activity: [], last7Days: [], hourlyActivity: null, totalToolCalls: null,
  coverage: { instanceCount: 1, missingInstances: [], notSyncingInstances: [], incompleteMonths: [] },
  monthly: { instanceCount: 1, series: [], history: [] },
  imageRenders: { renderGroups: 2, codexSessions: 2, jobIdentityGroups: 0, savedOutputs: 3, imageCostUsd: null },
  ...overrides,
});

describe('usage routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getFleetUsage.mockResolvedValue(fleetResult());
  });

  it('GET /api/usage includes local image activity in the selected range without changing the text cost report', async () => {
    usage.getUsageSummary.mockReturnValue({ report: { totals: { estimatedCost: 12 } } });
    const response = await request(buildApp()).get('/api/usage?from=2026-07-01&to=2026-07-31');
    expect(response.status).toBe(200);
    expect(getFleetUsage).toHaveBeenCalledWith(expect.objectContaining({ from: '2026-07-01', to: '2026-07-31' }));
    expect(response.body.imageRenders).toEqual({ renderGroups: 2, codexSessions: 2, jobIdentityGroups: 0, savedOutputs: 3, imageCostUsd: null });
    expect(response.body.report.totals.estimatedCost).toBe(12);
  });

  it('keeps text reporting available when image coverage is incomplete', async () => {
    usage.getUsageSummary.mockReturnValue({ report: { totals: { estimatedCost: 12 } } });
    getFleetUsage.mockResolvedValueOnce(fleetResult({ imageRenders: { incomplete: true, savedOutputs: 0 } }));
    const response = await request(buildApp()).get('/api/usage');
    expect(response.status).toBe(200);
    expect(response.body.report.totals.estimatedCost).toBe(12);
    expect(response.body.imageRenders).toEqual({ incomplete: true, savedOutputs: 0 });
  });

  it('keeps fleet-wide gaps separate from subscription-only completeness', async () => {
    usage.getUsageSummary.mockReturnValue({ freeTier: { blocks: [] } });
    getFleetUsage.mockResolvedValueOnce(fleetResult({ coverage: { instanceCount: 1, missingInstances: ['API peer'],
      notSyncingInstances: [], incompleteMonths: [], subscriptionIncomplete: false } }));
    const res = await request(buildApp()).get('/api/usage');
    expect(res.body.coverage.missingInstances).toEqual(['API peer']);
    expect(res.body.freeTier.blocksIncomplete).toBe(true);
    expect(res.body.subscriptionSavings.costIncomplete).toBe(false);
  });

  it('returns the fleet report and compares subscription-covered usage without double pricing plans', async () => {
    const all = { providers: [{ id: 'claude', free: false, models: [], tokensIn: 10, tokensOut: 20 }],
      totals: { sessions: 9, messages: 4, tokensIn: 10, tokensOut: 20, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCost: 90 } };
    const covered = { providers: [{ id: 'claude', family: 'claude', estimatedCost: 70 }], totals: { estimatedCost: 70 } };
    getFleetUsage.mockResolvedValueOnce(fleetResult({ report: all, subscriptionReport: covered,
      coverage: { instanceCount: 2, missingInstances: ['Offline'], notSyncingInstances: [], incompleteMonths: [] } }));
    usage.getUsageSummary.mockReturnValue({ report: { providers: [], totals: { estimatedCost: 10 } }, freeTier: { providers: [], blocks: [] } });
    const res = await request(buildApp()).get('/api/usage?from=2026-02-01&to=2026-02-07');
    expect(res.status).toBe(200);
    expect(res.body.report).toEqual(all);
    expect(res.body.coverage.missingInstances).toEqual(['Offline']);
    expect(res.body.imageRenders.savedOutputs).toBe(3);
    expect(getSubscriptionSavings).toHaveBeenCalledWith(expect.objectContaining({ report: covered, from: '2026-02-01', to: '2026-02-07' }));
  });

  it('GET /api/usage/hourly projects only counters and bypasses all reporting work', async () => {
    const hourlyActivity = Array.from({ length: 24 }, (_, hour) => hour);
    // Synthetic extra records must never escape in the hourly payload. Reporting
    // services are stubbed: this measures route calls, not report cost or latency.
    usage.getUsage.mockReturnValue({
      hourlyActivity,
      dailyActivity: Object.fromEntries(Array.from({ length: 400 }, (_, day) => [day, { tokens: 1000 }])),
      monthlyActivity: { '2025-01': { tokens: 2000 } },
      byProvider: { example: { tokens: 3000 } }
    });
    usage.getUsageSummary.mockReturnValue({ report: { totals: { estimatedCost: 12 } } });
    getFleetUsage.mockResolvedValueOnce(fleetResult({ instances: [{ id: 'peer-a' }, { id: 'peer-b' }], totals: {} }));
    const collaborators = [usage.getUsageSummary, getAllProviders, getSubscriptionSavings,
      getApiBilledInstanceIds, getFleetUsage];
    const app = buildApp();
    // Before: each dashboard refresh enters all five reporting/config/peer collaborators.
    for (let refresh = 0; refresh < 3; refresh++) {
      expect((await request(app).get('/api/usage')).status).toBe(200);
    }
    expect(collaborators.map((fn) => fn.mock.calls.length)).toEqual([3, 3, 3, 3, 3]);
    vi.clearAllMocks();
    // After: the same reads only serialize the 24 counters, regardless of history/peers.
    for (let refresh = 0; refresh < 3; refresh++) {
      const res = await request(app).get('/api/usage/hourly');
      expect(res.status).toBe(200);
      expect(res.body).toEqual({ hourlyActivity });
    }
    expect(usage.getUsage).toHaveBeenCalledTimes(3);
    expect(collaborators.map((fn) => fn.mock.calls.length)).toEqual([0, 0, 0, 0, 0]);
    expect(usage.getFirstActivityDay).not.toHaveBeenCalled();
    expect(getProviderQuotas).not.toHaveBeenCalled();
  });

  it.each([{}, { hourlyActivity: Array(24).fill(0) }])(
    'GET /api/usage/hourly returns 24 zero counters for empty usage %j', async (emptyUsage) => {
    usage.getUsage.mockReturnValue(emptyUsage);
    const res = await request(buildApp()).get('/api/usage/hourly');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hourlyActivity: Array(24).fill(0) });
  });

  it('GET /api/usage/rolling-cost passes the chart range through and refuses an unknown one', async () => {
    const app = buildApp();
    expect((await request(app).get('/api/usage/rolling-cost?range=1y')).status).toBe(200);
    expect(getFleetRollingCost).toHaveBeenCalledWith({ providers: [], range: '1y' });
    expect((await request(app).get('/api/usage/rolling-cost?range=5y')).status).toBe(400);
  });

  it('GET /api/usage returns the usage summary with the default 7d range', async () => {
    usage.getUsageSummary.mockReturnValue({ totalSessions: 4, providers: ['anthropic'] });
    const res = await request(buildApp()).get('/api/usage');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      totalSessions: 0,
      providers: ['anthropic'],
      subscriptionSavings: { configured: false, families: [] },
      fleet: { instances: [], totals: null },
      imageRenders: { renderGroups: 2, codexSessions: 2, jobIdentityGroups: 0, savedOutputs: 3, imageCostUsd: null },
      monthlyHistory: [],
      monthlySeries: [],
      monthlyInstanceCount: 1,
    });
    const arg = usage.getUsageSummary.mock.calls[0][0];
    expect(arg.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(arg.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(arg.providers).toEqual([]);
    // The fleet breakdown must be priced over the SAME window as the summary,
    // or a peer row would silently report a different period than its heading.
    expect(getFleetUsage).toHaveBeenCalledWith({ from: arg.from, to: arg.to, providers: [], apiBilledInstanceIds: [] });
  });

  it('GET /api/usage returns fleet monthly history for the selected report window', async () => {
    const monthly = {
      instanceCount: 2,
      series: [{ key: 'codex', label: 'Codex' }],
      history: [{ month: '2026-09', estimatedCost: 12, values: [12], tokens: 1000, partial: false }],
    };
    getFleetUsage.mockResolvedValueOnce(fleetResult({ monthly }));
    usage.getUsageSummary.mockReturnValue({ totalSessions: 4 });
    const res = await request(buildApp()).get('/api/usage?from=2026-10-01&to=2026-10-02');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ monthlyHistory: monthly.history, monthlySeries: monthly.series, monthlyInstanceCount: 2 });
    expect(getFleetUsage).toHaveBeenCalledWith(expect.objectContaining({ from: '2026-10-01', to: '2026-10-02' }));
  });

  it('GET /api/usage passes an explicit from/to range through', async () => {
    usage.getUsageSummary.mockReturnValue({});
    getAllProviders.mockResolvedValue({ activeProvider: 'ollama', providers: [{ id: 'ollama' }] });
    const res = await request(buildApp()).get('/api/usage?from=2026-01-01&to=2026-02-01');
    expect(res.status).toBe(200);
    expect(usage.getUsageSummary).toHaveBeenCalledWith({
      from: '2026-01-01',
      to: '2026-02-01',
      providers: [{ id: 'ollama' }]
    });
  });

  it('GET /api/usage resolves period=all to an unbounded range', async () => {
    usage.getUsageSummary.mockReturnValue({});
    const res = await request(buildApp()).get('/api/usage?period=all');
    expect(res.status).toBe(200);
    expect(usage.getUsageSummary.mock.calls[0][0]).toMatchObject({ from: null, to: null });
  });

  it('GET /api/usage rejects a malformed date', async () => {
    const res = await request(buildApp()).get('/api/usage?from=01-01-2026');
    expect(res.status).toBe(400);
    expect(usage.getUsageSummary).not.toHaveBeenCalled();
  });

  it('GET /api/usage rejects an impossible calendar date', async () => {
    const res = await request(buildApp()).get('/api/usage?from=2026-02-30');
    expect(res.status).toBe(400);
    expect(usage.getUsageSummary).not.toHaveBeenCalled();
  });

  it('GET /api/usage rejects from after to', async () => {
    const res = await request(buildApp()).get('/api/usage?from=2026-03-01&to=2026-01-01');
    expect(res.status).toBe(400);
  });

  it('GET /api/usage rejects an unknown period', async () => {
    const res = await request(buildApp()).get('/api/usage?period=14d');
    expect(res.status).toBe(400);
  });

  it('GET /api/usage prorates the savings block over the same window as the report', async () => {
    usage.getUsageSummary.mockReturnValue({ report: { totals: { estimatedCost: 12 } } });
    getAllProviders.mockResolvedValue({ activeProvider: null, providers: [{ id: 'claude-code' }] });
    const res = await request(buildApp()).get('/api/usage?from=2026-02-01&to=2026-02-07');
    expect(res.status).toBe(200);
    expect(getSubscriptionSavings).toHaveBeenCalledWith({
      report: { providers: [], totals: { estimatedCost: 12 } },
      providers: [{ id: 'claude-code' }],
      from: '2026-02-01',
      to: '2026-02-07',
      firstActivityDay: null
    });
  });

  it('uses the earliest subscription-covered activity to price all-time plans', async () => {
    usage.getUsageSummary.mockReturnValue({});
    await request(buildApp()).get('/api/usage?period=7d');
    expect(getSubscriptionSavings).toHaveBeenLastCalledWith(expect.objectContaining({ firstActivityDay: null }));

    getFleetUsage.mockResolvedValueOnce(fleetResult({ subscriptionFirstActivityDay: '2026-03-01' }));
    await request(buildApp()).get('/api/usage?period=all');
    expect(getSubscriptionSavings).toHaveBeenLastCalledWith(expect.objectContaining({ firstActivityDay: '2026-03-01' }));
  });

  it('PUT /api/usage/subscriptions saves a price patch, including a null clear', async () => {
    const res = await request(buildApp())
      .put('/api/usage/subscriptions')
      .send({ costs: { claude: 200, codex: null } });
    expect(res.status).toBe(200);
    // The second argument marks the save as a human edit for the operator-action
    // ledger (#5594) — without it the row would read as actor 'system'.
    expect(saveSubscriptionCosts).toHaveBeenCalledWith({ claude: 200, codex: null }, { actor: 'user' });
  });

  it('PUT /api/usage/subscriptions rejects a non-numeric price', async () => {
    const res = await request(buildApp())
      .put('/api/usage/subscriptions')
      .send({ costs: { claude: '200' } });
    expect(res.status).toBe(400);
    expect(saveSubscriptionCosts).not.toHaveBeenCalled();
  });

  // A key that isn't a real family would persist forever with no editor row to
  // clear it, so it is rejected at the edge rather than normalized away later.
  it('PUT /api/usage/subscriptions rejects an unknown family key', async () => {
    const res = await request(buildApp())
      .put('/api/usage/subscriptions')
      .send({ costs: { 'not-a-family': 10 } });
    expect(res.status).toBe(400);
    expect(saveSubscriptionCosts).not.toHaveBeenCalled();
  });

  it('PUT /api/usage/subscriptions rejects an over-cap price', async () => {
    const res = await request(buildApp())
      .put('/api/usage/subscriptions')
      .send({ costs: { claude: 100001 } });
    expect(res.status).toBe(400);
  });

  it('PUT /api/usage/subscriptions saves a tier patch without disturbing the stored prices', async () => {
    const res = await request(buildApp())
      .put('/api/usage/subscriptions')
      .send({ tiers: { claude: 'Max 20x' } });
    expect(res.status).toBe(200);
    expect(savePlanTiers).toHaveBeenCalledWith({ claude: 'Max 20x' }, { actor: 'user' });
    // A tier save must never rewrite the price map beside it.
    expect(saveSubscriptionCosts).not.toHaveBeenCalled();
    // The refreshed rows come back with the write, so the editor needs no
    // follow-up GET to apply what it just saved.
    expect(res.body.families).toEqual([{ family: 'claude' }]);
  });

  it('PUT /api/usage/subscriptions saves both slices in one call', async () => {
    const res = await request(buildApp())
      .put('/api/usage/subscriptions')
      .send({ costs: { claude: 200 }, tiers: { claude: null } });
    expect(res.status).toBe(200);
    expect(saveSubscriptionCosts).toHaveBeenCalledWith({ claude: 200 }, { actor: 'user' });
    expect(savePlanTiers).toHaveBeenCalledWith({ claude: null }, { actor: 'user' });
  });

  it('PUT /api/usage/subscriptions rejects an over-long plan tier', async () => {
    const res = await request(buildApp())
      .put('/api/usage/subscriptions')
      .send({ tiers: { claude: 'x'.repeat(61) } });
    expect(res.status).toBe(400);
    expect(savePlanTiers).not.toHaveBeenCalled();
  });

  it('PUT /api/usage/subscriptions rejects an unknown family key in the tier map', async () => {
    const res = await request(buildApp())
      .put('/api/usage/subscriptions')
      .send({ tiers: { 'not-a-family': 'Pro' } });
    expect(res.status).toBe(400);
    expect(savePlanTiers).not.toHaveBeenCalled();
  });

  it('GET /api/usage/subscriptions returns the plan rows', async () => {
    const res = await request(buildApp()).get('/api/usage/subscriptions');
    expect(res.status).toBe(200);
    expect(res.body.families).toEqual([{ family: 'claude' }]);
  });

  it('PUT /api/usage/subscriptions/enabled toggles one subscription', async () => {
    setSubscriptionEnabled.mockResolvedValue({ family: 'codex', enabled: false, applied: true, changed: ['codex-cli'] });
    const res = await request(buildApp())
      .put('/api/usage/subscriptions/enabled')
      .send({ family: 'codex', enabled: false });
    expect(res.status).toBe(200);
    expect(setSubscriptionEnabled).toHaveBeenCalledWith('codex', false);
    expect(res.body).toEqual({
      family: 'codex', enabled: false, applied: true, changed: ['codex-cli'],
      families: [{ family: 'claude' }],
    });
  });

  // The handler fans the flag across every provider record the family owns, so
  // an unrecognized id must be refused at the edge rather than silently no-op.
  it('PUT /api/usage/subscriptions/enabled rejects an unknown family', async () => {
    const res = await request(buildApp())
      .put('/api/usage/subscriptions/enabled')
      .send({ family: 'not-a-family', enabled: true });
    expect(res.status).toBe(400);
    expect(setSubscriptionEnabled).not.toHaveBeenCalled();
  });

  it('PUT /api/usage/fleet-billing marks an instance as API-billed', async () => {
    setInstanceUsesSubscriptions.mockResolvedValue(['inst-peer']);
    const res = await request(buildApp())
      .put('/api/usage/fleet-billing')
      .send({ instanceId: 'inst-peer', usesSubscriptions: false });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      instanceId: 'inst-peer',
      usesSubscriptions: false,
      apiBilledInstanceIds: ['inst-peer'],
    });
    expect(setInstanceUsesSubscriptions).toHaveBeenCalledWith('inst-peer', false, { actor: 'user' });
  });

  it('PUT /api/usage/fleet-billing rejects a blank instance id', async () => {
    const res = await request(buildApp())
      .put('/api/usage/fleet-billing')
      .send({ instanceId: '', usesSubscriptions: false });
    expect(res.status).toBe(400);
    expect(setInstanceUsesSubscriptions).not.toHaveBeenCalled();
  });

  it('GET /api/usage prices the fleet with the stored API-billed set', async () => {
    usage.getUsageSummary.mockReturnValue({});
    getApiBilledInstanceIds.mockResolvedValueOnce(['inst-peer']);
    await request(buildApp()).get('/api/usage');
    expect(getFleetUsage).toHaveBeenCalledWith(expect.objectContaining({
      apiBilledInstanceIds: ['inst-peer'],
    }));
  });

  it('GET /api/usage/providers returns quota entries and honors refresh', async () => {
    getProviderQuotas.mockResolvedValue([
      { family: 'claude', supported: true, limits: [] },
      { family: 'grok', supported: false, limits: [] }
    ]);
    const res = await request(buildApp()).get('/api/usage/providers?refresh=1');
    expect(res.status).toBe(200);
    expect(res.body.providers).toHaveLength(2);
    expect(getProviderQuotas).toHaveBeenCalledWith({ wait: 'fresh', family: null });
  });

  it('GET /api/usage/providers narrows the read to one family', async () => {
    getProviderQuotas.mockResolvedValue([{ family: 'grok', supported: true, limits: [] }]);
    const res = await request(buildApp()).get('/api/usage/providers?refresh=1&family=grok');
    expect(res.status).toBe(200);
    expect(res.body.providers).toEqual([{ family: 'grok', supported: true, limits: [] }]);
    expect(getProviderQuotas).toHaveBeenCalledWith({ wait: 'fresh', family: 'grok' });
  });

  it('GET /api/usage/providers forwards the period query parameter', async () => {
    getProviderQuotas.mockResolvedValue([{ family: 'imagegen', supported: true, limits: [], metrics: [] }]);
    const res = await request(buildApp()).get('/api/usage/providers?period=week');
    expect(res.status).toBe(200);
    expect(getProviderQuotas).toHaveBeenCalledWith({ wait: 'never', family: null, period: 'week' });
  });

  it('GET /api/usage/providers supports saved peer-only reads and rejects a forced peer scrape', async () => {
    getProviderQuotas.mockResolvedValue({ providers: [], federationUnavailable: false });
    expect((await request(buildApp()).get('/api/usage/providers?scope=peers')).status).toBe(200);
    expect(getProviderQuotas).toHaveBeenCalledWith({ wait: 'never', family: null, scope: 'peers' });
    getProviderQuotas.mockClear();
    expect((await request(buildApp()).get('/api/usage/providers?scope=peers&refresh=1')).status).toBe(400);
    expect(getProviderQuotas).not.toHaveBeenCalled();
  });

  it('GET /api/usage/providers rejects an invalid period parameter', async () => {
    const res = await request(buildApp()).get('/api/usage/providers?period=invalid');
    expect(res.status).toBe(400);
    expect(getProviderQuotas).not.toHaveBeenCalled();
  });

  it('GET /api/usage/providers rejects a malformed family id', async () => {
    const res = await request(buildApp()).get('/api/usage/providers?family=../etc');
    expect(res.status).toBe(400);
    expect(getProviderQuotas).not.toHaveBeenCalled();
  });

  it('POST /api/usage/messages rejects negative or non-integer token counts', async () => {
    const res = await request(buildApp())
      .post('/api/usage/messages')
      .send({ providerId: 'p1', model: 'm', messageCount: 1, tokenCount: -5 });
    expect(res.status).toBe(400);
    expect(usage.recordMessages).not.toHaveBeenCalled();
  });

  it('GET /api/usage/raw returns the raw usage data', async () => {
    usage.getUsage.mockReturnValue({ sessions: [{ providerId: 'p1' }] });
    const res = await request(buildApp()).get('/api/usage/raw');
    expect(res.status).toBe(200);
    expect(res.body.sessions[0].providerId).toBe('p1');
  });

  it('starts historical reconciliation only from the explicit POST and reports progress', async () => {
    getHistoricalUsageBackfillStatus.mockReturnValue({ status: 'running', processed: 2, total: 5 });
    startHistoricalUsageBackfill.mockReturnValue({ status: 'running', processed: 0, total: 0 });

    const status = await request(buildApp()).get('/api/usage/backfill');
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ status: 'running', processed: 2, total: 5 });
    expect(startHistoricalUsageBackfill).not.toHaveBeenCalled();

    const started = await request(buildApp()).post('/api/usage/backfill');
    expect(started.status).toBe(202);
    expect(startHistoricalUsageBackfill).toHaveBeenCalledTimes(1);
  });

  it('POST /api/usage/backfill returns the Grok and Antigravity repair summaries on the job', async () => {
    const grok = { added: 2, turns: 1, images: 1, videos: 0, backedUp: true, note: null };
    const agy = { added: 3, images: 3, backedUp: true, note: null };
    startHistoricalUsageBackfill.mockResolvedValue({ status: 'complete', corrected: 1, grok, agy });
    const started = await request(buildApp()).post('/api/usage/backfill');
    expect(started.status).toBe(202);
    expect(started.body.grok).toEqual(grok);
    expect(started.body.agy).toEqual(agy);
  });

  it('POST /api/usage/session records a session and returns its number', async () => {
    usage.recordSession.mockResolvedValue(42);
    const res = await request(buildApp())
      .post('/api/usage/session')
      .send({ providerId: 'anthropic', providerName: 'Anthropic', model: 'opus' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sessionNumber: 42 });
    expect(usage.recordSession).toHaveBeenCalledWith('anthropic', 'Anthropic', 'opus');
  });

  it('POST /api/usage/messages records messages and returns success', async () => {
    usage.recordMessages.mockResolvedValue();
    const res = await request(buildApp())
      .post('/api/usage/messages')
      .send({ providerId: 'p1', model: 'm', messageCount: 3, tokenCount: 1000 });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(usage.recordMessages).toHaveBeenCalledWith('p1', 'm', 3, 1000, 0);
  });

  it('POST /api/usage/messages passes an input token count through', async () => {
    usage.recordMessages.mockResolvedValue();
    await request(buildApp())
      .post('/api/usage/messages')
      .send({ providerId: 'p1', model: 'm', messageCount: 1, tokenCount: 100, inputTokenCount: 400 });
    expect(usage.recordMessages).toHaveBeenCalledWith('p1', 'm', 1, 100, 400);
  });

  it('POST /api/usage/tokens defaults missing token counts to 0', async () => {
    usage.recordTokens.mockResolvedValue();
    const res = await request(buildApp()).post('/api/usage/tokens').send({});
    expect(res.status).toBe(200);
    expect(usage.recordTokens).toHaveBeenCalledWith(0, 0);
  });

  it('POST /api/usage/tokens passes through provided counts', async () => {
    usage.recordTokens.mockResolvedValue();
    await request(buildApp()).post('/api/usage/tokens').send({ inputTokens: 500, outputTokens: 200 });
    expect(usage.recordTokens).toHaveBeenCalledWith(500, 200);
  });

  it.each(['5', -1, 1.5, {}, []])('POST /api/usage/tokens rejects %j', async (bad) => {
    usage.recordTokens.mockClear();
    const res = await request(buildApp()).post('/api/usage/tokens').send({ inputTokens: bad });
    expect(res.status).toBe(400);
    expect(usage.recordTokens).not.toHaveBeenCalled();
  });

  it.each([
    { providerId: 5 },
    { providerId: 'p1', providerName: {} },
    { providerId: 'p1', model: [] }
  ])('POST /api/usage/session rejects %j', async (body) => {
    usage.recordSession.mockClear();
    const res = await request(buildApp()).post('/api/usage/session').send(body);
    expect(res.status).toBe(400);
    expect(usage.recordSession).not.toHaveBeenCalled();
  });

  it('DELETE /api/usage resets usage data', async () => {
    usage.resetUsage.mockResolvedValue();
    const res = await request(buildApp()).delete('/api/usage');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(usage.resetUsage).toHaveBeenCalled();
  });
});
