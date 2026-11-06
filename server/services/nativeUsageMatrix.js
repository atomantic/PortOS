import { buildNativeUsageMatrix, nativeUsageAccountSelectionsSchema, nativeUsageParticipantKey } from '../lib/nativeUsageContract.js';
import { captureDashboardNativeUsageReport, getNativeUsageAccountSelections } from './nativeUsageReport.js';
import { getInstanceId } from './instanceIdentity.js';
export { NATIVE_USAGE_DASHBOARD_LIMITS } from './nativeUsageReport.js';

const pick = (value, fields) => Object.fromEntries(fields.filter(field => Object.hasOwn(value, field)).map(field => [field, value[field]]));
const PROVIDER_FIELDS = ['family', 'source', 'validator', 'status', 'completeness', 'retention', 'runtime', 'scope',
  'accountContext', 'dateBoundary', 'freshness', 'missingIntervals', 'scanCaps', 'reproducibility', 'duplicates',
  'coverage', 'steps', 'cacheOverlap', 'tokenFields', 'totals', 'cost', 'attribution', 'findings', 'nativeUsageCoverage', 'nativeAgyCoverage'];
const ACCOUNT_FIELDS = ['accountLabel', 'identityBasis', 'authoritativeParticipant', 'historyScope', 'members',
  'membersWithoutReport', 'status', 'completeness', 'retention', 'freshness', 'coverage', 'totals', 'findings', 'cost', 'attribution'];

/** Local observations stay separate from selected-account unions. Only the
 * paired report protocol carries hashed record identities for deduplication;
 * the browser projection never includes per-record arrays or source paths.
 */
async function readMatrix(scope) {
  const localKey = scope === 'fleet' ? nativeUsageParticipantKey(await getInstanceId()) : null;
  const fleet = scope === 'fleet' ? await import('./nativeUsageFleet.js') : null;
  const [report, collection] = await Promise.all([
    captureDashboardNativeUsageReport(),
    fleet ? fleet.collectNativeUsagePeerReports(localKey) : null,
  ]);
  if (scope === 'fleet' && report.participantKey !== localKey) throw new Error('Local participant changed during capture');
  // Resolve the selection after the network wait; configuration stays local and
  // never travels with the reports. Equal counters are not account identity.
  const selections = await getNativeUsageAccountSelections();
  if (collection) await fleet.revalidateNativeUsagePeerCollection(collection);
  const reports = [report, ...(collection?.reports ?? [])];
  const matrix = buildNativeUsageMatrix({ reports, selections });
  if (collection) {
    const parsed = nativeUsageAccountSelectionsSchema.safeParse(selections);
    const known = new Set([report.participantKey, ...collection.peerCollection.peers.map(peer => peer.participantKey)]);
    for (const key of new Set((parsed.success ? parsed.data : []).flatMap(selection => selection.members))) {
      if (known.has(key)) continue;
      collection.peerCollection.peers.push({ participantKey: key,
        status: collection.peerCollection.findings.includes('peer-inventory-truncated') ? 'not-collected' : 'not-configured', capturedAt: null });
      if (collection.peerCollection.status === 'complete') collection.peerCollection.status = 'partial';
    }
  }
  return {
    mode: 'read-only', scope: collection ? 'configured-peers' : 'local-instance', contractVersion: matrix.contractVersion,
    generatedAt: new Date().toISOString(), capturedAt: report.capturedAt,
    ledgerChanged: false, peerReports: collection ? 'collected' : 'not-collected', participantKey: report.participantKey,
    ...(collection ? {
      peerCollection: collection.peerCollection,
      participants: reports.map(source => ({ participantKey: source.participantKey, capturedAt: source.capturedAt,
        providers: source.providers.map(provider => pick(provider, PROVIDER_FIELDS)),
      })),
    } : {}),
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

const pendingReads = new Map();

/** Coalesce concurrent reads, not completed snapshots. Every later click reads
 * native sources again; a failed refresh can never return an old success.
 */
export function getNativeUsageMatrix({ scope = 'local' } = {}) {
  if (!['local', 'fleet'].includes(scope)) throw new Error('Unsupported native usage scope');
  if (!pendingReads.has(scope)) pendingReads.set(scope, readMatrix(scope)
    .catch(() => { throw new Error('Native usage capture failed. Existing usage records are unchanged.'); })
    .finally(() => { pendingReads.delete(scope); }));
  return pendingReads.get(scope);
}
