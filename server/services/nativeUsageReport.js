import { homedir } from 'node:os';
import { buildNativeUsageReport, buildNativeUsageRollupReport, NATIVE_USAGE_ACCOUNT_SELECTIONS_KEY, NATIVE_USAGE_CODEX_RETAINED_FINDING, nativeUsageCodexEntry } from '../lib/nativeUsageContract.js';
import { getInstanceId } from './instanceIdentity.js';
import { getNativeTranscriptCoverage } from './nativeTranscriptCoverage.js';
import { getNativeAgyUsageCoverage } from './nativeAgyUsageCoverage.js';
import { getNativeGrokUsageCoverage } from './nativeGrokUsageCoverage.js';
import { getSettingsWithStatus } from './settings.js';

// A capture runs in its own CLI process.
export const NATIVE_USAGE_CAPTURE_LIMITS = Object.freeze({
  bytes: 512 * 1024 ** 3, lineBytes: 64 * 1024 ** 2, entries: 5_000_000, records: 50_000_000, milliseconds: 30 * 60_000, depth: 8,
});

// An explicit read also covers the whole retained history (#15252). Only time bounds it:
// 45 seconds stays inside the 60-second peer request deadline. Finished sources are saved,
// so a read that stops there is continued by the next one (#15255). Callers cannot choose
// paths or raise caps.
export const NATIVE_USAGE_DASHBOARD_LIMITS = Object.freeze({ ...NATIVE_USAGE_CAPTURE_LIMITS, milliseconds: 45_000 });

// One deadline across providers: separate budgets would add up past the peer deadline.
async function readNativeSources({ home, limits, now }) {
  const capturedAt = now().toISOString();
  const deadline = Date.now() + limits.milliseconds;
  const { getCodexAccountUsageEvidence } = await import('./codexAppServer.js');
  const [codexEvidence, claude, agy, grok] = await Promise.all([
    getCodexAccountUsageEvidence(),
    getNativeTranscriptCoverage('claude', { home, limits, deadline, includeRecords: true }),
    getNativeAgyUsageCoverage({ home, limits, deadline }),
    getNativeGrokUsageCoverage({ home, limits, deadline }),
  ]);
  return { instanceId: await getInstanceId(), capturedAt, codexEvidence, transcripts: { claude, agy, grok }, scanLimits: limits };
}

const CODEX_SNAPSHOT = ['codex-account', 'latest'];

/** Like the staged read above, but collects only what changed and reports all it has kept. */
async function readStoredNativeSources() {
  const limits = NATIVE_USAGE_DASHBOARD_LIMITS;
  const capturedAt = new Date().toISOString();
  const deadline = Date.now() + limits.milliseconds;
  const { getCodexAccountUsageEvidence } = await import('./codexAppServer.js');
  const { collectNativeUsageSources } = await import('./nativeUsageCollection.js');
  const { getNativeUsageSnapshot, saveNativeUsageSnapshot } = await import('./nativeUsageStore.js');
  const [codexEvidence, { transcripts }] = await Promise.all([getCodexAccountUsageEvidence(), collectNativeUsageSources({ limits, deadline })]);
  const retainedCodexEntry = await getNativeUsageSnapshot(...CODEX_SNAPSHOT);
  // Only the projected entry is kept: the raw account read holds an email.
  const codex = nativeUsageCodexEntry(codexEvidence, capturedAt, retainedCodexEntry);
  if (codex.totals && !codex.findings.includes(NATIVE_USAGE_CODEX_RETAINED_FINDING)) await saveNativeUsageSnapshot(...CODEX_SNAPSHOT, codex);
  return { instanceId: await getInstanceId(), capturedAt, codexEvidence, transcripts, scanLimits: limits, retainedCodexEntry };
}

let pendingDashboardRead = null;

/** The local UI and authenticated peers share only an in-flight read. Each read collects
 * what changed since the last one and reports from the store, so nothing is forwarded from
 * another host and no finished read is replayed. Everything gets rollups, except a peer
 * on an older version, which asks for v4 record lists.
 */
export async function captureDashboardNativeUsageReport({ recordLists = false } = {}) {
  pendingDashboardRead ??= readStoredNativeSources()
    .finally(() => { pendingDashboardRead = null; });
  const read = await pendingDashboardRead;
  return recordLists ? buildNativeUsageReport(read) : buildNativeUsageRollupReport(read);
}

/**
 * Capture this participant's staged input for #15031. Reads native files and makes
 * the fixed Codex account reads: no inference, ledger, peer or sync access, and the
 * instance identity is read without being created.
 */
export async function captureNativeUsageReport({ home = homedir(), limits = NATIVE_USAGE_CAPTURE_LIMITS, now = () => new Date() } = {}) {
  return buildNativeUsageReport(await readNativeSources({ home, limits, now }));
}

/** The stored selection, or `null` when settings are unreadable, which the matrix refuses. */
export async function getNativeUsageAccountSelections() {
  const { settings, corrupt } = await getSettingsWithStatus();
  if (corrupt) return null;
  return settings?.[NATIVE_USAGE_ACCOUNT_SELECTIONS_KEY] ?? [];
}
