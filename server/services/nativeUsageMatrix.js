import { NATIVE_USAGE_ACCOUNT_SELECTIONS_KEY, buildNativeUsageMatrix, nativeUsageAccountSelectionsSchema, nativeUsageParticipantKey, nativeUsageSelectionRevision } from '../lib/nativeUsageContract.js';
import { captureDashboardNativeUsageReport, getNativeUsageAccountSelections } from './nativeUsageReport.js';
import { getInstanceId } from './instanceIdentity.js';
import { settingsEvents } from './settings.js';
export { NATIVE_USAGE_DASHBOARD_LIMITS } from './nativeUsageReport.js';

// Capture finality spans the peer revalidation wait. A settings event supplies a
// synchronous revision fence so no additional settings await can reopen the peer
// authority/freshness window after that final validation.
let selectionChange = 0;
let latestSelectionRevision;
settingsEvents.on('settings:updated', settings => {
  const selections = settings?.[NATIVE_USAGE_ACCOUNT_SELECTIONS_KEY];
  const revision = nativeUsageSelectionRevision(selections === undefined ? [] : selections);
  if (revision !== latestSelectionRevision) selectionChange += 1;
  latestSelectionRevision = revision;
});
settingsEvents.on('settings:invalidated', () => {
  selectionChange += 1;
  latestSelectionRevision = null;
});

const pick = (value, fields) => Object.fromEntries(fields.filter(field => Object.hasOwn(value, field)).map(field => [field, value[field]]));
const PROVIDER_FIELDS = ['family', 'source', 'validator', 'status', 'completeness', 'retention', 'runtime', 'scope',
  'accountContext', 'dateBoundary', 'freshness', 'missingIntervals', 'scanCaps', 'reproducibility', 'duplicates',
  'coverage', 'steps', 'cacheOverlap', 'tokenFields', 'totals', 'cost', 'attribution', 'findings', 'nativeUsageCoverage', 'nativeAgyCoverage'];
const ACCOUNT_FIELDS = ['accountLabel', 'identityBasis', 'authoritativeParticipant', 'historyScope', 'members',
  'membersWithoutReport', 'status', 'completeness', 'retention', 'freshness', 'totals', 'modelTotals', 'findings', 'cost', 'attribution'];

/** Machine totals add, per #15252. Account selections group machines and pick one
 * Codex authority. The browser projection never includes per-record arrays or source paths.
 */
async function readMatrix(scope) {
  const localKey = scope === 'fleet' ? nativeUsageParticipantKey(await getInstanceId()) : null;
  const fleet = scope === 'fleet' ? await import('./nativeUsageFleet.js') : null;
  const [report, collection] = await Promise.all([
    captureDashboardNativeUsageReport(),
    fleet ? fleet.collectNativeUsagePeerReports(localKey) : null,
  ]);
  if (scope === 'fleet' && report.participantKey !== localKey) throw new Error('Local participant changed during capture');
  // Selections stay local. Final peer revalidation follows all awaited reads.
  const selectionAtValidation = selectionChange;
  const selections = await getNativeUsageAccountSelections();
  const selectionRevision = nativeUsageSelectionRevision(selections);
  if (collection) await fleet.revalidateNativeUsagePeerCollection(collection);
  if (selectionChange !== selectionAtValidation && latestSelectionRevision !== selectionRevision) {
    throw new Error('Native account selections changed during capture');
  }
  const reports = [report, ...(collection?.reports ?? [])];
  const matrix = buildNativeUsageMatrix({ reports, selections, machineRollups: true });
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
    selectionRevision,
    ledgerChanged: false, peerReports: collection ? 'collected' : 'not-collected', participantKey: report.participantKey,
    ...(collection ? {
      peerCollection: collection.peerCollection,
      participants: reports.map(source => ({ participantKey: source.participantKey, capturedAt: source.capturedAt,
        ...(collection.peerCollection.peers.some(peer => peer.retained && peer.participantKey === source.participantKey) ? { retained: true } : {}),
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
