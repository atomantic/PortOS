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

import { invalidateMeatspace } from './meatspaceEvents.js';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { PATHS, readJSONFile, atomicWrite, ensureDir } from '../lib/fileUtils.js';
import { readDailyLogIfEnabled } from './mortalLoomStore.js';
import { createFileWriteQueue } from '../lib/fileWriteQueue.js';
import { parseTsMs, compareNewerWins } from '../lib/lwwTimestamp.js';
import { recordTombstone, supersedingTimestamp } from '../lib/tombstones.js';

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
 * Mint a logged alcohol drink or nicotine item as its own event (#8143).
 *
 * Peers merge these rows by `id`, so two machines that each log the same drink on
 * the same day keep two events instead of collapsing byte-identical rows into one.
 * `updatedAt` is the last-writer-wins stamp for edits. Rows logged before this
 * existed carry no `id` and keep merging by their full content.
 */
export function newDailyLogEvent(fields, now = new Date().toISOString()) {
  return { id: randomUUID(), ...fields, createdAt: now, updatedAt: now };
}

/**
 * Restamp an event about to be edited so the edit wins over a peer's older copy.
 * Call it BEFORE changing any field: a legacy row (no `id`) gets an id here and
 * records its pre-edit content in `replaces`, so a peer that still holds the
 * unedited legacy row does not merge it back in as a second event.
 */
export function stampDailyLogEventEdit(event, now = new Date().toISOString()) {
  if (typeof event.id !== 'string' || !event.id) {
    event.replaces = { ...event };
    event.id = randomUUID();
  }
  // Step past the copy being edited even if a peer that last touched it ran a
  // clock ahead of ours; otherwise that stale copy would win the id merge.
  event.updatedAt = supersedingTimestamp(dailyLogEventLiveStamp(event), now);
  return event;
}

/**
 * The newer of an event's `createdAt` and `updatedAt` — the instant a deletion
 * has to beat. Null for a legacy row with neither stamp.
 */
export function dailyLogEventLiveStamp(event) {
  const { createdAt, updatedAt } = event || {};
  if (compareNewerWins(createdAt, updatedAt)) return createdAt;
  return parseTsMs(updatedAt) === null ? null : updatedAt;
}

/** Top-level `daily-log.json` field holding `{ id, deletedAt }` event tombstones (#8154). */
export const DAILY_LOG_TOMBSTONES_KEY = 'eventTombstones';

/**
 * Record that a logged drink/nicotine event was deleted, so peers that still
 * hold it drop it on their next sync instead of sending it back (#8154). The
 * stamp is kept past the event's own live stamp so the deletion wins over the
 * copy the user was looking at even under clock skew. A legacy row without an
 * `id` has no identity a peer could match on, so its delete stays local.
 */
export function tombstoneDailyLogEvent(log, event, now = new Date().toISOString()) {
  if (typeof event?.id !== 'string' || !event.id) return;
  const deletedAt = supersedingTimestamp(dailyLogEventLiveStamp(event), now);
  log[DAILY_LOG_TOMBSTONES_KEY] = recordTombstone(log[DAILY_LOG_TOMBSTONES_KEY], event.id, { keyField: 'id', deletedAt });
}
