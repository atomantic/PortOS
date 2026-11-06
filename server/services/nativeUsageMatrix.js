import { buildNativeUsageMatrix } from '../lib/nativeUsageContract.js';
import { captureNativeUsageReport, getNativeUsageAccountSelections } from './nativeUsageReport.js';

// Dashboard requests must not inherit the standalone capture's 30-minute budget.
// These caps apply independently to each retained provider. They cannot be raised
// by HTTP input; incomplete inventories remain visibly partial/refused.
export const NATIVE_USAGE_DASHBOARD_LIMITS = Object.freeze({
  bytes: 128 * 1024 ** 2, lineBytes: 1024 ** 2, entries: 30000, records: 100000, milliseconds: 5000, depth: 8,
});

const pick = (value, fields) => Object.fromEntries(fields.filter(field => Object.hasOwn(value, field)).map(field => [field, value[field]]));
const PROVIDER_FIELDS = ['family', 'source', 'validator', 'status', 'completeness', 'retention', 'runtime', 'scope',
  'accountContext', 'dateBoundary', 'freshness', 'missingIntervals', 'scanCaps', 'reproducibility', 'duplicates',
  'coverage', 'steps', 'cacheOverlap', 'tokenFields', 'totals', 'cost', 'attribution', 'findings', 'nativeUsageCoverage', 'nativeAgyCoverage'];
const ACCOUNT_FIELDS = ['accountLabel', 'identityBasis', 'authoritativeParticipant', 'historyScope', 'members',
  'membersWithoutReport', 'status', 'completeness', 'retention', 'freshness', 'coverage', 'totals', 'findings', 'cost', 'attribution'];

/** Local observations and selected-account diagnostics, never a fleet snapshot.
 * The full contract contains hashed record identities for offline deduplication;
 * this HTTP projection deliberately has no per-record arrays or source paths.
 */
async function readLocalMatrix() {
  const report = await captureNativeUsageReport({ limits: NATIVE_USAGE_DASHBOARD_LIMITS });
  const matrix = buildNativeUsageMatrix({ reports: [report], selections: await getNativeUsageAccountSelections() });
  return {
    mode: 'read-only', scope: 'local-instance', contractVersion: matrix.contractVersion,
    generatedAt: new Date().toISOString(), capturedAt: report.capturedAt,
    ledgerChanged: false, peerReports: 'not-collected', participantKey: report.participantKey,
    providers: report.providers.map(provider => pick(provider, PROVIDER_FIELDS)),
    families: matrix.families.map(family => ({
      family: family.family, scope: family.scope, merge: family.merge,
      unresolvedParticipants: family.unresolvedParticipants ?? [],
      accounts: (family.accounts ?? []).map(account => ({
        ...pick(account, ACCOUNT_FIELDS),
        // Codex preserves source totals for offline diagnostics even when the
        // selection is refused. HTTP selected-account results must fail closed.
        ...(family.merge.status === 'refused' ? { status: 'refused', totals: null } : {}),
      })),
    })),
    refusals: matrix.refusals,
  };
}

let pendingRead = null;

/** Coalesce concurrent reads, not completed snapshots. Every later click reads
 * native sources again; a failed refresh can never return an old success.
 */
export function getNativeUsageMatrix() {
  pendingRead ??= readLocalMatrix()
    .catch(() => { throw new Error('Native usage capture failed. Existing usage records are unchanged.'); })
    .finally(() => { pendingRead = null; });
  return pendingRead;
}
