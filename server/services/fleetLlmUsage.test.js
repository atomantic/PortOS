import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ peers: [], tailnet: { peers: [] }, stored: null, written: [] }));

vi.mock('./instances.js', () => ({ getPeers: async () => state.peers }));
vi.mock('../lib/tailscale.js', () => ({ getTailscaleStatus: async () => state.tailnet }));
vi.mock('../lib/paths.js', () => ({ dataPath: (...parts) => `/example/data/${parts.join('/')}` }));
vi.mock('../lib/fileUtils.js', () => ({
  readJSONFile: async () => state.stored,
  atomicWrite: async (path, value) => state.written.push({ path, value }),
}));

const { __resetFleetHostUsage, flushFleetHostUsage, getFleetHostUsageLedger, getFleetHostUsageReport } = await import('./fleetLlmUsage.js');

beforeEach(() => {
  state.peers = [];
  state.tailnet = { peers: [] };
  state.stored = null;
  state.written = [];
  __resetFleetHostUsage();
});

describe('fleet host usage report', () => {
  it('names a caller from its peer record, falling back to the tailnet and then to nothing', async () => {
    // A peer record carries the name the USER chose for that machine; the
    // tailnet only knows its MagicDNS name. An address matching neither is the
    // case the report exists to surface, so it is flagged, not hidden.
    state.peers = [{ id: 'peer-1', name: 'Workstation GPU', address: '192.0.2.10', port: 5555 }];
    state.tailnet = {
      peers: [
        { dnsName: 'workstation.example.ts.net', ips: ['192.0.2.10'] },
        { dnsName: 'laptop.example.ts.net', ips: ['192.0.2.11'] },
      ],
    };

    const ledger = await getFleetHostUsageLedger();
    for (const address of ['192.0.2.10', '192.0.2.11', '192.0.2.99']) {
      ledger.endRequest(ledger.beginRequest({ address }), { status: 200, usage: { promptTokens: 1, completionTokens: 2 } });
    }

    const report = await getFleetHostUsageReport({ queue: { active: 0, queued: 0 } });
    const byAddress = Object.fromEntries(report.clients.map((c) => [c.address, c]));
    expect(byAddress['192.0.2.10']).toMatchObject({ label: 'Workstation GPU', source: 'peer', peerId: 'peer-1', known: true });
    expect(byAddress['192.0.2.11']).toMatchObject({ label: 'laptop.example.ts.net', source: 'tailnet', known: true });
    expect(byAddress['192.0.2.99']).toMatchObject({ label: null, source: 'unknown', known: false });
    expect(report.queue).toEqual({ active: 0, queued: 0 });
    expect(report.totals).toMatchObject({ requests: 3, completionTokens: 6 });
  });

  it('serves a report from disk after a restart, without a phantom in-flight request', async () => {
    state.stored = {
      version: 1,
      since: Date.parse('2026-09-01T00:00:00Z'),
      clients: [{
        key: '192.0.2.10',
        firstSeen: Date.parse('2026-09-19T00:00:00Z'),
        lastSeen: Date.now(),
        requests: 4,
        errors: 0,
        tokenReports: 4,
        promptTokens: 400,
        completionTokens: 900,
        activeRequests: 3,
        models: ['qwen3.8-27b'],
        days: {},
      }],
      recent: [],
    };

    const report = await getFleetHostUsageReport();
    expect(report.clients[0]).toMatchObject({ address: '192.0.2.10', requests: 4, completionTokens: 900 });
    expect(report.activeRequests).toBe(0);
  });

  it('persists a JSON document with no request or response content in it', async () => {
    const ledger = await getFleetHostUsageLedger();
    ledger.endRequest(
      ledger.beginRequest({ address: '192.0.2.10', path: '/v1/chat/completions' }),
      { status: 200, usage: { promptTokens: 5, completionTokens: 6 }, model: 'qwen3.8-27b' },
    );
    await flushFleetHostUsage();

    expect(state.written).toHaveLength(1);
    const payload = JSON.parse(state.written[0].value);
    expect(payload.version).toBe(1);
    expect(payload.clients[0]).toMatchObject({ key: '192.0.2.10', requests: 1, completionTokens: 6 });
    // A ledger row is counts and metadata. If a prompt ever reached it, this is
    // the assertion that fails.
    expect(payload.clients[0]).not.toHaveProperty('activeRequests');
    expect(Object.keys(payload.recent[0]).sort()).toEqual([
      'clientKey', 'completionTokens', 'durationMs', 'finishedAt', 'id', 'model', 'path', 'promptTokens', 'startedAt', 'status',
    ]);
  });
});
