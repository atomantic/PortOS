import { z } from 'zod';
import { canonicalStringify } from './objects.js';

const NATIVE_USAGE_RECORD_LIMIT = 100_000;
const digest = z.string().regex(/^[0-9a-f]{64}$/);
const counter = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable();
const recordSchema = z.strictObject({
  recordKey: digest,
  requestKey: digest.nullable(),
  values: z.tuple([counter, counter, counter, counter]),
  final: z.boolean(),
  conflict: z.boolean(),
  inconsistent: z.boolean(),
  at: z.string().regex(/^(?:\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/).nullable(),
});

/** Only opaque native message/request keys and accounting fields may travel. */
export const nativeUsageRecordProjectionSchema = z.strictObject({
  version: z.literal(1),
  identityScheme: z.literal('sha256-native-record/1'),
  truncated: z.boolean(),
  records: z.array(recordSchema).max(NATIVE_USAGE_RECORD_LIMIT),
}).refine(({ records }) => new Set(records.map(({ recordKey }) => recordKey)).size === records.length, 'duplicate projected identity');

/** Resolve copies of one Claude response, never choose a winner for a conflict. */
function resolveClaudeRecord(copies) {
  if (copies.some(({ conflict, inconsistent }) => conflict || inconsistent)) return { finding: 'conflicting-records' };
  if (copies.some(({ values }) => values.some((value) => value === null))) return { finding: 'missing-record-fields' };
  const inputs = ({ requestKey, values }) => canonicalStringify([requestKey, values[0], values[2], values[3]]);
  if (new Set(copies.map(inputs)).size !== 1) return { finding: 'conflicting-records' };
  const finals = copies.filter(({ final }) => final);
  if (!finals.length) return { finding: 'unfinalized-records' };
  const output = finals[0].values[1];
  if (finals.some(({ values }) => values[1] !== output)
    || copies.some(({ values }) => values[1] > output)
    || (!finals[0].requestKey && copies.some(({ values }) => values[1] !== output))) return { finding: 'conflicting-records' };
  const dates = copies.map(({ at }) => at).filter(Boolean).sort();
  if (!dates.length) return { finding: 'undated-records' };
  return { record: { ...finals[0], at: dates[0] } };
}

/** Retained subset, not account lifetime or spend. Call only within one selected account. */
export function unionNativeClaudeRecords(projections) {
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
    const { record, finding } = resolveClaudeRecord(identities.get(key));
    if (record) records.push(record);
    else excluded[finding] = (excluded[finding] ?? 0) + 1;
  }
  const values = [0, 0, 0, 0];
  for (const record of records) record.values.forEach((value, index) => { values[index] += value; });
  const totalTokens = values.reduce((sum, value) => sum + value, 0);
  const overflow = ![...values, totalTokens].every(Number.isSafeInteger);
  return {
    records,
    coverage: { uniqueRecords: identities.size, measuredRecords: records.length, duplicateRecords: observations - identities.size, excludedRecords: identities.size - records.length, excluded },
    totals: records.length && !overflow ? { totalTokens, tokensIn: values[0], tokensOut: values[1], cacheReadTokens: values[2], cacheWriteTokens: values[3] } : null,
    findings: [...Object.keys(excluded), ...(overflow ? ['counter-overflow'] : [])].sort(),
  };
}
