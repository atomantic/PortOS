import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { bindSettingsFile } from '../lib/settingsTestUtil.js';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { nativeUsageParticipantKey } from '../lib/nativeUsageContract.js';
import { derivePeerAuthToken, PEER_AUTH_HEADER, PEER_INSTANCE_HEADER } from '../lib/peerHttpClient.js';

const { tempRoot, makeProxy, cleanup } = await vi.hoisted(async () => {
  const { mockPathsDataRoot } = await import('../lib/mockPathsDataRoot.js');
  return mockPathsDataRoot({ prefix: 'portos-native-accounts-' });
});
vi.mock('../lib/fileUtils.js', async original => {
  const actual = await original();
  return makeProxy({ ...actual, tryReadFileStrict: vi.fn(actual.tryReadFileStrict) });
});
vi.mock('../services/userActions.js', () => ({ recordUserAction: vi.fn(async () => ({ id: 'test' })) }));
vi.mock('../services/voice/config.js', () => ({ getVoiceConfig: vi.fn(async () => ({})) }));
vi.mock('../lib/securityAuditLog.js', () => ({ logSecurityEvent: vi.fn() }));
let authEnabled = false;
vi.mock('../services/auth.js', () => ({
  isAuthEnabled: async () => authEnabled,
  verifyPassword: async () => false,
  verifyRequestSession: async req => req.headers.authorization === 'Bearer delegated-operator-session',
}));
let registry;
vi.mock('../services/instanceIdentity.js', () => ({ loadData: vi.fn(async () => registry) }));
vi.mock('../services/nativeUsageReport.js', () => ({ captureDashboardNativeUsageReport: vi.fn() }));
vi.mock('../services/nativeUsageMatrix.js', () => ({ getNativeUsageMatrix: vi.fn(async () => ({ mode: 'read-only', scope: 'local-instance', peerReports: 'not-collected', providers: [] })) }));
vi.mock('../services/nativeUsageCoverage.js', () => ({ getNativeUsageCoverage: vi.fn(async () => ({ mode: 'read-only', providers: [] })) }));
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
  startHistoricalUsageBackfill: vi.fn(),
  startCodexUsagePreview: vi.fn(() => ({ status: 'running', mode: 'preview' })),
  cancelCodexUsagePreview: vi.fn(async () => ({ status: 'cancelled' }))
}));

vi.mock('../services/usageCutoverBarrier.js', () => ({
  getUsageCutoverStatus: vi.fn(async () => ({ state: 'idle', holdReasons: [] })),
  acquireUsageCutover: vi.fn(async () => ({ state: 'fenced' })),
  verifyUsageCutover: vi.fn(async () => ({ state: 'fenced', holdReasons: [] })),
  activateUsageCutover: vi.fn(async () => ({ state: 'activated' })),
  rollbackUsageCutover: vi.fn(async () => ({ state: 'rolling-back' })),
  releaseUsageCutover: vi.fn(async () => ({ state: 'idle' })),
}));


import { tryReadFileStrict } from '../lib/fileUtils.js';
import { authGate, hostControlRouteGate } from '../services/authGate.js';
import { __resetSettingsCache, flushSettingsLedger, updateSettings, updateSettingsWith } from '../services/settings.js';
import { loadData } from '../services/instanceIdentity.js';
import { captureDashboardNativeUsageReport } from '../services/nativeUsageReport.js';
import { getNativeUsageMatrix } from '../services/nativeUsageMatrix.js';
import { getFleetUsage } from '../services/peerUsage.js';
import * as usage from '../services/usage.js';
import usageRoutes from './usage.js';

const LOCAL = nativeUsageParticipantKey('private-local-instance');
const PEER = nativeUsageParticipantKey('private-peer-instance');
const UNKNOWN = nativeUsageParticipantKey('private-missing-instance');
const { writeSettingsFile } = bindSettingsFile(tempRoot);
const stored = () => JSON.parse(readFileSync(join(tempRoot, 'settings.json'), 'utf8'));
const selection = (family, members = [LOCAL]) => ({ family, accountLabel: 'shared', members,
  ...(family === 'codex' ? { authoritativeParticipant: members[0] } : { historyScope: 'operator-confirmed-retained-history' }),
});
const app = express();
app.use(express.json());
app.use((req, res, next) => {
  if (req.headers['x-test-network']) Object.defineProperty(req.socket, 'remoteAddress', { value: '192.0.2.10', configurable: true });
  next();
});
app.use(authGate);
app.use(hostControlRouteGate);
app.use('/api/usage', usageRoutes);
app.use(errorMiddleware);
const get = () => request(app).get('/api/usage/native-accounts');
const put = (expectedRevision, selections) => request(app).put('/api/usage/native-accounts').send({ expectedRevision, selections });

