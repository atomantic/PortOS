import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// vi.hoisted lets us share this constant with the hoisted vi.mock factory.
const { TEMP_ROOT } = vi.hoisted(() => {
  const { mkdtempSync } = require('fs');
  const { tmpdir } = require('os');
  const { join } = require('path');
  return { TEMP_ROOT: mkdtempSync(join(tmpdir(), 'journal-')) };
});

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return {
    ...actual,
    PATHS: { ...actual.PATHS, brain: TEMP_ROOT },
  };
});

vi.mock('../lib/timezone.js', () => ({
tryReadFile: vi.fn().mockResolvedValue(null),
  getUserTimezone: () => Promise.resolve('UTC'),
  todayInTimezone: () => '2026-04-17',
}));

vi.mock('./obsidian.js', () => ({
  getVaultById: vi.fn(),
  // The update-then-create ordering lives inside the real upsertNote and is
  // tested against a real vault in obsidian.test.js — from the journal's side
  // the contract is just 'mirror this markdown to this vault path'.
  upsertNote: vi.fn(),
  deleteNote: vi.fn(),
}));

// brainJournal now delegates entry storage to brainStorage's `journals` entity
// store. Back it with an in-memory date→record map so the journal logic (segment
// append, content replace, tombstone-on-delete, slim summaries) is exercised for
// real while staying isolated from disk. Mirrors brainStorage semantics:
// getById/getAll strip tombstones and re-attach the map key as `id`;
// upsertWithId stores the record verbatim and stamps createdAt/updatedAt.
const { journalRecords } = vi.hoisted(() => ({ journalRecords: new Map() }));
vi.mock('./brainStorage.js', () => ({
  brainEvents: { emit: vi.fn() },
  now: () => '2026-04-17T12:00:00.000Z',
  getById: vi.fn(async (_type, id) => {
    const rec = journalRecords.get(id);
    return rec && !rec._deleted ? { id, ...rec } : null;
  }),
  getAll: vi.fn(async () =>
    [...journalRecords.entries()]
      .filter(([, rec]) => !rec._deleted)
      .map(([id, rec]) => ({ id, ...rec }))),
  upsertWithId: vi.fn(async (_type, id, record) => {
    const existing = journalRecords.get(id);
    const stored = {
      ...record,
      createdAt: existing?.createdAt ?? '2026-04-17T12:00:00.000Z',
      updatedAt: '2026-04-17T12:00:00.000Z',
    };
    journalRecords.set(id, stored);
    return { id, ...stored };
  }),
  remove: vi.fn(async (_type, id) => {
    if (!journalRecords.has(id)) return false;
    journalRecords.set(id, { _deleted: true, updatedAt: '2026-04-17T12:00:00.000Z' });
    return true;
  }),
}));

import * as journal from './brainJournal.js';
import { brainEvents, getAll } from './brainStorage.js';
import * as obsidian from './obsidian.js';

// Pull the payload of the last emit of `name`, or undefined if it never fired.
const lastEmit = (name) => brainEvents.emit.mock.calls.filter((c) => c[0] === name).at(-1)?.[1];

afterAll(() => {
  rmSync(TEMP_ROOT, { recursive: true, force: true });
});

