/**
 * Read-only provider/account coverage contract consumed by the staged usage
 * recovery (#15031). Pure: no file, provider, ledger or sync access.
 *
 * Three rules shape everything here:
 *  - Unknown stays `unknown`/`null`, never 0. A refused merge has `totals: null`.
 *  - Equal totals never establish account identity. Codex's runtime exposes no id
 *    that is safe to publish (`account/read` holds an email, and hashing one is
 *    dictionary-reversible), so `accountKey` is always null and only an operator
 *    selection can group participants.
 *  - Tokens, API-equivalent estimates and actual spend stay separate. PortOS run
 *    attribution is not a counter and is excluded.
 *
 * `evidenceHash` covers only source-derived facts, so an unchanged source re-hashes
 * equal at a later capture time. `contentHash` also covers the capture time.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { CODEX_ERROR_CODES } from './codexAccount.js';
import { canonicalStringify } from './objects.js';
import { nativeUsageRecordProjectionSchema, unionNativeClaudeRecords } from './nativeUsageRecords.js';
import { nativeAgyUsageProjectionSchema, unionNativeAgyRecords } from './nativeAgyUsageRecords.js';
import { nativeGrokUsageProjectionSchema, unionNativeGrokRecords } from './nativeGrokUsageRecords.js';

export const NATIVE_USAGE_CONTRACT_VERSION = 4;
export const NATIVE_USAGE_ACCOUNT_SELECTIONS_KEY = 'usageNativeAccountSelections';

const FAMILIES = ['agy', 'claude', 'codex', 'grok'];
const TRANSCRIPT_FAMILIES = ['agy', 'claude', 'grok'];
const MAX_MISSING_INTERVALS = 64;
const DAY_MS = 86_400_000;

const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const hashOf = (value) => sha256(canonicalStringify(value));

const MEASURED = 'measured';
const UNSUPPORTED = 'unsupported';
const UNVERIFIED = 'unverified';
const MACHINE_AGGREGATION = 'do-not-sum-across-instances';
const UTC_INSTANTS = { kind: 'utc-instant', timezone: 'UTC' };

const PROVIDER_CONTRACTS = {
  codex: {
    source: 'codex:account/usage/read', validator: 'codex-account-usage/1', scopeKind: 'account',
    aggregation: 'once-per-account', dateBoundary: { kind: 'provider-calendar-day', timezone: null },
    tokenFields: { totalTokens: MEASURED, tokensIn: UNSUPPORTED, tokensOut: UNSUPPORTED, cacheReadTokens: UNSUPPORTED, cacheWriteTokens: UNSUPPORTED },
  },
  claude: {
    source: 'claude:retained-transcripts', validator: 'claude-retained-messages/1', scopeKind: 'machine',
    aggregation: MACHINE_AGGREGATION, dateBoundary: UTC_INSTANTS,
    tokenFields: { totalTokens: 'derived-from-disjoint-fields', tokensIn: MEASURED, tokensOut: MEASURED, cacheReadTokens: MEASURED, cacheWriteTokens: MEASURED },
  },
  agy: {
    source: 'agy:retained-transcripts', validator: 'agy-retained-steps/1', scopeKind: 'machine',
    aggregation: MACHINE_AGGREGATION, dateBoundary: UTC_INSTANTS,
    tokenFields: { totalTokens: 'unverified-overlap', tokensIn: MEASURED, tokensOut: MEASURED, cacheReadTokens: MEASURED, cacheWriteTokens: UNSUPPORTED },
  },
  grok: {
    source: 'grok:retained-transcripts', validator: 'grok-retained-turns/1', scopeKind: 'machine',
    aggregation: MACHINE_AGGREGATION, dateBoundary: UTC_INSTANTS,
    tokenFields: { totalTokens: UNVERIFIED, tokensIn: UNVERIFIED, tokensOut: UNVERIFIED, cacheReadTokens: UNVERIFIED, cacheWriteTokens: UNVERIFIED },
  },
};

const participantKey = z.string().regex(/^[0-9a-f]{32}$/);
const contentHash = z.string().regex(/^[0-9a-f]{64}$/);
const count = z.number().int().nonnegative();
const nullableCount = count.nullable();
const slug = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
// Six-digit signed years are what toISOString gives a far-off native timestamp.
const instant = z.string().regex(/^(?:\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);

const providerEntrySchema = z.strictObject({
  family: z.enum(FAMILIES),
  source: z.enum(Object.values(PROVIDER_CONTRACTS).map(({ source }) => source)),
  validator: z.enum(Object.values(PROVIDER_CONTRACTS).map(({ validator }) => validator)),
  status: z.enum(['available', 'partial', 'unavailable', 'absent']),
  completeness: z.literal('unknown'),
  retention: z.literal('unknown'),
  runtime: z.strictObject({
    status: z.enum(['observed', 'unknown']),
    versions: z.array(z.string().regex(/^\d+\.\d+\.\d+[0-9A-Za-z.+-]{0,32}$/)).max(32),
  }),
  scope: z.strictObject({
    kind: z.enum(['account', 'machine']),
    accountKey: z.null(),
    identity: z.literal('unknown'),
    aggregation: z.enum(['once-per-account', MACHINE_AGGREGATION]),
  }),
  accountContext: z.strictObject({
    status: z.enum(['read', 'unread', 'signed-out', 'changed']),
    authMethod: slug.nullable(),
    planType: slug.nullable(),
  }).nullable(),
  dateBoundary: z.strictObject({ kind: z.enum(['provider-calendar-day', 'utc-instant']), timezone: z.literal('UTC').nullable() }),
  freshness: z.strictObject({ earliestObserved: z.union([day, instant]).nullable(), latestObserved: z.union([day, instant]).nullable() }),
  missingIntervals: z.strictObject({
    status: z.enum(['unknown', 'reported']),
    intervals: z.array(z.strictObject({ from: day, to: day })).max(MAX_MISSING_INTERVALS).nullable(),
    truncated: z.boolean().nullable(),
  }),
  scanCaps: z.strictObject({
    capped: z.boolean(),
    stoppedEarly: z.boolean(),
    oversizedLines: count,
    limits: z.strictObject({ bytes: count, lineBytes: count, entries: count, records: count, milliseconds: count, depth: count }),
  }).nullable(),
  reproducibility: z.enum(['deterministic', 'scan-stopped-early', 'live-account-read']),
  duplicates: z.strictObject({ duplicateRecords: count, conflictingRecords: count, streamingSupersededRecords: count }).nullable(),
  coverage: z.strictObject({
    files: count, records: count, measuredRecords: count, missingUsageRecords: count, missingIdentityRecords: count,
    invalidLines: count, undatedRecords: count, unreadableFiles: count, skippedLinks: count,
    unfinalizedRecords: count, fieldInconsistentRecords: count, missingSource: z.boolean(),
  }).nullable(),
  steps: z.strictObject({ conversations: count, conversationsWithStepGaps: count, missingStepIndexes: count, conversationsPartiallyMeasured: count }).nullable(),
  cacheOverlap: z.strictObject({ cacheExceedsInputRecords: count, cacheWithinInputRecords: count }).nullable(),
  tokenFields: z.strictObject(Object.fromEntries(['totalTokens', 'tokensIn', 'tokensOut', 'cacheReadTokens', 'cacheWriteTokens'].map((field) => [field, z.string().max(40)]))),
  totals: z.union([
    z.strictObject({ lifetimeTokens: nullableCount, dailyBuckets: z.array(z.strictObject({ startDate: day, tokens: count })).nullable() }),
    z.strictObject({ totalTokens: nullableCount, tokensIn: count, tokensOut: count, cacheReadTokens: count, cacheWriteTokens: nullableCount }),
  ]).nullable(),
  cost: z.strictObject({
    estimatedApiEquivalentUsd: z.null(),
    actualSpendUsd: z.null(),
    nativeCostSignal: z.strictObject({ kind: z.literal('grok-cost-usd-ticks'), status: z.literal('unverified-scope'), records: count }).nullable(),
  }),
  attribution: z.literal('excluded'),
  findings: z.array(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/)).max(32),
});

const reportSchemaV1 = z.strictObject({
  contractVersion: z.literal(1),
  kind: z.literal('native-usage-participant-report'),
  participantKey: participantKey.nullable(),
  capturedAt: instant,
  providers: z.array(providerEntrySchema).length(FAMILIES.length),
  evidenceHash: contentHash,
  contentHash,
});

const providerEntrySchemaV2 = providerEntrySchema.extend({ recordProjection: nativeUsageRecordProjectionSchema.nullable() })
  .refine(({ family, recordProjection }) => family === 'claude' || recordProjection === null, 'unsupported record projection');
const providerEntrySchemaV3 = providerEntrySchema.extend({
  source: z.enum([...Object.values(PROVIDER_CONTRACTS).map(({ source }) => source), 'grok:persisted-session-usage']),
  validator: z.enum([...Object.values(PROVIDER_CONTRACTS).map(({ validator }) => validator), 'grok-persisted-turns/1']),
  recordProjection: z.union([nativeUsageRecordProjectionSchema, nativeGrokUsageProjectionSchema]).nullable(),
  nativeUsageCoverage: z.strictObject({ validSnapshots: count, invalidSnapshots: count, sessionsWithoutUsage: count }).nullable(),
  cost: z.strictObject({
    estimatedApiEquivalentUsd: z.null(), actualSpendUsd: z.null(),
    nativeCostSignal: z.union([providerEntrySchema.shape.cost.shape.nativeCostSignal.unwrap(), z.strictObject({
      kind: z.literal('grok-cost-usd-ticks'), status: z.literal('unverified-scope'),
      knownCostUsdTicks: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
      measuredRecords: count, missingRecords: count, conflictingRecords: count,
    })]).nullable(),
  }),
}).refine(({ family, recordProjection, source, validator }) => !recordProjection || (
  family === 'claude' && recordProjection.identityScheme === 'sha256-native-record/1'
) || (family === 'grok' && source === 'grok:persisted-session-usage' && validator === 'grok-persisted-turns/1'
  && recordProjection.identityScheme === 'sha256-grok-session-turn/1'), 'unsupported record projection');
const providerEntrySchemaV4 = z.strictObject({
  ...providerEntrySchemaV3.shape,
  source: z.enum([...providerEntrySchemaV3.shape.source.options, 'agy:cli-sqlite-metadata']),
  validator: z.enum([...providerEntrySchemaV3.shape.validator.options, 'agy-cli-sqlite-v1/1']),
  recordProjection: z.union([nativeUsageRecordProjectionSchema, nativeGrokUsageProjectionSchema, nativeAgyUsageProjectionSchema]).nullable(),
  nativeAgyCoverage: z.strictObject(Object.fromEntries(['validDatabases', 'invalidDatabases', 'unsupportedSchemas', 'unstableDatabases',
    'rowsWithoutUsage', 'invalidMetadata', 'checkpointRecords', 'unverifiedAppFiles', 'unverifiedIdeFiles', 'legacyOnlySources'].map(field => [field, count]))).nullable(),
  tokenFields: providerEntrySchema.shape.tokenFields.extend({ thinkingOutputTokens: z.string().max(40).optional(), responseOutputTokens: z.string().max(40).optional() }),
  totals: z.union([providerEntrySchema.shape.totals.unwrap(), z.strictObject({ totalTokens: z.null(), tokensIn: count, tokensOut: count,
    cacheReadTokens: count, cacheWriteTokens: count, thinkingOutputTokens: count, responseOutputTokens: count })]).nullable(),
}).refine(({ family, recordProjection, source, validator, nativeAgyCoverage }) => (!nativeAgyCoverage || family === 'agy') && (!recordProjection || (
  family === 'claude' && recordProjection.identityScheme === 'sha256-native-record/1'
) || (family === 'grok' && source === 'grok:persisted-session-usage' && validator === 'grok-persisted-turns/1'
  && recordProjection.identityScheme === 'sha256-grok-session-turn/1') || (family === 'agy' && source === 'agy:cli-sqlite-metadata'
  && validator === 'agy-cli-sqlite-v1/1' && recordProjection.identityScheme === 'sha256-agy-message-response/1')), 'unsupported record projection');
export const nativeUsageReportSchema = z.discriminatedUnion('contractVersion', [
  reportSchemaV1,
  reportSchemaV1.extend({ contractVersion: z.literal(2), providers: z.array(providerEntrySchemaV2).length(FAMILIES.length) }),
  reportSchemaV1.extend({ contractVersion: z.literal(3), providers: z.array(providerEntrySchemaV3).length(FAMILIES.length) }),
  reportSchemaV1.extend({ contractVersion: z.literal(4), providers: z.array(providerEntrySchemaV4).length(FAMILIES.length) }),
]).refine(({ providers }) => FAMILIES.every((family) => providers.filter((entry) => entry.family === family).length === 1), 'provider family must be unique');

const accountSelection = {
  accountLabel: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,63}$/),
  members: z.array(participantKey).min(1).max(64),
};
/** A selection asserts account membership; equal counters never establish identity.
 * Retained-provider selections apply to retained history, not merely the currently signed-in account.
 */
