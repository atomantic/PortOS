import { homedir } from 'node:os';
import { buildNativeUsageReport, NATIVE_USAGE_ACCOUNT_SELECTIONS_KEY } from '../lib/nativeUsageContract.js';
import { getInstanceId } from './instanceIdentity.js';
import { getNativeTranscriptCoverage } from './nativeTranscriptCoverage.js';
import { getSettingsWithStatus } from './settings.js';

// A capture runs in its own CLI process and must cover the whole retained history,
// unlike the dashboard scan, which has to answer inside a request.
export const NATIVE_USAGE_CAPTURE_LIMITS = Object.freeze({
  bytes: 512 * 1024 ** 3, lineBytes: 64 * 1024 ** 2, entries: 5_000_000, records: 50_000_000, milliseconds: 30 * 60_000, depth: 8,
});

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
  for (const family of ['agy', 'claude', 'grok']) transcripts[family] = await getNativeTranscriptCoverage(family, { home, limits });
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
