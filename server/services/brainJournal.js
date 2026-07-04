/**
 * Daily Log (Journal) Service
 *
 * Single-entry-per-date diary store. Supports:
 *   - Free-form typed or dictated content per calendar date
 *   - Append-style segments from voice dictation
 *   - Mirroring to an optional Obsidian vault (so Apple Notes / iCloud backups
 *     pick up the file) — configured via brain meta (obsidianVaultId, obsidianFolder)
 *   - Emission of brainEvents so brainMemoryBridge can vector-embed each day
 *
 * Storage files:
 *   data/brain/journals.json          — { records: { 'YYYY-MM-DD': entry } }
 *   data/brain/journal-settings.json  — { obsidianVaultId, obsidianFolder, autoSync }
 *
 * The journals.json store is OWNED by brainStorage (type `journals`, see
 * BRAIN_ENTITY_TYPES): writes go through brainStorage.upsertWithId so every
 * Daily Log edit lands in the brain sync log and federates to peers via the same
 * delta-log + LWW + tombstone pipeline as every other brain entity. This module
 * keeps the Daily-Log-specific concerns on top: date-keyed identity, segment
 * append semantics, the Obsidian mirror, and the bridge events the memory
 * vectorizer listens for. We must NOT write journals.json directly here anymore
 * — that would bypass the sync log and silently diverge peers again.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { atomicWrite, ensureDir, readJSONFile, PATHS } from '../lib/fileUtils.js';
import { createMutex } from '../lib/asyncMutex.js';
import * as brainStorage from './brainStorage.js';
import { brainEvents, now } from './brainStorage.js';
import * as obsidian from './obsidian.js';
import { getUserTimezone, todayInTimezone } from '../lib/timezone.js';

const SETTINGS_FILE = join(PATHS.brain, 'journal-settings.json');

// Where each day's note was ACTUALLY mirrored, kept in a LOCAL sidecar that is
// deliberately NOT a synced brain store. Obsidian vault ids and note paths are
// machine-local: a peer's vault id is meaningless here, and federating it would
// (1) make removeFromObsidian refuse to unlink this machine's own mirror when a
// peer's id is stamped on the record, and (2) poison the brain reconcile
// checksum so two machines with the same day but different vaults never
// converge (endless reconcile churn — the #1077 amplification class). Shape:
// { [date]: { obsidianPath, obsidianVaultId } }.
const OBSIDIAN_LOCATIONS_FILE = join(PATHS.brain, 'journal-obsidian-locations.json');

const DEFAULT_SETTINGS = {
  obsidianVaultId: null,
  obsidianFolder: 'Daily Log',
  autoSync: true,
};

// ─── Settings ──────────────────────────────────────────────────────────────

export async function getSettings() {
  await ensureDir(PATHS.brain);
  const loaded = await readJSONFile(SETTINGS_FILE, null);
  return loaded ? { ...DEFAULT_SETTINGS, ...loaded } : { ...DEFAULT_SETTINGS };
}

export async function updateSettings(partial) {
  const current = await getSettings();
  const next = { ...current, ...partial };
  await atomicWrite(SETTINGS_FILE, next);
  return next;
}

// ─── Store ─────────────────────────────────────────────────────────────────

// Serialize every read→mutate→write of a journal entry so a fire-and-forget
// Obsidian path-persist can't interleave with an appendJournal() and clobber
// newer segments. PortOS is single-user, but dictation bursts schedule
// overlapping async tasks (appendJournal → fire-and-forget syncToObsidian →
// persistObsidianLocation) that all want to rewrite the same entry. This mutex
// guarantees at most one read-modify-write runs at a time.
//
// Entry storage is delegated to brainStorage (type `journals`): getById reads
// the live record, upsertWithId(date, …) persists it AND appends to the brain
// sync log so the edit federates. We never touch journals.json directly here.
const storeMutex = createMutex();

// ── Local Obsidian-location sidecar (NOT synced) ─────────────────────────────
// Read/write the machine-local map of where each day was mirrored. Kept out of
// the synced journal record (see OBSIDIAN_LOCATIONS_FILE rationale above).
async function loadObsidianLocations() {
  await ensureDir(PATHS.brain);
  return readJSONFile(OBSIDIAN_LOCATIONS_FILE, {});
}

async function getObsidianLocation(date) {
  const map = await loadObsidianLocations();
  return map[date] || { obsidianPath: null, obsidianVaultId: null };
}

// Serialized via storeMutex by callers; persists the location for one date (or
// drops it when both fields are null, e.g. after a delete).
async function saveObsidianLocation(date, { obsidianPath, obsidianVaultId }) {
  const map = await loadObsidianLocations();
  if (obsidianPath == null && obsidianVaultId == null) {
    delete map[date];
  } else {
    map[date] = { obsidianPath: obsidianPath ?? null, obsidianVaultId: obsidianVaultId ?? null };
  }
  await atomicWrite(OBSIDIAN_LOCATIONS_FILE, map);
}

// ── Synced journal entry store ───────────────────────────────────────────────

// Daily Log entries are keyed by calendar date in the entity store, so the
// record id IS the date — that's what lets two peers editing the same day
// converge (LWW on one record) instead of forking into per-machine uuids.
// Reads merge the local Obsidian location back onto the entry so callers
// (summaries, UI, delete) still see obsidianPath/obsidianVaultId, even though
// those fields live in the non-synced sidecar.
async function getEntry(date) {
  const entry = await brainStorage.getById('journals', date);
  if (!entry) return null;
  const loc = await getObsidianLocation(date);
  return { ...entry, obsidianPath: loc.obsidianPath, obsidianVaultId: loc.obsidianVaultId };
}

// Persist a fully-formed entry under its date key. The inner `id` AND the
// machine-local Obsidian fields are stripped before storage: the map key IS the
// id (so an inner `id` would be redundant and pollute the synced record /
// reconcile checksum), and obsidianPath/obsidianVaultId must never federate
// (they live in the local sidecar — see OBSIDIAN_LOCATIONS_FILE). `emitEvent:false`
// because this module emits its own richer bridge-shaped events (journals:upserted
// with the segment, journals:appended, etc.) right after, and we don't want the
// generic brainStorage `journals:upserted` to double-fire.
async function putEntry(date, entry) {
  // eslint-disable-next-line no-unused-vars
  const { id: _id, obsidianPath: _op, obsidianVaultId: _ov, ...rest } = entry;
  const saved = await brainStorage.upsertWithId('journals', date, rest, { emitEvent: false });
  // Re-attach the local location so the returned entry shape is unchanged for callers.
  const loc = await getObsidianLocation(date);
  return { ...saved, obsidianPath: loc.obsidianPath, obsidianVaultId: loc.obsidianVaultId };
}

// The legacy journals:changed event carried the full date→entry map. Rebuild it
// from the store (tombstones stripped) so existing consumers keep working. The
// brainStorage 2s cache absorbs dictation bursts so this isn't a hot re-read.
async function rawRecords() {
  const locations = await loadObsidianLocations();
  const records = {};
  for (const entry of await brainStorage.getAll('journals')) {
    const date = entry.date || entry.id;
    const loc = locations[date] || { obsidianPath: null, obsidianVaultId: null };
    records[date] = { ...entry, obsidianPath: loc.obsidianPath, obsidianVaultId: loc.obsidianVaultId };
  }
  return records;
}

// Accept YYYY-MM-DD only, and require a real calendar day so we can't create
// store keys like '2026-02-30' that don't sort meaningfully or round-trip.
export const isIsoDate = (date) => {
  if (typeof date !== 'string') return false;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return false;
  const [, y, m, d] = match.map((v, i) => (i === 0 ? v : Number(v)));
  const parsed = new Date(Date.UTC(y, m - 1, d));
  return parsed.getUTCFullYear() === y
    && parsed.getUTCMonth() === m - 1
    && parsed.getUTCDate() === d;
};

export async function resolveDate(date) {
  return isIsoDate(date) ? date : getToday();
}

export async function getToday() {
  return todayInTimezone(await getUserTimezone());
}

// ─── Reads ─────────────────────────────────────────────────────────────────

// Sidebar/history views only need lightweight metadata — full `content` and
// `segments` would balloon the response as the log grows. Callers that want
// the full entry should use getJournal(date) or pass includeContent=true.
function toJournalSummary(entry) {
  return {
    id: entry.id,
    date: entry.date,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    obsidianPath: entry.obsidianPath,
    obsidianVaultId: entry.obsidianVaultId || null,
    segmentCount: Array.isArray(entry.segments) ? entry.segments.length : 0,
  };
}

export async function listJournals({ limit = 50, offset = 0, includeContent = false } = {}) {
  // getAll strips tombstones, so deleted days don't show in the sidebar even
  // before the tombstone is GC'd.
  const records = await brainStorage.getAll('journals');
  records.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const total = records.length;
  const page = records.slice(offset, offset + limit);
  // Hydrate just the page with each day's local Obsidian location (the
  // obsidianPath/obsidianVaultId fields live in the non-synced sidecar, not the
  // synced record) so summaries still report the mirror status.
  const locations = await loadObsidianLocations();
  const hydrated = page.map((entry) => {
    const loc = locations[entry.date || entry.id] || { obsidianPath: null, obsidianVaultId: null };
    return { ...entry, obsidianPath: loc.obsidianPath, obsidianVaultId: loc.obsidianVaultId };
  });
  return {
    records: includeContent ? hydrated : hydrated.map(toJournalSummary),
    total,
  };
}

export async function getJournal(date) {
  if (!isIsoDate(date)) return null;
  return getEntry(date);
}

// ─── Writes ────────────────────────────────────────────────────────────────

// Build a fresh entry skeleton for a date that has no record yet. createdAt/
// updatedAt/originInstanceId are stamped by brainStorage.upsertWithId on write —
// we only seed the Daily-Log-specific fields. `id` is the date (the entity-store
// key) so it converges across peers; upsertWithId returns it as `id` too.
function newEntry(date) {
  // Obsidian location is tracked in the local sidecar, never on the synced
  // record, so it's intentionally absent here (putEntry strips it regardless).
  return {
    date,
    content: '',
    segments: [],
  };
}

// Fire-and-forget: Obsidian lives on iCloud and writes can stall for hundreds
// of ms; callers shouldn't wait on it. The sync path persists any discovered
// obsidianPath itself via persistObsidianLocation() — callers must not assume
// this async work mutates the `entry` they passed in or that a later
// putEntry() in their flow will pick up the path.
function scheduleObsidianSync(entry) {
  syncToObsidian(entry).catch((err) => console.error(`📓 Obsidian sync failed: ${err.message}`));
}

export async function setJournalContent(date, content) {
  if (!isIsoDate(date)) throw new Error(`invalid date: ${date}`);
  const entry = await storeMutex(async () => {
    const existing = await getEntry(date);
    const clean = content || '';
    const next = {
      ...(existing || newEntry(date)),
      content: clean,
      // Full replace invalidates the old segment history: the user rewrote the
      // whole day, so segment metadata (counts, per-line sources, timestamps)
      // would otherwise drift from what's actually stored in `content`. Collapse
      // to a single 'edit' segment that represents the rewrite.
      segments: clean ? [{ text: clean, at: now(), source: 'edit' }] : [],
    };
    return putEntry(date, next);
  });
  scheduleObsidianSync(entry);
  brainEvents.emit('journals:changed', { records: await rawRecords() });
  // Per-entry event so downstream syncers (memory bridge) can update the
  // single affected day without iterating the whole store.
  brainEvents.emit('journals:upserted', { entry });
  return entry;
}

// Segment source metadata is persisted on disk, so reject unknown or
// non-string values at the service boundary rather than trusting the caller
// (HTTP body, socket payload). Unknown sources fall back to 'text'.
const SEGMENT_SOURCES = new Set(['text', 'voice', 'edit']);
const normalizeSource = (source) => (SEGMENT_SOURCES.has(source) ? source : 'text');

/**
 * Append a text segment (typed or dictated) to the given date's entry.
 * Preserves segment metadata (source, timestamp) so the entry can be
 * re-played later with provenance.
 */
