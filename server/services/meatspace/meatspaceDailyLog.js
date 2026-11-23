/**
 * MeatSpace Daily Log Reader
 *
 * `data/meatspace/daily-log.json` is one file with several tenants (alcohol, nicotine and
 * body-composition entries on day-keyed records); this is the single copy of the read they
 * delegate to (#2726, #4112). Two entry points:
 *  - `loadMeatspaceDailyLog`: full read, MortalLoom-first, for alcohol/nicotine (whose
 *    records MortalLoom composes into a daily log).
 *  - `readLocalDailyLog`: local mirror only, for callers that probe MortalLoom on a different
 *    key (body entries) or deliberately read only the local file (export, overview).
 * Absent is a trustworthy empty; present-but-unreadable/malformed is a failure, and under
 * `strict: true` it throws so a caller that COUNTS entries cannot report a fake 0.
 */

import { invalidateMeatspace } from './meatspaceEvents.js';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { PATHS, readJSONFile, atomicWrite, ensureDir } from '../../lib/fileUtils.js';
import { readDailyLogIfEnabled } from '../mortalLoomStore.js';
import { createFileWriteQueue } from '../../lib/fileWriteQueue.js';
import { parseTsMs, compareNewerWins } from '../../lib/lwwTimestamp.js';
import { recordTombstone, supersedingTimestamp } from '../../lib/tombstones.js';

export const DAILY_LOG_FILE = join(PATHS.meatspace, 'daily-log.json');

export const queueDailyLogWrite = createFileWriteQueue();

// Fresh object per call — callers mutate the log they get back (entry push,
// lastEntryDate stamp) before writing it, so a shared constant would leak state.
const emptyDailyLog = () => ({ entries: [], lastEntryDate: null });
const resourceSnapshot = (entries, key) => JSON.stringify(
  entries?.filter(entry => entry[key]).map(entry => ({ date: entry.date, value: entry[key] }))
);

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
 * Read the daily log, preferring the MortalLoom-composed view when iCloud sync is on, else
 * the local mirror.
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
 * Serialized read-modify-write on `daily-log.json`: writes queue through
 * `queueDailyLogWrite`, the read is `readLocalDailyLog({ strict: true, label })` so a
 * transient failure cannot truncate history (#2726), then `mutatorFn(log)` may mutate in
 * place, entries re-sort by date, `lastEntryDate` updates, and the file is written atomically.
 *
 * @param {(log: { entries: object[], lastEntryDate: string|null }) => Promise<any>|any} mutatorFn
 *   Return `null` when the targeted record is absent: that skips the write. Any other
 *   return, including `undefined`, persists.
 * @param {{ label?: string }} [options]
 * @returns {Promise<any>} The result of mutatorFn, or the updated log if mutatorFn returns undefined.
 */
export async function mutateDailyLog(mutatorFn, { label = 'MeatSpace' } = {}) {
  return queueDailyLogWrite(async () => {
    const log = await readLocalDailyLog({ strict: true, label });
    const beforeAlcohol = resourceSnapshot(log.entries, 'alcohol');
    const beforeBody = resourceSnapshot(log.entries, 'body');
    const result = await mutatorFn(log);
    if (result === null) return result;
    if (Array.isArray(log?.entries)) {
      log.entries.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
      log.lastEntryDate = log.entries.length > 0 ? (log.entries[log.entries.length - 1]?.date || null) : null;
    }
    await ensureDir(PATHS.meatspace);
    await atomicWrite(DAILY_LOG_FILE, log);
    invalidateMeatspace([
      'overview',
      ...(beforeAlcohol !== resourceSnapshot(log.entries, 'alcohol') ? ['alcohol'] : []),
      ...(beforeBody !== resourceSnapshot(log.entries, 'body') ? ['body'] : []),
    ]);
    return result !== undefined ? result : log;
  });
}

/**
 * Mint a logged alcohol drink or nicotine item as its own event (#8143): peers merge rows
 * by `id`, so identical same-day rows from two machines stay two events. `updatedAt` is
 * the last-writer-wins stamp. Legacy rows carry no `id` and merge by full content.
 */
export function newDailyLogEvent(fields, now = new Date().toISOString()) {
  return { id: randomUUID(), ...fields, createdAt: now, updatedAt: now };
}

/**
 * Restamp an event about to be edited so the edit wins over a peer's older copy. Call it
 * BEFORE changing any field: a legacy row (no `id`) gets an id and records its pre-edit
 * content in `replaces`, so a peer holding the unedited row does not merge it back.
 */
export function stampDailyLogEventEdit(event, now = new Date().toISOString()) {
  if (typeof event.id !== 'string' || !event.id) {
    event.replaces = { ...event };
    event.id = randomUUID();
  }
  // Step past the edited copy even if a peer's clock ran ahead, or that stale copy wins the id merge.
  event.updatedAt = supersedingTimestamp(dailyLogEventLiveStamp(event), now);
  return event;
}

/** The newer of an event's `createdAt` and `updatedAt`: the instant a deletion must beat; null for a legacy row. */
export function dailyLogEventLiveStamp(event) {
  const { createdAt, updatedAt } = event || {};
  if (compareNewerWins(createdAt, updatedAt)) return createdAt;
  return parseTsMs(updatedAt) === null ? null : updatedAt;
}

/** Top-level `daily-log.json` field holding `{ id, deletedAt }` event tombstones (#8154). */
export const DAILY_LOG_TOMBSTONES_KEY = 'eventTombstones';

/**
 * Record that a drink/nicotine event was deleted so peers drop it on next sync (#8154). The
 * stamp is kept past the event's live stamp so the deletion wins under clock skew. A legacy
 * row without an `id` has no identity a peer could match, so its delete stays local.
 */
export function tombstoneDailyLogEvent(log, event, now = new Date().toISOString()) {
  if (typeof event?.id !== 'string' || !event.id) return;
  const deletedAt = supersedingTimestamp(dailyLogEventLiveStamp(event), now);
  log[DAILY_LOG_TOMBSTONES_KEY] = recordTombstone(log[DAILY_LOG_TOMBSTONES_KEY], event.id, { keyField: 'id', deletedAt });
}
