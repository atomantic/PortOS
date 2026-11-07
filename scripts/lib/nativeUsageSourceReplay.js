/** Replay only caller-verified private source copies, never a live provider runtime. */
import { isAbsolute } from 'node:path';
import { nativeUsageCanonicalJson, nativeUsageReportSchema, projectTranscriptCoverage, reportIsIntact } from '../../server/lib/nativeUsageContract.js';
import { refuseNativeUsageRehearsal as refuse } from '../../server/lib/nativeUsageRehearsal.js';
import { getNativeTranscriptCoverage } from '../../server/services/nativeTranscriptCoverage.js';
import { getNativeGrokUsageCoverage } from '../../server/services/nativeGrokUsageCoverage.js';
import { getNativeAgyUsageCoverage } from '../../server/services/nativeAgyUsageCoverage.js';

const ROLES = ['claudeProjects', 'grokSessions', 'agyCliConversations', 'agyLegacyBrain', 'agyAppConversations', 'agyIdeConversations'];
const FAMILIES = ['agy', 'claude', 'grok'];
// Accept existing capture budgets without rewriting bound projection metadata.
// Source-bundle validation independently bounds the supplied files; a shared
// wall-clock deadline bounds all three readers together to 15 minutes.
export const NATIVE_USAGE_SOURCE_REPLAY_LIMITS = Object.freeze({
  bytes: 512 * 1024 ** 3, lineBytes: 64 * 1024 ** 2, entries: 5_000_000, records: 50_000_000, milliseconds: 30 * 60_000, depth: 64,
});
const REPLAY_MILLISECONDS = 15 * 60_000;

/**
 * All six roots are mandatory absolute paths, including nonexistent paths for
 * absent sources. The caller verifies private copies before and after replay.
 * Entries are internal comparison evidence; publish only family/status, never
 * their record projections. Codex remains bound-report evidence, not replayed.
 */
export async function replayNativeUsageSources(report, roots, { deadline: operationDeadline = Infinity } = {}) {
  const parsed = nativeUsageReportSchema.safeParse(report);
  if (!parsed.success || !reportIsIntact(parsed.data)) refuse('native-source-report-invalid');
  if (!roots || ROLES.some(role => !Object.hasOwn(roots, role) || typeof roots[role] !== 'string'
    || !isAbsolute(roots[role]) || roots[role].includes('\0'))) refuse('native-source-roots-invalid');
  const expected = FAMILIES.map(family => parsed.data.providers.find(entry => entry.family === family));
  // Validate every binding before the first read; never invent fallback limits.
  if (expected.some(entry => !entry?.scanCaps?.limits)) refuse('native-source-scan-limits-missing');
  if (expected.some(entry => Object.entries(NATIVE_USAGE_SOURCE_REPLAY_LIMITS).some(([field, maximum]) => {
    const value = entry.scanCaps.limits[field];
    return !Number.isSafeInteger(value) || value < 0 || value > maximum;
  }))) refuse('native-source-scan-limits-unsupported');
  const deadline = Math.min(operationDeadline, Date.now() + REPLAY_MILLISECONDS);
  const readers = {
    claude: limits => getNativeTranscriptCoverage('claude', { projectsRoot: roots.claudeProjects, limits, deadline, identityLimit: 100000, includeRecords: true }),
    grok: limits => getNativeGrokUsageCoverage({ sessionsRoot: roots.grokSessions, limits, deadline }),
    agy: limits => getNativeAgyUsageCoverage({ cliConversationsRoot: roots.agyCliConversations, legacyBrainRoot: roots.agyLegacyBrain,
      appConversationsRoot: roots.agyAppConversations, ideConversationsRoot: roots.agyIdeConversations, limits, deadline }),
  };
  const providers = [];
  for (const original of expected) {
    if (Date.now() >= deadline) refuse('native-source-replay-deadline-exceeded');
    const limits = original.scanCaps.limits;
    const scan = await readers[original.family](limits);
    if (Date.now() >= deadline) refuse('native-source-replay-deadline-exceeded');
    if (scan.executionLimit) refuse('native-source-identity-limit-exceeded');
    const entry = projectTranscriptCoverage(original.family, scan, limits);
    const matched = nativeUsageCanonicalJson(entry) === nativeUsageCanonicalJson(original);
    providers.push({ family: original.family, status: matched ? 'matched' : 'mismatch', entry });
  }
  return { matched: providers.every(({ status }) => status === 'matched'), providers, codex: { status: 'report-evidence-only' } };
}