export const nativeUsageAccountSelectionsSchema = z.array(z.discriminatedUnion('family', [
  z.strictObject({ family: z.literal('codex'), ...accountSelection, authoritativeParticipant: participantKey }),
  z.strictObject({ family: z.literal('claude'), ...accountSelection, historyScope: z.literal('operator-confirmed-retained-history') }),
  z.strictObject({ family: z.literal('grok'), ...accountSelection, historyScope: z.literal('operator-confirmed-retained-history') }),
  z.strictObject({ family: z.literal('agy'), ...accountSelection, historyScope: z.literal('operator-confirmed-retained-history') }),
])).max(64).superRefine((selections, ctx) => {
  const claimed = new Set();
  const labels = new Set();
  for (const [index, selection] of selections.entries()) {
    const refuse = (message) => ctx.addIssue({ code: 'custom', path: [index], message });
    const label = `${selection.family}:${selection.accountLabel}`;
    if (labels.has(label)) refuse('accountLabel is already selected for this provider');
    labels.add(label);
    if (selection.family === 'codex' && !selection.members.includes(selection.authoritativeParticipant)) refuse('authoritativeParticipant must be a member');
    for (const member of selection.members) {
      const membership = `${selection.family}:${member}`;
      if (claimed.has(membership)) refuse('a participant can belong to only one account per provider');
      claimed.add(membership);
    }
  }
});