export async function appendJournal(date, text, { source = 'text' } = {}) {
  if (!isIsoDate(date)) throw new Error(`invalid date: ${date}`);
  const clean = (text || '').trim();
  if (!clean) return null;
  const segmentSource = normalizeSource(source);

  const { entry, segment } = await storeMutex(async () => {
    const existing = await getEntry(date);
    const base = existing || newEntry(date);
    const segmentLocal = { text: clean, at: now(), source: segmentSource };
    const next = {
      ...base,
      segments: [...(Array.isArray(base.segments) ? base.segments : []), segmentLocal],
      content: base.content
        ? `${base.content.trimEnd()}\n\n${clean}`
        : clean,
    };
    const saved = await putEntry(date, next);
    return { entry: saved, segment: segmentLocal };
  });
  scheduleObsidianSync(entry);
  brainEvents.emit('journals:changed', { records: await rawRecords() });
  brainEvents.emit('journals:appended', { entry, segment });
  // Per-entry event so the memory bridge re-embeds only this day, not all
  // of them. (Keep journals:appended separate — it carries the single new
  // segment for UI live-updates, which is a different consumer.)
  brainEvents.emit('journals:upserted', { entry });
  return entry;
}

export async function deleteJournal(date) {
  if (!isIsoDate(date)) return false;
  const entry = await storeMutex(async () => {
    const existing = await getEntry(date);
    if (!existing) return null;
    // Tombstones in place (via brainStorage.remove) so the delete federates and
    // a stale create echoed from a peer can't resurrect the day.
    await brainStorage.remove('journals', date);
    return existing;
  });
  if (!entry) return false;
  if (entry.obsidianPath) {
    await removeFromObsidian(entry).catch((err) => console.error(`📓 Obsidian delete failed: ${err.message}`));
  }
  // Drop the local mirror-location record for this day (sidecar is not synced).
  await saveObsidianLocation(date, { obsidianPath: null, obsidianVaultId: null });
  brainEvents.emit('journals:changed', { records: await rawRecords() });
  // Explicit deletion signal so memory bridges / integrations can archive
  // the corresponding vector entry — the changed event alone doesn't tell
  // the bridge which record vanished.
  brainEvents.emit('journals:deleted', { date, entry });
  return true;
}

