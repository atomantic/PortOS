import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdirSync, rmSync, readFileSync, writeFileSync } from 'fs';
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
    atomicWrite: vi.fn(actual.atomicWrite),
    readJSONFile: vi.fn(actual.readJSONFile),
    PATHS: { ...actual.PATHS, brain: TEMP_ROOT },
  };
});

vi.mock('../lib/timezone.js', () => ({
  todayInTimezone: () => '2026-04-17',
}));
vi.mock('./userTimezone.js', () => ({
  getUserTimezone: () => Promise.resolve('UTC'),
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
// `updatedAt` advances per write (monotonic fake clock) so ifMatch concurrency
// tests can observe a real LWW move between append and rewrite.
const { journalRecords, clock } = vi.hoisted(() => ({
  journalRecords: new Map(),
  clock: { n: 0 },
}));
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
    const live = existing && !existing._deleted ? { id, ...existing } : null;
    if (typeof record === 'function') {
      record = await record(live);
      if (record == null) return live;
    }
    clock.n += 1;
    const stamp = `2026-04-17T12:00:${String(clock.n).padStart(2, '0')}.000Z`;
    const stored = {
      ...record,
      createdAt: existing?.createdAt ?? stamp,
      updatedAt: stamp,
    };
    journalRecords.set(id, stored);
    return { id, ...stored };
  }),
  remove: vi.fn(async (_type, id) => {
    if (!journalRecords.has(id)) return false;
    clock.n += 1;
    journalRecords.set(id, {
      _deleted: true,
      updatedAt: `2026-04-17T12:00:${String(clock.n).padStart(2, '0')}.000Z`,
    });
    return true;
  }),
}));

