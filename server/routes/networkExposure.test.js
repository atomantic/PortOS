import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import networkExposureRoutes from './networkExposure.js';

vi.mock('../lib/networkExposure.js', () => ({
  getNetworkExposureStatus: vi.fn().mockReturnValue({
    scheme: 'https',
    httpsEnabled: true,
    httpsStateInitialized: true,
    bind: { host: '0.0.0.0', port: 5555, audience: 'all-interfaces' },
    loopbackMirror: { enabled: true, port: 5553 },
    cert: { mode: 'tailscale', tailscaleHost: 'void.taile8179.ts.net', ips: [] },
    docsUrl: 'https://github.com/atomantic/PortOS/blob/main/docs/PORTS.md',
  }),
}));

describe('Network Exposure Routes', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/network-exposure', networkExposureRoutes);

  it('returns the network exposure status snapshot', async () => {
    const res = await request(app).get('/api/network-exposure/status');
    expect(res.status).toBe(200);
    expect(res.body.scheme).toBe('https');
    expect(res.body.bind.port).toBe(5555);
    expect(res.body.loopbackMirror.port).toBe(5553);
    expect(res.body.cert.tailscaleHost).toBe('void.taile8179.ts.net');
    expect(res.body.docsUrl).toMatch(/PORTS\.md$/);
  });
});
