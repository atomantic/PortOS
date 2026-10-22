import { describe, it, expect, vi } from 'vitest';

// The pure rule/dismissal functions need none of the probes; stub the modules
// so importing the file does not instantiate the CoS/DB/PM2 graph.
vi.mock('./pm2.js', () => ({ listProcessesStrict: vi.fn() }));
vi.mock('./appProcessStatus.js', () => ({ getAppStatusSummary: vi.fn(), annotateExpectedExit: vi.fn() }));
vi.mock('./cos.js', () => ({}));
vi.mock('./instanceIdentity.js', () => ({ getSelf: vi.fn() }));
vi.mock('../lib/db.js', () => ({ checkHealth: vi.fn() }));
vi.mock('./updateChecker.js', () => ({ getCurrentVersion: vi.fn() }));
vi.mock('../lib/memoryStats.js', () => ({ getMemoryStats: vi.fn() }));
vi.mock('./github.js', () => ({ checkGhHealth: vi.fn() }));
vi.mock('./mediaCapacity.js', () => ({ getMediaCapacity: vi.fn() }));
const updateSettingsWith = vi.hoisted(() => vi.fn());
vi.mock('./settings.js', () => ({ getSettingsWithStatus: vi.fn(), updateSettingsWith }));

const {
  _buildHealthWarnings: buildHealthWarnings,
  _reconcileDismissals: reconcileDismissals,
  _pruneStaleDismissals: pruneStaleDismissals
} = await import('./systemHealthSnapshot.js');

const healthyInputs = (overrides = {}) => ({
  thresholdsAvailable: true,
  thresholds: { diskWarn: 90, diskCritical: 98 },
  diskStats: {},
  disk: { usagePercent: 10 },
  dataDisk: { usagePercent: 10 },
  sameFilesystem: false,
  pm2Processes: [],
  processStats: { errored: 0, unstableRestarts: 0 },
  supervised: [],
  appStatusSummary: {},
  appStats: { degraded: false },
  cosStatus: {},
  cosPendingTaskIds: [],
  cosAgents: [],
  dbHealth: { connected: true, hasSchema: true },
  forgeHealth: { ok: true },
  reviewerConfigHealth: { configFaults: {} },
  ...overrides
});

describe('buildHealthWarnings', () => {
  it('emits nothing for a healthy snapshot', () => {
    expect(buildHealthWarnings(healthyInputs())).toEqual([]);
  });

  it('reports unavailable probes as non-dismissible', () => {
    const sample = buildHealthWarnings(healthyInputs({ pm2Processes: null, processStats: null, dataDisk: null }));
    expect(sample.map(w => w.source)).toEqual(['data-disk', 'pm2']);
    expect(sample.every(w => w.dismissible === false && w.type === 'probe-unavailable')).toBe(true);
  });

  it('uses one threshold ladder for root and data disks', () => {
    const warnings = buildHealthWarnings(healthyInputs({
      disk: { usagePercent: 91 }, dataDisk: { usagePercent: 99 }
    }));
    expect(warnings).toEqual([
      { type: 'disk', severity: 'warning', message: 'Disk usage at or above 90%' },
      { type: 'data-disk', severity: 'critical', message: 'Runtime data disk usage at or above 98%' }
    ]);
  });

  it('keeps one warning identity on a shared volume and forces non-dismissible when settings are unavailable', () => {
    const warnings = buildHealthWarnings(healthyInputs({
      thresholdsAvailable: false, sameFilesystem: true,
      disk: { usagePercent: 50 }, dataDisk: { usagePercent: 95 }
    }));
    expect(warnings.map(w => w.type)).toEqual(['health-settings', 'disk']);
    expect(warnings.every(w => w.dismissible === false)).toBe(true);
  });
});

describe('reconcileDismissals', () => {
  const warning = { type: 'disk', severity: 'warning', message: 'Disk usage at or above 90%' };

  it('suppresses a dismissal that is still current', () => {
    const dismissed = { disk: { message: warning.message, dismissedAt: 't' } };
    expect(reconcileDismissals([warning], dismissed, true, new Map()))
      .toEqual({ warnings: [], staleDismissals: [] });
  });

  it('shows a changed message again and marks the old dismissal stale', () => {
    const dismissed = { disk: { message: 'Disk usage at or above 80%', dismissedAt: 't' } };
    const result = reconcileDismissals([warning], dismissed, true, new Map());
    expect(result.warnings).toEqual([warning]);
    expect(result.staleDismissals).toEqual([['disk', dismissed.disk]]);
  });

  it('keeps a warning visible while its dismissal awaits a prune', () => {
    const dismissal = { message: warning.message, dismissedAt: 't' };
    const result = reconcileDismissals([warning], { disk: dismissal }, true, new Map([['disk', { ...dismissal }]]));
    expect(result.warnings).toEqual([warning]);
    expect(result.staleDismissals).toEqual([['disk', dismissal]]);
  });

  it('never reports stale dismissals while settings are unavailable', () => {
    expect(reconcileDismissals([], { disk: { message: 'x' } }, false, new Map()).staleDismissals).toEqual([]);
  });
});

describe('pruneStaleDismissals', () => {
  it('logs and swallows a failed settings write', async () => {
    updateSettingsWith.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 'EIO' }));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const dismissal = { message: 'm' };
    await expect(pruneStaleDismissals([['gone', dismissal]], { gone: dismissal })).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('type=gone, error=EIO'));
    spy.mockRestore();
  });
});
