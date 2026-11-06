import { z } from 'zod';
import { canonicalStringify } from './objects.js';

export const GROK_USAGE_RECORD_LIMIT = 100_000;
export const GROK_USAGE_FIELDS = ['inputTokens', 'outputTokens', 'cachedReadTokens', 'cacheCreationTokens', 'reasoningTokens', 'totalTokens', 'modelCalls'];
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
export const nativeGrokUsageProjectionSchema = z.strictObject({
  version: z.literal(1),
  identityScheme: z.literal('sha256-grok-session-turn/1'),
  truncated: z.boolean(),
  records: z.array(z.strictObject({
    recordKey: z.string().regex(/^[0-9a-f]{64}$/),
    values: z.tuple([counter, counter, counter, counter, counter, counter, counter]),
    costUsdTicks: counter,
    costConflict: z.boolean(),
    conflict: z.boolean(),
    inconsistent: z.boolean(),
    at: z.string().regex(/^(?:\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/).nullable(),
  })).max(GROK_USAGE_RECORD_LIMIT),
}).refine(({ records }) => new Set(records.map(({ recordKey }) => recordKey)).size === records.length, 'duplicate projected identity');

function resolve(copies) {
  if (copies.some(({ conflict, inconsistent }) => conflict || inconsistent)
    || new Set(copies.map(({ values, at }) => canonicalStringify([values, at]))).size !== 1) return { finding: 'conflicting-records' };
  if (copies[0].values.some(value => value === null)) return { finding: 'missing-record-fields' };
  const [input, output, cached, , reasoning, total] = copies[0].values;
  if (total !== input + output || cached > input || reasoning > output) return { finding: 'conflicting-records' };
  if (!copies[0].at) return { finding: 'undated-records' };
  const costs = [...new Set(copies.map(({ costUsdTicks }) => costUsdTicks).filter(value => value !== null))];
  const costConflict = costs.length > 1 || copies.some(record => record.costConflict);
  return { record: { ...copies[0], costUsdTicks: costConflict ? null : costs[0] ?? null, costConflict } };
}

/** Persisted native turns, never raw updates or session totals added a second time. */
export function unionNativeGrokRecords(projections) {
  const identities = new Map();
  let observations = 0;
  for (const { records } of projections) {
    for (const record of records) {
      const copies = identities.get(record.recordKey) ?? [];
      copies.push(record);
      identities.set(record.recordKey, copies);
      observations++;
    }
  }
  const records = [];
  const excluded = {};
  for (const key of [...identities.keys()].sort()) {
    const { record, finding } = resolve(identities.get(key));
    if (record) records.push(record);
    else excluded[finding] = (excluded[finding] ?? 0) + 1;
  }
  const values = GROK_USAGE_FIELDS.map((_, index) => records.reduce((sum, record) => sum + record.values[index], 0));
  const overflow = !values.every(Number.isSafeInteger);
  const measuredCosts = records.filter(({ costUsdTicks }) => costUsdTicks !== null);
  const costTicks = measuredCosts.reduce((sum, record) => sum + record.costUsdTicks, 0);
  const costOverflow = !Number.isSafeInteger(costTicks);
  const costConflictRecords = records.filter(({ costConflict }) => costConflict).length;
  return {
    records,
    coverage: { uniqueRecords: identities.size, measuredRecords: records.length, duplicateRecords: observations - identities.size, excludedRecords: identities.size - records.length, excluded },
    totals: records.length && !overflow ? {
      totalTokens: values[5], tokensIn: values[0], tokensOut: values[1], cacheReadTokens: values[2], cacheWriteTokens: values[3], reasoningTokens: values[4], modelCalls: values[6],
    } : null,
    cost: { estimatedApiEquivalentUsd: null, actualSpendUsd: null, nativeCostSignal: {
      kind: 'grok-cost-usd-ticks', status: 'unverified-scope',
      knownCostUsdTicks: measuredCosts.length && !costOverflow ? costTicks : null,
      measuredRecords: measuredCosts.length, missingRecords: records.length - measuredCosts.length, conflictingRecords: costConflictRecords,
    } },
    findings: [...Object.keys(excluded), 'cost-tick-scope-unverified', ...(records.length > measuredCosts.length ? ['native-cost-incomplete'] : []),
      ...(costConflictRecords ? ['native-cost-conflict'] : []), ...(overflow ? ['counter-overflow'] : []), ...(costOverflow ? ['cost-counter-overflow'] : [])].sort(),
  };
}