// ─── Obsidian mirror ───────────────────────────────────────────────────────

function buildMarkdown(entry) {
  const lines = [
    '---',
    `date: ${entry.date}`,
    `tags: [daily-log, portos]`,
    '---',
    '',
    `# Daily Log — ${entry.date}`,
    '',
    entry.content || '',
    '',
  ];
  return lines.join('\n');
}

function buildObsidianNotePath(settings, date) {
  const folder = (settings.obsidianFolder || '').replace(/^\/+|\/+$/g, '');
  const filename = `${date}.md`;
  return folder ? `${folder}/${filename}` : filename;
}

/**
 * Write the entry's markdown to the configured Obsidian vault. If the file
 * doesn't exist yet, create it; otherwise update. Records the path on the
 * entry so delete can unlink it later.
 *
 * `force: true` bypasses the autoSync check — used by the manual "Re-sync
 * all entries now" action so users who turn off auto-sync can still trigger
 * a one-shot backfill.
 */
export async function syncToObsidian(entry, { force = false } = {}) {
  const settings = await getSettings();
  if (!settings.obsidianVaultId) return null;
  if (!force && !settings.autoSync) return null;

  const vault = await obsidian.getVaultById(settings.obsidianVaultId);
  if (!vault || !existsSync(vault.path)) return null;

  const vaultId = settings.obsidianVaultId;
  const notePath = buildObsidianNotePath(settings, entry.date);
  const markdown = buildMarkdown(entry);

  // createNote errors when the file exists; try update first then create.
  const update = await obsidian.updateNote(vaultId, notePath, markdown);
  if (update?.error === 'NOTE_NOT_FOUND') {
    const created = await obsidian.createNote(vaultId, notePath, markdown);
    if (created?.error) return null;
    await persistObsidianLocation(entry.date, notePath, vaultId);
    return notePath;
  }
  if (update?.error) return null;
  // Persist whenever the path OR the vault changes — a folder rename or
  // a vault swap in Settings both need to update the store so a later
  // deleteJournal() unlinks the right file in the right vault.
  if (entry.obsidianPath !== notePath || entry.obsidianVaultId !== vaultId) {
    await persistObsidianLocation(entry.date, notePath, vaultId);
  }
  return notePath;
}

