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

import { join } from 'path';
import { atomicWrite, ensureDir, readJSONFile, PATHS } from '../lib/fileUtils.js';
import { createMutex } from '../lib/asyncMutex.js';
import { createSettingsStore } from '../lib/settingsStore.js';
import { ServerError } from '../lib/errorHandler.js';
import { replaceMarkedSection } from '../lib/markedSection.js';
import * as brainStorage from './brainStorage.js';
import { brainEvents, now } from './brainStorage.js';
import * as obsidian from './obsidian.js';
import { todayInTimezone } from '../lib/timezone.js';
import { getUserTimezone } from './userTimezone.js';

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
const OBSIDIAN_LOCATIONS_WRITE_OPTIONS = { mode: 0o600, dirMode: 0o700 };

const DEFAULT_SETTINGS = {
  obsidianVaultId: null,
  obsidianFolder: 'Daily Log',
  autoSync: true,
};

// ─── Settings ──────────────────────────────────────────────────────────────

// Strict read + serialized PATCH live in the store (#4115): a corrupt file
// rejects instead of reading as DEFAULT_SETTINGS and being overwritten.
const settingsStore = createSettingsStore(SETTINGS_FILE, DEFAULT_SETTINGS);

export const getSettings = settingsStore.get;
export const updateSettings = settingsStore.update;

// ─── Store ─────────────────────────────────────────────────────────────────

// Coordinate local journal writes with the machine-local Obsidian sidecar.
// Peer applies do not take this mutex: putEntry also runs its read/transform
// inside brainStorage's per-record queue, shared with every Brain writer.
const storeMutex = createMutex();

// ── Local Obsidian-location sidecar (NOT synced) ─────────────────────────────
// Read/write the machine-local map of where each day was mirrored. Kept out of
// the synced journal record (see OBSIDIAN_LOCATIONS_FILE rationale above).
// Bulk mirrors stage their locations here until one sidecar write at the end.
const pendingBulkLocations = new Map();
let obsidianLocationsCache = null;
let obsidianLocationsCacheTime = 0;
const OBSIDIAN_LOCATIONS_CACHE_TTL_MS = 2000;

export function _clearObsidianLocationsCacheForTest() {
  pendingBulkLocations.clear();
  obsidianLocationsCache = null;
  obsidianLocationsCacheTime = 0;
}

async function loadObsidianLocations() {
  const nowMs = Date.now();
  if (obsidianLocationsCache && (nowMs - obsidianLocationsCacheTime) < OBSIDIAN_LOCATIONS_CACHE_TTL_MS) {
    return obsidianLocationsCache;
  }
  await ensureDir(PATHS.brain, { mode: 0o700 });
  obsidianLocationsCache = await readJSONFile(OBSIDIAN_LOCATIONS_FILE, {}, { strict: true });
  obsidianLocationsCacheTime = Date.now();
  return obsidianLocationsCache;
}

async function getObsidianLocation(date) {
  const map = await loadObsidianLocations();
  return pendingBulkLocations.get(date) || map[date] || { obsidianPath: null, obsidianVaultId: null };
}

// Serialized via storeMutex by callers; persists the location for one date (or
// drops it when both fields are null, e.g. after a delete).
async function saveObsidianLocation(date, { obsidianPath, obsidianVaultId }) {
  const map = { ...(await loadObsidianLocations()) };
  if (obsidianPath == null && obsidianVaultId == null) {
    delete map[date];
  } else {
    map[date] = { obsidianPath: obsidianPath ?? null, obsidianVaultId: obsidianVaultId ?? null };
  }
  await atomicWrite(OBSIDIAN_LOCATIONS_FILE, map, OBSIDIAN_LOCATIONS_WRITE_OPTIONS);
  obsidianLocationsCache = map;
  obsidianLocationsCacheTime = Date.now();
}