/** Stable and not reversible to the random instance UUID it is derived from. */
export const nativeUsageParticipantKey = (instanceId) => (
  typeof instanceId === 'string' && instanceId && instanceId !== 'unknown'
    ? sha256(`portos-native-usage-participant/1\0${instanceId}`).slice(0, 32)
    : null
);

const baseEntry = (family) => {
  const { source, validator, scopeKind, aggregation, dateBoundary, tokenFields } = PROVIDER_CONTRACTS[family];
  return {
    family, source, validator, status: 'unavailable', completeness: 'unknown', retention: 'unknown',
    runtime: { status: 'unknown', versions: [] },
    scope: { kind: scopeKind, accountKey: null, identity: 'unknown', aggregation },
    accountContext: null, dateBoundary, freshness: { earliestObserved: null, latestObserved: null },
    missingIntervals: { status: 'unknown', intervals: null, truncated: null },
    scanCaps: null, reproducibility: 'deterministic', duplicates: null, coverage: null, steps: null, cacheOverlap: null,
    tokenFields, totals: null,
    cost: { estimatedApiEquivalentUsd: null, actualSpendUsd: null, nativeCostSignal: null },
    attribution: 'excluded', findings: [], recordProjection: null, nativeUsageCoverage: null, nativeAgyCoverage: null,
  };
};