beforeEach(async () => {
  vi.clearAllMocks();
  authEnabled = false;
  registry = { self: { instanceId: 'private-local-instance', name: 'private-host-name' }, peers: [{
    id: 'private-peer-record', instanceId: 'private-peer-instance', syncSecret: 'private-secret-'.repeat(8),
    address: 'private-host.ts.net', name: 'private-peer-name', enabled: true,
  }] };
  await writeSettingsFile({ theme: 'dark', unrelated: { preserved: true } });
});
afterEach(async () => {
  await flushSettingsLedger();
  expect(captureDashboardNativeUsageReport).not.toHaveBeenCalled();
  expect(getNativeUsageMatrix).not.toHaveBeenCalled();
  expect(getFleetUsage).not.toHaveBeenCalled();
  expect(usage.recordTokens).not.toHaveBeenCalled();
  expect(usage.resetUsage).not.toHaveBeenCalled();
});
afterAll(cleanup);

describe('native account editor HTTP workflow', () => {
  it('opens empty, saves and reopens explicit selections for all four providers without touching unrelated settings or sources', async () => {
    const initial = await get();
    expect(initial.status).toBe(200);
    expect(initial.headers['cache-control']).toBe('no-store');
    expect(initial.body).toMatchObject({ selections: [], revision: expect.stringMatching(/^[a-f0-9]{64}$/),
      inventory: { status: 'complete', maxPeers: 64 }, participants: [
        { participantKey: LOCAL, kind: 'local', status: 'configured' },
        { participantKey: PEER, kind: 'peer', status: 'configured' },
      ] });
    const selections = ['codex', 'claude', 'grok', 'agy'].map(family => selection(family, [LOCAL, PEER]));
    const saved = await put(initial.body.revision, selections);
    expect(saved.status).toBe(200);
    expect(saved.body.selections).toEqual(selections);
    expect(saved.body.revision).not.toBe(initial.body.revision);
    __resetSettingsCache();
    expect((await get()).body).toEqual(saved.body);
    expect(stored()).toEqual({ theme: 'dark', unrelated: { preserved: true }, usageNativeAccountSelections: selections });
    expect(JSON.stringify(saved.body)).not.toContain('private-');
  });

  it('rejects invalid identity assertions, extra fields and query overrides without writing', async () => {
    const { revision } = (await get()).body;
    const before = readFileSync(join(tempRoot, 'settings.json'), 'utf8');
    const invalid = [
      [{ ...selection('codex'), authoritativeParticipant: PEER }],
      [{ ...selection('claude'), historyScope: undefined }],
      [{ ...selection('grok'), accountLabel: 'private@example.test' }],
      [selection('agy'), { ...selection('agy'), accountLabel: 'other' }],
      [{ ...selection('claude'), sourcePath: '/private/native' }],
    ];
    for (const selections of invalid) expect((await put(revision, selections)).status).toBe(400);
    expect((await request(app).put('/api/usage/native-accounts').send({ expectedRevision: revision, selections: [], force: true })).status).toBe(400);
    expect((await request(app).put('/api/usage/native-accounts').send({ selections: [] })).status).toBe(400);
    expect((await request(app).get('/api/usage/native-accounts?home=/private/native')).status).toBe(400);
    expect(readFileSync(join(tempRoot, 'settings.json'), 'utf8')).toBe(before);
  });

  it('preserves unavailable saved members but refuses invented or newly missing assignments', async () => {
    await writeSettingsFile({ usageNativeAccountSelections: [selection('claude', [LOCAL, UNKNOWN])] });
    const initial = await get();
    expect(initial.body.participants).toContainEqual({ participantKey: UNKNOWN, kind: 'unavailable', status: 'not-configured' });
    const renamed = [{ ...initial.body.selections[0], accountLabel: 'renamed' }];
    expect((await put(initial.body.revision, renamed)).status).toBe(200);
    const opened = await get();
    const before = stored();
    expect((await put(opened.body.revision, [...renamed, selection('grok', [UNKNOWN])])).status).toBe(409);
    registry.peers = [];
    expect((await put(opened.body.revision, [...renamed, selection('codex', [PEER])])).status).toBe(409);
    expect(stored()).toEqual(before);
  });

  it('does not offer duplicate peer identities or a local identity also registered as a peer', async () => {
    registry.peers.push({ ...registry.peers[0] }, { instanceId: 'private-local-instance' });
    await writeSettingsFile({ usageNativeAccountSelections: [selection('grok', [PEER])] });
    const opened = await get();
    expect(opened.body.participants).toEqual([{ participantKey: PEER, kind: 'unavailable', status: 'not-configured' }]);
    expect((await put(opened.body.revision, [selection('codex', [LOCAL])])).status).toBe(409);
    expect((await put(opened.body.revision, opened.body.selections)).status).toBe(200);
  });

  it('compares revisions inside the shared write queue and preserves overlapping unrelated writes', async () => {
    const { revision } = (await get()).body;
    const results = await Promise.all([put(revision, [selection('codex')]), put(revision, [selection('grok')])]);
    expect(results.map(result => result.status).sort()).toEqual([200, 409]);
    const opened = await get();
    let release;
    const queued = updateSettingsWith(async current => {
      await new Promise(resolve => { release = resolve; });
      return { ...current, theme: 'light' };
    });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const saving = put(opened.body.revision, [selection('claude')]);
    release();
    await queued;
    expect((await saving).status).toBe(200);
    expect(stored().theme).toBe('light');
    const stale = (await get()).body.revision;
    // The generic settings route uses this same queued writer. An intervening
    // valid generic change must invalidate a dedicated editor's old revision.
    await updateSettings({ usageNativeAccountSelections: [selection('agy')] });
    const refused = await put(stale, [selection('grok')]);
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('NATIVE_USAGE_ACCOUNTS_CONFLICT');
    expect(refused.body).not.toHaveProperty('selections');
    expect(stored().usageNativeAccountSelections).toEqual([selection('agy')]);
  });

  it('refuses corrupt settings and invalid saved selections rather than offering or saving an empty fallback', async () => {
    const { revision } = (await get()).body;
    for (const raw of ['{"broken":', JSON.stringify({ usageNativeAccountSelections: null }), JSON.stringify({ usageNativeAccountSelections: [{ family: 'grok' }] })]) {
      writeFileSync(join(tempRoot, 'settings.json'), raw);
      const failed = await get();
      expect(failed.status).toBe(503);
      expect(failed.body).not.toHaveProperty('selections');
      expect((await put(revision, [])).status).toBe(503);
      expect(readFileSync(join(tempRoot, 'settings.json'), 'utf8')).toBe(raw);
      expect(JSON.stringify(failed.body)).not.toContain(tempRoot);
    }
  });

  it('sanitizes unreadable and rejected settings reads without changing the backing file', async () => {
    const { revision } = (await get()).body;
    const before = readFileSync(join(tempRoot, 'settings.json'), 'utf8');
    tryReadFileStrict.mockResolvedValueOnce({ ok: false, value: null });
    expect((await get()).status).toBe(503);
    tryReadFileStrict.mockRejectedValueOnce(new Error('/private/settings.json: private-secret'));
    const failed = await get();
    expect(failed.status).toBe(503);
    expect(JSON.stringify(failed.body)).not.toContain('private');
    tryReadFileStrict.mockResolvedValueOnce({ ok: false, value: null });
    expect((await put(revision, [])).status).toBe(503);
    expect(readFileSync(join(tempRoot, 'settings.json'), 'utf8')).toBe(before);
  });

  it('bounds configured inventory, retains selected missing identities and refuses a failed inventory on save', async () => {
    registry.peers = Array.from({ length: 65 }, (_, index) => ({ instanceId: `private-peer-${index}` }));
    const omitted = nativeUsageParticipantKey('private-peer-64');
    await writeSettingsFile({ usageNativeAccountSelections: [selection('grok', [omitted])] });
    const opened = await get();
    expect(opened.body.inventory).toEqual({ status: 'truncated', maxPeers: 64 });
    expect(opened.body.participants).toHaveLength(66);
    expect(opened.body.participants.at(-1)).toEqual({ participantKey: omitted, kind: 'unavailable', status: 'not-configured' });
    loadData.mockRejectedValueOnce(new Error('/private/instances.json contains private-secret'));
    const unavailable = await get();
    expect(unavailable.status).toBe(200);
    expect(unavailable.body.inventory.status).toBe('unavailable');
    expect(unavailable.body.selections).toEqual(opened.body.selections);
    loadData.mockRejectedValueOnce(new Error('/private/instances.json contains private-secret'));
    const before = stored();
    expect((await put(opened.body.revision, [])).status).toBe(503);
    expect(stored()).toEqual(before);
    expect(JSON.stringify(unavailable.body)).not.toContain('private');
  });

  it('rejects network peer writes with password on or off while retaining local and delegated operator saves', async () => {
    const { revision } = (await get()).body;
    const peer = registry.peers[0];
    for (const enabled of [false, true]) {
      authEnabled = enabled;
      const denied = await request(app).put('/api/usage/native-accounts').set('x-test-network', '1')
        .set(PEER_AUTH_HEADER, derivePeerAuthToken(peer.syncSecret, peer.instanceId)).set(PEER_INSTANCE_HEADER, peer.instanceId)
        .send({ expectedRevision: revision, selections: [selection('codex')] });
      expect(denied.status).toBe(403);
      expect(stored()).not.toHaveProperty('usageNativeAccountSelections');
    }
    const delegated = await request(app).put('/api/usage/native-accounts').set('x-test-network', '1')
      .set('Authorization', 'Bearer delegated-operator-session').send({ expectedRevision: revision, selections: [selection('codex')] });
    expect(delegated.status).toBe(200);
    authEnabled = false;
    expect((await put(delegated.body.revision, [selection('grok')])).status).toBe(200);
  });
});
