import { describe, it, expect, vi, beforeEach } from 'vitest';
import os from 'os';
import { checkHealth } from '../lib/db.js';
import { getMemoryStats } from '../lib/memoryStats.js';
import express from 'express';
import { request } from '../lib/testHelper.js';
import systemHealthRoutes from './systemHealth.js';
import { listProcesses, listProcessesStrict } from '../services/pm2.js';
import { getStatus, getPendingTaskIds, getAgents } from '../services/cos.js';
import { getSelf } from '../services/instanceIdentity.js';
import { isAuthEnabled } from '../services/auth.js';
import { checkGhHealth } from '../services/github.js';
import { getBuildIdentity } from '../lib/buildIdentity.js';
import { getSettingsWithStatus, updateSettingsWith } from '../services/settings.js';
import { statfs } from 'fs/promises';

vi.mock('../services/pm2.js', () => ({
  listProcesses: vi.fn().mockResolvedValue([]),
  listProcessesStrict: vi.fn().mockResolvedValue([])
}));

// Health assertions must not inherit the developer machine's disk or memory
// pressure. In particular, a nearly-full volume can legitimately make every
// otherwise-unrelated route case critical, masking the behavior under test.
vi.mock('fs/promises', async (importOriginal) => ({
  ...(await importOriginal()),
  statfs: vi.fn().mockResolvedValue({ blocks: 100, bavail: 50, bsize: 1 })
}));

vi.mock('../lib/memoryStats.js', () => ({
  getMemoryStats: vi.fn().mockResolvedValue({ total: 100, used: 50, free: 50 })
}));

// Mock instances + auth directly (rather than through settings) so the pre-auth
// companion-app identity fields on GET /health are deterministic. Mocking auth.js
// directly also sidesteps its module-load `settingsEvents.on(...)` side effect,
// which the partial settings.js mock below does not provide.
vi.mock('../services/instanceIdentity.js', () => ({
  getSelf: vi.fn().mockResolvedValue({ instanceId: 'test-instance-id', name: 'Example Instance' })
}));

vi.mock('../services/auth.js', () => ({
  isAuthEnabled: vi.fn().mockResolvedValue(false)
}));

// `desktopProcessNames` drives the annotateExpectedExit mock below; tests that
// exercise the desktop exemption set it, everything else leaves it empty.
const mock = vi.hoisted(() => ({ desktopProcessNames: new Set() }));

vi.mock('../services/appProcessStatus.js', () => ({
  getAppStatusSummary: vi.fn().mockResolvedValue({
    total: 0,
    online: 0,
    stopped: 0,
    notStarted: 0,
    unmanaged: 0
  }),
  annotateExpectedExit: vi.fn(async (processes) =>
    processes.map(p => ({ ...p, expectedExit: mock.desktopProcessNames.has(p?.name) }))
  )
}));

vi.mock('../services/cos.js', () => ({
  getStatus: vi.fn().mockResolvedValue(null),
  getPendingTaskIds: vi.fn().mockResolvedValue([]),
  getAgents: vi.fn().mockResolvedValue([])
}));

vi.mock('../lib/db.js', () => ({
  checkHealth: vi.fn().mockResolvedValue({ connected: false, hasSchema: false })
}));

// The build stamp is read from the checkout the suite happens to run in, so
// mock it — otherwise every assertion below would depend on which worktree
// (and which commit) CI cloned.
vi.mock('../lib/buildIdentity.js', () => ({
  getBuildIdentity: vi.fn().mockResolvedValue({
    commit: 'abc1234567890abcdef1234567890abcdef12345',
    shortCommit: 'abc1234',
    branch: 'main',
    dirty: false
  })
}));

// The real probe spawns `gh` and hits the network — mock it, and default to a
// healthy forge so the existing cases keep their warning counts.
vi.mock('../services/github.js', () => ({
  checkGhHealth: vi.fn().mockResolvedValue({
    status: 'ok', ok: true, detail: null, remedy: null, checkedAt: '2026-01-01T00:00:00.000Z'
  })
}));

