/**
 * Scheduled broker recheck — per-purpose subject selection (#8332).
 *
 * The scheduled run is the unattended path, so it is where a too-broad consent
 * check would disclose without anyone clicking anything. Pins that each pass
 * runs ONLY for subjects holding an active grant of that exact purpose: a
 * local-vault-only (or revoked) subject gets neither pass, and a scan-only
 * grant never triggers the submission pass.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { listSubjectsMock, runScanPassMock, runOptOutPassMock, scheduleMock, getSettingsMock, updateSettingsWithMock, prevRunMock } = vi.hoisted(() => ({
  scheduleMock: vi.fn(),
  getSettingsMock: vi.fn(),
  updateSettingsWithMock: vi.fn(async () => ({})),
  prevRunMock: vi.fn(),
  listSubjectsMock: vi.fn(),
  runScanPassMock: vi.fn(async () => ({})),
  runOptOutPassMock: vi.fn(async () => ({})),
}));

vi.mock('./privacySubjects.js', () => ({ listSubjects: listSubjectsMock }));
vi.mock('./privacyScan.js', () => ({ runScanPass: runScanPassMock }));
vi.mock('./privacyOptOut.js', () => ({ runOptOutPass: runOptOutPassMock }));
vi.mock('./eventScheduler.js', async (importOriginal) => {
  const real = await importOriginal();
  scheduleMock.mockImplementation((config) => config.type === 'once' ? real.schedule(config) : undefined);
  return { schedule: scheduleMock, cancel: vi.fn(real.cancel), parseCronToNextRun: vi.fn(), parseCronToPrevRun: prevRunMock };
});
vi.mock('./settings.js', () => ({ getSettings: getSettingsMock, updateSettingsWith: updateSettingsWithMock }));
vi.mock('./userTimezone.js', () => ({ getUserTimezone: vi.fn(async () => 'UTC') }));

const { startPrivacyRecheckScheduler, getPrivacyRecheckStatus, __resetCatchUpForTests } = await import('./privacyRecheckScheduler.js');

// Register the cron, then fire its handler the way the event scheduler would.
const runScheduledRecheck = async () => {
  await startPrivacyRecheckScheduler();
  const { handler } = scheduleMock.mock.calls.at(-1)[0];
  await handler();
};

const ranFor = (mock) => mock.mock.calls.map(([arg]) => arg.subjectId);

const SLOT = new Date('2026-10-18T04:00:00.000Z');
const setRecheck = (recheck) => getSettingsMock.mockResolvedValue({ privacy: { recheck } });

beforeEach(() => {
  vi.clearAllMocks();
  __resetCatchUpForTests();
  setRecheck({ enabled: true });
  prevRunMock.mockReturnValue(SLOT);
  listSubjectsMock.mockResolvedValue([
    { id: 'vault-only', activeScopes: ['pii_vault'] },
    { id: 'scan-only', activeScopes: ['broker_scan', 'pii_vault'] },
    { id: 'both', activeScopes: ['broker_optout', 'broker_scan', 'pii_vault'] },
    // Revoked grants are excluded from activeScopes by listSubjects.
    { id: 'revoked', activeScopes: [] },
  ]);
});

describe('runScheduledRecheck', () => {
  it('selects subjects per purpose from their active grants', async () => {
    await runScheduledRecheck();
    expect(ranFor(runScanPassMock)).toEqual(['scan-only', 'both']);
    expect(ranFor(runOptOutPassMock)).toEqual(['both']);
  });

  it("one subject's failed pass does not stop the other purpose or subjects", async () => {
    runScanPassMock.mockRejectedValueOnce(new Error('broker down'));
    await runScheduledRecheck();
    expect(ranFor(runScanPassMock)).toEqual(['scan-only', 'both']);
    expect(ranFor(runOptOutPassMock)).toEqual(['both']);
  });
});

describe('lastRunAt persistence', () => {
  it('stamps lastRunAt after a run, even when a subject failed, and status returns it', async () => {
    runScanPassMock.mockRejectedValueOnce(new Error('broker down'));
    await runScheduledRecheck();
    const mutate = updateSettingsWithMock.mock.calls.at(-1)[0];
    const next = mutate({ privacy: { recheck: { enabled: true, cronExpression: '0 4 * * 0' } } });
    expect(next.privacy.recheck.enabled).toBe(true);
    expect(Date.parse(next.privacy.recheck.lastRunAt)).not.toBeNaN();

    setRecheck({ enabled: true, lastRunAt: '2026-10-18T04:01:00.000Z' });
    expect((await getPrivacyRecheckStatus()).lastRunAt).toBe('2026-10-18T04:01:00.000Z');
  });
});

describe('missed-slot catch-up', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const bootAndAdvance = async () => {
    await startPrivacyRecheckScheduler({ catchUpMissedSlot: true });
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
  };

  it('runs exactly one catch-up when the last run predates the latest slot', async () => {
    setRecheck({ enabled: true, lastRunAt: '2026-10-11T04:01:00.000Z' });
    await bootAndAdvance();
    expect(runScanPassMock).toHaveBeenCalledTimes(2);
    // A second boot evaluation in the same process never re-arms.
    await bootAndAdvance();
    expect(runScanPassMock).toHaveBeenCalledTimes(2);
  });

  it('schedules none once a run completed after the latest slot', async () => {
    setRecheck({ enabled: true, lastRunAt: '2026-10-18T04:02:00.000Z' });
    await bootAndAdvance();
    expect(runScanPassMock).not.toHaveBeenCalled();
  });

  it('with no lastRunAt, catches up only if enabled before the missed slot', async () => {
    setRecheck({ enabled: true, enabledAt: '2026-10-19T00:00:00.000Z' });
    await bootAndAdvance();
    expect(runScanPassMock).not.toHaveBeenCalled();

    __resetCatchUpForTests();
    setRecheck({ enabled: true, enabledAt: '2026-10-01T00:00:00.000Z' });
    await bootAndAdvance();
    expect(runScanPassMock).toHaveBeenCalledTimes(2);
  });

  it('schedules no catch-up when disabled, or when not a boot-time start', async () => {
    setRecheck({ enabled: false, lastRunAt: '2026-10-01T00:00:00.000Z' });
    await bootAndAdvance();
    setRecheck({ enabled: true, lastRunAt: '2026-10-01T00:00:00.000Z' });
    await startPrivacyRecheckScheduler();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(runScanPassMock).not.toHaveBeenCalled();
  });

  it('skips the catch-up run if disabled before the boot delay elapses', async () => {
    setRecheck({ enabled: true, lastRunAt: '2026-10-01T00:00:00.000Z' });
    await startPrivacyRecheckScheduler({ catchUpMissedSlot: true });
    setRecheck({ enabled: false });
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 1);
    expect(runScanPassMock).not.toHaveBeenCalled();
  });
});
