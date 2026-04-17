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
 */

import { writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { v4 as uuidv4 } from '../lib/uuid.js';
import { ensureDir, readJSONFile, PATHS } from '../lib/fileUtils.js';
import { createMutex } from '../lib/asyncMutex.js';
import { brainEvents, now } from './brainStorage.js';
import * as obsidian from './obsidian.js';
import { getUserTimezone, todayInTimezone } from '../lib/timezone.js';

const JOURNALS_FILE = join(PATHS.brain, 'journals.json');
const SETTINGS_FILE = join(PATHS.brain, 'journal-settings.json');

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
  await writeFile(SETTINGS_FILE, JSON.stringify(next, null, 2));
  return next;
}

// ─── Store ─────────────────────────────────────────────────────────────────

// Serialize every load→mutate→save of journals.json so a fire-and-forget
// Obsidian path-persist can't interleave with an appendJournal() and clobber
// newer segments. PortOS is single-user, but dictation bursts schedule
// overlapping async tasks (appendJournal → fire-and-forget syncToObsidian →
// persistObsidianPath) that all want to rewrite the same file. This mutex
// guarantees at most one read-modify-write runs at a time.
const storeMutex = createMutex();

async function loadStore() {
  await ensureDir(PATHS.brain);
  return readJSONFile(JOURNALS_FILE, { records: {} });
}

async function saveStore(store) {
  await ensureDir(PATHS.brain);
  await writeFile(JOURNALS_FILE, JSON.stringify(store, null, 2));
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
  const store = await loadStore();
  const records = Object.values(store.records || {});
  records.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const total = records.length;
  const page = records.slice(offset, offset + limit);
  return {
    records: includeContent ? page : page.map(toJournalSummary),
    total,
  };
}

export async function getJournal(date) {
  if (!isIsoDate(date)) return null;
  const store = await loadStore();
  return store.records?.[date] || null;
}

// ─── Writes ────────────────────────────────────────────────────────────────

function ensureEntry(store, date) {
  if (!store.records) store.records = {};
  if (store.records[date]) return store.records[date];
  const entry = {
    id: uuidv4(),
    date,
    content: '',
    segments: [],
    createdAt: now(),
    updatedAt: now(),
    obsidianPath: null,
    obsidianVaultId: null,
  };
  store.records[date] = entry;
  return entry;
}

// Fire-and-forget: Obsidian lives on iCloud and writes can stall for hundreds
// of ms; callers shouldn't wait on it. The sync path persists any discovered
// obsidianPath itself via persistObsidianPath() — callers must not assume
// this async work mutates the `entry` they passed in or that a later
// saveStore() in their flow will pick up the path.
function scheduleObsidianSync(entry) {
  syncToObsidian(entry).catch((err) => console.error(`📓 Obsidian sync failed: ${err.message}`));
}

export async function setJournalContent(date, content) {
  if (!isIsoDate(date)) throw new Error(`invalid date: ${date}`);
  const { entry, records } = await storeMutex(async () => {
    const store = await loadStore();
    const entryLocal = ensureEntry(store, date);
    const clean = content || '';
    entryLocal.content = clean;
    // Full replace invalidates the old segment history: the user rewrote the
    // whole day, so segment metadata (counts, per-line sources, timestamps)
    // would otherwise drift from what's actually stored in `content`. Collapse
    // to a single 'edit' segment that represents the rewrite.
    entryLocal.segments = clean
      ? [{ text: clean, at: now(), source: 'edit' }]
      : [];
    entryLocal.updatedAt = now();
    await saveStore(store);
    return { entry: entryLocal, records: store.records };
  });
  scheduleObsidianSync(entry);
  brainEvents.emit('journals:changed', { records });
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

  const { entry, segment, records } = await storeMutex(async () => {
    const store = await loadStore();
    const entryLocal = ensureEntry(store, date);
    const segmentLocal = { text: clean, at: now(), source: segmentSource };
    entryLocal.segments.push(segmentLocal);
    entryLocal.content = entryLocal.content
      ? `${entryLocal.content.trimEnd()}\n\n${clean}`
      : clean;
    entryLocal.updatedAt = now();
    await saveStore(store);
    return { entry: entryLocal, segment: segmentLocal, records: store.records };
  });
  scheduleObsidianSync(entry);
  brainEvents.emit('journals:changed', { records });
  brainEvents.emit('journals:appended', { entry, segment });
  // Per-entry event so the memory bridge re-embeds only this day, not all
  // of them. (Keep journals:appended separate — it carries the single new
  // segment for UI live-updates, which is a different consumer.)
  brainEvents.emit('journals:upserted', { entry });
  return entry;
}

export async function deleteJournal(date) {
  if (!isIsoDate(date)) return false;
  const result = await storeMutex(async () => {
    const store = await loadStore();
    if (!store.records?.[date]) return null;
    const entryLocal = store.records[date];
    delete store.records[date];
    await saveStore(store);
    return { entry: entryLocal, records: store.records };
  });
  if (!result) return false;
  const { entry, records } = result;
  if (entry.obsidianPath) {
    await removeFromObsidian(entry).catch((err) => console.error(`📓 Obsidian delete failed: ${err.message}`));
  }
  brainEvents.emit('journals:changed', { records });
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

// Record the note location (path + vault) on the store entry whenever it
// changes. Serialized via storeMutex so a fire-and-forget Obsidian persist
// can't clobber concurrent appendJournal writes.
async function persistObsidianLocation(date, notePath, vaultId) {
  return storeMutex(async () => {
    const store = await loadStore();
    const entry = store.records?.[date];
    if (!entry) return;
    if (entry.obsidianPath !== notePath || entry.obsidianVaultId !== vaultId) {
      entry.obsidianPath = notePath;
      entry.obsidianVaultId = vaultId;
      await saveStore(store);
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