const codeReviewMock = vi.hoisted(() => ({
  getReviewerConfigHealth: vi.fn().mockResolvedValue({ status: 'ok', configFaults: {} }),
}));

vi.mock('../services/codeReview.js', () => codeReviewMock);

vi.mock('../services/settings.js', () => ({
  getSettingsWithStatus: vi.fn().mockResolvedValue({ corrupt: false, settings: {} }),
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

  it('reports failed disk and CoS probes without exposing their errors or hiding healthy measurements', async () => {
    const diskError = 'private disk probe detail';
    const cosError = 'private CoS probe detail';
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(statfs).mockRejectedValueOnce(new Error(diskError));
    getStatus.mockRejectedValueOnce(new Error(cosError));
    checkHealth.mockResolvedValueOnce({ connected: true, hasSchema: true });

    try {
      const response = await request(app).get('/api/system/health/details');
      expect(response.status).toBe(200);
      expect(response.body.overallHealth).toBe('warning');
      expect(response.body.system.disk).toBeNull();
      expect(response.body.cos).toBeNull();
      expect(response.body.warnings).toEqual([
        { type: 'probe-unavailable', source: 'disk', status: 'unavailable', severity: 'warning', message: 'Disk status unavailable', dismissible: false },
        { type: 'probe-unavailable', source: 'cos', status: 'unavailable', severity: 'warning', message: 'Chief of Staff status unavailable', dismissible: false }
      ]);
      expect(JSON.stringify(response.body)).not.toContain(diskError);
      expect(JSON.stringify(response.body)).not.toContain(cosError);
      expect(errorSpy).toHaveBeenCalledTimes(2);

      const dismiss = await request(app).post('/api/system/health/warnings/probe-unavailable/dismiss').send({ message: 'Disk status unavailable' });
      expect(dismiss.status).toBe(400);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('serves the running build on its own route (#4694)', async () => {
    const response = await request(app).get('/api/system/build');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      commit: 'abc1234567890abcdef1234567890abcdef12345',
      shortCommit: 'abc1234',
      branch: 'main',
      dirty: false
    });
  });

  it('keeps the build stamp OFF every payload peers scrape (#4694)', async () => {
    // THE federation boundary for this feature, and the reason /build is its
    // own route. `probePeer` (services/instances.js) fetches /health/details
    // from every configured peer and persists the whole JSON verbatim as
    // `peer.lastHealth` — so a `build` field there would ship the branch name
    // (which can carry an issue title) to someone else's install and land on
    // their disk. /health is additionally in the always-public set.
    for (const path of ['/api/system/health', '/api/system/health/details']) {
      const response = await request(app).get(path);
      expect(response.status).toBe(200);
      expect(response.body).not.toHaveProperty('build');
      expect(JSON.stringify(response.body)).not.toContain('abc1234');
    }
  });

  it('never leaks a path, hostname, or username through the build route', async () => {
    const response = await request(app).get('/api/system/build');

    expect(Object.keys(response.body).sort()).toEqual(
      ['branch', 'commit', 'dirty', 'shortCommit']
    );
  });


  it('reports saturated memory and CPU without degrading health', async () => {
    checkHealth.mockResolvedValueOnce({ connected: true, hasSchema: true });
    getMemoryStats.mockResolvedValueOnce({ total: 100, used: 99, free: 1 });
    const load = vi.spyOn(os, 'loadavg').mockReturnValue([1000, 1000, 1000]);
    try {
      const response = await request(app).get('/api/system/health/details');
      expect(response.status).toBe(200);
      expect(response.body.system.memory.usagePercent).toBe(99);
      expect(response.body.system.cpu.usagePercent).toBeGreaterThan(100);
      expect(response.body.warnings).toEqual([]);
      expect(response.body.overallHealth).toBe('healthy');
    } finally {
      load.mockRestore();
    }
  });

  it('does not warn on cumulative restart_time (developer-driven restarts)', async () => {
    listProcessesStrict.mockResolvedValueOnce([
      { name: 'portos', status: 'online', restarts: 97, unstableRestarts: 0, cpu: 0, memory: 0 }
    ]);
    const response = await request(app).get('/api/system/health/details');
    const restartWarnings = (response.body.warnings || []).filter(w => w.type === 'restarts');
    expect(restartWarnings).toHaveLength(0);
  });

  it('warns when a process has unstable_restarts (real crash loop)', async () => {
    listProcessesStrict.mockResolvedValueOnce([
      { name: 'flaky-svc', status: 'online', restarts: 5, unstableRestarts: 3, cpu: 0, memory: 0 }
    ]);
    const response = await request(app).get('/api/system/health/details');
    const restartWarnings = (response.body.warnings || []).filter(w => w.type === 'restarts');
    expect(restartWarnings).toHaveLength(1);
    expect(restartWarnings[0].message).toContain('crash-loop');
    expect(restartWarnings[0].message).toContain('flaky-svc');
  });

  it('exposes thresholds and topProcesses (sorted by memory desc)', async () => {
    listProcessesStrict.mockResolvedValueOnce([
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

  describe('GET /health/details — forge (gh CLI) reachability', () => {
    it('reports a healthy forge without raising a warning', async () => {
      const response = await request(app).get('/api/system/health/details');
      expect(response.body.forge).toMatchObject({ status: 'ok', ok: true });
      expect((response.body.warnings || []).filter(w => w.type === 'forge')).toHaveLength(0);
    });

    it('warns, with the remedy, when gh is installed but cannot reach the forge', async () => {
      // The failure this exists for: every `gh` call site swallows the error
      // into an empty list, so a blocked CLI looks like a repo with nothing
      // open. Without this warning the only symptom is agents silently not
      // filing PRs.
      checkGhHealth.mockResolvedValueOnce({
        status: 'unreachable',
        ok: false,
        detail: 'dial tcp 140.82.116.6:443: connect: bad file descriptor',
        remedy: 'allow the gh binary to reach api.github.com',
        checkedAt: '2026-01-01T00:00:00.000Z'
      });
      const response = await request(app).get('/api/system/health/details');

      expect(response.body.forge).toMatchObject({ status: 'unreachable', ok: false });
      const forgeWarnings = (response.body.warnings || []).filter(w => w.type === 'forge');
      expect(forgeWarnings).toHaveLength(1);
      expect(forgeWarnings[0].message).toContain('unreachable');
      expect(forgeWarnings[0].message).toContain('allow the gh binary');
      expect(response.body.overallHealth).toBe('warning');
    });

    it('warns when gh is present but unauthenticated', async () => {
      checkGhHealth.mockResolvedValueOnce({
        status: 'not-authenticated', ok: false, detail: 'gh auth login', remedy: 'Run `gh auth login`', checkedAt: null
      });
      const response = await request(app).get('/api/system/health/details');
      expect((response.body.warnings || []).filter(w => w.type === 'forge')).toHaveLength(1);
    });

    it('stays quiet when gh was never installed — that is opting out, not a fault', async () => {
      checkGhHealth.mockResolvedValueOnce({
        status: 'not-installed', ok: false, detail: 'spawn gh ENOENT', remedy: 'Install the GitHub CLI', checkedAt: null
      });
      const response = await request(app).get('/api/system/health/details');

      expect(response.body.forge).toMatchObject({ status: 'not-installed' });
      expect((response.body.warnings || []).filter(w => w.type === 'forge')).toHaveLength(0);
    });

    it('does not downgrade an already-critical verdict to warning', async () => {
      listProcessesStrict.mockResolvedValueOnce([
        { name: 'broken', status: 'errored', restarts: 1, unstableRestarts: 0, cpu: 0, memory: 0 }
      ]);
      checkGhHealth.mockResolvedValueOnce({
        status: 'unreachable', ok: false, detail: null, remedy: null, checkedAt: null
      });
      const response = await request(app).get('/api/system/health/details');
      expect(response.body.overallHealth).toBe('critical');
    });

    it('degrades to an error verdict rather than 500ing when the probe itself throws', async () => {
      checkGhHealth.mockRejectedValueOnce(new Error('probe blew up'));
      const response = await request(app).get('/api/system/health/details');

      expect(response.status).toBe(200);
      expect(response.body.forge).toMatchObject({ status: 'error', ok: false });
    });
  });

  it('surfaces persisted reviewer configuration faults as install health', async () => {
    codeReviewMock.getReviewerConfigHealth.mockResolvedValueOnce({
      status: 'warning',
      configFaults: { ollama: { code: 'NO_MODEL', lastFailureAt: 123 } },
    });
    const response = await request(app).get('/api/system/health/details');

    expect(response.body.codeReview).toEqual({
      status: 'warning',
      configFaults: { ollama: { code: 'NO_MODEL', lastFailureAt: 123 } },
    });
    expect(response.body.warnings).toContainEqual(expect.objectContaining({
      type: 'code-review',
      message: expect.stringContaining('ollama'),
    }));
    expect(response.body.overallHealth).toBe('warning');
  });

  it('dismisses and restores a reviewer warning without clearing its configuration fault', async () => {
    const reviewerHealth = { ollama: { code: 'NO_MODEL', lastFailureAt: 123 } };
    const health = { status: 'warning', configFaults: reviewerHealth };
    let settings = { codeReview: { reviewerHealth } };
    await codeReviewMock.getReviewerConfigHealth.withImplementation(async () => health, async () => {
      await getSettingsWithStatus.withImplementation(async () => ({ corrupt: false, settings }), async () => {
        await updateSettingsWith.withImplementation(async (mutate) => (settings = await mutate(settings)), async () => {
          const original = await request(app).get('/api/system/health/details');
          const warning = original.body.warnings.find((item) => item.type === 'code-review');
          expect(warning).toBeDefined();
          const dismissed = await request(app)
            .post('/api/system/health/warnings/code-review/dismiss')
            .send({ message: warning.message });
          expect(dismissed.status).toBe(200);

          const hidden = await request(app).get('/api/system/health/details');
          expect(hidden.body.warnings.some((item) => item.type === 'code-review')).toBe(false);
          expect(hidden.body.codeReview).toEqual(health);
          expect(settings.codeReview.reviewerHealth).toEqual(reviewerHealth);

          const undone = await request(app).delete('/api/system/health/warnings/code-review/dismiss');
          expect(undone.status).toBe(200);
          const restored = await request(app).get('/api/system/health/details');
          expect(restored.body.warnings).toContainEqual(warning);
          expect(restored.body.codeReview).toEqual(health);
          expect(settings.codeReview.reviewerHealth).toEqual(reviewerHealth);
        });
      });
    });
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
  // up the dashboard widget and the OpenWorld HUD until the PM2 entry is cleared
  // by hand. This is the widest-blast-radius consumer of `errored` (#2991).
  describe('GET /health/details — desktop (GUI) process exemption', () => {
    beforeEach(() => {
      mock.desktopProcessNames = new Set();
      vi.mocked(listProcessesStrict).mockResolvedValue([]);
    });

    it('stays healthy when the only errored process is a quit game window', async () => {
      mock.desktopProcessNames = new Set(['game']);
      vi.mocked(listProcessesStrict).mockResolvedValue([{ name: 'game', status: 'errored' }]);

      const { body } = await request(app).get('/api/system/health/details');

      expect(body.processes.errored).toBe(0);
      expect(body.processes.desktopExited).toBe(1);
      expect(body.overallHealth).not.toBe('critical');
      expect(body.warnings.some(w => w.type === 'process')).toBe(false);
    });

    it('still goes critical for a genuinely errored web process', async () => {
      vi.mocked(listProcessesStrict).mockResolvedValue([{ name: 'web', status: 'errored' }]);

      const { body } = await request(app).get('/api/system/health/details');

      expect(body.processes.errored).toBe(1);
      expect(body.overallHealth).toBe('critical');
    });

    it('does not report a quit game as a crash loop', async () => {
      mock.desktopProcessNames = new Set(['game']);
      vi.mocked(listProcessesStrict).mockResolvedValue([
        { name: 'game', status: 'errored', unstableRestarts: 5 }
      ]);

      const { body } = await request(app).get('/api/system/health/details');

      expect(body.processes.unstableRestarts).toBe(0);
      expect(body.warnings.some(w => w.type === 'restarts')).toBe(false);
    });

    it('counts a cleanly stopped desktop app as exited, not stopped', async () => {
      mock.desktopProcessNames = new Set(['game']);
      vi.mocked(listProcessesStrict).mockResolvedValue([{ name: 'game', status: 'stopped' }]);

      const { body } = await request(app).get('/api/system/health/details');

      expect(body.processes.stopped).toBe(0);
      expect(body.processes.desktopExited).toBe(1);
      // `total` still counts every process, so nothing vanishes from the roster.
      expect(body.processes.total).toBe(1);
    });

    it('still counts a RUNNING desktop app as online', async () => {
      // Only the FAILURE-bearing counts filter on `expectedExit`. Filtering
      // `online` too would render "1 of 2 running · all healthy" with both up,
      // and read identically whether the game is running or quit.
      mock.desktopProcessNames = new Set(['game']);
      vi.mocked(listProcessesStrict).mockResolvedValue([
        { name: 'game', status: 'online' },
        { name: 'web', status: 'online' }
      ]);

      const { body } = await request(app).get('/api/system/health/details');

      expect(body.processes.online).toBe(2);
      expect(body.processes.total).toBe(2);
      expect(body.processes.desktopExited).toBe(0);
    });

    it('keeps resource totals covering every process, exempt or not', async () => {
      mock.desktopProcessNames = new Set(['game']);
      vi.mocked(listProcessesStrict).mockResolvedValue([
        { name: 'game', status: 'errored', memory: 100, cpu: 5, restarts: 2 },
        { name: 'web', status: 'online', memory: 50, cpu: 3, restarts: 1 }
      ]);

      const { body } = await request(app).get('/api/system/health/details');

      expect(body.processes.totalMemory).toBe(150);
      expect(body.processes.totalCpu).toBe(8);
      expect(body.processes.totalRestarts).toBe(3);
    });
  });

  describe('dismissing dashboard warnings as resolved', () => {
    it('suppresses a warning whose stored dismissal message still matches', async () => {
      // Force a disk-warn condition (95% used) so the 'disk' warning fires,
      // then supply a dismissal recorded against that exact message.
      vi.mocked(statfs).mockResolvedValueOnce({ blocks: 100, bavail: 5, bsize: 1 });
      getSettingsWithStatus.mockResolvedValueOnce({
        corrupt: false,
        settings: { health: { dismissedWarnings: { disk: { message: 'Disk usage at or above 90%', dismissedAt: '2026-01-01T00:00:00.000Z' } } } }
      });

      const response = await request(app).get('/api/system/health/details');

      expect(response.body.warnings.some(w => w.type === 'disk')).toBe(false);
    });

    it('shows the warning again when the current message differs from the dismissal (new occurrence)', async () => {
      // 99% used crosses diskCritical (98), not diskWarn (90) — a different
      // message than the one that was dismissed.
      vi.mocked(statfs).mockResolvedValueOnce({ blocks: 100, bavail: 1, bsize: 1 });
      getSettingsWithStatus.mockResolvedValueOnce({
        corrupt: false,
        settings: { health: { dismissedWarnings: { disk: { message: 'Disk usage at or above 90%', dismissedAt: '2026-01-01T00:00:00.000Z' } } } }
      });

      const response = await request(app).get('/api/system/health/details');

      const diskWarnings = response.body.warnings.filter(w => w.type === 'disk');
      expect(diskWarnings).toHaveLength(1);
      expect(diskWarnings[0].message).toContain('98%');
    });

    it('prunes a stale dismissal once its condition no longer holds', async () => {
      // Default disk mock (50% used) never raises a 'disk' warning, so a
      // stored disk dismissal is now stale and should be dropped.
      getSettingsWithStatus.mockResolvedValueOnce({
        corrupt: false,
        settings: { health: { dismissedWarnings: { disk: { message: 'Disk usage at or above 90%', dismissedAt: '2026-01-01T00:00:00.000Z' } } } }
      });
      vi.mocked(updateSettingsWith).mockClear();

      await request(app).get('/api/system/health/details');

      expect(updateSettingsWith).toHaveBeenCalledTimes(1);
      const mutate = vi.mocked(updateSettingsWith).mock.calls[0][0];
      const next = await mutate({});
      expect(next.health.dismissedWarnings).toEqual({});
    });

    it('uses custom disk thresholds for health warnings', async () => {
      vi.mocked(statfs).mockResolvedValueOnce({ blocks: 100, bavail: 20, bsize: 1 });
      getSettingsWithStatus.mockResolvedValueOnce({
        corrupt: false,
        settings: { health: { diskWarn: 70, diskCritical: 90 } }
      });

      const { body } = await request(app).get('/api/system/health/details');

      expect(body.thresholdsAvailable).toBe(true);
      expect(body.thresholds).toMatchObject({ diskWarn: 70, diskCritical: 90 });
      expect(body.warnings).toContainEqual({
        type: 'disk', severity: 'warning', message: 'Disk usage at or above 70%'
      });
    });

    it('reports corrupt settings, ignores their thresholds and dismissals, and blocks settings writes', async () => {
      vi.mocked(statfs).mockResolvedValueOnce({ blocks: 100, bavail: 5, bsize: 1 });
      const healthSettingsWarning = 'System health settings are unavailable; default thresholds are being used and saved warning dismissals were ignored.';
      const corruptStatus = { corrupt: true, settings: {
        health: {
          diskWarn: 70,
          diskCritical: 75,
          dismissedWarnings: {
            'health-settings': { message: healthSettingsWarning, dismissedAt: '2026-01-01T00:00:00.000Z' },
            disk: { message: 'Disk usage at or above 90%', dismissedAt: '2026-01-01T00:00:00.000Z' }
          }
        }
      } };
      getSettingsWithStatus
        .mockResolvedValueOnce(corruptStatus)
        .mockResolvedValueOnce(corruptStatus)
        .mockResolvedValueOnce(corruptStatus)
        .mockResolvedValueOnce(corruptStatus);
      vi.mocked(updateSettingsWith).mockClear();

      const { body } = await request(app).get('/api/system/health/details');

      expect(body.thresholdsAvailable).toBe(false);
      expect(body.thresholds).toBeUndefined();
      expect(body.warnings).toContainEqual(expect.objectContaining({
        type: 'health-settings', severity: 'warning', message: healthSettingsWarning, dismissible: false
      }));
      expect(body.warnings).toContainEqual({
        type: 'disk', severity: 'warning', message: 'Disk usage at or above 90%', dismissible: false
      });
      expect(updateSettingsWith).not.toHaveBeenCalled();

      const saveThresholds = await request(app).put('/api/system/health/thresholds').send({
        memoryWarn: 85, memoryCritical: 95, diskWarn: 70, diskCritical: 90
      });
      const dismissWarning = await request(app)
        .post('/api/system/health/warnings/disk/dismiss')
        .send({ message: 'Disk usage at or above 70%' });
      const undismissWarning = await request(app).delete('/api/system/health/warnings/disk/dismiss');
      const dismissSettingsWarning = await request(app)
        .post('/api/system/health/warnings/health-settings/dismiss')
        .send({ message: 'settings unavailable' });
      const undismissSettingsWarning = await request(app).delete('/api/system/health/warnings/health-settings/dismiss');

      expect(saveThresholds.status).toBe(503);
      expect(dismissWarning.status).toBe(503);
      expect(undismissWarning.status).toBe(503);
      expect(dismissSettingsWarning.status).toBe(400);
      expect(undismissSettingsWarning.status).toBe(400);
      expect(updateSettingsWith).not.toHaveBeenCalled();
    });

    it('keeps a recurring warning visible and retries a failed stale-dismissal prune', async () => {
      let persistedSettings = {
        health: {
          diskWarn: 70,
          diskCritical: 90,
          dismissedWarnings: {
            disk: { message: 'Disk usage at or above 70%', dismissedAt: '2026-01-01T00:00:00.000Z' }
          }
        }
      };
      const staleSnapshot = () => ({ corrupt: false, settings: structuredClone(persistedSettings) });
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      vi.mocked(updateSettingsWith).mockClear();

      try {
        vi.mocked(statfs).mockResolvedValueOnce({ blocks: 100, bavail: 50, bsize: 1 });
        getSettingsWithStatus.mockResolvedValueOnce(staleSnapshot());
        vi.mocked(updateSettingsWith).mockRejectedValueOnce(Object.assign(new Error('write failed'), { code: 'EIO' }));

        const cleared = await request(app).get('/api/system/health/details');

        expect(cleared.body.warnings.some((warning) => warning.type === 'disk')).toBe(false);
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('type=disk, error=EIO'));

        vi.mocked(statfs).mockResolvedValueOnce({ blocks: 100, bavail: 20, bsize: 1 });
        getSettingsWithStatus.mockResolvedValueOnce(staleSnapshot());
        vi.mocked(updateSettingsWith).mockImplementationOnce(async (mutate) => {
          persistedSettings = await mutate(persistedSettings);
          return persistedSettings;
        });

        const recurring = await request(app).get('/api/system/health/details');

        expect(recurring.body.warnings).toContainEqual({
          type: 'disk', severity: 'warning', message: 'Disk usage at or above 70%'
        });
        expect(persistedSettings.health.dismissedWarnings).toEqual({});

        vi.mocked(statfs).mockResolvedValueOnce({ blocks: 100, bavail: 20, bsize: 1 });
        getSettingsWithStatus.mockResolvedValueOnce(staleSnapshot());

        const afterRetry = await request(app).get('/api/system/health/details');

        expect(afterRetry.body.warnings).toContainEqual({
          type: 'disk', severity: 'warning', message: 'Disk usage at or above 70%'
        });
        expect(updateSettingsWith).toHaveBeenCalledTimes(2);
      } finally {
        errorSpy.mockRestore();
      }
    });

    describe('POST /health/warnings/:type/dismiss', () => {
      it('records the dismissal and echoes it back', async () => {
        const response = await request(app)
          .post('/api/system/health/warnings/disk/dismiss')
          .send({ message: 'Disk usage at or above 90%' });

        expect(response.status).toBe(200);
        expect(response.body).toMatchObject({ message: 'Disk usage at or above 90%' });
        expect(response.body.dismissedAt).toEqual(expect.any(String));
      });

      it('rejects an unknown warning type', async () => {
        const response = await request(app)
          .post('/api/system/health/warnings/bogus/dismiss')
          .send({ message: 'anything' });
        expect(response.status).toBe(400);
      });

      it('rejects a missing message', async () => {
        const response = await request(app)
          .post('/api/system/health/warnings/disk/dismiss')
          .send({});
        expect(response.status).toBe(400);
      });
    });

    describe('DELETE /health/warnings/:type/dismiss', () => {
      it('undoes a dismissal', async () => {
        vi.mocked(updateSettingsWith).mockClear();
        const response = await request(app).delete('/api/system/health/warnings/disk/dismiss');

        expect(response.status).toBe(200);
        expect(response.body).toEqual({ success: true });
        const mutate = vi.mocked(updateSettingsWith).mock.calls[0][0];
        const next = await mutate({ health: { dismissedWarnings: { disk: { message: 'x', dismissedAt: 'y' } } } });
        expect(next.health.dismissedWarnings).toEqual({});
      });

      it('rejects an unknown warning type', async () => {
        const response = await request(app).delete('/api/system/health/warnings/bogus/dismiss');
        expect(response.status).toBe(400);
      });
    });
  });

  describe('GET /health/details — CoS queue depth', () => {
    const live = (taskId) => ({ id: `agent-${taskId}`, taskId, status: 'running', startedAt: new Date().toISOString() });

    beforeEach(() => {
      getStatus.mockResolvedValue({ running: true, paused: false, activeAgents: 1 });
    });

    it('reports the pending tasks no live agent is already working', async () => {
      // Regression: this read `cosStatus.queueLength`, a field getStatus has never
      // returned, so the dashboard's "N queued" was dead and always rendered 0.
      getPendingTaskIds.mockResolvedValueOnce(['user/42', 'sys-7']);
      getAgents.mockResolvedValueOnce([live('user/99')]);

      const response = await request(app).get('/api/system/health/details');

      expect(response.status).toBe(200);
      expect(response.body.cos).toMatchObject({ activeAgents: 1, queuedTasks: 2 });
    });

    it('does not also count the task its running agent already holds', async () => {
      // The spawn window: the agent registers as running a beat before its task
      // leaves 'pending', and the widget read "1 agent · 1 queued" for one task.
      getPendingTaskIds.mockResolvedValueOnce(['user/42']);
      getAgents.mockResolvedValueOnce([live('user/42')]);

      const response = await request(app).get('/api/system/health/details');

      expect(response.body.cos).toMatchObject({ activeAgents: 1, queuedTasks: 0 });
    });

    it('takes active and queued off the SAME agent read, so the two cannot skew', async () => {
      // Pairing getStatus()'s own tally with a separately-read queue is the
      // defect one layer down (services/activeProcessing.js) — here it would
      // report the daemon's stale count beside a freshly-settled queue.
      getStatus.mockResolvedValue({ running: true, paused: false, activeAgents: 7 });
      getPendingTaskIds.mockResolvedValueOnce(['user/42']);
      getAgents.mockResolvedValueOnce([live('user/99'), live('user/98')]);

      const response = await request(app).get('/api/system/health/details');

      expect(response.body.cos).toMatchObject({ activeAgents: 2, queuedTasks: 1 });
    });

    it('falls back to the daemon tally when the agent list cannot be read', async () => {
      getPendingTaskIds.mockResolvedValueOnce(['user/42']);
      getAgents.mockRejectedValueOnce(new Error('state unreadable'));

      const response = await request(app).get('/api/system/health/details');

      // No claim set to subtract, so the queue over-reports rather than hiding
      // work — the safe direction — and active falls back rather than reading 0.
      expect(response.body.cos).toMatchObject({ activeAgents: 1, queuedTasks: 1 });
    });

    it('reports an unreadable pending list as unknown rather than as an empty queue', async () => {
      getPendingTaskIds.mockRejectedValueOnce(new Error('task file unreadable'));

      const response = await request(app).get('/api/system/health/details');

      expect(response.body.cos.queuedTasks).toBeNull();
    });
  });
});
