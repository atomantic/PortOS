import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import systemHealthRoutes from './systemHealth.js';
import { listProcesses } from '../services/pm2.js';

vi.mock('../services/pm2.js', () => ({
  listProcesses: vi.fn().mockResolvedValue([])
}));

vi.mock('../services/apps.js', () => ({
  getAllApps: vi.fn().mockResolvedValue([]),
  getAppStatusSummary: vi.fn().mockResolvedValue({
    total: 0,
    online: 0,
    stopped: 0,
    notStarted: 0,
    unmanaged: 0
  })
}));

vi.mock('../services/cos.js', () => ({
  getStatus: vi.fn().mockResolvedValue(null)
}));

vi.mock('../lib/db.js', () => ({
  checkHealth: vi.fn().mockResolvedValue({ connected: false, hasSchema: false })
}));

vi.mock('../services/settings.js', () => ({
  getSettings: vi.fn().mockResolvedValue({}),
  updateSettings: vi.fn().mockResolvedValue({})
}));

describe('System Health Routes', () => {
  const app = express();
  app.use(express.json());
  app.use('/api/system', systemHealthRoutes);

  it('should return health status', async () => {
    const response = await request(app).get('/api/system/health');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.version).toBeDefined();
  });

  it('should return health details with version', async () => {
    const response = await request(app).get('/api/system/health/details');

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('version');
    expect(response.body).toHaveProperty('system');
    expect(response.body).toHaveProperty('apps');
    expect(response.body).toHaveProperty('overallHealth');
  });

  it('does not warn on cumulative restart_time (developer-driven restarts)', async () => {
    listProcesses.mockResolvedValueOnce([
      { name: 'portos', status: 'online', restarts: 97, unstableRestarts: 0, cpu: 0, memory: 0 }
    ]);
    const response = await request(app).get('/api/system/health/details');
    const restartWarnings = (response.body.warnings || []).filter(w => w.type === 'restarts');
    expect(restartWarnings).toHaveLength(0);
  });

  it('warns when a process has unstable_restarts (real crash loop)', async () => {
    listProcesses.mockResolvedValueOnce([
      { name: 'flaky-svc', status: 'online', restarts: 5, unstableRestarts: 3, cpu: 0, memory: 0 }
    ]);
    const response = await request(app).get('/api/system/health/details');
    const restartWarnings = (response.body.warnings || []).filter(w => w.type === 'restarts');
    expect(restartWarnings).toHaveLength(1);
    expect(restartWarnings[0].message).toContain('crash-loop');
    expect(restartWarnings[0].message).toContain('flaky-svc');
  });

  it('exposes thresholds and topProcesses (sorted by memory desc)', async () => {
    listProcesses.mockResolvedValueOnce([
      { name: 'small', status: 'online', memory: 100, cpu: 1, restarts: 0, unstableRestarts: 0 },
      { name: 'big', status: 'online', memory: 5_000_000, cpu: 50, restarts: 0, unstableRestarts: 0 },
      { name: 'mid', status: 'online', memory: 2_000_000, cpu: 5, restarts: 0, unstableRestarts: 0 }
    ]);
    const response = await request(app).get('/api/system/health/details');
    expect(response.body.thresholds).toMatchObject({
      memoryWarn: expect.any(Number),
      memoryCritical: expect.any(Number),
      diskWarn: expect.any(Number),
      diskCritical: expect.any(Number)
    });
    expect(response.body.topProcesses.map(p => p.name)).toEqual(['big', 'mid', 'small']);
  });

  describe('PUT /health/thresholds', () => {
    it('rejects invalid numbers', async () => {
      const response = await request(app)
        .put('/api/system/health/thresholds')
        .send({ memoryWarn: 'oops', memoryCritical: 95, diskWarn: 90, diskCritical: 98 });
      expect(response.status).toBe(400);
    });

    it('rejects warn >= critical', async () => {
      const response = await request(app)
        .put('/api/system/health/thresholds')
        .send({ memoryWarn: 95, memoryCritical: 90, diskWarn: 80, diskCritical: 95 });
      expect(response.status).toBe(400);
      expect(response.body.error).toMatch(/memoryWarn/);
    });

    it('clamps and persists valid thresholds', async () => {
      const response = await request(app)
        .put('/api/system/health/thresholds')
        .send({ memoryWarn: 87, memoryCritical: 96, diskWarn: 92, diskCritical: 99 });
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ memoryWarn: 87, memoryCritical: 96, diskWarn: 92, diskCritical: 99 });
    });
  });
});
