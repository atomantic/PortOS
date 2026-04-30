import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import systemHealthRoutes from './systemHealth.js';
import { listProcesses } from '../services/pm2.js';

vi.mock('../services/pm2.js', () => ({
  listProcesses: vi.fn().mockResolvedValue([])
}));

vi.mock('../services/apps.js', () => ({
  getAllApps: vi.fn().mockResolvedValue([])
}));

vi.mock('../services/cos.js', () => ({
  getStatus: vi.fn().mockResolvedValue(null)
}));

vi.mock('../lib/db.js', () => ({
  checkHealth: vi.fn().mockResolvedValue({ connected: false, hasSchema: false })
}));

describe('System Health Routes', () => {
  const app = express();
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
});
