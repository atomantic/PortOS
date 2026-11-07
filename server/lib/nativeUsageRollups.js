/**
 * Per-day, per-model rollups a machine reports instead of its record list (#15252).
 * Contract and evidence rules: docs/plans/2026-11-07-native-usage-model-attribution.md.
 * Each machine resolves its own copies first, so a report holds no record identity.
 * A label is what the endpoint reported, not a verified vendor model or a pricing key.
 */
import { canonicalStringify } from './objects.js';
import { GROK_USAGE_FIELDS } from './nativeGrokUsageRecords.js';

const NATIVE_USAGE_MODEL_LIMITS = Object.freeze({ maxLabelsPerProjection: 1024, maxRowsPerRecord: 256 });
export const OLD_REPORT_MODEL_REASON = 'report-without-model-capability';

const LABEL = /^(?![Aa][Rr][Nn]:)(?=[^A-Za-z]*[A-Za-z])(?=.{1,128}$)[A-Za-z0-9][A-Za-z0-9._:+-]*(?:@(?:[0-9]{8}|default))?$/;
const SENTINELS = new Set(['<synthetic>']);
const UNKNOWN_REASONS = new Set(['model-missing', 'model-sentinel']);
const UNALLOCATED_REASONS = new Set(['model-conflict', 'model-label-invalid', 'model-label-limit', 'model-rows-invalid', 'model-sum-mismatch']);
// Antigravity records numeric model enums with no validated label mapping.
const AGY_REASON = 'model-unverified';
const COUNTER_FIELDS = {
  claude: ['tokensIn', 'tokensOut', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens'],
  grok: ['tokensIn', 'tokensOut', 'cacheReadTokens', 'cacheWriteTokens', 'totalTokens', 'reasoningTokens', 'modelCalls'],
  agy: ['tokensIn', 'tokensOut', 'cacheReadTokens', 'cacheWriteTokens', 'thinkingOutputTokens', 'responseOutputTokens'],
};
const counter = value => Number.isSafeInteger(value) && value >= 0;
const validLabel = value => typeof value === 'string' && LABEL.test(value);

/** Provider acceptance is unchanged: the mappings below only name its accepted counters. */
const COUNTERS = {
  claude: ([tokensIn, tokensOut, cacheReadTokens, cacheWriteTokens]) => ({ tokensIn, tokensOut, cacheReadTokens, cacheWriteTokens,
    totalTokens: tokensIn + tokensOut + cacheReadTokens + cacheWriteTokens }),
  grok: ([tokensIn, tokensOut, cacheReadTokens, cacheWriteTokens, reasoningTokens, totalTokens, modelCalls]) => ({
    tokensIn, tokensOut, cacheReadTokens, cacheWriteTokens, reasoningTokens, totalTokens, modelCalls }),
  agy: ([tokensIn, tokensOut, cacheReadTokens, cacheWriteTokens, thinkingOutputTokens, responseOutputTokens]) => ({
    tokensIn, tokensOut, cacheReadTokens, cacheWriteTokens, thinkingOutputTokens, responseOutputTokens }),
};

const CONFLICT = { kind: 'model-conflict' };
const LOW_RANK = { 'model-missing': 1, 'model-sentinel': 2 };
const rank = ({ kind }) => LOW_RANK[kind] ?? 3;

/** Join-semilattice over one identity's copies: any file order gives one outcome, with no winner. */
export function joinModelEvidence(a, b) {
  if (!a) return b;
  if (canonicalStringify(a) === canonicalStringify(b)) return a;
  if (a.kind === CONFLICT.kind || b.kind === CONFLICT.kind) return CONFLICT;
  if (rank(a) === 3 && rank(b) === 3) return CONFLICT;
  return rank(a) > rank(b) ? a : b;
}

export function claudeModelEvidence(model) {
  if (model === undefined || model === null || (typeof model === 'string' && !model.trim())) return { kind: 'model-missing' };
  if (SENTINELS.has(model)) return { kind: 'model-sentinel' };
  return validLabel(model) ? { kind: 'attributed', label: model } : { kind: 'model-label-invalid' };
}

const validGrokRow = row => GROK_USAGE_FIELDS.every(field => counter(row?.[field]))
  && row.totalTokens === row.inputTokens + row.outputTokens
  && row.cachedReadTokens <= row.inputTokens && row.reasoningTokens <= row.outputTokens;

/** Only `turns[].modelUsage` is evidence. The first failed check names the whole turn. */
export function grokModelEvidence(turn, { maxRowsPerRecord = NATIVE_USAGE_MODEL_LIMITS.maxRowsPerRecord } = {}) {
  const usage = turn?.modelUsage;
  if (usage === undefined || usage === null) return { kind: 'model-missing' };
  if (typeof usage !== 'object' || Array.isArray(usage)) return { kind: 'model-rows-invalid' };
  const entries = Object.entries(usage);
  if (!entries.length) return { kind: 'model-missing' };
  if (entries.some(([label]) => !validLabel(label))) return { kind: 'model-label-invalid' };
  if (entries.length > maxRowsPerRecord || !entries.every(([, row]) => validGrokRow(row))) return { kind: 'model-rows-invalid' };
  if (!GROK_USAGE_FIELDS.every(field => entries.reduce((sum, [, row]) => sum + row[field], 0) === turn[field])) return { kind: 'model-sum-mismatch' };
  return { kind: 'attributed', rows: entries.map(([label, row]) => [label, ...GROK_USAGE_FIELDS.map(field => row[field])]).sort(([a], [b]) => (a < b ? -1 : 1)) };
}

const kindOf = reason => (UNKNOWN_REASONS.has(reason) ? 'unknown' : 'unallocated');
const dayOf = at => {
  const day = typeof at === 'string' ? at.slice(0, 10) : '';
  const ms = /^\d{4}-\d{2}-\d{2}$/.test(day) ? Date.parse(`${day}T00:00:00.000Z`) : Number.NaN;
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === day ? day : null;
};
const sumCounters = list => {
  const total = {};
  for (const counters of list) for (const [field, value] of Object.entries(counters)) total[field] = (total[field] ?? 0) + value;
  return list.length ? total : null;
};
const bucketOrder = ({ day, kind, key }) => `${day}\u0000${kind}\u0000${key}`;
const withUnknownTotal = (family, total) => (family === 'agy' && total ? { totalTokens: null, ...total } : total);

/** Roll accepted records up by UTC day and model. Totals are the sum of the buckets by construction. */
export function buildNativeUsageRollup(family, accepted, { maxLabelsPerProjection = NATIVE_USAGE_MODEL_LIMITS.maxLabelsPerProjection } = {}) {
  const labelsOf = ({ kind, label, rows }) => (kind !== 'attributed' ? [] : label ? [label] : rows.map(([name]) => name));
  const seen = new Set();
  for (const { evidence } of accepted) if (evidence) for (const label of labelsOf(evidence)) seen.add(label);
  const kept = new Set([...seen].sort().slice(0, maxLabelsPerProjection));
  const buckets = new Map();
  const findings = new Set();
  const add = (day, kind, key, counters, incomplete) => {
    const id = bucketOrder({ day, kind, key });
    const bucket = buckets.get(id) ?? { day, kind, key, counters: null, ...(family === 'grok' ? { incompleteRecords: 0 } : {}) };
    bucket.counters = sumCounters(bucket.counters ? [bucket.counters, counters] : [counters]);
    if (family === 'grok' && incomplete) bucket.incompleteRecords++;
    buckets.set(id, bucket);
  };
  for (const { at, values, evidence, incomplete } of accepted) {
    const day = dayOf(at);
    if (!day) { findings.add('undated-records'); continue; }
    const counters = COUNTERS[family](values);
    if (family === 'agy') { add(day, 'unknown', AGY_REASON, counters); continue; }
    const outcome = labelsOf(evidence).every(label => kept.has(label)) ? evidence : { kind: 'model-label-limit' };
    if (outcome.kind !== 'attributed') add(day, kindOf(outcome.kind), outcome.kind, counters, incomplete);
    else if (outcome.label) add(day, 'model', outcome.label, counters, incomplete);
    else for (const [label, ...row] of outcome.rows) add(day, 'model', label, COUNTERS.grok(row), incomplete);
  }
  const sorted = [...buckets.values()].sort((a, b) => (bucketOrder(a) < bucketOrder(b) ? -1 : 1));
  const total = sumCounters(sorted.map(({ counters }) => counters));
  // A total inside the safe range keeps every bucket, each a part of it, safe too.
  if (total && !Object.values(total).every(Number.isSafeInteger)) {
    return { modelUsage: { version: 1, buckets: [] }, totals: null, findings: [...findings, 'counter-overflow'].sort() };
  }
  return { modelUsage: { version: 1, buckets: sorted }, totals: withUnknownTotal(family, total), findings: [...findings].sort() };
}

const hasExactKeys = (value, keys) => value !== null && typeof value === 'object'
  && canonicalStringify(Object.keys(value).sort()) === canonicalStringify([...keys].sort());
const keyFits = (family, { kind, key }) => {
  if (family === 'agy') return kind === 'unknown' && key === AGY_REASON;
  if (kind === 'model') return validLabel(key);
  return kind === 'unknown' ? UNKNOWN_REASONS.has(key) : kind === 'unallocated' && UNALLOCATED_REASONS.has(key);
};
const validCounters = {
  // Claude's fields are disjoint; Grok's cache and reasoning sit inside input and output.
  claude: bucket => bucket.totalTokens === bucket.tokensIn + bucket.tokensOut + bucket.cacheReadTokens + bucket.cacheWriteTokens,
  grok: bucket => bucket.totalTokens === bucket.tokensIn + bucket.tokensOut
    && bucket.cacheReadTokens <= bucket.tokensIn && bucket.reasoningTokens <= bucket.tokensOut,
  agy: bucket => bucket.tokensOut === bucket.thinkingOutputTokens + bucket.responseOutputTokens,
};

/** Why a received rollup is refused, or null. The block must partition the provider total exactly. */
export function nativeModelUsageRefusal(family, { totals, modelUsage }) {
  if (!hasExactKeys(modelUsage, ['version', 'buckets']) || modelUsage.version !== 1 || !Array.isArray(modelUsage.buckets)) return 'fields-not-exact';
  const { buckets } = modelUsage;
  const fields = family === 'grok' ? ['day', 'kind', 'key', 'counters', 'incompleteRecords'] : ['day', 'kind', 'key', 'counters'];
  if (!buckets.every(bucket => hasExactKeys(bucket, fields))) return 'fields-not-exact';
  if (!buckets.every(({ day }) => dayOf(day) === day)) return 'invalid-day';
  if (!buckets.every(bucket => keyFits(family, bucket))) return 'invalid-key';
  const countersValid = ({ counters, incompleteRecords }) => hasExactKeys(counters, COUNTER_FIELDS[family])
    && Object.values(counters).every(counter) && validCounters[family](counters) && (family !== 'grok' || counter(incompleteRecords));
  if (!buckets.every(countersValid)) return 'counters-invalid';
  if (buckets.some((bucket, index) => index > 0 && bucketOrder(buckets[index - 1]) >= bucketOrder(bucket))) return 'buckets-not-canonical';
  const sum = withUnknownTotal(family, sumCounters(buckets.map(({ counters }) => counters)));
  return canonicalStringify(sum) === canonicalStringify(totals ?? null) ? null : 'buckets-do-not-reconcile';
}
