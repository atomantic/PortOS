/**
 * Migration 081 — bring the Daily Log (journals) and Inbox into brain peer-sync.
 *
 * Both stores were previously OUTSIDE the brain entity-store contract, so neither
 * ever entered the sync log — they silently never federated across peers:
 *   - The Daily Log lived in journals.json with the right `{ records: { date: e } }`
 *     SHAPE, but its entries were written by a separate brainJournal store that
 *     never called brainSyncLog.appendChange, and `journals` wasn't in
 *     BRAIN_ENTITY_TYPES, so even a received entry would be dropped on apply.
 *   - The Inbox lived in inbox_log.jsonl, an append-only JSONL with no id-keyed
 *     map, no updatedAt LWW clock, and no tombstones.
 *
 * brainStorage now lists `journals` and `inbox` in BRAIN_ENTITY_TYPES as ordinary
 * `{ records: { id: record } }` stores. This migration reshapes the on-disk data
 * to match that contract so existing entries sync going forward:
 *
 *   1. journals.json — STRIP the inner `id` field from each entry (the map key is
 *      the record id now, and an inner `id` would clobber the date key that
 *      getById re-attaches), then stamp the sync fields (originInstanceId +
 *      createdAt/updatedAt fallbacks) any entry is missing.
 *   2. inbox_log.jsonl → inbox.json — re-key each JSONL row by its `id` into a
 *      records map, drop the now-redundant inner `id`, and stamp the same sync
 *      fields (createdAt/updatedAt seeded from capturedAt so the LWW clock is
 *      meaningful). The old .jsonl is renamed aside (.migrated) as a recovery
 *      copy rather than deleted.
 *
 * Idempotent: re-running finds the inner `id` already stripped and the sync
 * fields already present, and skips a missing/renamed inbox_log.jsonl. The wire
 * format is the standard entity-store record, so no schemaVersion bump is needed
 * — but a peer still on pre-081 code simply won't have `journals`/`inbox` in its
 * BRAIN_ENTITY_TYPES and will skip those records on apply (forward-compatible).
 *
 * Runs in the boot-time migration runner, BEFORE the service layer is wired up,
 * so it reads the instance id straight from data/instances.json and rewrites the
 * JSON files directly.
 */

import { readFile, writeFile, rename } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

const UNKNOWN_INSTANCE = 'unknown';

// Read this install's instance id without importing the service layer (which the
// boot-time runner can't load yet). Falls back to the 'unknown' sentinel that
// brainStorage itself uses when identity is unavailable.
async function readInstanceId(rootDir) {
  const file = join(rootDir, 'data', 'instances.json');
  if (!existsSync(file)) return UNKNOWN_INSTANCE;
  const raw = await readFile(file, 'utf-8').catch(() => null);
  if (raw == null) return UNKNOWN_INSTANCE;
  try {
    return JSON.parse(raw)?.self?.instanceId || UNKNOWN_INSTANCE;
  } catch {
    return UNKNOWN_INSTANCE;
  }
}

// Stamp the entity-store sync fields a record is missing, WITHOUT overwriting
// values it already has. `seedTime` seeds createdAt/updatedAt when absent (for
// inbox we pass capturedAt so the LWW clock reflects real capture order; for
// journals we pass the existing updatedAt/createdAt or now()). Returns a new
// object with the inner `id` removed (the map key is the id).
function normalizeRecord(record, { instanceId, seedTime, nowIso }) {
  // eslint-disable-next-line no-unused-vars
  const { id: _innerId, ...rest } = record;
  return {
    ...rest,
    originInstanceId: rest.originInstanceId || instanceId,
    createdAt: rest.createdAt || seedTime || nowIso,
    updatedAt: rest.updatedAt || seedTime || rest.createdAt || nowIso,
  };
}

/**
 * Pure transform over parsed inputs, exported for unit tests.
 *   - journalsStore: parsed journals.json (or null if absent).
 *   - inboxRows: array of parsed inbox_log.jsonl rows (empty if absent).
 * Returns { journalsStore, inboxStore, journalsChanged, inboxCount }.
 */