const safeSlug = (value) => (slug.safeParse(value).success ? value : null);
const addDays = (date, days) => new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);

/** Calendar gaps between reported days. A gap is "no bucket", which is not zero usage. */
function bucketGaps(buckets) {
  const gaps = [];
  for (let index = 1; index < buckets.length; index++) {
    const from = addDays(buckets[index - 1].startDate, 1);
    if (from !== buckets[index].startDate) gaps.push({ from, to: addDays(buckets[index].startDate, -1) });
  }
  return { status: 'reported', intervals: gaps.slice(0, MAX_MISSING_INTERVALS), truncated: gaps.length > MAX_MISSING_INTERVALS };
}

function codexAccountContext({ accountBefore, accountAfter }) {
  const describe = ({ account }) => (account ? { authMethod: safeSlug(account.authMethod), planType: safeSlug(account.planType) } : null);
  if (accountBefore?.status !== 'read' || accountAfter?.status !== 'read') return { status: 'unread', authMethod: null, planType: null };
  const before = describe(accountBefore);
  const after = describe(accountAfter);
  if (canonicalStringify(before) !== canonicalStringify(after)) return { status: 'changed', authMethod: null, planType: null };
  return before ? { status: 'read', ...before } : { status: 'signed-out', authMethod: null, planType: null };
}

/** Project the bracketed Codex read. Fails closed when the account moved mid-capture. */
function projectCodexEvidence(evidence, capturedAt) {
  const entry = baseEntry('codex');
  entry.reproducibility = 'live-account-read';
  if (evidence.runtimeVersion) entry.runtime = { status: 'observed', versions: [evidence.runtimeVersion] };
  const { usage, failureCode } = evidence;
  if (failureCode === CODEX_ERROR_CODES.runtimeMissing) return { ...entry, status: 'absent', findings: ['runtime-missing'] };
  entry.accountContext = codexAccountContext(evidence);
  if (entry.accountContext.status === 'changed') return { ...entry, findings: ['account-changed-during-capture'] };
  if (!usage) {
    return entry.accountContext.status === 'signed-out'
      ? { ...entry, status: 'absent', findings: ['signed-out'] }
      : { ...entry, findings: ['refresh-failed'] };
  }
  const findings = [];
  const buckets = usage.dailyUsageBuckets;
  const lifetimeTokens = usage.summary.lifetimeTokens;
  if (lifetimeTokens === null) findings.push('lifetime-unknown');
  if (buckets === null) findings.push('history-unknown');
  if (entry.accountContext.status === 'unread') findings.push('account-context-unread');
  if (entry.accountContext.status === 'signed-out') findings.push('usage-without-account');
  if (buckets) {
    const sum = buckets.reduce((total, bucket) => total + bucket.tokens, 0);
    // Agreement proves nothing about completeness. Only the impossible direction is a finding.
    if (lifetimeTokens !== null && sum > lifetimeTokens) findings.push('daily-exceeds-lifetime');
    // Bucket timezone is unknown, so only a date past every timezone counts as future.
    if (buckets.some(({ startDate }) => startDate > addDays(capturedAt.slice(0, 10), 1))) findings.push('future-dated-bucket');
    entry.missingIntervals = bucketGaps(buckets);
    if (entry.missingIntervals.intervals.length) findings.push('calendar-gaps');
    entry.freshness = { earliestObserved: buckets[0]?.startDate ?? null, latestObserved: buckets.at(-1)?.startDate ?? null };
  }
  entry.totals = { lifetimeTokens, dailyBuckets: buckets };
  // Calendar gaps alone may be idle days, so they stay a finding without lowering status.
  const degraded = findings.some((finding) => finding !== 'calendar-gaps');
  return { ...entry, status: degraded ? 'partial' : 'available', findings };
}