// Apply a bulk re-sync's changed locations in one sidecar write. Re-check each
// record under the same mutex as individual writes so a day deleted while the
// foreground re-sync was running cannot be resurrected in the local map.
async function saveObsidianLocations() {
  if (!pendingBulkLocations.size) return;
  return storeMutex(async () => {
    const map = { ...(await loadObsidianLocations()) };
    let changed = false;
    for (const [date, location] of pendingBulkLocations) {
      if (!(await brainStorage.getById('journals', date))) continue;
      if (map[date]?.obsidianPath === location.obsidianPath && map[date]?.obsidianVaultId === location.obsidianVaultId) continue;
      map[date] = location;
      changed = true;
    }
    if (changed) await atomicWrite(OBSIDIAN_LOCATIONS_FILE, map, OBSIDIAN_LOCATIONS_WRITE_OPTIONS);
    pendingBulkLocations.clear();
    obsidianLocationsCache = map;
    obsidianLocationsCacheTime = Date.now();
  });
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

// Transform the fresh entry under brainStorage's per-record write lock, shared
// with peer applies. A local-only mutex cannot protect a snapshot read before
// this queue: an accepted peer edit could otherwise be overwritten by it.
// Returning null leaves the entry unchanged. The inner `id` AND the
// machine-local Obsidian fields are stripped before storage: the map key IS the
// id (so an inner `id` would be redundant and pollute the synced record /
// reconcile checksum), and obsidianPath/obsidianVaultId must never federate
// (they live in the local sidecar — see OBSIDIAN_LOCATIONS_FILE). `emitEvent:false`
// because this module emits its own richer bridge-shaped events (journals:upserted
// with the segment, journals:appended, etc.) right after, and we don't want the
// generic brainStorage `journals:upserted` to double-fire.
async function putEntry(date, transform) {
  const saved = await brainStorage.upsertWithId('journals', date, async (existing) => {
    const loc = await getObsidianLocation(date);
    const entry = await transform(existing ? { ...existing, ...loc } : null);
    if (!entry) return null;
    const { id: _id, obsidianPath: _op, obsidianVaultId: _ov, ...rest } = entry;
    return rest;
  }, { emitEvent: false });
  if (!saved) return null;
  // Re-attach the local location so the returned entry shape is unchanged for callers.
  const loc = await getObsidianLocation(date);
  return { ...saved, obsidianPath: loc.obsidianPath, obsidianVaultId: loc.obsidianVaultId };
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

// Attach each day's local Obsidian location (the obsidianPath/obsidianVaultId
// fields live in the non-synced sidecar, not the synced record) so summaries
// still report the mirror status.
async function hydrateObsidianLocations(entries) {
  const locations = await loadObsidianLocations();
  return entries.map((entry) => {
    const date = entry.date || entry.id;
    const loc = pendingBulkLocations.get(date) || locations[date] || { obsidianPath: null, obsidianVaultId: null };
    return { ...entry, obsidianPath: loc.obsidianPath, obsidianVaultId: loc.obsidianVaultId };
  });
}

// Journal ids ARE the calendar date, so a descending id sort is newest-first
// without opening any body.
async function listJournalIdsNewestFirst() {
  return (await brainStorage.listStoredIds('journals')).sort((a, b) => b.localeCompare(a));
}

// Walk ids newest-first and load only as many bodies as `wanted` needs: each
// batch asks for exactly the shortfall, so a store with no tombstones reads
// `offset + limit` bodies and nothing beyond. getById returns null for a
// tombstone or corrupt record, which drops out instead of failing the page.
export async function listJournals({ limit = 50, offset = 0, includeContent = false } = {}) {
  const ids = await listJournalIdsNewestFirst();
  const page = [];
  let toSkip = offset;
  let cursor = 0;
  let dropped = 0;
  while (page.length < limit && cursor < ids.length) {
    const batch = ids.slice(cursor, cursor + toSkip + (limit - page.length));
    cursor += batch.length;
    for (const entry of await Promise.all(batch.map((id) => brainStorage.getById('journals', id)))) {
      if (!entry) { dropped += 1; continue; }
      if (toSkip > 0) toSkip -= 1;
      else if (page.length < limit) page.push(entry);
    }
  }
  const hydrated = await hydrateObsidianLocations(page);
  return {
    records: includeContent ? hydrated : hydrated.map(toJournalSummary),
    // Upper bound: ids on disk minus the tombstoned/corrupt rows this walk
    // actually opened. Counting live days exactly would mean reading every body.
    total: ids.length - dropped,
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

// The next operation needs the actual location of a preceding in-flight upsert,
// even if the journal was tombstoned before that upsert could save its sidecar.
const obsidianQueues = new Map();

function queueObsidian(date, work) {
  const queue = obsidianQueues.get(date) || { tail: Promise.resolve() };
  const run = () => work(queue);
  const next = queue.tail.then(run, run);
  queue.tail = next;
  obsidianQueues.set(date, queue);
  const release = () => {
    if (queue.tail === next) obsidianQueues.delete(date);
  };
  next.then(release, release);
  return next;
}

function scheduleObsidianSync(entry) {
  syncToObsidian(entry).catch((err) => console.error(`📓 Obsidian sync failed: ${err.message}`));
}

/**
 * Full-content rewrite for a day.
 *
 * @param {string} date ISO YYYY-MM-DD
 * @param {string} content Replacement body
 * @param {{ ifMatchUpdatedAt?: string|null }} [opts]
 *   When `ifMatchUpdatedAt` is a non-empty string, the write is rejected with
 *   `STALE_JOURNAL` (409) if the on-disk entry's `updatedAt` differs — i.e. a
 *   concurrent voice append, another tab, or a peer moved the LWW clock since
 *   the client last observed it. The error's `context.entry` is the current
 *   record so the client can merge and retry. Absent/empty ifMatch is a
 *   force-write (legacy callers, explicit "save my edits" without a base).
 */
export async function setJournalContent(date, content, { ifMatchUpdatedAt } = {}) {
  if (!isIsoDate(date)) throw new Error(`invalid date: ${date}`);
  const entry = await storeMutex(() => putEntry(date, (existing) => {
    // Precondition: a full rewrite based on a known updatedAt must not clobber
    // a concurrent append (voice dictation is the common case — the client
    // autosave and the append share the same day key). When the on-disk entry
    // has no `updatedAt` (pre-stamp legacy / hand-edited store), there is no
    // clock to compare — accept the write rather than rejecting forever.
    // brainStorage.upsertWithId always stamps updatedAt on new writes, so this
    // path is an edge case, not the steady state.
    if (
      typeof ifMatchUpdatedAt === 'string'
      && ifMatchUpdatedAt.length > 0
      && existing?.updatedAt
      && existing.updatedAt !== ifMatchUpdatedAt
    ) {
      throw new ServerError('Daily log was modified since you last loaded it', {
        status: 409,
        code: 'STALE_JOURNAL',
        context: { entry: existing },
      });
    }
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
    return next;
  }));
  scheduleObsidianSync(entry);
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
    let segmentLocal;
    const saved = await putEntry(date, (existing) => {
      const base = existing || newEntry(date);
      segmentLocal = { text: clean, at: now(), source: segmentSource };
      return {
        ...base,
        segments: [...(Array.isArray(base.segments) ? base.segments : []), segmentLocal],
        content: base.content
          ? `${base.content.trimEnd()}\n\n${clean}`
          : clean,
      };
    });
    return { entry: saved, segment: segmentLocal };
  });
  scheduleObsidianSync(entry);
  brainEvents.emit('journals:appended', { entry, segment });
  // Per-entry event so the memory bridge re-embeds only this day, not all
  // of them. (Keep journals:appended separate — it carries the single new
  // segment for UI live-updates, which is a different consumer.)
  brainEvents.emit('journals:upserted', { entry });
  return entry;
}

/**
 * Splice an auto-generated, marker-delimited section into a day's entry WITHOUT
 * disturbing user-authored content or segment history. Unlike setJournalContent
 * (which collapses segments on a full rewrite), this preserves `segments` — it
 * only rewrites the region between the markers (see server/lib/markedSection.js),
 * so a re-run replaces just the auto section and typed/dictated text stays
 * primary. Passing an empty `body` removes the section.
 *
 * Rides the same brainStorage.upsertWithId path as every other journal write
 * (via putEntry), so the edit federates + re-embeds through brainMemoryBridge.
 * Returns the updated entry, or null when there was nothing to write (no
 * existing entry AND an empty section, or an idempotent no-op re-run).
 */
export async function upsertAutoSection(date, body, markers) {
  if (!isIsoDate(date)) throw new Error(`invalid date: ${date}`);
  let changed = false;
  const entry = await storeMutex(() => putEntry(date, (existing) => {
    const base = existing || newEntry(date);
    const nextContent = replaceMarkedSection(base.content || '', body, markers);
    // Idempotent re-run against an unchanged day: skip the write, sync-log
    // append, and Obsidian round-trip entirely.
    if (existing && nextContent === (base.content || '')) return null;
    // Nothing to persist: no prior entry and the draft produced no section.
    if (!existing && !nextContent.trim()) return null;
    changed = true;
    return { ...base, content: nextContent };
  }));
  if (!changed) return entry;
  scheduleObsidianSync(entry);
  brainEvents.emit('journals:upserted', { entry });
  return entry;
}

export async function deleteJournal(date) {
  if (!isIsoDate(date)) return false;
  const deleted = await storeMutex(async () => {
    const entry = await getEntry(date);
    if (!entry) return null;
    // Reserve the unlink in tombstone order before another write can recreate the day.
    await brainStorage.remove('journals', date);
    const cleanup = queueObsidian(date, async (queue) => {
      const location = queue.location === undefined ? entry : queue.location;
      if (location?.obsidianPath) {
        await removeFromObsidian({ ...location, date }).catch((err) => console.error(`📓 Obsidian delete failed: ${err.message}`));
      }
      await storeMutex(async () => {
        await saveObsidianLocation(date, { obsidianPath: null, obsidianVaultId: null });
        pendingBulkLocations.delete(date);
      });
      queue.location = null;
    });
    brainEvents.emit('journals:deleted', { date, entry });
    return { cleanup };
  });
  if (!deleted) return false;
  await deleted.cleanup;
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
export function syncToObsidian({ date }, { force = false, batch = false } = {}) {
  return queueObsidian(date, queue => mirrorJournal(date, { force, batch }, queue));
}

async function mirrorJournal(date, { force, batch }, queue) {
  // A bulk page or manual request may have captured the day before deletion or
  // recreation. Mirror the live content when this date's turn actually starts.
  const entry = await brainStorage.getById('journals', date);
  if (!entry) return null;
  const settings = await getSettings();
  if (!settings.obsidianVaultId || (!force && !settings.autoSync)) return null;

  const vaultId = settings.obsidianVaultId;
  const notePath = buildObsidianNotePath(settings, entry.date);

  // upsertNote owns the update-then-create ordering (createNote errors when the
  // file exists) and the missing-vault-folder no-op — both properties of the
  // Obsidian adapter, not of this caller.
  const written = await obsidian.upsertNote(vaultId, notePath, buildMarkdown(entry));
  if (!written) return null;

  const location = { obsidianPath: notePath, obsidianVaultId: vaultId };
  queue.location = location;
  await storeMutex(async () => {
    if (!(await brainStorage.getById('journals', date))) return;
    // A queued deletion or a concurrent bulk pass may have superseded the
    // location the caller saw. Compare against the persisted sidecar.
    const stored = (await loadObsidianLocations())[date];
    if (stored?.obsidianPath !== notePath || stored.obsidianVaultId !== vaultId) {
      if (batch) {
        pendingBulkLocations.set(date, location);
        return;
      }
      await saveObsidianLocation(date, location);
    }
    pendingBulkLocations.delete(date);
  });
  return notePath;
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
// Consecutive failed upserts that mean "the vault is gone", not "this entry is odd".
// Sized so an ordinary transient blip cannot trip it but a systemic outage does.
const MAX_CONSECUTIVE_RESYNC_SKIPS = 25;

// Whole-store catch-up: each id is listed once and its body read once, a page
// of ids at a time to bound memory.
const ITERATE_PAGE_SIZE = 100;
export async function* iterateJournals() {
  const ids = await listJournalIdsNewestFirst();
  for (let i = 0; i < ids.length; i += ITERATE_PAGE_SIZE) {
    const loaded = await Promise.all(ids.slice(i, i + ITERATE_PAGE_SIZE)
      .map((id) => brainStorage.getById('journals', id)));
    for (const record of await hydrateObsidianLocations(loaded.filter(Boolean))) yield record;
  }
}

export async function resyncAllToObsidian() {
  const settings = await getSettings();
  if (!settings.obsidianVaultId) return { synced: 0, skipped: 0 };

  let synced = 0;
  let skipped = 0;
  let consecutiveSkips = 0;
  let stoppedEarly = false;
  for await (const entry of iterateJournals()) {
    // force:true so this bulk resync still writes even when the user has
    // turned off the per-write autoSync — they explicitly clicked "Re-sync
    // all entries now", which is the manual-sync escape hatch.
    const path = await syncToObsidian(entry, { force: true, batch: true }).catch(() => null);
    if (path) {
      synced += 1;
      consecutiveSkips = 0;
      continue;
    }
    skipped += 1;
    consecutiveSkips += 1;
    // Circuit breaker. This is a FOREGROUND request over all entries,
    // and an evicted note now costs up to MATERIALIZE_TIMEOUT_MS (20s) before it
    // is refused (#3706) — so a wedged iCloud or an unplugged vault would turn
    // "Re-sync all entries now" into a multi-hour request the user cannot cancel.
    // A run of failures means the VAULT is unavailable, not that one entry is
    // odd: inside this loop a null is always a failed upsert (the vault is
    // configured, and force:true bypasses the autoSync check), so there is no
    // legitimate run of skips to confuse it with. Stop and report instead.
    if (consecutiveSkips >= MAX_CONSECUTIVE_RESYNC_SKIPS) {
      stoppedEarly = true;
      console.warn(`⚠️ Daily-log resync stopped after ${consecutiveSkips} consecutive failures — vault unavailable?`);
      break;
    }
  }
  await saveObsidianLocations();
  return { synced, skipped, stoppedEarly };
}
