/**
 * Pure overlay of each provider app's own daily usage history onto the ledger's `dailyActivity` —
 * `overlayNativeUsage(dailyActivity, { stores, providers })`.
 *
 * For a family's CLI/TUI providers, reported tokens = native store + estimates + measured ephemeral turns
 * (runs the app never saves); from the store's `coverageStart` it replaces, before it only where it
 * counts more, after its last refresh the ledger stands. Fed by `services/nativeUsageHistory.js`.
 */

import { familyForProvider, familyLabel } from './provider/providerFamilies.js';
import {
  ALL_TOKEN_FIELDS as TOKEN_FIELDS,
  BASE_TOKEN_FIELDS as BILLED_FIELDS,
  rebuildDayTotals,
  SPEED_CLASS_FIELDS as SPEED_CLASSES,
} from './usageFields.js';

/**
 * Put each provider app's own usage history in place of the PortOS ledger's
 * token counts for that app, day by day.
 *
 * The ledger counts what PortOS saw: its own runs, matched to the app's session
 * files after the fact, plus estimates where nothing matched. The app's files
 * (`services/nativeUsageHistory.js`) count every session on the machine —
 * terminal and desktop use included — and are the source of truth for them. So
 * for a CLI/TUI provider of a family with a native store:
 *
 *   reported tokens = native store + estimates + measured ephemeral turns
 *
 * The ledger's measured share came from those same files and is dropped. Its
 * estimated and `unpersisted` measured shares are absent from native history
 * (PortOS runs one-shots and reviews with `--no-session-persistence` / `--ephemeral`, and a run whose
 * session could not be found), so it is kept. API providers, local models and
 * every non-token counter (sessions, images, video seconds) are untouched.
 *
 * Which days:
 *   - from the store's `coverageStart` to the day it was last refreshed, the
 *     store is complete: always replace.
 *   - before `coverageStart` the app may already have pruned some files, so the
 *     store can be partial: replace only when it shows MORE than the ledger.
 *   - after the last refresh (a scan that keeps failing): ledger.
 * A store with no days at all is ignored, so a reader that finds nothing can
 * never zero out the ledger.
 *
 * Pure. Returns a new `dailyActivity`; the input is not modified.
 */

const STORE_FIELDS = { messages: 'messages', tokensIn: 'input', tokensOut: 'output', cacheReadTokens: 'cacheRead',
  cacheWriteTokens: 'cacheWrite', longTokensIn: 'longInput', longTokensOut: 'longOutput',
  longCacheReadTokens: 'longCacheRead', longCacheWriteTokens: 'longCacheWrite',
  fastTokensIn: 'fastInput', fastTokensOut: 'fastOutput', fastCacheReadTokens: 'fastCacheRead', fastCacheWriteTokens: 'fastCacheWrite',
  ultrafastTokensIn: 'ultrafastInput', ultrafastTokensOut: 'ultrafastOutput',
  ultrafastCacheReadTokens: 'ultrafastCacheRead', ultrafastCacheWriteTokens: 'ultrafastCacheWrite' };
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const billed = (counts) => BILLED_FIELDS.reduce((sum, field) => sum + num(counts?.[field]), 0);
const speedOf = (counts, fields) => fields.reduce((sum, field) => sum + num(counts?.[field]), 0);
const SESSION_TYPES = new Set(['cli', 'tui']);

/** Ledger field counts for one native store row. */
const nativeCounts = (row) => Object.fromEntries(TOKEN_FIELDS.map((field) => [field, num(row?.[STORE_FIELDS[field]])]));

/**
 * The share of a ledger bucket the provider app never recorded. Buckets written
 * before `estimated` existed carry only a source label: a wholly estimated (or
 * unlabeled, i.e. pre-measurement) bucket is all estimate; a measured or mixed
 * one is treated as measured.
 */
function estimatedShare(bucket) {
  if (bucket?.estimated) return Object.fromEntries(TOKEN_FIELDS.map((field) => [field, Math.min(num(bucket[field]), num(bucket.estimated[field]))]));
  const all = bucket?.source === 'estimate' || bucket?.source == null;
  return Object.fromEntries(TOKEN_FIELDS.map((field) => [field, all ? num(bucket?.[field]) : 0]));
}

// Measured ephemeral turns are absent from the native store just like estimates,
// but retain measured provenance. The two shares are disjoint at ledger write.
function retainedShare(bucket) {
  const estimated = estimatedShare(bucket);
  return Object.fromEntries(TOKEN_FIELDS.map((field) => [field,
    Math.min(num(bucket?.[field]), estimated[field] + num(bucket?.unpersisted?.[field])),
  ]));
}
const retainedSource = (bucket) => {
  const estimated = billed(estimatedShare(bucket)) > 0;
  const measured = billed(bucket?.unpersisted) > 0;
  return estimated && measured ? 'mixed' : estimated ? 'estimate' : measured ? 'measured' : null;
};

/**
 * What a provider bucket keeps: its models' retained shares, plus the retained
 * part of any counts no model row carries. Provider totals then always match
 * `byModel`, which the report prices and reconciles against.
 */
function keptShare(bucket) {
  const models = Object.values(bucket?.byModel || {});
  if (!models.length) return retainedShare(bucket);
  const modelKeeps = models.map(retainedShare);
  const residualEstimated = bucket?.estimated || bucket?.unpersisted
    ? (field) => num(bucket.estimated?.[field]) + num(bucket.unpersisted?.[field]) - models.reduce((sum, model) => sum + retainedShare(model)[field], 0)
    : (field) => (bucket?.source === 'estimate' || bucket?.source == null ? Infinity : 0);
  return Object.fromEntries(TOKEN_FIELDS.map((field) => {
    const kept = modelKeeps.reduce((sum, keep) => sum + keep[field], 0);
    const residual = Math.max(0, num(bucket?.[field]) - models.reduce((sum, model) => sum + num(model[field]), 0));
    return [field, kept + Math.max(0, Math.min(residual, residualEstimated(field)))];
  }));
}

