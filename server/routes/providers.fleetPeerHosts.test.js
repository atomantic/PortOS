import { describe, it, expect, vi, beforeEach } from 'vitest';
import express, { Router } from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/fleetLlmHost.js', () => ({
  getFleetPeerHosts: vi.fn(),
  revealFleetPeerHostKey: vi.fn(),
  getFleetLlmHostStatus: vi.fn(),
  revealFleetLlmKey: vi.fn(),
  configureFleetLlmHost: vi.fn(),
  getFleetLlmHostUsage: vi.fn(),
  disableFleetLlmHost: vi.fn(),
}));

const fleetLlmHost = await import('../services/fleetLlmHost.js');
const { createPortOSProviderRoutes } = await import('./providers.js');

const buildApp = () => {
  const providerService = { getAllProviders: vi.fn().mockResolvedValue({ activeProvider: 'test', providers: [] }) };
  const app = express();
  app.use(express.json());
  app.use('/api/providers', createPortOSProviderRoutes({
    services: { providers: providerService }, routes: { providers: Router() },
  }));
  app.use(errorMiddleware);
  return app;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/providers/fleet-peer-hosts', () => {
  it('rejects a repeated query key with 400 (fleet-host, #16428)', async () => {
    const res = await request(buildApp()).get('/api/providers/fleet-host?fresh=1&fresh=1');
    expect(res.status).toBe(400);
  });

  it('returns peer hosts list from fleetLlmHost service', async () => {
    const mockHosts = [
      {
        peerId: 'peer-1',
        peerName: 'Workstation GPU',
        endpoint: 'http://gpu.ts.net:18022/v1',
        model: 'qwen3.8-27b',
        serving: true,
      },
    ];
    fleetLlmHost.getFleetPeerHosts.mockResolvedValue({ hosts: mockHosts });

    const res = await request(buildApp()).get('/api/providers/fleet-peer-hosts');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ hosts: mockHosts });
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('this host\'s inbound usage and stop controls', () => {
  it('serves the usage report uncached', async () => {
    // Cached, this would answer "nobody is using your GPU" for a minute after
    // someone started — the one window where the page is being read.
    const report = { activeRequests: 1, clients: [{ address: '192.0.2.10', label: 'Workstation GPU', requests: 4 }], recent: [], totals: { requests: 4 } };
    fleetLlmHost.getFleetLlmHostUsage.mockResolvedValue(report);

    const res = await request(buildApp()).get('/api/providers/fleet-host/usage');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(report);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('identifies the same setup holder when another setup or a stop is refused', async () => {
    const app = buildApp();
    const release = Promise.withResolvers();
    fleetLlmHost.configureFleetLlmHost.mockReturnValueOnce(release.promise);
    fleetLlmHost.getFleetLlmHostStatus.mockResolvedValueOnce({ enabled: true });
    const pending = request(app).post('/api/providers/fleet-host/setup').then(response => response);
    try {
      await vi.waitFor(() => expect(fleetLlmHost.configureFleetLlmHost).toHaveBeenCalledTimes(1));
      const busy = await request(app).post('/api/providers/fleet-host/setup');
      expect(busy.status).toBe(409);
      expect(busy.body).toMatchObject({ code: 'SETUP_BUSY', context: { holder: { runId: expect.any(String), kind: 'fleet-host' } } });
      const stop = await request(app).post('/api/providers/fleet-host/stop');
      expect(stop.status).toBe(409);
      expect(stop.body).toMatchObject({ code: 'SETUP_BUSY', context: busy.body.context });
      expect(fleetLlmHost.disableFleetLlmHost).not.toHaveBeenCalled();
    } finally {
      release.resolve({ success: true });
      await pending;
    }
  });

  it('stops the host and returns what happened', async () => {
    fleetLlmHost.disableFleetLlmHost.mockImplementation(async ({ emit }) => {
      emit('Closing the shared API queue — no new peer requests will be admitted.');
      return { success: true, containerStopped: true };
    });

    fleetLlmHost.getFleetLlmHostStatus.mockResolvedValue({ enabled: false, stoppable: false });
    const res = await request(buildApp()).post('/api/providers/fleet-host/stop');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, containerStopped: true, status: { enabled: false, stoppable: false } });
    expect(res.body.log[0]).toContain('Closing the shared API queue');
  });
});

describe('POST /api/providers/fleet-peer-hosts/:peerId/key', () => {
  it('reveals key for a specific peer', async () => {
    fleetLlmHost.revealFleetPeerHostKey.mockResolvedValue({ apiKey: 'sample-peer-token' });

    const res = await request(buildApp()).post('/api/providers/fleet-peer-hosts/peer-1/key');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ apiKey: 'sample-peer-token' });
    expect(fleetLlmHost.revealFleetPeerHostKey).toHaveBeenCalledWith('peer-1');
  });
});
