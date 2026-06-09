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
 *      getById re-attaches), STRIP the machine-local `obsidianPath`/
 *      `obsidianVaultId` into a non-synced sidecar (journal-obsidian-locations.json
 *      — federating them would poison the reconcile checksum across peers with
 *      different vaults and break local mirror cleanup), then stamp the sync
 *      fields (originInstanceId + createdAt/updatedAt fallbacks) any entry is missing.
 *   2. inbox_log.jsonl → inbox.json — re-key each JSONL row by its `id` into a
 *      records map, drop the now-redundant inner `id`, and stamp the same sync
 *      fields (createdAt/updatedAt seeded from capturedAt so the LWW clock is
 *      meaningful). The old .jsonl is renamed aside (.migrated) as a recovery
 *      copy rather than deleted.
 *   3. memory-bridge-map.json — the brain→memory vector bridge keys each
 *      vectorized journal as `journals:<innerUuid>`. Now that the journal record
 *      id is the DATE, re-key those entries to `journals:<date>` using the inner
 *      uuid we strip in step 1. Without this, the next edit to an existing day
 *      computes the new date-key, finds no match, and mints a DUPLICATE memory
 *      entry — orphaning the uuid-keyed one. (Inbox is not vectorized, so it has
 *      no bridge entries to remap.)
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
  // Strip the inner `id` (map key is the id) AND the machine-local Obsidian
  // fields (extracted to the sidecar by the caller; they must never federate).
  // The Obsidian keys are no-ops on inbox records, which never carry them.
  // eslint-disable-next-line no-unused-vars
  const { id: _innerId, obsidianPath: _op, obsidianVaultId: _ov, ...rest } = record;
  const normalized = {
    ...rest,
    createdAt: rest.createdAt || seedTime || nowIso,
    updatedAt: rest.updatedAt || seedTime || rest.createdAt || nowIso,
  };
  // Only stamp originInstanceId when we have a REAL id (or the record already
  // carries one). Migrations run before ensureSelf() creates instances.json, so
  // on a data dir copied in without it `instanceId` is the 'unknown' sentinel.
  // Baking 'unknown' onto a LIVE record is permanent — backfillOriginInstanceId
  // only repairs falsy values, so it would never fix it and the bogus provenance
  // would federate. Leaving the field absent instead lets that boot-time backfill
  // (which runs AFTER ensureSelf) fill the real id. (A tombstone legitimately
  // carries 'unknown', but tombstones never flow through this path.)
  if (rest.originInstanceId || instanceId !== UNKNOWN_INSTANCE) {
    normalized.originInstanceId = rest.originInstanceId || instanceId;
  }
  return normalized;
}

/**
 * Pure transform over parsed inputs, exported for unit tests.
 *   - journalsStore: parsed journals.json (or null if absent).
 *   - inboxRows: array of parsed inbox_log.jsonl rows (empty if absent).
 *   - bridgeMap: parsed memory-bridge-map.json (or null if absent).
 *   - obsidianLocations: parsed journal-obsidian-locations.json (or null if absent).
 * Returns { journalsStore, inboxStore, bridgeMap, bridgeRemapped, obsidianLocations,
 *           obsidianExtracted, journalsChanged, inboxCount }.
 */