// Record the note location (path + vault) in the LOCAL sidecar whenever it
// changes — NOT on the synced journal record (these fields are machine-local;
// see OBSIDIAN_LOCATIONS_FILE). Serialized via storeMutex so a fire-and-forget
// Obsidian persist can't clobber concurrent appendJournal writes. The `!==`
// guard skips a redundant sidecar write on every sync of an unchanged day.
async function persistObsidianLocation(date, notePath, vaultId) {
  return storeMutex(async () => {
    // Re-check the live record under the lock: a fire-and-forget syncToObsidian()
    // can land AFTER the user deleted the day (deleteJournal tombstones it and
    // clears the sidecar). Without this guard we'd resurrect an orphan sidecar
    // entry for a tombstoned day, which would reattach if the date is recreated.
    // brainStorage.getById returns null for a tombstone, so this skips correctly.
    if (!(await brainStorage.getById('journals', date))) return;
    const loc = await getObsidianLocation(date);
    if (loc.obsidianPath !== notePath || loc.obsidianVaultId !== vaultId) {
      await saveObsidianLocation(date, { obsidianPath: notePath, obsidianVaultId: vaultId });
    }
  });
}

// Refuse to delete if the entry's recorded vault doesn't match the currently
// configured vault — the same relative path in a different vault points at an
// unrelated note, and silently nuking it would be data loss.
async function removeFromObsidian(entry) {
  const settings = await getSettings();
  if (!settings.obsidianVaultId || !entry.obsidianPath) return false;
  if (entry.obsidianVaultId && entry.obsidianVaultId !== settings.obsidianVaultId) {
    console.warn(
      `📓 Skipping Obsidian delete for ${entry.date}: entry was mirrored to vault ` +
      `${entry.obsidianVaultId} but current vault is ${settings.obsidianVaultId}. ` +
      `Clean up the stale note manually if needed.`
    );
    return false;
  }
  const result = await obsidian.deleteNote(settings.obsidianVaultId, entry.obsidianPath);
  return result === true;
}

/**
 * Rewrite every existing daily-log entry to the currently-configured Obsidian
 * vault. Used when the user first points the daily log at a vault or changes
 * which vault it targets.
 */
export async function resyncAllToObsidian() {
  const settings = await getSettings();
  if (!settings.obsidianVaultId) return { synced: 0, skipped: 0 };

  const { records } = await listJournals({ limit: 10000, includeContent: true });
  let synced = 0;
  let skipped = 0;
  for (const entry of records) {
    // force:true so this bulk resync still writes even when the user has
    // turned off the per-write autoSync — they explicitly clicked "Re-sync
    // all entries now", which is the manual-sync escape hatch.
    const path = await syncToObsidian(entry, { force: true }).catch(() => null);
    if (path) synced += 1;
    else skipped += 1;
  }
  return { synced, skipped };
}