function transcriptFindings(family, coverage, persisted = false) {
  const flags = {
    'scan-capped': coverage.capped, 'scan-stopped-early': coverage.stoppedEarly, 'oversized-lines': coverage.oversizedLines,
    'source-missing': coverage.missingSource, 'conflicting-duplicates': coverage.conflictingRecords,
    'missing-usage': coverage.missingUsageRecords, 'missing-identity': coverage.missingIdentityRecords,
    'invalid-lines': coverage.invalidLines, 'undated-records': coverage.undatedRecords, 'unreadable-files': coverage.unreadableFiles,
    'skipped-links': coverage.skippedLinks, 'unfinalized-messages': coverage.unfinalizedRecords,
    'field-inconsistency': coverage.fieldInconsistentRecords, 'missing-steps': coverage.steps?.missingStepIndexes,
    'partially-measured-conversations': coverage.steps?.conversationsPartiallyMeasured,
    'input-cache-overlap-unverified': family === 'agy', 'turn-semantics-unverified': family === 'grok' && !persisted,
    'cost-tick-scope-unverified': coverage.costTickRecords,
  };
  return Object.keys(flags).filter((code) => flags[code]);
}

/** Project a retained-transcript scan. Scan timing and absolute paths never survive this. */
function projectTranscriptCoverage(family, scan, scanLimits) {
  const { coverage } = scan;
  const pick = (source, keys) => Object.fromEntries(keys.map((key) => [key, source[key]]));
  return {
    ...baseEntry(family),
    ...(scan.source === 'grok:persisted-session-usage' ? { source: scan.source, validator: scan.validator,
      tokenFields: { totalTokens: MEASURED, tokensIn: MEASURED, tokensOut: MEASURED, cacheReadTokens: MEASURED, cacheWriteTokens: MEASURED } } : {}),
    ...(scan.source === 'agy:cli-sqlite-metadata' ? { source: scan.source, validator: scan.validator,
      tokenFields: { totalTokens: 'unverified-overlap', tokensIn: MEASURED, tokensOut: MEASURED, cacheReadTokens: MEASURED, cacheWriteTokens: MEASURED,
        thinkingOutputTokens: MEASURED, responseOutputTokens: MEASURED } } : {}),
    nativeUsageCoverage: scan.nativeUsageCoverage ?? null, nativeAgyCoverage: scan.nativeAgyCoverage ?? null,
    status: scan.status,
    runtime: coverage.runtimeVersions.length ? { status: 'observed', versions: coverage.runtimeVersions } : { status: 'unknown', versions: [] },
    freshness: { earliestObserved: coverage.firstObservedAt, latestObserved: coverage.lastObservedAt },
    scanCaps: { capped: coverage.capped, stoppedEarly: coverage.stoppedEarly, oversizedLines: coverage.oversizedLines, limits: pick(scanLimits, ['bytes', 'lineBytes', 'entries', 'records', 'milliseconds', 'depth']) },
    reproducibility: coverage.stoppedEarly ? 'scan-stopped-early' : 'deterministic',
    duplicates: pick(coverage, ['duplicateRecords', 'conflictingRecords', 'streamingSupersededRecords']),
    coverage: pick(coverage, ['files', 'records', 'measuredRecords', 'missingUsageRecords', 'missingIdentityRecords', 'invalidLines', 'undatedRecords', 'unreadableFiles', 'skippedLinks', 'unfinalizedRecords', 'fieldInconsistentRecords', 'missingSource']),
    steps: coverage.steps,
    cacheOverlap: coverage.cacheOverlap,
    totals: scan.summary,
    recordProjection: scan.recordProjection ?? null,
    cost: scan.nativeUsageCoverage ? scan.cost : {
      estimatedApiEquivalentUsd: null, actualSpendUsd: null,
      nativeCostSignal: coverage.costTickRecords ? { kind: 'grok-cost-usd-ticks', status: 'unverified-scope', records: coverage.costTickRecords } : null,
    },
    findings: [...new Set([...transcriptFindings(family, coverage, Boolean(scan.nativeUsageCoverage)), ...(scan.findings ?? []),
      ...(scan.nativeUsageCoverage?.invalidSnapshots ? ['invalid-native-snapshots'] : []),
      ...(scan.nativeUsageCoverage?.sessionsWithoutUsage ? ['native-usage-files-missing'] : [])])],
  };
}