describe('brainJournal', () => {
  beforeEach(() => {
    // Fresh scratch state per test — rm then recreate the same dir so the
    // vi.mock of PATHS.brain still points at it. (mkdtempSync with a concrete
    // path silently creates sibling dirs, orphaning our mocked path.)
    rmSync(TEMP_ROOT, { recursive: true, force: true });
    mkdirSync(TEMP_ROOT, { recursive: true });
    journalRecords.clear();
    journal._clearObsidianLocationsCacheForTest();
    vi.clearAllMocks();
  });

  describe('getToday', () => {
    it('returns the user timezone today', async () => {
      expect(await journal.getToday()).toBe('2026-04-17');
    });
  });

  describe('getJournal / listJournals', () => {
    it('returns null for missing dates', async () => {
      expect(await journal.getJournal('2026-01-01')).toBeNull();
    });

    it('rejects malformed dates in getJournal', async () => {
      expect(await journal.getJournal('not-a-date')).toBeNull();
    });

    it('lists empty initially', async () => {
      const { records, total } = await journal.listJournals();
      expect(total).toBe(0);
      expect(records).toEqual([]);
    });

    it('default listJournals returns slim summaries (no content/segments)', async () => {
      await journal.appendJournal('2026-04-17', 'day one body', { source: 'voice' });
      const { records } = await journal.listJournals();
      expect(records).toHaveLength(1);
      const [entry] = records;
      expect(entry).toHaveProperty('segmentCount', 1);
      expect(entry).toHaveProperty('date', '2026-04-17');
      expect(entry).not.toHaveProperty('content');
      expect(entry).not.toHaveProperty('segments');
    });

    it('includeContent: true returns full entries', async () => {
      await journal.appendJournal('2026-04-17', 'day one body');
      const { records } = await journal.listJournals({ includeContent: true });
      expect(records[0].content).toBe('day one body');
      expect(records[0].segments).toHaveLength(1);
    });
  });

  describe('appendJournal', () => {
    it('creates an entry on first append and joins subsequent segments with blank lines', async () => {
      const first = await journal.appendJournal('2026-04-17', 'line one', { source: 'voice' });
      expect(first.content).toBe('line one');
      expect(first.segments).toHaveLength(1);
      expect(first.segments[0].source).toBe('voice');

      const second = await journal.appendJournal('2026-04-17', 'line two');
      expect(second.content).toBe('line one\n\nline two');
      expect(second.segments).toHaveLength(2);
    });

    it('emits journals:appended and journals:upserted', async () => {
      await journal.appendJournal('2026-04-17', 'hello');
      const eventNames = brainEvents.emit.mock.calls.map((c) => c[0]);
      expect(eventNames).toContain('journals:appended');
      // journals:upserted is the per-entry event the memory bridge listens
      // on — must fire for every append so a single day's embedding gets
      // refreshed without re-embedding every other day in the store.
      expect(eventNames).toContain('journals:upserted');
    });

    it('emits journals:upserted with the updated entry delta', async () => {
      await journal.appendJournal('2026-04-16', 'yesterday');
      await journal.appendJournal('2026-04-17', 'today');
      const payload = lastEmit('journals:upserted');
      expect(payload.entry.date).toBe('2026-04-17');
      expect(payload.entry.content).toBe('today');
    });

    it('does not read every historical entry when appending to one day', async () => {
      await journal.appendJournal('2026-04-15', 'day one');
      await journal.appendJournal('2026-04-16', 'day two');
      getAll.mockClear();
      await journal.appendJournal('2026-04-17', 'day three');
      expect(getAll).not.toHaveBeenCalled();
    });

    it('ignores empty/whitespace text', async () => {
      const res = await journal.appendJournal('2026-04-17', '   ');
      expect(res).toBeNull();
    });

    it('rejects invalid dates', async () => {
      await expect(journal.appendJournal('not-a-date', 'hi')).rejects.toThrow(/invalid date/);
    });
  });

  describe('setJournalContent', () => {
    it('replaces the full content and collapses segments', async () => {
      await journal.appendJournal('2026-04-17', 'old one');
      await journal.appendJournal('2026-04-17', 'old two');
      const replaced = await journal.setJournalContent('2026-04-17', 'brand new');
      expect(replaced.content).toBe('brand new');
      // Full replace invalidates prior segment history — collapse to a single
      // 'edit' segment that matches the current content.
      expect(replaced.segments).toHaveLength(1);
      expect(replaced.segments[0].source).toBe('edit');
      expect(replaced.segments[0].text).toBe('brand new');
    });

    it('clears segments when content is emptied', async () => {
      await journal.appendJournal('2026-04-17', 'old');
      const cleared = await journal.setJournalContent('2026-04-17', '');
      expect(cleared.content).toBe('');
      expect(cleared.segments).toEqual([]);
    });

    it('emits journals:upserted without re-reading the store (#3510)', async () => {
      await journal.appendJournal('2026-04-16', 'yesterday');
      getAll.mockClear();
      await journal.setJournalContent('2026-04-17', 'brand new');
      expect(getAll).not.toHaveBeenCalled();
      expect(lastEmit('journals:upserted')).toMatchObject({
        entry: { content: 'brand new' },
      });
    });
  });

  describe('deleteJournal', () => {
    it('emits journals:deleted without full-store read (#3510)', async () => {
      await journal.appendJournal('2026-04-16', 'yesterday');
      await journal.appendJournal('2026-04-17', 'today');
      getAll.mockClear();

      expect(await journal.deleteJournal('2026-04-17')).toBe(true);
      expect(getAll).not.toHaveBeenCalled();
      expect(lastEmit('journals:deleted').entry.content).toBe('today');
    });
  });

  describe('Obsidian mirror', () => {
    it('skips sync when autoSync is false', async () => {
      await journal.updateSettings({ obsidianVaultId: 'v1', autoSync: false });
      await journal.appendJournal('2026-04-17', 'hi');
      expect(obsidian.upsertNote).not.toHaveBeenCalled();
    });

    it('honors force:true even when autoSync is false (manual resync path)', async () => {
      obsidian.getVaultById.mockResolvedValue({ id: 'v1', path: '/' });
      obsidian.upsertNote.mockResolvedValue('Daily Log/2026-04-17.md');

      await journal.updateSettings({ obsidianVaultId: 'v1', autoSync: false, obsidianFolder: 'Daily Log' });
      // Regular syncToObsidian() still no-ops without force.
      await journal.syncToObsidian({ id: 'j1', date: '2026-04-17', content: 'hi', segments: [] });
      expect(obsidian.upsertNote).not.toHaveBeenCalled();

      // force bypasses autoSync so the manual "Re-sync all" action works.
      await journal.syncToObsidian(
        { id: 'j1', date: '2026-04-17', content: 'hi', segments: [] },
        { force: true },
      );
      expect(obsidian.upsertNote).toHaveBeenCalled();
    });

    // Test syncToObsidian() directly rather than going through
    // appendJournal()'s fire-and-forget scheduleObsidianSync() — the
    // background promise isn't awaited, so assertions against mocked
    // obsidian calls would otherwise race with the test runner.
    it('mirrors the day as markdown to the configured vault and folder', async () => {
      obsidian.getVaultById.mockResolvedValue({ id: 'v1', path: '/' });
      obsidian.upsertNote.mockResolvedValue('Daily Log/2026-04-17.md');

      await journal.updateSettings({ obsidianVaultId: 'v1', autoSync: true, obsidianFolder: 'Daily Log' });
      const entry = { id: 'j1', date: '2026-04-17', content: 'first', segments: [] };
      await journal.syncToObsidian(entry);
      await journal.syncToObsidian({ ...entry, content: 'first\n\nsecond' });

      // Both syncs go through the SAME call — whether the note already existed
      // is upsertNote's problem (covered against a real vault in obsidian.test.js),
      // not something the journal branches on.
      expect(obsidian.upsertNote).toHaveBeenCalledTimes(2);
      const [vaultIdArg, pathArg, markdownArg] = obsidian.upsertNote.mock.calls[0];
      expect(vaultIdArg).toBe('v1');
      expect(pathArg).toBe('Daily Log/2026-04-17.md');
      expect(markdownArg).toContain('# Daily Log — 2026-04-17');
      expect(markdownArg).toContain('first');
      expect(obsidian.upsertNote.mock.calls[1][2]).toContain('second');
    });

    it('refuses to delete notes from a different vault than the one the entry was mirrored to', async () => {
      obsidian.getVaultById.mockResolvedValue({ id: 'v1', path: '/' });
      obsidian.upsertNote.mockResolvedValue('Daily Log/2026-04-17.md');

      // Mirror a note to vault v1.
      await journal.updateSettings({ obsidianVaultId: 'v1', autoSync: true, obsidianFolder: 'Daily Log' });
      await journal.appendJournal('2026-04-17', 'content');
      await journal.syncToObsidian({
        id: 'j1', date: '2026-04-17', content: 'content', segments: [], obsidianPath: null, obsidianVaultId: null,
      });

      // User changes their configured vault to v2. deleteJournal() should not
      // delete the v1 note (which could collide with an unrelated v2 note at
      // the same relative path).
      await journal.updateSettings({ obsidianVaultId: 'v2' });
      obsidian.deleteNote.mockClear();

      await journal.deleteJournal('2026-04-17');

      expect(obsidian.deleteNote).not.toHaveBeenCalled();
    });

    it('does not resurrect an Obsidian-location sidecar entry for a day deleted before a deferred sync lands', async () => {
      obsidian.getVaultById.mockResolvedValue({ id: 'v1', path: '/' });
      obsidian.upsertNote.mockResolvedValue('Daily Log/2026-04-17.md');
      await journal.updateSettings({ obsidianVaultId: 'v1', autoSync: true, obsidianFolder: 'Daily Log' });

      // Create the day, then delete it (tombstone + clear sidecar).
      await journal.appendJournal('2026-04-17', 'content');
      await journal.deleteJournal('2026-04-17');

      // A deferred sync for the now-deleted day must NOT re-create the sidecar
      // entry (which would reattach if the date were recreated).
      await journal.syncToObsidian({ id: 'j1', date: '2026-04-17', content: 'content', segments: [] });

      const { records } = await journal.listJournals();
      const revived = records.find((r) => r.date === '2026-04-17');
      expect(revived).toBeUndefined();
    });

    it('serializes obsidian syncs per date in strict sequential order', async () => {
      const callOrder = [];
      obsidian.upsertNote.mockImplementation(async (vaultId, path, content) => {
        const match = content.match(/content-(\d+)/);
        const num = match ? match[1] : '0';
        callOrder.push(`start-${num}`);
        await new Promise((r) => setTimeout(r, 10));
        callOrder.push(`end-${num}`);
        return path;
      });

      await journal.updateSettings({ obsidianVaultId: 'v1', autoSync: true });

      await journal.setJournalContent('2026-04-17', 'content-1');
      await journal.setJournalContent('2026-04-17', 'content-2');

      // Wait for background queue to flush
      await new Promise((r) => setTimeout(r, 50));

      expect(callOrder).toEqual(['start-1', 'end-1', 'start-2', 'end-2']);
    });
  });
});
