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
  getUserTimezone: () => Promise.resolve('UTC'),
  todayInTimezone: () => '2026-04-17',
}));

vi.mock('./obsidian.js', () => ({
  getVaultById: vi.fn(),
  updateNote: vi.fn(),
  createNote: vi.fn(),
  deleteNote: vi.fn(),
}));

vi.mock('./brainStorage.js', () => ({
  brainEvents: { emit: vi.fn() },
  now: () => '2026-04-17T12:00:00.000Z',
}));

import * as journal from './brainJournal.js';
import { brainEvents } from './brainStorage.js';
import * as obsidian from './obsidian.js';

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

    it('emits journals:changed, journals:appended, and journals:upserted', async () => {
      await journal.appendJournal('2026-04-17', 'hello');
      const eventNames = brainEvents.emit.mock.calls.map((c) => c[0]);
      expect(eventNames).toContain('journals:changed');
      expect(eventNames).toContain('journals:appended');
      // journals:upserted is the per-entry event the memory bridge listens
      // on — must fire for every append so a single day's embedding gets
      // refreshed without re-embedding every other day in the store.
      expect(eventNames).toContain('journals:upserted');
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
  });

  describe('Obsidian mirror', () => {
    it('skips sync when autoSync is false', async () => {
      await journal.updateSettings({ obsidianVaultId: 'v1', autoSync: false });
      await journal.appendJournal('2026-04-17', 'hi');
      expect(obsidian.updateNote).not.toHaveBeenCalled();
      expect(obsidian.createNote).not.toHaveBeenCalled();
    });

    it('honors force:true even when autoSync is false (manual resync path)', async () => {
      obsidian.getVaultById.mockResolvedValue({ id: 'v1', path: '/' });
      obsidian.updateNote.mockResolvedValueOnce({ path: 'Daily Log/2026-04-17.md' });

      await journal.updateSettings({ obsidianVaultId: 'v1', autoSync: false, obsidianFolder: 'Daily Log' });
      // Regular syncToObsidian() still no-ops without force.
      await journal.syncToObsidian({ id: 'j1', date: '2026-04-17', content: 'hi', segments: [] });
      expect(obsidian.updateNote).not.toHaveBeenCalled();

      // force bypasses autoSync so the manual "Re-sync all" action works.
      await journal.syncToObsidian(
        { id: 'j1', date: '2026-04-17', content: 'hi', segments: [] },
        { force: true },
      );
      expect(obsidian.updateNote).toHaveBeenCalled();
    });

    // Test syncToObsidian() directly rather than going through
    // appendJournal()'s fire-and-forget scheduleObsidianSync() — the
    // background promise isn't awaited, so assertions against mocked
    // obsidian calls would otherwise race with the test runner.
    it('creates an obsidian note on first sync and updates on later syncs', async () => {
      obsidian.getVaultById.mockResolvedValue({ id: 'v1', path: '/' });
      obsidian.updateNote.mockResolvedValueOnce({ error: 'NOTE_NOT_FOUND' });
      obsidian.createNote.mockResolvedValueOnce({ path: 'Daily Log/2026-04-17.md' });
      obsidian.updateNote.mockResolvedValueOnce({ path: 'Daily Log/2026-04-17.md' });

      await journal.updateSettings({ obsidianVaultId: 'v1', autoSync: true, obsidianFolder: 'Daily Log' });
      const entry = { id: 'j1', date: '2026-04-17', content: 'first', segments: [] };
      await journal.syncToObsidian(entry);
      await journal.syncToObsidian({ ...entry, content: 'first\n\nsecond' });

      expect(obsidian.createNote).toHaveBeenCalledTimes(1);
      const [vaultIdArg, pathArg, markdownArg] = obsidian.createNote.mock.calls[0];
      expect(vaultIdArg).toBe('v1');
      expect(pathArg).toBe('Daily Log/2026-04-17.md');
      expect(markdownArg).toContain('# Daily Log — 2026-04-17');
      expect(markdownArg).toContain('first');

      // Second sync updates, not creates
      expect(obsidian.updateNote).toHaveBeenCalled();
    });

    it('refuses to delete notes from a different vault than the one the entry was mirrored to', async () => {
      obsidian.getVaultById.mockResolvedValue({ id: 'v1', path: '/' });
      obsidian.updateNote.mockResolvedValueOnce({ error: 'NOTE_NOT_FOUND' });
      obsidian.createNote.mockResolvedValueOnce({ path: 'Daily Log/2026-04-17.md' });

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
  });
});
