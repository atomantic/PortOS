import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
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
    // Fresh scratch state per test
    rmSync(TEMP_ROOT, { recursive: true, force: true });
    mkdtempSync(TEMP_ROOT); // no-op if gone; we recreate via ensureDir
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

    it('emits journals:changed and journals:appended', async () => {
      await journal.appendJournal('2026-04-17', 'hello');
      const eventNames = brainEvents.emit.mock.calls.map((c) => c[0]);
      expect(eventNames).toContain('journals:changed');
      expect(eventNames).toContain('journals:appended');
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
    it('replaces the full content', async () => {
      await journal.appendJournal('2026-04-17', 'old');
      const replaced = await journal.setJournalContent('2026-04-17', 'brand new');
      expect(replaced.content).toBe('brand new');
    });
  });

  describe('Obsidian mirror', () => {
    it('skips sync when autoSync is false', async () => {
      await journal.updateSettings({ obsidianVaultId: 'v1', autoSync: false });
      await journal.appendJournal('2026-04-17', 'hi');
      expect(obsidian.updateNote).not.toHaveBeenCalled();
      expect(obsidian.createNote).not.toHaveBeenCalled();
    });

    it('creates an obsidian note on first append and updates on later appends', async () => {
      obsidian.getVaultById.mockResolvedValue({ id: 'v1', path: '/' });
      obsidian.updateNote.mockResolvedValueOnce({ error: 'NOTE_NOT_FOUND' });
      obsidian.createNote.mockResolvedValueOnce({ path: 'Daily Log/2026-04-17.md' });
      obsidian.updateNote.mockResolvedValueOnce({ path: 'Daily Log/2026-04-17.md' });

      await journal.updateSettings({ obsidianVaultId: 'v1', autoSync: true, obsidianFolder: 'Daily Log' });
      await journal.appendJournal('2026-04-17', 'first');
      await journal.appendJournal('2026-04-17', 'second');

      expect(obsidian.createNote).toHaveBeenCalledTimes(1);
      const [vaultIdArg, pathArg, markdownArg] = obsidian.createNote.mock.calls[0];
      expect(vaultIdArg).toBe('v1');
      expect(pathArg).toBe('Daily Log/2026-04-17.md');
      expect(markdownArg).toContain('# Daily Log — 2026-04-17');
      expect(markdownArg).toContain('first');

      // Second append updates, not creates
      expect(obsidian.updateNote).toHaveBeenCalled();
    });
  });
});