/** The CLI/TUI providers whose sessions a family's store already counts, and the one to report them under. */
function nativeFamilyProviders(providers, family) {
  const members = (providers || []).filter((provider) => SESSION_TYPES.has(provider?.type) && familyForProvider(provider) === family);
  const enabled = members.filter((provider) => provider.enabled !== false);
  const pool = enabled.filter((provider) => provider.type === 'cli').length ? enabled.filter((provider) => provider.type === 'cli')
    : enabled.length ? enabled : members;
  const target = pool[0] ?? { id: `native-${family}`, name: familyLabel(family) };
  return { ids: new Set([...members.map((provider) => provider.id), target.id]), target };
}

function applyFamilyDay(day, nativeModels, { ids, target }, mode) {
  const native = Object.entries(nativeModels || {}).map(([model, row]) => [model, nativeCounts(row)]);
  const buckets = Object.entries(day.byProvider || {}).filter(([id]) => ids.has(id));
  if (mode === 'larger') {
    const ledgerTotal = buckets.reduce((sum, [, bucket]) => sum + billed(bucket), 0);
    const estimatedTotal = buckets.reduce((sum, [, bucket]) => sum + billed(keptShare(bucket)), 0);
    const nativeTotal = native.reduce((sum, [, counts]) => sum + billed(counts), 0);
    const combined = nativeTotal + estimatedTotal;
    // A partial native day (pruned files) must not replace a larger ledger.
    // Equal bases still replace when the native row carries a speed premium
    // the ledger does not: the premium is inside the base, so the base compare
    // alone would keep the ledger and drop it.
    if (combined < ledgerTotal) return false;
    if (combined === ledgerTotal) {
      const correctsSpeedClass = SPEED_CLASSES.some(fields => {
        const nativeSpeed = native.reduce((sum, [, counts]) => sum + speedOf(counts, fields), 0);
        const keptSpeed = buckets.reduce((sum, [, bucket]) => sum + speedOf(keptShare(bucket), fields), 0);
        const ledgerSpeed = buckets.reduce((sum, [, bucket]) => sum + speedOf(bucket, fields), 0);
        return nativeSpeed + keptSpeed > ledgerSpeed;
      });
      if (!correctsSpeedClass) return false;
    }
  }
  if (!native.length && !buckets.length) return false;
  day.byProvider ??= {};
  // Keep only the estimated share of every family bucket, per model and in total.
  for (const [, bucket] of buckets) {
    const keep = keptShare(bucket);
    for (const model of Object.values(bucket.byModel || {})) {
      const modelKeep = retainedShare(model);
      for (const field of TOKEN_FIELDS) if (model[field] != null || modelKeep[field]) model[field] = modelKeep[field];
      model.source = retainedSource(model) ?? model.source;
    }
    for (const field of TOKEN_FIELDS) if (bucket[field] != null || keep[field]) bucket[field] = keep[field];
    bucket.source = retainedSource(bucket);
  }
  if (native.length) {
    const bucket = day.byProvider[target.id] ??= { name: target.name || target.id, sessions: 0, byModel: {}, source: null };
    bucket.byModel ??= {};
    for (const [model, counts] of native) {
      const row = bucket.byModel[model] ??= { sessions: 0, source: null };
      const hadEstimate = billed(row) > 0 && row.source !== 'measured';
      for (const field of TOKEN_FIELDS) row[field] = num(row[field]) + counts[field];
      row.source = hadEstimate ? 'mixed' : 'measured';
      for (const field of TOKEN_FIELDS) bucket[field] = num(bucket[field]) + counts[field];
    }
    bucket.source = ['estimate', 'mixed'].includes(bucket.source) ? 'mixed' : 'measured';
  }
  return true;
}

/**
 * @param {object} dailyActivity the ledger's `day -> { byProvider }` map
 * @param {{ stores?: Record<string, { days: object, updatedAt: string|null, coverageStart: string|null }|null>, providers?: object[] }} options
 * @returns {object} a new dailyActivity
 */
export function overlayNativeUsage(dailyActivity, { stores = {}, providers = [] } = {}) {
  const families = Object.entries(stores || {})
    .filter(([, store]) => store?.updatedAt && store.coverageStart && Object.keys(store.days || {}).length)
    .map(([family, store]) => ({ family, store, through: store.updatedAt.slice(0, 10), members: nativeFamilyProviders(providers, family) }));
  if (!families.length) return dailyActivity || {};
  const out = structuredClone(dailyActivity || {});
  const dayKeys = new Set(Object.keys(out));
  for (const { store } of families) for (const day of Object.keys(store.days)) dayKeys.add(day);
  for (const key of dayKeys) {
    let changed = false;
    for (const { store, through, members } of families) {
      if (key > through) continue;
      const mode = key >= store.coverageStart ? 'replace' : 'larger';
      const day = out[key] ?? { sessions: 0, messages: 0, tokens: 0, byProvider: {} };
      if (applyFamilyDay(day, store.days[key], members, mode)) {
        out[key] = day;
        changed = true;
      }
    }
    if (changed) rebuildDayTotals(out[key]);
  }
  return out;
}
