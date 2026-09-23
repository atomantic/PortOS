/**
 * MeatSpace Daily Log Reader
 *
 * `data/meatspace/daily-log.json` is one file with several tenants — alcohol,
 * nicotine, and body-composition entries all live on the same day-keyed records —
 * so every one of those services needs to read it. They each used to carry their
 * own copy of the read: same MortalLoom probe, same `{ entries: [], lastEntryDate:
 * null }` default, same shape validation, same `{ strict }` branch (#2726). This is
 * the single copy they all delegate to (#4112).
 *
 * Two entry points, because the MortalLoom half is not universal:
 *  - `loadMeatspaceDailyLog` — the full read, MortalLoom-first. Correct for the
 *    alcohol/nicotine services, whose records MortalLoom composes INTO a daily log
 *    (`readDailyLogIfEnabled`).
 *  - `readLocalDailyLog` — the local mirror only. Correct for callers that either
 *    probe MortalLoom on a different key first (body entries come from the
 *    `bodyEntries` array, not the composed daily log) or deliberately read only the
 *    local file (export, overview).
 *
 * Both keep the sentinel distinction the strict branch exists for: absent is a
 * trustworthy empty, present-but-unreadable/malformed is a failure. Under
 * `strict: true` the second must throw rather than collapse into the first, so a
 * caller that COUNTS these entries can't report a fake 0 (#2726).
 */

import { join } from 'path';
import { PATHS, readJSONFile, atomicWrite, ensureDir } from '../lib/fileUtils.js';
import { readDailyLogIfEnabled } from './mortalLoomStore.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';

export const DAILY_LOG_FILE = join(PATHS.meatspace, 'daily-log.json');

export const queueDailyLogWrite = createFileWriteQueue();

// Fresh object per call — callers mutate the log they get back (entry push,
// lastEntryDate stamp) before writing it, so a shared constant would leak state.
const emptyDailyLog = () => ({ entries: [], lastEntryDate: null });

/**
 * Read the local `daily-log.json` mirror, without consulting MortalLoom.
 *
 * @param {{ strict?: boolean, label?: string }} [options]
 *   `strict: true` throws when the file is present-but-unreadable or shaped wrong,
 *   instead of substituting an empty log. Off by default so the UI keeps degrading
 *   gracefully. `label` names the domain in the malformed-log error.
 * @returns {Promise<{ entries: object[], lastEntryDate: string|null }>}
 */
export async function readLocalDailyLog({ strict = false, label = 'MeatSpace' } = {}) {
  const raw = await readJSONFile(DAILY_LOG_FILE, emptyDailyLog(), { allowArray: false, strict });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    if (strict) throw new Error(`${label} daily log malformed: ${DAILY_LOG_FILE}`);
    return emptyDailyLog();
  }
  if (!Array.isArray(raw.entries)) {
    if (strict) throw new Error(`${label} daily log malformed: ${DAILY_LOG_FILE}`);
    raw.entries = [];
  }
  return raw;
}

/**
 * Read the daily log, preferring the MortalLoom-composed view when iCloud sync is
 * on and falling back to the local mirror when it is not.
 *
 * @param {{ strict?: boolean, label?: string }} [options] - see `readLocalDailyLog`.
 *   Under `strict` the MortalLoom probe throws on a present-but-unreadable store
 *   rather than falling through to a local log that may be a genuine ENOENT (#2742).
 * @returns {Promise<{ entries: object[], lastEntryDate: string|null }>}
 */
export async function loadMeatspaceDailyLog({ strict = false, label = 'MeatSpace' } = {}) {
  const ml = await readDailyLogIfEnabled({ strict });
  if (ml) return ml;
  return readLocalDailyLog({ strict, label });
}

/**
 * Coordinate a serialized read-modify-write cycle on `daily-log.json`.
 *
 * Encapsulates:
 * 1. Serializing writes through `queueDailyLogWrite` so concurrent mutators
 *    never interleave.
 * 2. Reading via `readLocalDailyLog({ strict: true, label })` so transient read
 *    failures fail fast instead of truncating historical entries (#2726).
 * 3. Invoking `mutatorFn(log)` which may mutate `log` in place.
 * 4. Sorting `log.entries` by date and updating `log.lastEntryDate`.
 * 5. Atomically writing the updated log back to `DAILY_LOG_FILE`.
 *
 * @param {(log: { entries: object[], lastEntryDate: string|null }) => Promise<any>|any} mutatorFn
 *   Return `null` when the targeted record is absent. That skips the write so a
 *   miss cannot rewrite the file. Any other return, including `undefined`, persists.
 * @param {{ label?: string }} [options]
 * @returns {Promise<any>} The result of mutatorFn, or the updated log if mutatorFn returns undefined.
 */
export async function mutateDailyLog(mutatorFn, { label = 'MeatSpace' } = {}) {
  return queueDailyLogWrite(async () => {
    const log = await readLocalDailyLog({ strict: true, label });
    const result = await mutatorFn(log);
    if (result === null) return result;
    if (Array.isArray(log?.entries)) {
      log.entries.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
      log.lastEntryDate = log.entries.length > 0 ? (log.entries[log.entries.length - 1]?.date || null) : null;
    }
    await ensureDir(PATHS.meatspace);
    await atomicWrite(DAILY_LOG_FILE, log);
    return result !== undefined ? result : log;
  });
}