export function computeDailyLogInboxMigration(journalsStore, inboxRows, { instanceId, nowIso }) {
  // 1. Journals: normalize each entry in place (strip inner id, stamp sync fields).
  let journalsChanged = false;
  let outJournals = null;
  if (journalsStore && typeof journalsStore === 'object') {
    const records = journalsStore.records && typeof journalsStore.records === 'object'
      ? journalsStore.records
      : {};
    const nextRecords = {};
    for (const [date, entry] of Object.entries(records)) {
      if (!entry || typeof entry !== 'object') continue;
      const before = JSON.stringify(entry);
      // Seed from the entry's own updatedAt/createdAt so we don't bump the LWW
      // clock of days that already have one.
      const normalized = normalizeRecord(entry, {
        instanceId,
        seedTime: entry.updatedAt || entry.createdAt || nowIso,
        nowIso,
      });
      nextRecords[date] = normalized;
      if (JSON.stringify(normalized) !== before) journalsChanged = true;
    }
    outJournals = { ...journalsStore, records: nextRecords };
  }

  // 2. Inbox: re-key JSONL rows by id into a records map.
  const inboxRecords = {};
  let inboxCount = 0;
  for (const row of inboxRows) {
    if (!row || typeof row !== 'object' || !row.id) continue;
    inboxRecords[row.id] = normalizeRecord(row, {
      instanceId,
      seedTime: row.capturedAt || nowIso,
      nowIso,
    });
    inboxCount++;
  }
  const inboxStore = { records: inboxRecords };

  return { journalsStore: outJournals, inboxStore, journalsChanged, inboxCount };
}

function parseJsonl(content) {
  const rows = [];
  for (const line of content.trim().split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      // Skip a corrupt/half-written line rather than aborting the migration.
    }
  }
  return rows;
}

export async function up({ rootDir }) {
  const brainDir = join(rootDir, 'data', 'brain');
  const journalsPath = join(brainDir, 'journals.json');
  const legacyInboxPath = join(brainDir, 'inbox_log.jsonl');
  const inboxPath = join(brainDir, 'inbox.json');

  const instanceId = await readInstanceId(rootDir);
  const nowIso = new Date().toISOString();

  // Load journals.json if present.
  let journalsStore = null;
  if (existsSync(journalsPath)) {
    const raw = await readFile(journalsPath, 'utf-8').catch(() => null);
    if (raw != null) {
      try { journalsStore = JSON.parse(raw); } catch { journalsStore = null; }
    }
  }

  // Load legacy inbox JSONL if present AND we haven't already produced inbox.json
  // (idempotency: once migrated, the .jsonl is renamed aside so this is skipped).
  let inboxRows = [];
  const hasLegacyInbox = existsSync(legacyInboxPath);
  if (hasLegacyInbox) {
    const raw = await readFile(legacyInboxPath, 'utf-8').catch(() => null);
    if (raw != null) inboxRows = parseJsonl(raw);
  }

  const { journalsStore: outJournals, inboxStore, journalsChanged, inboxCount } =
    computeDailyLogInboxMigration(journalsStore, inboxRows, { instanceId, nowIso });

  if (outJournals && journalsChanged) {
    await writeFile(journalsPath, JSON.stringify(outJournals, null, 2));
  }

  // Only write inbox.json + retire the legacy file when there was a legacy file
  // to convert. If inbox.json already exists and no .jsonl remains, this is a
  // re-run — leave the authoritative inbox.json untouched.
  if (hasLegacyInbox) {
    // Merge into an existing inbox.json if a partial prior run left one, so we
    // never drop records already converted. New rows win only when absent.
    let existing = {};
    if (existsSync(inboxPath)) {
      const raw = await readFile(inboxPath, 'utf-8').catch(() => null);
      if (raw != null) {
        try { existing = JSON.parse(raw)?.records || {}; } catch { existing = {}; }
      }
    }
    const merged = { records: { ...inboxStore.records, ...existing } };
    await writeFile(inboxPath, JSON.stringify(merged, null, 2));
    // Rename the legacy JSONL aside as a recovery copy (idempotent: gone next run).
    await rename(legacyInboxPath, `${legacyInboxPath}.migrated`);
  }

  console.log(
    `🧠 daily-log/inbox-sync: journals ${journalsChanged ? 'normalized' : 'already current'}, ` +
    `inbox ${hasLegacyInbox ? `migrated ${inboxCount} entr${inboxCount === 1 ? 'y' : 'ies'} → inbox.json` : 'already current'}`
  );
}

export default { up };
