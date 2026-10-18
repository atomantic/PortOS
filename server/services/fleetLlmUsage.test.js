import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ peers: [], tailnet: { peers: [] }, stored: { ok: true, value: null }, written: [] }));

vi.mock('./instances.js', () => ({ getPeers: async () => state.peers }));
vi.mock('../lib/tailscale.js', () => ({ getTailscaleStatus: async () => state.tailnet }));
vi.mock('../lib/paths.js', () => ({ dataPath: (...parts) => `/example/data/${parts.join('/')}` }));
vi.mock('../lib/fileUtils.js', () => ({
  readJSONFileStrict: async () => state.stored,
  atomicWrite: async (path, value) => state.written.push({ path, value }),
}));

const { __resetFleetHostUsage, flushFleetHostUsage, getFleetHostUsageLedger, getFleetHostUsageReport } = await import('./fleetLlmUsage.js');

beforeEach(() => {
  state.peers = [];
  state.tailnet = { peers: [] };
  state.stored = { ok: true, value: null };
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
      ok: true,
      value: {
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
      },
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

  it('skips persisting and logs error once when usage file is unreadable, then resumes on successful read', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    // First attempt: unreadable file (e.g. EACCES, torn write)
    state.stored = { ok: false, value: null };

    const ledger = await getFleetHostUsageLedger();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toContain('Could not read fleet host usage');

    // Second touch while still unreadable: logs no additional error
    await getFleetHostUsageLedger();
    expect(errorSpy).toHaveBeenCalledTimes(1);

    // Record request and try to flush
    ledger.endRequest(
      ledger.beginRequest({ address: '192.0.2.10', path: '/v1/chat/completions' }),
      { status: 200, usage: { promptTokens: 5, completionTokens: 6 } },
    );
    await flushFleetHostUsage();

    // Persist must be skipped to avoid overwriting unreadable file
    expect(state.written).toHaveLength(0);

    // File becomes readable (e.g. lock released or permissions fixed)
    state.stored = {
      ok: true,
      value: {
        version: 1,
        since: Date.parse('2026-09-01T00:00:00Z'),
        clients: [{
          key: '192.0.2.10',
          firstSeen: Date.parse('2026-09-01T00:00:00Z'),
          lastSeen: Date.now(),
          requests: 10,
          errors: 0,
          tokenReports: 10,
          promptTokens: 1000,
          completionTokens: 2000,
          activeRequests: 0,
          models: [],
          days: {},
        }],
        recent: [],
      },
    };

    const recoveredLedger = await getFleetHostUsageLedger();
    expect(recoveredLedger).toBe(ledger);

    // Now flush should proceed and persist loaded history
    await flushFleetHostUsage();
    expect(state.written).toHaveLength(1);
    const payload = JSON.parse(state.written[0].value);
    expect(payload.clients[0].requests).toBe(10);
    expect(payload.clients[0].completionTokens).toBe(2000);

    errorSpy.mockRestore();
  });

  it('absent file hydrates empty and persists normally', async () => {
    state.stored = { ok: true, value: null };

    const ledger = await getFleetHostUsageLedger();
    ledger.endRequest(
      ledger.beginRequest({ address: '192.0.2.10', path: '/v1/chat/completions' }),
      { status: 200, usage: { promptTokens: 1, completionTokens: 1 } },
    );
    await flushFleetHostUsage();

    expect(state.written).toHaveLength(1);
    const payload = JSON.parse(state.written[0].value);
    expect(payload.clients[0].requests).toBe(1);
  });
});
