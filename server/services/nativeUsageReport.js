import { homedir } from 'node:os';
import { buildNativeUsageReport, NATIVE_USAGE_ACCOUNT_SELECTIONS_KEY, NATIVE_USAGE_CODEX_RETAINED_FINDING } from '../lib/nativeUsageContract.js';
import { getInstanceId } from './instanceIdentity.js';
import { getNativeTranscriptCoverage } from './nativeTranscriptCoverage.js';
import { getNativeAgyUsageCoverage } from './nativeAgyUsageCoverage.js';
import { getNativeGrokUsageCoverage } from './nativeGrokUsageCoverage.js';
import { getSettingsWithStatus } from './settings.js';

// A capture runs in its own CLI process and must cover the whole retained history,
// unlike a dashboard read, which has to answer inside a request.
export const NATIVE_USAGE_CAPTURE_LIMITS = Object.freeze({
  bytes: 512 * 1024 ** 3, lineBytes: 64 * 1024 ** 2, entries: 5_000_000, records: 50_000_000, milliseconds: 30 * 60_000, depth: 8,
});

// One read's budget, across all providers and inside the 60-second peer deadline. Only
// time really bounds it: finished sources are already saved, so a run that stops here
// is continued by the next one. Callers cannot choose paths or raise caps.
export const NATIVE_USAGE_DASHBOARD_LIMITS = Object.freeze({ ...NATIVE_USAGE_CAPTURE_LIMITS, milliseconds: 45_000 });

const CODEX_SNAPSHOT = ['codex-account', 'latest'];
let pendingDashboardCapture = null;

/** Like the staged capture below, but reads only what changed and reports all it has kept. */
async function captureStoredNativeUsageReport() {
  const limits = NATIVE_USAGE_DASHBOARD_LIMITS;
  const capturedAt = new Date().toISOString();
  // Starts before the Codex read, so that read also spends the peer's deadline.
  const deadline = Date.now() + limits.milliseconds;
  const { getCodexAccountUsageEvidence } = await import('./codexAppServer.js');
  const { collectNativeUsageSources } = await import('./nativeUsageCollection.js');
  const { getNativeUsageSnapshot, saveNativeUsageSnapshot } = await import('./nativeUsageStore.js');
  const codexEvidence = await getCodexAccountUsageEvidence();
  const { transcripts } = await collectNativeUsageSources({ limits, deadline });
  const retainedCodexEntry = await getNativeUsageSnapshot(...CODEX_SNAPSHOT);
  const report = buildNativeUsageReport({
    instanceId: await getInstanceId(), capturedAt, codexEvidence, transcripts, scanLimits: limits, retainedCodexEntry,
  });
  // Only the projected entry is kept: the raw account read holds an email.
  const codex = report.providers.find(({ family }) => family === 'codex');
  if (codex.totals && !codex.findings.includes(NATIVE_USAGE_CODEX_RETAINED_FINDING)) await saveNativeUsageSnapshot(...CODEX_SNAPSHOT, codex);
  return report;
}

/** The local UI and authenticated peer endpoint share only an in-flight read. Each read
 * collects what changed since the last one and reports from the store, so nothing is
 * forwarded from another host and no finished read is ever replayed.
 */
export function captureDashboardNativeUsageReport() {
  pendingDashboardCapture ??= captureStoredNativeUsageReport()
    .finally(() => { pendingDashboardCapture = null; });
  return pendingDashboardCapture;
}

/**
 * Capture this participant's staged input for #15031. Reads native files and makes
 * the fixed Codex account reads: no inference, ledger, peer or sync access, and the
 * instance identity is read without being created.
 */
export async function captureNativeUsageReport({ home = homedir(), limits = NATIVE_USAGE_CAPTURE_LIMITS, now = () => new Date() } = {}) {
  const capturedAt = now().toISOString();
  const { getCodexAccountUsageEvidence } = await import('./codexAppServer.js');
  const codexEvidence = await getCodexAccountUsageEvidence();
  const transcripts = {};
  transcripts.claude = await getNativeTranscriptCoverage('claude', { home, limits, includeRecords: true });
  transcripts.agy = await getNativeAgyUsageCoverage({ home, limits });
  transcripts.grok = await getNativeGrokUsageCoverage({ home, limits });
  return buildNativeUsageReport({
    instanceId: await getInstanceId(), capturedAt, codexEvidence, transcripts, scanLimits: limits,
  });
}

/** The stored selection, or `null` when settings are unreadable, which the matrix refuses. */
export async function getNativeUsageAccountSelections() {
  const { settings, corrupt } = await getSettingsWithStatus();
  if (corrupt) return null;
  return settings?.[NATIVE_USAGE_ACCOUNT_SELECTIONS_KEY] ?? [];
}
