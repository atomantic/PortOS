import { describe, expect, it, vi } from 'vitest';

const scan = vi.hoisted(() => ({ coverage: { files: 0, records: 0, measuredRecords: 0, missingUsageRecords: 0, missingIdentityRecords: 0,
  duplicateRecords: 0, conflictingRecords: 0, invalidLines: 0, undatedRecords: 0, unreadableFiles: 0, skippedLinks: 0, missingSource: true,
  capped: false, stoppedEarly: false, oversizedLines: 0, streamingSupersededRecords: 0, unfinalizedRecords: 0, fieldInconsistentRecords: 0,
  runtimeVersions: [], steps: null, cacheOverlap: null, costTickRecords: null, firstObservedAt: null, lastObservedAt: null }, status: 'unavailable', summary: null }));
vi.mock('./codexAppServer.js', () => ({ getCodexAccountUsageEvidence: vi.fn(async () => ({ failureCode: 'CODEX_APP_SERVER_TIMEOUT' })) }));
vi.mock('./instanceIdentity.js', () => ({ getInstanceId: vi.fn(async () => 'synthetic-instance') }));
vi.mock('./settings.js', () => ({ getSettingsWithStatus: vi.fn() }));
vi.mock('./nativeTranscriptCoverage.js', () => ({ getNativeTranscriptCoverage: vi.fn(async () => scan) }));
vi.mock('./nativeAgyUsageCoverage.js', () => ({ getNativeAgyUsageCoverage: vi.fn(async () => scan) }));
vi.mock('./nativeGrokUsageCoverage.js', () => ({ getNativeGrokUsageCoverage: vi.fn(async () => scan) }));
import { getNativeAgyUsageCoverage } from './nativeAgyUsageCoverage.js';
import { getNativeGrokUsageCoverage } from './nativeGrokUsageCoverage.js';
import { getNativeTranscriptCoverage } from './nativeTranscriptCoverage.js';
import { captureDashboardNativeUsageReport, NATIVE_USAGE_DASHBOARD_LIMITS } from './nativeUsageReport.js';

describe('explicit read deadline', () => {
  it('gives all providers one deadline, so their budgets cannot add up', async () => {
    const started = Date.now();
    const { contractVersion } = await captureDashboardNativeUsageReport();
    expect(contractVersion).toBe(5);
    const deadlines = [getNativeTranscriptCoverage.mock.calls[0][1], getNativeAgyUsageCoverage.mock.calls[0][0], getNativeGrokUsageCoverage.mock.calls[0][0]].map(({ deadline }) => deadline);
    expect(new Set(deadlines).size).toBe(1);
    expect(deadlines[0] - started).toBeLessThan(NATIVE_USAGE_DASHBOARD_LIMITS.milliseconds + 5000);
  });
});
