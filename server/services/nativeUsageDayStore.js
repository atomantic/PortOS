import { stat } from 'fs/promises';
import { atomicWrite, readJSONFile } from '../lib/fileUtils.js';
import { createMutex } from '../lib/asyncMutex.js';
import { isPlainObject, POLLUTING_KEYS, bucketFor } from '../lib/objects.js';
import { isNonBlankStr } from '../lib/textUtils.js';
import { usageLedgerFenced } from './usageCutoverBarrier.js';

/**
 * A persisted `day -> model -> counts` history of one provider app's own usage
 * records (Claude Code transcripts, Codex rollouts, Grok sessions, …).
 *
 * The provider apps prune their session files, so each scan is folded into this
 * store and the store keeps what the app has since deleted. A day is only ever
 * re-scanned whole (every file written since the scan floor is read), and the
 * fold keeps the larger count per field, so a rescan after pruning never
 * shrinks a stored day.
 *
 * `coverageStart` is the first day the store is known to hold COMPLETELY: the
 * first full scan reads everything on disk, but the app may already have pruned
 * files older than its retention window, so days before
 * `firstScan - retentionDays` can be partial. The Usage report trusts the store
 * as the source of truth from `coverageStart` on (see `nativeUsageOverlay.js`).
 *
 * Days are UTC calendar days, matching `usageRange.js`. Scans read local files
 * only; no provider calls.
 */

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;
const MAX_DAYS = 800;
const MAX_MODELS_PER_DAY = 100;
const num = (v) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0);
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);

/** Rebuild a day -> model -> counts map to `fields`, dropping anything else. */
function sanitizeNativeUsageDays(raw, fields) {
  const out = {};
  if (!isPlainObject(raw)) return out;
  const dayKeys = Object.keys(raw).filter((d) => DAY_RE.test(d)).sort().slice(-MAX_DAYS);
  for (const day of dayKeys) {
    if (!isPlainObject(raw[day])) continue;
    for (const [model, counts] of Object.entries(raw[day]).slice(0, MAX_MODELS_PER_DAY)) {
      if (!isNonBlankStr(model) || POLLUTING_KEYS.has(model)) continue;
      const trimmedModel = model.slice(0, 200);
      if (POLLUTING_KEYS.has(trimmedModel)) continue;
      const dayBucket = bucketFor(out, day, () => ({}));
      if (!dayBucket) continue;
      dayBucket[trimmedModel] = Object.fromEntries(fields.map((f) => [f, num(counts?.[f])]));
    }
  }
  return out;
}

// Per (day, model, field) the larger count wins: a rescan of a day whose oldest
// files were pruned must never shrink what an earlier scan saw.
function mergeDays(stored, scanned, fields) {
  const merged = { ...stored };
  for (const [day, models] of Object.entries(scanned || {})) {
    if (POLLUTING_KEYS.has(day) || !isPlainObject(models)) continue;
    const target = { ...(isPlainObject(merged[day]) ? merged[day] : {}) };
    for (const [model, row] of Object.entries(models)) {
      if (!isNonBlankStr(model) || POLLUTING_KEYS.has(model) || !isPlainObject(row)) continue;
      const prev = Object.hasOwn(target, model) && isPlainObject(target[model]) ? target[model] : {};
      target[model] = Object.fromEntries(fields.map((f) => [f, Math.max(num(prev[f]), num(row[f]))]));
    }
    merged[day] = target;
  }
  return sanitizeNativeUsageDays(merged, fields);
}

const earliestDay = (days) => Object.keys(days).sort()[0] ?? null;

/**
 * @param {object} spec
 * @param {string} spec.family provider family id (`claude`, `codex`, `grok`, `agy`)
 * @param {string} spec.file persisted store path
 * @param {string[]} spec.fields per-model counters kept for this family
 * @param {(opts: { from: string|null }) => Promise<{ days: object, filesScanned?: number, incomplete?: string }>} spec.scan
 *   reads the app's files written on or after `from` (null = everything). A result
 *   with `incomplete` set is not folded in, so a partial read never advances coverage.
 * @param {number} [spec.retentionDays] how long the app keeps its files (unknown → 30)
 * @param {number} [spec.scanVersion] bump when `scan` starts finding counts it
 *   missed in days already stored: the next refresh rescans everything once. Only
 *   for a scan that finds MORE; the max-merge cannot undo a count that moved tiers.
 */
export function createNativeUsageStore({ family, file, fields, scan, retentionDays = 30, lookbackDays = 3, staleMs = 5 * 60_000, scanVersion = 1 }) {
  const withLock = createMutex();
  let memo = null;

  /** `{ days, updatedAt, coverageStart }`. Throws when the file exists but is unreadable. */
  async function read() {
    const info = await stat(file).catch(() => null);
    const key = info ? `${info.mtimeMs}|${info.size}` : null;
    if (key && memo?.key === key) return memo.value;
    // Strict: a damaged store must stop the refresh, not read as empty and be
    // overwritten by a rescan of only the files the app has not yet pruned.
    const raw = await readJSONFile(file, null, { strict: true });
    const value = {
      family,
      days: sanitizeNativeUsageDays(raw?.days, fields),
      updatedAt: isNonBlankStr(raw?.updatedAt) ? raw.updatedAt : null,
      coverageStart: typeof raw?.coverageStart === 'string' && DAY_RE.test(raw.coverageStart) ? raw.coverageStart : null,
      scanVersion: Number.isSafeInteger(raw?.scanVersion) ? raw.scanVersion : 1,
    };
    memo = key ? { key, value } : null;
    return value;
  }

  /**
   * Fold a fresh scan into the store. Until coverage is established every file is
   * read; after that only the last few days are. Skipped when the store is younger
   * than `staleMs` unless `force`.
   */
  function refresh({ force = false, now = Date.now(), ...scanOptions } = {}) {
    return withLock(async () => {
      const stored = await read();
      const age = stored.updatedAt ? now - Date.parse(stored.updatedAt) : Infinity;
      if (!force && age < staleMs) return { ...stored, filesScanned: 0, refreshed: false };
      // The app's files stay on disk, so the next refresh after a fence catches up.
      if (await usageLedgerFenced()) return { ...stored, filesScanned: 0, refreshed: false };
      const current = stored.coverageStart && stored.updatedAt && stored.scanVersion === scanVersion;
      const from = current ? dayOf(now - lookbackDays * DAY_MS) : null;
      const result = await scan({ ...scanOptions, from });
      if (result?.incomplete) return { ...stored, filesScanned: result.filesScanned ?? 0, refreshed: false, incomplete: result.incomplete };
      const days = mergeDays(stored.days, result?.days, fields);
      const retentionFloor = dayOf(now - retentionDays * DAY_MS);
      const first = earliestDay(days);
      const coverageStart = stored.coverageStart ?? (first && first > retentionFloor ? first : retentionFloor);
      const next = { days, updatedAt: new Date(now).toISOString(), coverageStart, scanVersion };
      await atomicWrite(file, next);
      return { family, ...next, filesScanned: result?.filesScanned ?? 0, refreshed: true };
    });
  }

  return { family, file, fields, read, refresh, sanitize: (raw) => sanitizeNativeUsageDays(raw, fields) };
}