import * as journal from './brainJournal.js';
import { brainEvents, getAll } from './brainStorage.js';
import { atomicWrite, readJSONFile } from '../lib/fileUtils.js';
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
    clock.n = 0;
    journal._clearObsidianLocationsCacheForTest();
    vi.clearAllMocks();
  });

  describe('getToday', () => {
    it('returns the user timezone today', async () => {
      expect(await journal.getToday()).toBe('2026-04-17');
    });
  });

  describe('settings', () => {
    it('serializes concurrent patches so each update sees the latest settings', async () => {
      const [vaultUpdate, folderUpdate] = await Promise.all([
        journal.updateSettings({ obsidianVaultId: 'vault-1' }),
        journal.updateSettings({ obsidianFolder: 'Journal' }),
      ]);

      expect(vaultUpdate).toMatchObject({ obsidianVaultId: 'vault-1' });
      expect(folderUpdate).toMatchObject({
        obsidianVaultId: 'vault-1',
        obsidianFolder: 'Journal',
      });
      expect(await journal.getSettings()).toEqual({
        obsidianVaultId: 'vault-1',
        obsidianFolder: 'Journal',
        autoSync: true,
      });
    });

    // Strict-read regression (#4115): the journal was one of four settings
    // stores the original audit missed — a corrupt journal-settings.json read
    // as DEFAULT_SETTINGS and the next PATCH wrote those defaults over the
    // user's vault/folder choice. The store now rejects and leaves the file.
    it('refuses to overwrite an unreadable settings file with the defaults', async () => {
      const file = join(TEMP_ROOT, 'journal-settings.json');
      const corrupt = '{"obsidianVaultId": "vault-1",';
      writeFileSync(file, corrupt);
      await expect(journal.getSettings()).rejects.toThrow(/Unreadable JSON file/);
      await expect(journal.updateSettings({ obsidianFolder: 'Journal' })).rejects.toThrow(/Unreadable JSON file/);
      expect(readFileSync(file, 'utf8')).toBe(corrupt);
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

    it('rejects a stale ifMatchUpdatedAt with STALE_JOURNAL and the current entry', async () => {
      const first = await journal.setJournalContent('2026-04-17', 'typed');
      await journal.appendJournal('2026-04-17', 'spoken', { source: 'voice' });
      await expect(
        journal.setJournalContent('2026-04-17', 'typed plus more', {
          ifMatchUpdatedAt: first.updatedAt,
        }),
      ).rejects.toMatchObject({
        status: 409,
        code: 'STALE_JOURNAL',
        context: {
          entry: expect.objectContaining({
            content: expect.stringContaining('spoken'),
          }),
        },
      });
      // On-disk content must be untouched by the rejected rewrite.
      const current = await journal.getJournal('2026-04-17');
      expect(current.content).toContain('spoken');
      expect(current.content).not.toContain('typed plus more');
    });

    it('accepts a rewrite when ifMatchUpdatedAt matches the current clock', async () => {
      const first = await journal.setJournalContent('2026-04-17', 'base');
      const next = await journal.setJournalContent('2026-04-17', 'revised', {
        ifMatchUpdatedAt: first.updatedAt,
      });
      expect(next.content).toBe('revised');
    });

    it('force-writes when ifMatchUpdatedAt is omitted (legacy callers)', async () => {
      await journal.setJournalContent('2026-04-17', 'base');
      await journal.appendJournal('2026-04-17', 'spoken', { source: 'voice' });
      const forced = await journal.setJournalContent('2026-04-17', 'overwrite all');
      expect(forced.content).toBe('overwrite all');
    });

    it('accepts a rewrite when the on-disk entry has no updatedAt to compare', async () => {
      // Legacy / hand-edited stores may lack a clock. Rejecting forever would
      // trap the day; accept the write when there is nothing to precondition on.
      journalRecords.set('2026-04-17', {
        date: '2026-04-17',
        content: 'legacy body',
        segments: [{ text: 'legacy body', at: '2026-04-17T10:00:00.000Z', source: 'edit' }],
        // deliberately no updatedAt
      });
      const next = await journal.setJournalContent('2026-04-17', 'recovered', {
        ifMatchUpdatedAt: '2026-04-17T12:00:00.000Z',
      });
      expect(next.content).toBe('recovered');
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
      const entry = await journal.appendJournal('2026-04-17', 'hi');
      // Regular syncToObsidian() still no-ops without force.
      await journal.syncToObsidian(entry);
      expect(obsidian.upsertNote).not.toHaveBeenCalled();

      // force bypasses autoSync so the manual "Re-sync all" action works.
      await journal.syncToObsidian(entry, { force: true });
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
      const entry = { date: '2026-04-17', content: 'first', segments: [] };
      journalRecords.set(entry.date, entry);
      await journal.syncToObsidian(entry);
      journalRecords.set(entry.date, { ...entry, content: 'first\n\nsecond' });
      await journal.syncToObsidian(entry);

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
      obsidian.upsertNote.mockClear();
      expect(await journal.syncToObsidian({ date: '2026-04-17' })).toBeNull();
      expect(obsidian.upsertNote).not.toHaveBeenCalled();
      expect(JSON.parse(readFileSync(join(TEMP_ROOT, 'journal-obsidian-locations.json'), 'utf8'))).toEqual({});
    });

    it.each(['manual', 'bulk'])('preserves a recreated day mirrored by %s sync during deletion', async (mode) => {
      const date = '2026-04-17';
      const path = `Daily Log/${date}.md`;
      const vault = new Map();
      const entered = Promise.withResolvers();
      const release = Promise.withResolvers();
      obsidian.upsertNote.mockImplementation(async (_vault, notePath, markdown) => {
        vault.set(notePath, markdown);
        return notePath;
      });
      obsidian.deleteNote.mockImplementationOnce(async (_vault, notePath) => {
        entered.resolve();
        await release.promise;
        return vault.delete(notePath);
      });
      await journal.updateSettings({ obsidianVaultId: 'v1', obsidianFolder: 'Daily Log', autoSync: false });
      const original = await journal.appendJournal(date, 'old day');
      await journal.syncToObsidian(original, { force: true });

      const deletion = journal.deleteJournal(date);
      await entered.promise;
      const replacement = await journal.appendJournal(date, 'replacement day');
      const settings = await journal.getSettings();
      // Resolve settings reads in memory so one event-loop turn drains all
      // runnable mirror work while the adapter still holds the old unlink.
      const readFile = readJSONFile.getMockImplementation();
      const readSettings = (file, ...args) => file.endsWith('journal-settings.json') ? settings : readFile(file, ...args);
      await readJSONFile.withImplementation(readSettings, async () => {
        const sync = mode === 'bulk'
          ? journal.resyncAllToObsidian()
          : journal.syncToObsidian(replacement, { force: true });
        await new Promise(resolve => setImmediate(resolve));
        release.resolve();
        await Promise.all([deletion, sync]);
      });

      expect(vault.get(path)).toContain('replacement day');
      expect((await journal.getJournal(date)).content).toBe('replacement day');
      expect(JSON.parse(readFileSync(join(TEMP_ROOT, 'journal-obsidian-locations.json'), 'utf8'))).toEqual({
        [date]: { obsidianPath: path, obsidianVaultId: 'v1' },
      });
    });

    it('unlinks a first mirror that finishes after its day was tombstoned', async () => {
      const date = '2026-04-17';
      const entered = Promise.withResolvers();
      const release = Promise.withResolvers();
      const tombstoned = Promise.withResolvers();
      const vault = new Map();
      await journal.updateSettings({ obsidianVaultId: 'v1', obsidianFolder: 'Daily Log', autoSync: false });
      const entry = await journal.appendJournal(date, 'old day');
      obsidian.upsertNote.mockImplementationOnce(async (_vault, path, markdown) => {
        entered.resolve();
        await release.promise;
        vault.set(path, markdown);
        return path;
      });
      obsidian.deleteNote.mockImplementationOnce(async (_vault, path) => vault.delete(path));
      const sync = journal.syncToObsidian(entry, { force: true });
      await entered.promise;
      brainEvents.emit.mockImplementationOnce(() => tombstoned.resolve());
      const deletion = journal.deleteJournal(date);
      await tombstoned.promise;
      release.resolve();
      await Promise.all([deletion, sync]);

      expect(vault.size).toBe(0);
      expect(JSON.parse(readFileSync(join(TEMP_ROOT, 'journal-obsidian-locations.json'), 'utf8'))).toEqual({});
    });

    it('deletes a bulk mirror before its sidecar batch flushes and keeps the recreated day unmirrored', async () => {
      const date = '2026-04-18';
      const other = '2026-04-17';
      const entered = Promise.withResolvers();
      const release = Promise.withResolvers();
      const vault = new Map();
      await journal.updateSettings({ obsidianVaultId: 'v1', obsidianFolder: 'Daily Log', autoSync: false });
      await journal.appendJournal(date, 'old day');
      await journal.appendJournal(other, 'other day');
      obsidian.upsertNote.mockImplementation(async (_vault, path, markdown) => {
        if (path.endsWith(`${other}.md`)) {
          entered.resolve();
          await release.promise;
        }
        vault.set(path, markdown);
        return path;
      });
      obsidian.deleteNote.mockImplementationOnce(async (_vault, path) => vault.delete(path));

      const bulk = journal.resyncAllToObsidian();
      await entered.promise;
      try {
        await journal.deleteJournal(date);
        await journal.appendJournal(date, 'replacement day');
      } finally {
        release.resolve();
      }
      await bulk;

      expect([...vault.keys()]).toEqual([`Daily Log/${other}.md`]);
      expect(await journal.getJournal(date)).toMatchObject({ content: 'replacement day', obsidianPath: null });
      expect(JSON.parse(readFileSync(join(TEMP_ROOT, 'journal-obsidian-locations.json'), 'utf8'))).toEqual({
        [other]: { obsidianPath: `Daily Log/${other}.md`, obsidianVaultId: 'v1' },
      });
    });

    it('preserves another date mirrored during sidecar deletion (#16765)', async () => {
      await journal.updateSettings({ obsidianVaultId: 'v1', autoSync: false, obsidianFolder: 'Daily Log' });
      const removed = await journal.appendJournal('2026-04-17', 'remove');
      const surviving = await journal.appendJournal('2026-04-18', 'keep');
      obsidian.upsertNote.mockImplementation(async (_vault, path) => path);
      await journal.syncToObsidian(removed, { force: true });

      const actual = await vi.importActual('../lib/fileUtils.js');
      let releaseCleanup;
      let cleanupStarted;
      const gate = new Promise((resolve) => { releaseCleanup = resolve; });
      const started = new Promise((resolve) => { cleanupStarted = resolve; });
      atomicWrite.mockImplementationOnce(async (...args) => {
        cleanupStarted();
        await gate;
        return actual.atomicWrite(...args);
      });
      const deletion = journal.deleteJournal(removed.date);
      await started;
      let mirrorStarted;
      const mirrored = new Promise((resolve) => { mirrorStarted = resolve; });
      obsidian.upsertNote.mockImplementationOnce(async (_vault, path) => {
        mirrorStarted();
        return path;
      });
      const sync = journal.syncToObsidian(surviving, { force: true });
      await mirrored;
      // Let persistence reach the mutex while the deletion write is held.
      await new Promise((resolve) => setImmediate(resolve));
      releaseCleanup();
      await Promise.all([deletion, sync]);

      expect(JSON.parse(readFileSync(join(TEMP_ROOT, 'journal-obsidian-locations.json'), 'utf8'))).toEqual({
        '2026-04-18': { obsidianPath: 'Daily Log/2026-04-18.md', obsidianVaultId: 'v1' },
      });
    });

    it('serializes obsidian syncs per date in strict sequential order', async () => {
      const callOrder = [];
      obsidian.upsertNote.mockImplementation(async (vaultId, path, content) => {
        const match = content.match(/content-(\d+)/);
        // A fire-and-forget mirror left over from an earlier test can land on
        // this shared mock (same date queue); only this test's own writes count.
        if (!match) return path;
        const num = match[1];
        callOrder.push(`start-${num}`);
        await new Promise((r) => setTimeout(r, 10));
        callOrder.push(`end-${num}`);
        return path;
      });

      await journal.updateSettings({ obsidianVaultId: 'v1', autoSync: true });

      await journal.setJournalContent('2026-04-17', 'content-1');
      await journal.setJournalContent('2026-04-17', 'content-2');

      // Poll for the background queue to drain rather than sleeping a flat
      // 50ms: the two syncs sleep 10ms EACH and only run back-to-back because
      // they are serialized, so a fixed budget that is fine locally leaves the
      // second one mid-flight on a slower runner — the assertion then reads
      // three entries and fails on the sequencing it is meant to prove.
      const deadline = Date.now() + 5000;
      while (callOrder.length < 4 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }

      expect(callOrder).toEqual(['start-1', 'end-1', 'start-2', 'end-2']);
    });
  });

  /**
   * #3706 fallout: an evicted note now costs up to MATERIALIZE_TIMEOUT_MS (20s)
   * before upsertNote refuses it, and this bulk resync is a FOREGROUND request
   * over up to 10,000 entries — so an unavailable vault must not turn "Re-sync
   * all entries now" into a multi-hour request nobody can cancel.
   */
  describe('resyncAllToObsidian — circuit breaker', () => {
    // Valid consecutive calendar dates (a bare day counter would mint 2026-03-32).
    const isoDay = (i) => new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10);

    beforeEach(async () => {
      // autoSync:false while seeding — appendJournal fires its OWN fire-and-forget
      // mirror per entry, which would double the call count. resyncAllToObsidian
      // passes force:true, so it still runs.
      await journal.updateSettings({ obsidianVaultId: 'v1', autoSync: false, obsidianFolder: 'Daily Log' });
    });

    it('re-mirrors the oldest day beyond 10000 entries', async () => {
      for (let i = 0; i < 10001; i += 1) {
        const date = isoDay(i);
        journalRecords.set(date, { date, content: 'Day ' + i, segments: [] });
      }
      obsidian.upsertNote.mockResolvedValue('Daily Log/note.md');
      expect(await journal.resyncAllToObsidian()).toEqual({ synced: 10001, skipped: 0, stoppedEarly: false });
      expect(obsidian.upsertNote.mock.calls.some(call => JSON.stringify(call).includes(isoDay(0)))).toBe(true);
    });

    it('writes all changed Obsidian locations in one sidecar save', async () => {
      for (let i = 0; i < 3; i += 1) await journal.appendJournal(isoDay(i), `day ${i}`);
      obsidian.upsertNote.mockResolvedValue('Daily Log/note.md');
      atomicWrite.mockClear();

      await journal.resyncAllToObsidian();

      expect(atomicWrite).toHaveBeenCalledTimes(1);
      const locations = await Promise.all([0, 1, 2].map((i) => journal.getJournal(isoDay(i))));
      expect(locations.map(({ obsidianPath, obsidianVaultId }) => ({ obsidianPath, obsidianVaultId }))).toEqual([
        { obsidianPath: 'Daily Log/2026-01-01.md', obsidianVaultId: 'v1' },
        { obsidianPath: 'Daily Log/2026-01-02.md', obsidianVaultId: 'v1' },
        { obsidianPath: 'Daily Log/2026-01-03.md', obsidianVaultId: 'v1' },
      ]);
    });

    it('stops after a run of consecutive failures instead of grinding through every entry', async () => {
      for (let i = 0; i < 40; i += 1) await journal.appendJournal(isoDay(i), `day ${i}`);
      obsidian.upsertNote.mockClear();
      obsidian.upsertNote.mockResolvedValue(null);   // vault unavailable for every entry

      const stats = await journal.resyncAllToObsidian();

      expect(stats.stoppedEarly).toBe(true);
      // Bailed at the threshold rather than attempting all 40.
      expect(obsidian.upsertNote).toHaveBeenCalledTimes(25);
      expect(stats.synced).toBe(0);
    });

    it('does not trip on scattered failures among successes', async () => {
      for (let i = 0; i < 30; i += 1) await journal.appendJournal(isoDay(i), `day ${i}`);
      // Every third entry fails — never 25 in a row, so the run must complete.
      obsidian.upsertNote.mockClear();
      let n = 0;
      obsidian.upsertNote.mockImplementation(async () => {
        n += 1;
        return n % 3 === 0 ? null : 'Daily Log/note.md';
      });

      const stats = await journal.resyncAllToObsidian();

      expect(stats.stoppedEarly).toBe(false);
      expect(obsidian.upsertNote).toHaveBeenCalledTimes(30);
      expect(stats.synced + stats.skipped).toBe(30);
    });
  });

});