const withContentHash = (body) => ({ ...body, contentHash: hashOf(body) });

/** One participant's staged input. `capturedAt` must be an ISO instant from `toISOString()`. */
export function buildNativeUsageReport({ instanceId, capturedAt, codexEvidence, transcripts, scanLimits }) {
  const providers = [
    ...TRANSCRIPT_FAMILIES.map((family) => projectTranscriptCoverage(family, transcripts[family], scanLimits)),
    projectCodexEvidence(codexEvidence, capturedAt),
  ].sort((a, b) => a.family.localeCompare(b.family));
  const report = withContentHash({
    contractVersion: NATIVE_USAGE_CONTRACT_VERSION, kind: 'native-usage-participant-report',
    participantKey: nativeUsageParticipantKey(instanceId), capturedAt, providers, evidenceHash: hashOf(providers),
  });
  return nativeUsageReportSchema.parse(report);
}

/** Verify content and evidence hashes after validating the strict report schema. */
export const reportIsIntact = (report) => {
  const { contentHash: claimed, ...body } = report;
  return claimed === hashOf(body) && report.evidenceHash === hashOf(report.providers);
};

const codexEntryOf = (report) => report.providers.find(({ family }) => family === 'codex');

/** Signs the same participant no longer reads the same account or history. */
function accountChangeFindings(prior, next) {
  const findings = [];
  if (prior.accountContext?.status === 'read' && next.accountContext?.status === 'read'
    && (prior.accountContext.authMethod !== next.accountContext.authMethod || prior.accountContext.planType !== next.accountContext.planType)) {
    findings.push('account-context-changed');
  }
  if (prior.totals && next.totals) {
    const { lifetimeTokens: before } = prior.totals;
    const { lifetimeTokens: after } = next.totals;
    if (before !== null && after !== null && after < before) findings.push('lifetime-regressed');
    if (prior.totals.dailyBuckets && next.totals.dailyBuckets) {
      const later = new Map(next.totals.dailyBuckets.map(({ startDate, tokens }) => [startDate, tokens]));
      if (prior.totals.dailyBuckets.some(({ startDate, tokens }) => !(later.get(startDate) >= tokens))) findings.push('history-restated');
    }
  }
  return findings;
}

function loadParticipants(reports, refuse) {
  const byParticipant = new Map();
  for (const raw of reports) {
    const parsed = nativeUsageReportSchema.safeParse(raw);
    if (!parsed.success || !reportIsIntact(parsed.data)) { refuse('report-invalid'); continue; }
    if (!parsed.data.participantKey) { refuse('participant-identity-unknown'); continue; }
    const list = byParticipant.get(parsed.data.participantKey) ?? [];
    if (!list.some(({ contentHash: hash }) => hash === parsed.data.contentHash)) list.push(parsed.data);
    byParticipant.set(parsed.data.participantKey, list);
  }
  for (const [key, list] of byParticipant) {
    list.sort((a, b) => a.capturedAt.localeCompare(b.capturedAt) || a.contentHash.localeCompare(b.contentHash));
    list.forEach((report, index) => {
      if (!index) return;
      if (report.capturedAt === list[index - 1].capturedAt) refuse('conflicting-reports', null, key);
      for (const code of accountChangeFindings(codexEntryOf(list[index - 1]), codexEntryOf(report))) refuse(code, 'codex', key);
    });
  }
  return byParticipant;
}

