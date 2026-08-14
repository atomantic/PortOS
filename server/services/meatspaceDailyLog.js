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
import { PATHS, readJSONFile } from '../lib/fileUtils.js';
import { readDailyLogIfEnabled } from './mortalLoomStore.js';

export const DAILY_LOG_FILE = join(PATHS.meatspace, 'daily-log.json');

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
