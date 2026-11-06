/** Offline staging only. No runtime registration, ledger, settings or peer access. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  buildNativeUsageMatrix,
  NATIVE_USAGE_CONTRACT_VERSION,
  nativeUsageAccountSelectionsSchema,
  nativeUsageCanonicalJson,
  nativeUsageReportSchema,
} from './nativeUsageContract.js';

const FAMILIES = ['agy', 'claude', 'codex', 'grok'];
const hash = value => createHash('sha256').update(nativeUsageCanonicalJson(value)).digest('hex');
const stamped = body => ({ ...body, contentHash: hash(body) });
const sorted = values => [...values].sort();

export const nativeUsageStagingRequestSchema = z.strictObject({
  version: z.literal(1),
  participants: z.array(z.string().regex(/^[0-9a-f]{32}$/)).min(1).max(64)
    .refine(values => new Set(values).size === values.length, 'duplicate participant'),
  selections: nativeUsageAccountSelectionsSchema.refine(values => values.length > 0, 'selection required'),
}).refine(({ participants, selections }) => selections.every(({ members }) => members.every(member => participants.includes(member))), 'member outside participant set');

const refuse = reasons => {
  const error = new Error(`Native usage staging refused: ${sorted(new Set(reasons)).join(', ')}`);
  error.code = 'NATIVE_USAGE_STAGE_REFUSED';
  throw error;
};

// Schema-checked reports can carry nullable historical facts. Neither a cap nor a
// failed read is a complete input set: an omitted copy may contain a conflict.
function incompleteSource(entry) {
  return entry.status === 'unavailable' || entry.status === 'absent'
    || entry.scanCaps?.capped || entry.scanCaps?.stoppedEarly || entry.scanCaps?.oversizedLines > 0
    || entry.reproducibility === 'scan-stopped-early' || entry.recordProjection?.truncated
    || entry.coverage?.missingSource || entry.coverage?.unreadableFiles > 0
    || entry.coverage?.invalidLines > 0 || entry.coverage?.skippedLinks > 0
    || entry.coverage?.missingIdentityRecords > 0
    || entry.nativeUsageCoverage?.invalidSnapshots > 0
    || ['invalidDatabases', 'unsupportedSchemas', 'unstableDatabases', 'invalidMetadata']
      .some(field => entry.nativeAgyCoverage?.[field] > 0);
}

function safeFacts(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value);
  if (typeof value === 'string' && /^(?:\d{4}|[+-]\d{6})-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}\.\d{3}Z)?$/.test(value)) {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) && (value.length === 10 ? date.toISOString().slice(0, 10) : date.toISOString()) === value;
  }
  if (value && typeof value === 'object') return Object.values(value).every(safeFacts);
  return true;
}

function validCodexSnapshot(entry) {
  const totals = entry.totals;
  if (entry.source !== 'codex:account/usage/read' || entry.validator !== 'codex-account-usage/1'
    || entry.scope.kind !== 'account' || entry.accountContext?.status !== 'read'
    || !Number.isSafeInteger(totals?.lifetimeTokens) || !Array.isArray(totals?.dailyBuckets)) return false;
  const days = totals.dailyBuckets.map(({ startDate }) => startDate);
  const sum = totals.dailyBuckets.reduce((total, { tokens }) => total + tokens, 0);
  return new Set(days).size === days.length && Number.isSafeInteger(sum) && sum <= totals.lifetimeTokens;
}

const sourceCoverage = (participant, family) => {
  const { recordProjection: _records, totals: _totals, ...coverage } = participant.providers.find(entry => entry.family === family);
  return { participantKey: participant.participantKey, reportHash: participant.reportHash, capturedAt: participant.capturedAt, ...coverage };
};

/**
 * A reproducible partition artifact, never an additive adjustment or permission
 * to activate. Reports remain embedded so conflict tombstones and earlier source
 * revisions are not lost when a staged subset excludes their records.
 */