function buildCodexFamily(latest, selections, refusals, refuse) {
  const entryFor = (key) => (latest.has(key) ? codexEntryOf(latest.get(key)) : null);
  const selected = new Set(selections.flatMap(({ members }) => members));
  const unresolved = [...latest.keys()].filter((key) => !selected.has(key) && entryFor(key).status !== 'absent').sort();
  for (const key of unresolved) refuse('participant-account-unresolved', 'codex', key);
  const accounts = selections.map(({ accountLabel, authoritativeParticipant, members }) => {
    const entry = entryFor(authoritativeParticipant);
    if (!entry) refuse('authoritative-report-missing', 'codex', authoritativeParticipant);
    else if (entry.status !== 'available') refuse(`authoritative-source-${entry.status}`, 'codex', authoritativeParticipant);
    return {
      accountLabel, identityBasis: 'operator-selection', authoritativeParticipant,
      members: [...members].sort(),
      membersWithoutReport: members.filter((key) => !latest.has(key)).sort(),
      status: entry?.status ?? 'unavailable',
      freshness: entry?.freshness ?? { earliestObserved: null, latestObserved: null },
      // The one snapshot for this account. Other members are never read for totals,
      // so a shared account cannot be added twice however many machines report it.
      totals: entry?.totals ?? null,
      findings: entry?.findings ?? ['authoritative-report-missing'],
    };
  }).sort((a, b) => a.accountLabel.localeCompare(b.accountLabel));
  const reasons = [...new Set(refusals.map(({ code }) => code))].sort();
  const empty = !accounts.length && !unresolved.length && !reasons.length;
  const lifetimes = accounts.map(({ totals }) => totals?.lifetimeTokens ?? null);
  const combined = lifetimes.every((value) => value !== null) ? lifetimes.reduce((sum, value) => sum + value, 0) : null;
  const merged = !empty && !reasons.length && Number.isSafeInteger(combined);
  if (!empty && !merged && !reasons.length) reasons.push('account-total-unknown');
  return {
    family: 'codex', scope: 'account', accounts, unresolvedParticipants: unresolved,
    merge: { status: empty ? 'empty' : merged ? 'merged' : 'refused', reasons, accountCount: accounts.length, totals: merged ? { lifetimeTokens: combined } : null },
  };
}

function buildMachineFamily(family, latest) {
  return {
    family, scope: 'machine',
    sources: [...latest.keys()].sort().map((key) => {
      const entry = latest.get(key).providers.find((provider) => provider.family === family);
      return { participantKey: key, status: entry.status, freshness: entry.freshness, totals: entry.totals, findings: entry.findings };
    }),
    // Without a supported record projection and account selection, copied or
    // restored history cannot be safely combined across participants.
    merge: { status: 'refused', reasons: ['machine-subset-disjointness-unverified'], accountCount: null, totals: null },
  };
}

function buildRetainedFamily(family, latest, selections, refusals, refuse) {
  const sources = buildMachineFamily(family, latest).sources;
  if (!selections.length) return buildMachineFamily(family, latest);
  const entryFor = (key) => latest.get(key)?.providers.find(({ family: entryFamily }) => entryFamily === family);
  const selected = new Set(selections.flatMap(({ members }) => members));
  const unresolved = [...latest.keys()].filter((key) => !selected.has(key) && !entryFor(key).coverage?.missingSource).sort();
  for (const key of unresolved) refuse('participant-account-unresolved', family, key);
  const recordAccounts = new Map();
  const accounts = selections.map(({ accountLabel, members, historyScope }) => {
    const projections = [];
    const findings = new Set(['retained-history-completeness-unknown']);
    const missing = [];
    for (const member of members) {
      const entry = entryFor(member);
      if (!entry) {
        missing.push(member);
        refuse('member-report-missing', family, member);
      } else if (!entry.recordProjection || entry.recordProjection.truncated) {
        refuse(entry.recordProjection ? 'record-projection-truncated' : 'record-projection-unavailable', family, member);
      } else {
        projections.push(entry.recordProjection);
        for (const finding of entry.findings) findings.add(finding);
        for (const { recordKey, responseKeys = [] } of entry.recordProjection.records) {
          for (const identity of [`message:${recordKey}`, ...responseKeys.map(key => `response:${key}`)]) {
            const owner = recordAccounts.get(identity);
            if (owner && owner !== accountLabel) refuse('record-in-multiple-accounts', family);
            recordAccounts.set(identity, accountLabel);
          }
        }
      }
    }
    const union = ({ agy: unionNativeAgyRecords, grok: unionNativeGrokRecords, claude: unionNativeClaudeRecords }[family])(projections);
    delete union.projectedRecords;
    if (union.findings.includes('counter-overflow')) refuse('counter-overflow', family);
    for (const finding of union.findings) findings.add(finding);
    return {
      accountLabel, identityBasis: 'operator-selection', historyScope,
      members: [...members].sort(), membersWithoutReport: missing.sort(),
      status: 'partial', completeness: 'unknown', retention: 'unknown',
      ...union, findings: [...findings].sort(),
      cost: union.cost ?? { estimatedApiEquivalentUsd: null, actualSpendUsd: null }, attribution: 'excluded',
    };
  }).sort((a, b) => a.accountLabel.localeCompare(b.accountLabel));
  const reasons = [...new Set(refusals.filter(({ family: refusedFamily }) => !refusedFamily || refusedFamily === family).map(({ code }) => code))].sort();
  const fields = ['totalTokens', 'tokensIn', 'tokensOut', 'cacheReadTokens', 'cacheWriteTokens', ...(family === 'grok' ? ['reasoningTokens', 'modelCalls'] : []), ...(family === 'agy' ? ['thinkingOutputTokens', 'responseOutputTokens'] : [])];
  const totals = Object.fromEntries(fields.map((field) => [field, accounts.reduce((sum, account) => sum + (account.totals?.[field] ?? 0), 0)]));
  if (!Object.values(totals).every(Number.isSafeInteger)) reasons.push('counter-overflow');
  if (family === 'agy') totals.totalTokens = null;
  if (!accounts.some(({ totals: value }) => value)) reasons.push('no-verified-retained-records');
  if (reasons.length) {
    // Keep diagnostic counts, but do not publish any account partition as usable
    // when its requested input set or grouping cannot be established.
    for (const account of accounts) { account.status = 'refused'; account.totals = null; account.records = []; account.cost = { estimatedApiEquivalentUsd: null, actualSpendUsd: null }; }
  }
  return {
    family, scope: 'selected-account-retained-records', sources, accounts, unresolvedParticipants: unresolved,
    merge: { status: reasons.length ? 'refused' : 'partial', reasons, accountCount: accounts.length, completeness: 'unknown', totals: reasons.length ? null : totals },
  };
}

