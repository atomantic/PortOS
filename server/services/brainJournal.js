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

export async function listJournals({ limit = 50, offset = 0 } = {}) {
  const store = await loadStore();
  const records = Object.values(store.records || {});
  records.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const total = records.length;
  return { records: records.slice(offset, offset + limit), total };
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
  const store = await loadStore();
  const entry = ensureEntry(store, date);
  const clean = content || '';
  entry.content = clean;
  // Full replace invalidates the old segment history: the user rewrote the
  // whole day, so segment metadata (counts, per-line sources, timestamps)
  // would otherwise drift from what's actually stored in `content`. Collapse
  // to a single 'edit' segment that represents the rewrite.
  entry.segments = clean
    ? [{ text: clean, at: now(), source: 'edit' }]
    : [];
  entry.updatedAt = now();
  await saveStore(store);
  scheduleObsidianSync(entry);
  brainEvents.emit('journals:changed', { records: store.records });
  // Per-entry event so downstream syncers (memory bridge) can update the
  // single affected day without iterating the whole store.
  brainEvents.emit('journals:upserted', { entry });
  return entry;
}

/**
 * Append a text segment (typed or dictated) to the given date's entry.
 * Preserves segment metadata (source, timestamp) so the entry can be
 * re-played later with provenance.
 */
export async function appendJournal(date, text, { source = 'text' } = {}) {
  if (!isIsoDate(date)) throw new Error(`invalid date: ${date}`);
  const clean = (text || '').trim();
  if (!clean) return null;

  const store = await loadStore();
  const entry = ensureEntry(store, date);
  const segment = { text: clean, at: now(), source };
  entry.segments.push(segment);
  entry.content = entry.content
    ? `${entry.content.trimEnd()}\n\n${clean}`
    : clean;
  entry.updatedAt = now();
  await saveStore(store);
  scheduleObsidianSync(entry);
  brainEvents.emit('journals:changed', { records: store.records });
  brainEvents.emit('journals:appended', { entry, segment });
  // Per-entry event so the memory bridge re-embeds only this day, not all
  // of them. (Keep journals:appended separate — it carries the single new
  // segment for UI live-updates, which is a different consumer.)
  brainEvents.emit('journals:upserted', { entry });
  return entry;
}

export async function deleteJournal(date) {
  if (!isIsoDate(date)) return false;
  const store = await loadStore();
  if (!store.records?.[date]) return false;
  const entry = store.records[date];
  delete store.records[date];
  await saveStore(store);
  if (entry.obsidianPath) {
    await removeFromObsidian(entry).catch((err) => console.error(`📓 Obsidian delete failed: ${err.message}`));
  }
  brainEvents.emit('journals:changed', { records: store.records });
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
 */
export async function syncToObsidian(entry) {
  const settings = await getSettings();
  if (!settings.autoSync || !settings.obsidianVaultId) return null;

  const vault = await obsidian.getVaultById(settings.obsidianVaultId);
  if (!vault || !existsSync(vault.path)) return null;

  const notePath = buildObsidianNotePath(settings, entry.date);
  const markdown = buildMarkdown(entry);

  // createNote errors when the file exists; try update first then create.
  const update = await obsidian.updateNote(settings.obsidianVaultId, notePath, markdown);
  if (update?.error === 'NOTE_NOT_FOUND') {
    const created = await obsidian.createNote(settings.obsidianVaultId, notePath, markdown);
    if (created?.error) return null;
    await persistObsidianPath(entry.date, notePath);
    return notePath;
  }
  if (update?.error) return null;
  // Persist whenever the path differs — not just when it's missing — so a
  // folder rename or manual move in Obsidian doesn't leave a stale path
  // that would later point deleteJournal() at the wrong file.
  if (entry.obsidianPath !== notePath) await persistObsidianPath(entry.date, notePath);
  return notePath;
}

// Record the note path on the store entry whenever it changes. Typical case
// is the first successful Obsidian create, but a folder-rename or manual
// vault move can also shift the path — we want the store to reflect the
// current location so deleteJournal() unlinks the right file later. The
// `!== notePath` guard in syncToObsidian() keeps the steady-state cost
// zero; this function is only invoked on an actual change. PortOS is
// single-user/single-instance (see CLAUDE.md) so we don't guard against
// concurrent-writer lost-update races here.
async function persistObsidianPath(date, notePath) {
  const store = await loadStore();
  const entry = store.records?.[date];
  if (entry && entry.obsidianPath !== notePath) {
    entry.obsidianPath = notePath;
    await saveStore(store);
  }
}

async function removeFromObsidian(entry) {
  const settings = await getSettings();
  if (!settings.obsidianVaultId || !entry.obsidianPath) return false;
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

  const { records } = await listJournals({ limit: 10000 });
  let synced = 0;
  let skipped = 0;
  for (const entry of records) {
    const path = await syncToObsidian(entry).catch(() => null);
    if (path) synced += 1;
    else skipped += 1;
  }
  return { synced, skipped };
}
