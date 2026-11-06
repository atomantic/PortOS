import { z } from 'zod';
import { canonicalStringify } from './objects.js';

export const AGY_USAGE_RECORD_LIMIT = 100_000;
export const AGY_USAGE_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'thinkingOutputTokens', 'responseOutputTokens'];
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const enumeration = z.number().int().min(-2147483648).max(2147483647).nullable();
const instant = z.string().datetime({ precision: 3 });
export const nativeAgyUsageProjectionSchema = z.strictObject({
  version: z.literal(1), identityScheme: z.literal('sha256-agy-message-response/1'), truncated: z.boolean(),
  records: z.array(z.strictObject({
    recordKey: digest, responseKeys: z.array(digest).min(1).max(100),
    values: z.tuple(Array.from({ length: 6 }, () => counter.nullable())),
    model: enumeration, apiProvider: enumeration, stepType: counter.nullable(),
    at: instant.nullable(), completedAt: instant.nullable(), conflict: z.boolean(), final: z.boolean(),
  }).refine(({ responseKeys }) => new Set(responseKeys).size === responseKeys.length, 'duplicate response key')).max(AGY_USAGE_RECORD_LIMIT),
}).refine(({ records }) => new Set(records.map(({ recordKey }) => recordKey)).size === records.length, 'duplicate projected identity');

const signature = ({ values, model, apiProvider, stepType, at, completedAt, responseKeys }) => canonicalStringify([
  values, model, apiProvider, stepType, at, completedAt, [...responseKeys].sort(),
]);

/** Copies share native message and response identities, never a file or host name.
 * Retain both identity indexes: a reused response under another message is a
 * conflict too, and must not become two apparently distinct billable calls.
 */
export function unionNativeAgyRecords(projections) {
  const messages = new Map();
  const responses = new Map();
  let observations = 0;
  for (const { records } of projections) {
    for (const record of records) {
      const copies = messages.get(record.recordKey) ?? [];
      copies.push(record);
      messages.set(record.recordKey, copies);
      for (const key of record.responseKeys) {
        const owners = responses.get(key) ?? new Set();
        owners.add(record.recordKey);
        responses.set(key, owners);
      }
      observations++;
    }
  }
  const records = [];
  const projectedRecords = [];
  const excluded = {};
  for (const recordKey of [...messages.keys()].sort()) {
    const copies = messages.get(recordKey);
    const first = copies[0];
    const responseKeys = [...new Set(copies.flatMap(record => record.responseKeys))].sort();
    let finding = null;
    if (copies.some(record => record.conflict) || responseKeys.length !== 1
      || responseKeys.some(key => responses.get(key).size !== 1) || copies.some(record => signature(record) !== signature(first))) finding = 'conflicting-records';
    else if (copies.some(record => !record.final)) finding = 'unfinalized-records';
    else if (first.values.some(value => value === null)) finding = 'missing-record-fields';
    else if (!first.at || !first.completedAt) finding = 'undated-records';
    else if (first.values[1] !== first.values[4] + first.values[5] || first.at > first.completedAt) finding = 'inconsistent-records';
    if (finding) {
      excluded[finding] = (excluded[finding] ?? 0) + 1;
      projectedRecords.push({ recordKey, responseKeys, values: [null, null, null, null, null, null], model: null,
        apiProvider: null, stepType: null, at: null, completedAt: null, conflict: true, final: false });
    } else {
      const record = { ...first, responseKeys };
      records.push(record);
      projectedRecords.push(record);
    }
  }
  const values = AGY_USAGE_FIELDS.map((_, index) => records.reduce((sum, record) => sum + record.values[index], 0));
  const overflow = !values.every(Number.isSafeInteger);
  return {
    records, projectedRecords,
    coverage: { uniqueRecords: messages.size, measuredRecords: records.length, duplicateRecords: observations - messages.size,
      excludedRecords: messages.size - records.length, excluded },
    totals: records.length && !overflow ? { totalTokens: null, tokensIn: values[0], tokensOut: values[1], cacheReadTokens: values[2],
      cacheWriteTokens: values[3], thinkingOutputTokens: values[4], responseOutputTokens: values[5] } : null,
    findings: [...Object.keys(excluded), 'input-cache-overlap-unverified', ...(overflow ? ['counter-overflow'] : [])].sort(),
  };
}