/**
 * Combine participant reports under an operator selection. Output depends only on
 * its inputs and not on their order, so re-running it over captured reports is
 * byte-identical through `nativeUsageCanonicalJson`.
 *
 * Several reports from one participant are compared for account change, and the
 * latest is used. When a change is detected the operator resolves it by reselecting
 * and dropping the older report, because this contract cannot tell which account the
 * older snapshot belonged to.
 */
export function buildNativeUsageMatrix({ reports, selections }) {
  const refusals = [];
  const refuse = (code, family = null, key = null) => refusals.push({ code, family, participantKey: key });
  const parsedSelections = nativeUsageAccountSelectionsSchema.safeParse(selections);
  if (!parsedSelections.success) refuse('selections-invalid');
  const usableSelections = parsedSelections.success ? parsedSelections.data : [];
  const byParticipant = loadParticipants(reports, refuse);
  const latest = new Map([...byParticipant].map(([key, list]) => [key, list.at(-1)]));
  const codex = buildCodexFamily(latest, usableSelections.filter(({ family }) => family === 'codex'), refusals, refuse);
  const retained = ['agy', 'claude', 'grok'].map(family => buildRetainedFamily(family, latest, usableSelections.filter(selection => selection.family === family), refusals, refuse));
  const unique = [...new Map(refusals.map((refusal) => [canonicalStringify(refusal), refusal])).entries()]
    .sort(([a], [b]) => a.localeCompare(b)).map(([, refusal]) => refusal);
  return withContentHash({
    contractVersion: NATIVE_USAGE_CONTRACT_VERSION, kind: 'native-usage-matrix',
    selectionsHash: hashOf(selections ?? null),
    selections: usableSelections,
    participants: [...latest.keys()].sort().map((key) => ({
      participantKey: key, capturedAt: latest.get(key).capturedAt, reportHash: latest.get(key).contentHash,
      evidenceHash: latest.get(key).evidenceHash, comparedReports: byParticipant.get(key).length, providers: latest.get(key).providers,
    })),
    families: [...retained, codex].sort((a, b) => a.family.localeCompare(b.family)),
    refusals: unique,
  });
}

/** The exact bytes a report or matrix is published as. */
export const nativeUsageCanonicalJson = (value) => `${canonicalStringify(value)}\n`;

/** Short operator summary: statuses and refusal reasons, with identifiers shortened. */
export function formatNativeUsageMatrixSummary(matrix) {
  const short = (key) => key.slice(0, 8);
  const lines = [`Native usage matrix ${matrix.contentHash.slice(0, 16)}: ${matrix.participants.length} participant(s), ${matrix.refusals.length} refusal(s)`];
  for (const family of matrix.families) {
    const total = family.merge.totals ? family.family === 'codex' ? `${family.merge.totals.lifetimeTokens} lifetime tokens` : family.family === 'agy' ? 'separate native counters (combined total unknown)' : `${family.merge.totals.totalTokens} retained tokens (completeness unknown)` : 'no combined total';
    lines.push(`${family.family}: ${family.merge.status}, ${total}${family.merge.reasons.length ? ` (${family.merge.reasons.join(', ')})` : ''}`);
    for (const account of family.accounts ?? []) {
      lines.push(`  ${account.accountLabel}: ${account.status}${account.authoritativeParticipant ? ` from ${short(account.authoritativeParticipant)}` : ''}, ${account.members.length} member(s)`);
    }
    for (const source of family.sources ?? []) lines.push(`  ${short(source.participantKey)}: ${source.status}, ${source.findings.length} finding(s)`);
  }
  return lines.join('\n');
}
