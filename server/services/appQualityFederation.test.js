import { it, expect, vi } from 'vitest';
import { mockNoPeers } from '../lib/mockPathsDataRoot.js';
import { exportPortosQuality, collectPortosQuality } from './appQualityFederation.js';
import { enrichAppsWithQuality, getAppQualityHistory } from './appQuality.js';
vi.mock('./instances.js', () => mockNoPeers());
const now = Date.parse('2026-09-10T12:00:00Z');
const peer = { id: 'peer-a', instanceId: 'instance-a', enabled: true, fullSync: true, address: '192.0.2.1', port: 5555 };
const getOriginInfo = async () => ({ host: 'github.com', fullName: 'atomantic/PortOS' });
const row = (category, score, assessed_at = '2026-09-10T10:00:00Z', extra = {}) => ({
  app_id: 'portos-default', category, agent_id: `agent-${category}`, assessed_at,
  report: { version: 1, category, score, worstSeverity: 5, coverage: 'broad', confidence: 'high',
    summary: 'Private paths /Users/person/project and audit narrative', scannedFiles: 12, totalFiles: 12 }, ...extra,
});
const deps = rows => ({ now, getOriginInfo, getPeers: async () => [peer], query: vi.fn(async () => ({ rows })) });
const response = payload => new Response(JSON.stringify(payload), { status: 200 });

// Uniquely pins numeric-only privacy, peer consent and cross-install score convergence.
it('exports only validated local numeric evidence to approved full-sync peers', async () => {
  const local = deps([row('security', 40)]);
  const payload = await exportPortosQuality(peer.instanceId, 30, local);
  expect(payload).toMatchObject({ schemaVersion: 1, measurements: [{ report: { category: 'security', score: 40 } }] });
  expect(JSON.stringify(payload)).not.toMatch(/Private|Users|agent-security|summary|app_id|github/);
  expect(local.query.mock.calls[0][1][0]).toBe('portos-default');
  expect(local.query.mock.calls[0][1][1].toISOString()).toBe('2026-07-13T00:00:00.000Z');
  for (const caller of [undefined, 'unknown']) expect(await exportPortosQuality(caller, 30, local)).toBeNull();
  for (const disabled of [{ enabled: false }, { fullSync: false }, { syncEnabled: false }, { directions: ['inbound'] }]) {
    const blocked = { ...local, getPeers: async () => [{ ...peer, ...disabled }] };
    expect(await exportPortosQuality(peer.instanceId, 30, blocked)).toBeNull();
    expect(await collectPortosQuality(30, blocked)).toMatchObject({ records: [], federation: { peers: 0 } });
  }
  expect(await exportPortosQuality(peer.instanceId, 30, { ...local, getOriginInfo: async () => ({}) })).toBeNull();
});

it('combines newest categories in app view and UTC history without changing other apps or forwarding evidence', async () => {
  const remote = await exportPortosQuality(peer.instanceId, 30, deps([row('security', 80), row('performance', 60)]));
  const local = { ...deps([row('security', 20, '2026-09-09T10:00:00Z')]), peerFetch: vi.fn(async () => response(remote)) };
  const apps = await enrichAppsWithQuality([{ id: 'portos-default' }, { id: 'other' }], local);
  expect(apps[0].quality).toMatchObject({ score: 70, ratedCategories: 2, federation: { peers: 1, available: 1, unavailable: 0 } });
  expect(apps[0].quality.categories.find(c => c.id === 'security')).toMatchObject({ sourcePeerId: 'peer-a', agentId: null });
  expect(apps[1].quality.score).toBeNull();
  expect(local.peerFetch.mock.calls[0]).toEqual(['http://192.0.2.1:5555/api/apps/quality-federation?days=30',
    expect.objectContaining({ signal: expect.any(AbortSignal), redirect: 'error', maxBytes: 4194304 }), peer]);
  const history = await getAppQualityHistory('portos-default', 30, local);
  expect(history.points.find(p => p.date === '2026-09-09').score).toBe(20);
  expect(history.points.at(-1)).toMatchObject({ score: 70, ratedCategories: 2 });
  expect((await enrichAppsWithQuality([{ id: 'portos-default' }], local))[0].quality.score).toBe(70);
  expect((await exportPortosQuality(peer.instanceId, 30, local)).measurements.map(m => m.report.score)).toEqual([20]);
});

it('keeps local scores on old, offline, malformed, oversize or mismatched peers and rejects future evidence', async () => {
  const payload = await exportPortosQuality(peer.instanceId, 30, deps([row('security', 90)]));
  const local = deps([row('security', 20)]);
  for (const fetch of [
    async () => new Response('', { status: 404 }),
    async () => { throw new Error('offline'); },
    async () => response({ ...payload, schemaVersion: 2 }),
    async () => response({ ...payload, repository: '0'.repeat(64) }),
    async () => response({ ...payload, measurements: [{ ...payload.measurements[0], report: { ...payload.measurements[0].report, score: 101 } }] }),
    async () => new Response('too large', { headers: { 'content-length': '4194305' } }),
  ]) {
    const [app] = await enrichAppsWithQuality([{ id: 'portos-default' }], { ...local, peerFetch: fetch });
    expect(app.quality).toMatchObject({ score: 20, federation: { available: 0, unavailable: 1 } });
  }
  const future = { ...payload, measurements: [{ ...payload.measurements[0], assessedAt: '2026-09-11T00:00:00Z' }] };
  expect((await collectPortosQuality(30, { ...local, peerFetch: async () => response(future) })).records).toEqual([]);
});

it('lets newer partial evidence supersede older broad scores and breaks ties consistently', async () => {
  const partial = row('security', 80);
  partial.report.coverage = 'partial';
  partial.report.scannedFiles = 1;
  const payload = await exportPortosQuality(peer.instanceId, 30, deps([partial]));
  const partialDeps = { ...deps([row('security', 20, '2026-09-09T10:00:00Z')]), peerFetch: async () => response(payload) };
  expect((await enrichAppsWithQuality([{ id: 'portos-default' }], partialDeps))[0].quality.score).toBeNull();
  expect((await getAppQualityHistory('portos-default', 30, partialDeps)).points.at(-1).score).toBeNull();
  const a = row('security', 25, undefined, { agent_id: 'run-a' });
  const b = row('security', 75, undefined, { agent_id: 'run-b' });
  const scores = [];
  for (const [here, there] of [[a, b], [b, a]]) {
    const shared = await exportPortosQuality(peer.instanceId, 30, deps([there]));
    const combined = { ...deps([here]), peerFetch: async () => response(shared) };
    scores.push((await enrichAppsWithQuality([{ id: 'portos-default' }], combined))[0].quality.score);
    scores.push((await getAppQualityHistory('portos-default', 30, combined)).points.at(-1).score);
  }
  expect(new Set(scores).size).toBe(1);
});
