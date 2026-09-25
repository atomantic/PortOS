/**
 * Scheduled broker recheck — per-purpose subject selection (#8332).
 *
 * The scheduled run is the unattended path, so it is where a too-broad consent
 * check would disclose without anyone clicking anything. Pins that each pass
 * runs ONLY for subjects holding an active grant of that exact purpose: a
 * local-vault-only (or revoked) subject gets neither pass, and a scan-only
 * grant never triggers the submission pass.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { listSubjectsMock, runScanPassMock, runOptOutPassMock } = vi.hoisted(() => ({
  listSubjectsMock: vi.fn(),
  runScanPassMock: vi.fn(async () => ({})),
  runOptOutPassMock: vi.fn(async () => ({})),
}));

vi.mock('./privacySubjects.js', () => ({ listSubjects: listSubjectsMock }));
vi.mock('./privacyScan.js', () => ({ runScanPass: runScanPassMock }));
vi.mock('./privacyOptOut.js', () => ({ runOptOutPass: runOptOutPassMock }));
vi.mock('./eventScheduler.js', () => ({ schedule: vi.fn(), cancel: vi.fn(), parseCronToNextRun: vi.fn() }));
vi.mock('./settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));
vi.mock('./userTimezone.js', () => ({ getUserTimezone: vi.fn(async () => 'UTC') }));

const { runScheduledRecheck } = await import('./privacyRecheckScheduler.js');

const ranFor = (mock) => mock.mock.calls.map(([arg]) => arg.subjectId);

beforeEach(() => {
  vi.clearAllMocks();
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