export function buildNativeUsageStage({ request, reports }) {
  const parsed = nativeUsageStagingRequestSchema.safeParse(request);
  if (!parsed.success) refuse(['request-invalid']);
  if (!Array.isArray(reports) || !reports.length || reports.length > 128) refuse(['reports-invalid']);
  const inputs = reports.map(report => {
    const result = nativeUsageReportSchema.safeParse(report);
    if (!result.success || !safeFacts(result.data)) refuse(['report-invalid']);
    return result.data;
  });
  const normalizedRequest = {
    version: 1, participants: sorted(parsed.data.participants),
    selections: parsed.data.selections.map(selection => ({ ...selection, members: sorted(selection.members) }))
      .sort((a, b) => `${a.family}:${a.accountLabel}`.localeCompare(`${b.family}:${b.accountLabel}`)),
  };
  const normalizedReports = [...new Map(inputs.map(report => [report.contentHash, report])).values()]
    .sort((a, b) => a.contentHash.localeCompare(b.contentHash));
  // Validate every input before deduplicating hashes: a tampered copy must not
  // disappear behind an intact report carrying the same claimed content hash.
  const matrix = buildNativeUsageMatrix({ reports: inputs, selections: normalizedRequest.selections });
  const families = sorted(new Set(normalizedRequest.selections.map(({ family }) => family)));
  const reasons = matrix.refusals.filter(({ family }) => !family || families.includes(family)).map(({ code }) => code);
  // The matrix selects the latest report per participant. Do not let that hide
  // earlier retained identities/conflicts or move them between account groups.
  // Resolving a revision requires deliberately selecting a fresh input set.
  for (const family of families.filter(value => value !== 'codex')) {
    for (const participant of normalizedRequest.participants) {
      const projections = normalizedReports.filter(report => report.participantKey === participant)
        .map(report => nativeUsageCanonicalJson(report.providers.find(entry => entry.family === family).recordProjection ?? null));
      if (new Set(projections).size > 1) reasons.push(`${family}-retained-source-revised`);
    }
  }
  if (nativeUsageCanonicalJson(matrix.participants.map(({ participantKey }) => participantKey))
    !== nativeUsageCanonicalJson(normalizedRequest.participants)) reasons.push('participant-set-mismatch');
  for (const family of families) {
    const result = matrix.families.find(entry => entry.family === family);
    if (result.merge.status !== 'merged' && result.merge.status !== 'partial') reasons.push(...result.merge.reasons);
    for (const selection of normalizedRequest.selections.filter(entry => entry.family === family)) {
      for (const member of selection.members) {
        const entry = matrix.participants.find(participant => participant.participantKey === member)?.providers.find(provider => provider.family === family);
        if (!entry || incompleteSource(entry)) reasons.push(`${family}-source-incomplete`);
        if (entry && family === 'codex' && !validCodexSnapshot(entry)) reasons.push('codex-snapshot-invalid');
      }
    }
  }
  if (reasons.length) refuse(reasons);

  const partitions = families.flatMap(family => {
    const result = matrix.families.find(entry => entry.family === family);
    return result.accounts.map(account => stamped({
      version: 1, kind: 'native-usage-account-partition', family, scope: result.scope,
      ...account,
      completeness: 'unknown', retention: 'unknown',
      cost: account.cost ?? { estimatedApiEquivalentUsd: null, actualSpendUsd: null },
      attribution: 'excluded',
      sourceCoverage: matrix.participants.filter(({ participantKey }) => account.members.includes(participantKey))
        .map(participant => sourceCoverage(participant, family)),
      legacy: { policy: 'preserve-separately', overlap: 'unknown', additiveAdjustment: null },
    }));
  });
  const manifest = {
    version: 1, producer: 'native-usage-staging/1', reportContractVersion: NATIVE_USAGE_CONTRACT_VERSION,
    participants: normalizedRequest.participants,
    selections: normalizedRequest.selections, selectionsHash: hash(normalizedRequest.selections),
    reports: normalizedReports.map(({ contractVersion, participantKey, capturedAt, contentHash, evidenceHash }) => (
      { contractVersion, participantKey, capturedAt, contentHash, evidenceHash }
    )),
    partitions: partitions.map(({ family, accountLabel, contentHash }) => ({ family, accountLabel, contentHash })),
    legacy: { policy: 'preserve-separately', unselectedFamilies: FAMILIES.filter(family => !families.includes(family)), overlap: 'unknown' },
    activation: { ready: false, reasons: [
      'runtime-not-registered', 'backup-restore-not-verified', 'barrier-not-verified',
      'fenced-interval-not-verified', 'source-freshness-not-verified-at-cutover',
    ] },
  };
  return stamped({ version: 1, kind: 'native-usage-stage', inputs: { request: normalizedRequest, reports: normalizedReports }, manifest, partitions });
}

/** Rebuild from the bound inputs, rather than trusting an editable ready flag. */
export function verifyNativeUsageStage(artifact) {
  if (!artifact || artifact.kind !== 'native-usage-stage' || artifact.version !== 1 || !artifact.inputs) refuse(['artifact-invalid']);
  const rebuilt = buildNativeUsageStage(artifact.inputs);
  if (nativeUsageCanonicalJson(artifact) !== nativeUsageCanonicalJson(rebuilt)) refuse(['artifact-mismatch']);
  return rebuilt;
}
