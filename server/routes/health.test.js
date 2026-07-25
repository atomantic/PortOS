import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'os';
import express from 'express';
import { request } from '../lib/testHelper.js';
import systemHealthRoutes from './systemHealth.js';
import { listProcesses } from '../services/pm2.js';
import { getSelf } from '../services/instances.js';
import { isAuthEnabled } from '../services/auth.js';

vi.mock('../services/pm2.js', () => ({
  listProcesses: vi.fn().mockResolvedValue([])
}));

// Mock instances + auth directly (rather than through settings) so the pre-auth
// companion-app identity fields on GET /health are deterministic. Mocking auth.js
// directly also sidesteps its module-load `settingsEvents.on(...)` side effect,
// which the partial settings.js mock below does not provide.
vi.mock('../services/instances.js', () => ({
  getSelf: vi.fn().mockResolvedValue({ instanceId: 'test-instance-id', name: 'Example Instance' })
}));

vi.mock('../services/auth.js', () => ({
  isAuthEnabled: vi.fn().mockResolvedValue(false)
}));

// `desktopProcessNames` drives the annotateExpectedExit mock below; tests that
// exercise the desktop exemption set it, everything else leaves it empty.
const mock = vi.hoisted(() => ({ desktopProcessNames: new Set() }));

vi.mock('../services/apps.js', () => ({
  getAllApps: vi.fn().mockResolvedValue([]),
  getAppStatusSummary: vi.fn().mockResolvedValue({
    total: 0,
    online: 0,
    stopped: 0,
    notStarted: 0,
    unmanaged: 0
  }),
  // Mirrors the real helper: stamps expectedExit from the desktop-owned names.
  annotateExpectedExit: vi.fn(async (processes) =>
    processes.map(p => ({ ...p, expectedExit: mock.desktopProcessNames.has(p?.name) }))
  )
}));

vi.mock('../services/cos.js', () => ({
  getStatus: vi.fn().mockResolvedValue(null)
}));

vi.mock('../lib/db.js', () => ({
  checkHealth: vi.fn().mockResolvedValue({ connected: false, hasSchema: false })
}));

vi.mock('../services/settings.js', () => ({
  getSettings: vi.fn().mockResolvedValue({}),
  updateSettings: vi.fn().mockResolvedValue({}),
  // PUT /health/thresholds was migrated to updateSettingsWith (a read-modify-write
  // that hands the mutator the current settings and returns its result). Mirror
  // that contract faithfully — including the real helper's plain-object guard —
  // so a future route mutator that forgets to `return` (or returns a non-object)
  // fails this test instead of silently passing while it would throw in prod.
  updateSettingsWith: vi.fn(async (mutate) => {
    const next = await mutate({});
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      throw new TypeError('updateSettingsWith: mutate() must return a plain settings object');
    }
    return next;
  })
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

  it('exposes companion-app identity fields (name, instanceId, authRequired, scheme)', async () => {
    const response = await request(app).get('/api/system/health');

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty('name', 'Example Instance');
    expect(response.body).toHaveProperty('instanceId', 'test-instance-id');
    expect(response.body).toHaveProperty('authRequired', false);
    expect(['http', 'https']).toContain(response.body.scheme);
  });

  it('reports authRequired true when the password gate is on and falls back to hostname for name', async () => {
    isAuthEnabled.mockResolvedValueOnce(true);
    getSelf.mockResolvedValueOnce(null);

    const response = await request(app).get('/api/system/health');

    expect(response.status).toBe(200);
    expect(response.body.authRequired).toBe(true);
    expect(response.body.name).toBe(os.hostname());
    expect(response.body.instanceId).toBeNull();
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

  // A quit desktop app must not drive overallHealth to 'critical' — that lights
  // up the dashboard widget and the CyberCity HUD until the PM2 entry is cleared
  // by hand. This is the widest-blast-radius consumer of `errored` (#2991).
  describe('GET /health/details — desktop (GUI) process exemption', () => {
    beforeEach(() => {
      mock.desktopProcessNames = new Set();
      vi.mocked(listProcesses).mockResolvedValue([]);
    });

    it('stays healthy when the only errored process is a quit game window', async () => {
      mock.desktopProcessNames = new Set(['game']);
      vi.mocked(listProcesses).mockResolvedValue([{ name: 'game', status: 'errored' }]);

      const { body } = await request(app).get('/api/system/health/details');

      expect(body.processes.errored).toBe(0);
      expect(body.processes.desktopExited).toBe(1);
      expect(body.overallHealth).not.toBe('critical');
      expect(body.warnings.some(w => w.type === 'process')).toBe(false);
    });

    it('still goes critical for a genuinely errored web process', async () => {
      vi.mocked(listProcesses).mockResolvedValue([{ name: 'web', status: 'errored' }]);

      const { body } = await request(app).get('/api/system/health/details');

      expect(body.processes.errored).toBe(1);
      expect(body.overallHealth).toBe('critical');
    });

    it('does not report a quit game as a crash loop', async () => {
      mock.desktopProcessNames = new Set(['game']);
      vi.mocked(listProcesses).mockResolvedValue([
        { name: 'game', status: 'errored', unstableRestarts: 5 }
      ]);

      const { body } = await request(app).get('/api/system/health/details');

      expect(body.processes.unstableRestarts).toBe(0);
      expect(body.warnings.some(w => w.type === 'restarts')).toBe(false);
    });

    it('counts a cleanly stopped desktop app as exited, not stopped', async () => {
      mock.desktopProcessNames = new Set(['game']);
      vi.mocked(listProcesses).mockResolvedValue([{ name: 'game', status: 'stopped' }]);

      const { body } = await request(app).get('/api/system/health/details');

      expect(body.processes.stopped).toBe(0);
      expect(body.processes.desktopExited).toBe(1);
      // `total` still counts every process, so nothing vanishes from the roster.
      expect(body.processes.total).toBe(1);
    });

    it('keeps resource totals covering every process, exempt or not', async () => {
      mock.desktopProcessNames = new Set(['game']);
      vi.mocked(listProcesses).mockResolvedValue([
        { name: 'game', status: 'errored', memory: 100, cpu: 5, restarts: 2 },
        { name: 'web', status: 'online', memory: 50, cpu: 3, restarts: 1 }
      ]);

      const { body } = await request(app).get('/api/system/health/details');

      expect(body.processes.totalMemory).toBe(150);
      expect(body.processes.totalCpu).toBe(8);
      expect(body.processes.totalRestarts).toBe(3);
    });
  });
});
