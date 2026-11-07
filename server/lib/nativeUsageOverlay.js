import { familyForProvider, familyLabel } from './providerFamilies.js';

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
 *   reported tokens = native store + the ledger's ESTIMATED share
 *
 * The ledger's measured share came from those same files and is dropped. Its
 * estimated share is usage the app never recorded (PortOS runs one-shots and
 * reviews with `--no-session-persistence` / `--ephemeral`, and a run whose
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

const TOKEN_FIELDS = ['messages', 'tokensIn', 'tokensOut', 'cacheReadTokens', 'cacheWriteTokens',
  'longTokensIn', 'longTokensOut', 'longCacheReadTokens', 'longCacheWriteTokens'];
const BILLED_FIELDS = ['tokensIn', 'tokensOut', 'cacheReadTokens', 'cacheWriteTokens'];
const STORE_FIELDS = { messages: 'messages', tokensIn: 'input', tokensOut: 'output', cacheReadTokens: 'cacheRead',
  cacheWriteTokens: 'cacheWrite', longTokensIn: 'longInput', longTokensOut: 'longOutput',
  longCacheReadTokens: 'longCacheRead', longCacheWriteTokens: 'longCacheWrite' };
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const billed = (counts) => BILLED_FIELDS.reduce((sum, field) => sum + num(counts?.[field]), 0);
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
    const estimatedTotal = buckets.reduce((sum, [, bucket]) => sum + billed(estimatedShare(bucket)), 0);
    const nativeTotal = native.reduce((sum, [, counts]) => sum + billed(counts), 0);
    if (nativeTotal + estimatedTotal <= ledgerTotal) return false;
  }
  if (!native.length && !buckets.length) return false;
  day.byProvider ??= {};
  // Keep only the estimated share of every family bucket, per model and in total.
  for (const [, bucket] of buckets) {
    const keep = estimatedShare(bucket);
    for (const model of Object.values(bucket.byModel || {})) {
      const modelKeep = estimatedShare(model);
      for (const field of TOKEN_FIELDS) if (model[field] != null || modelKeep[field]) model[field] = modelKeep[field];
      model.source = billed(modelKeep) > 0 ? 'estimate' : model.source;
    }
    for (const field of TOKEN_FIELDS) if (bucket[field] != null || keep[field]) bucket[field] = keep[field];
    bucket.source = billed(keep) > 0 ? 'estimate' : null;
  }
  if (native.length) {
    const bucket = day.byProvider[target.id] ??= { name: target.name || target.id, sessions: 0, byModel: {}, source: null };
    bucket.byModel ??= {};
    for (const [model, counts] of native) {
      const row = bucket.byModel[model] ??= { sessions: 0, source: null };
      const hadEstimate = billed(row) > 0;
      for (const field of TOKEN_FIELDS) row[field] = num(row[field]) + counts[field];
      row.source = hadEstimate ? 'mixed' : 'measured';
      for (const field of TOKEN_FIELDS) bucket[field] = num(bucket[field]) + counts[field];
    }
    bucket.source = bucket.source === 'estimate' ? 'mixed' : 'measured';
  }
  return true;
}

function rebuildDayTotals(day) {
  const providers = Object.values(day.byProvider || {});
  day.sessions = providers.reduce((sum, provider) => sum + num(provider.sessions), 0);
  day.messages = providers.reduce((sum, provider) => sum + num(provider.messages), 0);
  day.tokensIn = providers.reduce((sum, provider) => sum + num(provider.tokensIn), 0);
  day.tokensOut = providers.reduce((sum, provider) => sum + num(provider.tokensOut), 0);
  day.tokens = day.tokensOut;
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