export function computeDailyLogInboxMigration(journalsStore, inboxRows, { instanceId, nowIso, bridgeMap = null, obsidianLocations = null } = {}) {
  // 1. Journals: normalize each entry (strip inner id + machine-local Obsidian
  //    fields, stamp sync fields). Capture oldUuid→date so step 3 can re-key the
  //    memory bridge, and extract Obsidian location into the local sidecar so it
  //    stops federating (it would poison the reconcile checksum across peers with
  //    different vaults — see brainJournal.OBSIDIAN_LOCATIONS_FILE).
  let journalsChanged = false;
  let outJournals = null;
  const uuidToDate = new Map();
  const outLocations = { ...(obsidianLocations && typeof obsidianLocations === 'object' ? obsidianLocations : {}) };
  let obsidianExtracted = 0;
  if (journalsStore && typeof journalsStore === 'object') {
    const records = journalsStore.records && typeof journalsStore.records === 'object'
      ? journalsStore.records
      : {};
    const nextRecords = {};
    for (const [date, entry] of Object.entries(records)) {
      if (!entry || typeof entry !== 'object') continue;
      if (entry.id) uuidToDate.set(entry.id, date);
      // Move Obsidian location to the sidecar (only when the record carries one
      // and the sidecar doesn't already have an entry for this day — don't
      // overwrite a newer local sidecar on re-run).
      if ((entry.obsidianPath != null || entry.obsidianVaultId != null) && !(date in outLocations)) {
        outLocations[date] = {
          obsidianPath: entry.obsidianPath ?? null,
          obsidianVaultId: entry.obsidianVaultId ?? null,
        };
        obsidianExtracted++;
      }
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

  // 3. Memory bridge: re-key `journals:<oldUuid>` → `journals:<date>`. Only
  //    touches journal entries whose uuid we just mapped; leaves every other
  //    bridge entry (people/projects/…) and any already-date-keyed journal
  //    entry untouched (idempotent).
  let outBridge = null;
  let bridgeRemapped = 0;
  if (bridgeMap && typeof bridgeMap === 'object') {
    outBridge = { ...bridgeMap };
    for (const [oldUuid, date] of uuidToDate) {
      const oldKey = `journals:${oldUuid}`;
      const newKey = `journals:${date}`;
      if (oldKey in outBridge && !(newKey in outBridge)) {
        outBridge[newKey] = outBridge[oldKey];
        delete outBridge[oldKey];
        bridgeRemapped++;
      }
    }
  }

  // Only surface the sidecar when something was extracted (or one was passed in),
  // so a fresh install with no Obsidian usage doesn't get an empty file written.
  const outObsidian = (obsidianExtracted > 0 || obsidianLocations) ? outLocations : null;

  return {
    journalsStore: outJournals, inboxStore,
    bridgeMap: outBridge, bridgeRemapped,
    obsidianLocations: outObsidian, obsidianExtracted,
    journalsChanged, inboxCount,
  };
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
  const bridgeMapPath = join(brainDir, 'memory-bridge-map.json');
  const obsidianLocationsPath = join(brainDir, 'journal-obsidian-locations.json');

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

  // Load the memory-bridge map if present (for journal uuid→date re-keying).
  let bridgeMap = null;
  if (existsSync(bridgeMapPath)) {
    const raw = await readFile(bridgeMapPath, 'utf-8').catch(() => null);
    if (raw != null) {
      try { bridgeMap = JSON.parse(raw); } catch { bridgeMap = null; }
    }
  }

  // Load the local Obsidian-locations sidecar if a prior run already created one
  // (so we merge into it rather than clobber a newer local value).
  let obsidianLocations = null;
  if (existsSync(obsidianLocationsPath)) {
    const raw = await readFile(obsidianLocationsPath, 'utf-8').catch(() => null);
    if (raw != null) {
      try { obsidianLocations = JSON.parse(raw); } catch { obsidianLocations = null; }
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

  const {
    journalsStore: outJournals, inboxStore,
    bridgeMap: outBridge, bridgeRemapped,
    obsidianLocations: outObsidian, obsidianExtracted,
    journalsChanged, inboxCount,
  } = computeDailyLogInboxMigration(journalsStore, inboxRows, { instanceId, nowIso, bridgeMap, obsidianLocations });

  // ORDER MATTERS for crash-safety: write the DERIVED copies (Obsidian sidecar,
  // re-keyed bridge map) BEFORE overwriting journals.json with the stripped
  // records. journals.json is the only source of the inner uuids and the
  // Obsidian fields; if we stripped it first and the process died before the
  // sidecar/bridge writes landed, a rerun couldn't recover them (the data would
  // be gone from the only copy). Writing the copies first means a crash at worst
  // leaves journals.json un-stripped, which a rerun re-processes idempotently.
  if (outObsidian && obsidianExtracted > 0) {
    await writeFile(obsidianLocationsPath, JSON.stringify(outObsidian, null, 2));
  }

  if (outBridge && bridgeRemapped > 0) {
    await writeFile(bridgeMapPath, JSON.stringify(outBridge, null, 2));
  }

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
    `inbox ${hasLegacyInbox ? `migrated ${inboxCount} entr${inboxCount === 1 ? 'y' : 'ies'} → inbox.json` : 'already current'}` +
    `${obsidianExtracted > 0 ? `, moved ${obsidianExtracted} Obsidian location${obsidianExtracted === 1 ? '' : 's'} to local sidecar` : ''}` +
    `${bridgeRemapped > 0 ? `, re-keyed ${bridgeRemapped} journal memory-bridge entr${bridgeRemapped === 1 ? 'y' : 'ies'}` : ''}`
  );
}

export default { up };
