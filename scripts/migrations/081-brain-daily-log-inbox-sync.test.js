import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import migration, { computeDailyLogInboxMigration } from './081-brain-daily-log-inbox-sync.js';

let rootDir;
let brainDir;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), 'migration-081-'));
  brainDir = join(rootDir, 'data', 'brain');
  mkdirSync(brainDir, { recursive: true });
});

afterEach(() => {
  rmSync(rootDir, { recursive: true, force: true });
});

const writeJson = (name, obj) => writeFileSync(join(brainDir, name), JSON.stringify(obj, null, 2));
const writeJsonl = (name, rows) =>
  writeFileSync(join(brainDir, name), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
const readJson = (name) => JSON.parse(readFileSync(join(brainDir, name), 'utf-8'));
const writeInstanceId = (id) => {
  mkdirSync(join(rootDir, 'data'), { recursive: true });
  writeFileSync(join(rootDir, 'data', 'instances.json'), JSON.stringify({ self: { instanceId: id } }));
};

describe('computeDailyLogInboxMigration (pure)', () => {
  const opts = { instanceId: 'inst-1', nowIso: '2026-06-09T00:00:00.000Z' };

  it('strips the inner id from journal entries and stamps missing sync fields', () => {
    const journals = {
      records: {
        '2026-04-18': { id: 'uuid-1', date: '2026-04-18', content: 'hi', segments: [] },
      },
    };
    const { journalsStore, journalsChanged } = computeDailyLogInboxMigration(journals, [], opts);
    const entry = journalsStore.records['2026-04-18'];
    expect(entry).not.toHaveProperty('id');
    expect(entry.originInstanceId).toBe('inst-1');
    expect(entry.createdAt).toBe('2026-06-09T00:00:00.000Z');
    expect(entry.updatedAt).toBe('2026-06-09T00:00:00.000Z');
    expect(journalsChanged).toBe(true);
  });

  it('preserves existing journal sync clocks (no LWW bump on already-stamped days)', () => {
    const journals = {
      records: {
        '2026-04-18': {
          date: '2026-04-18', content: 'hi', segments: [],
          originInstanceId: 'other', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-02-02T00:00:00.000Z',
        },
      },
    };
    const { journalsStore, journalsChanged } = computeDailyLogInboxMigration(journals, [], opts);
    const entry = journalsStore.records['2026-04-18'];
    expect(entry.originInstanceId).toBe('other');
    expect(entry.updatedAt).toBe('2026-02-02T00:00:00.000Z');
    // Already in shape (no inner id, all fields present) → no rewrite.
    expect(journalsChanged).toBe(false);
  });

  it('re-keys inbox JSONL rows by id, drops inner id, seeds clocks from capturedAt', () => {
    const rows = [
      { id: 'a', capturedText: 'x', status: 'done', capturedAt: '2026-03-01T00:00:00.000Z' },
      { id: 'b', capturedText: 'y', status: 'needs_review', capturedAt: '2026-03-02T00:00:00.000Z' },
    ];
    const { inboxStore, inboxCount } = computeDailyLogInboxMigration(null, rows, opts);
    expect(inboxCount).toBe(2);
    expect(Object.keys(inboxStore.records)).toEqual(['a', 'b']);
    expect(inboxStore.records.a).not.toHaveProperty('id');
    expect(inboxStore.records.a.originInstanceId).toBe('inst-1');
    expect(inboxStore.records.a.createdAt).toBe('2026-03-01T00:00:00.000Z');
    expect(inboxStore.records.a.updatedAt).toBe('2026-03-01T00:00:00.000Z');
  });

  it('skips inbox rows without an id', () => {
    const { inboxStore, inboxCount } = computeDailyLogInboxMigration(null, [{ capturedText: 'no id' }], opts);
    expect(inboxCount).toBe(0);
    expect(inboxStore.records).toEqual({});
  });

  it('handles a null journals store (fresh install)', () => {
    const { journalsStore, journalsChanged } = computeDailyLogInboxMigration(null, [], opts);
    expect(journalsStore).toBeNull();
    expect(journalsChanged).toBe(false);
  });

  it('extracts machine-local Obsidian fields off the synced record into the sidecar', () => {
    const journals = {
      records: {
        '2026-04-18': {
          id: 'uuid-1', date: '2026-04-18', content: 'hi', segments: [],
          obsidianPath: 'Daily Log/2026-04-18.md', obsidianVaultId: 'vault-A',
        },
      },
    };
    const { journalsStore, obsidianLocations, obsidianExtracted } =
      computeDailyLogInboxMigration(journals, [], { ...opts, obsidianLocations: {} });
    const entry = journalsStore.records['2026-04-18'];
    expect(entry).not.toHaveProperty('obsidianPath');
    expect(entry).not.toHaveProperty('obsidianVaultId');
    expect(obsidianExtracted).toBe(1);
    expect(obsidianLocations['2026-04-18']).toEqual({
      obsidianPath: 'Daily Log/2026-04-18.md', obsidianVaultId: 'vault-A',
    });
  });

  it('does not overwrite a newer sidecar entry on re-run (idempotent extraction)', () => {
    const journals = {
      records: { '2026-04-18': { date: '2026-04-18', content: 'hi', segments: [], obsidianPath: 'old.md', obsidianVaultId: 'v1' } },
    };
    const existing = { '2026-04-18': { obsidianPath: 'new.md', obsidianVaultId: 'v2' } };
    const { obsidianLocations, obsidianExtracted } =
      computeDailyLogInboxMigration(journals, [], { ...opts, obsidianLocations: existing });
    expect(obsidianExtracted).toBe(0);
    expect(obsidianLocations['2026-04-18']).toEqual({ obsidianPath: 'new.md', obsidianVaultId: 'v2' });
  });

  it('re-keys journal memory-bridge entries from uuid to date, leaving others alone', () => {
    const journals = { records: { '2026-04-18': { id: 'uuid-1', date: '2026-04-18', content: 'hi', segments: [] } } };
    const bridgeMap = {
      'journals:uuid-1': 'mem-journal',
      'people:p1': 'mem-person', // untouched
    };
    const { bridgeMap: out, bridgeRemapped } = computeDailyLogInboxMigration(journals, [], { ...opts, bridgeMap });
    expect(bridgeRemapped).toBe(1);
    expect(out['journals:2026-04-18']).toBe('mem-journal');
    expect(out).not.toHaveProperty('journals:uuid-1');
    expect(out['people:p1']).toBe('mem-person');
  });

  it('does not clobber an existing date-keyed bridge entry (idempotent)', () => {
    const journals = { records: { '2026-04-18': { id: 'uuid-1', date: '2026-04-18', content: 'hi', segments: [] } } };
    const bridgeMap = { 'journals:uuid-1': 'old', 'journals:2026-04-18': 'already' };
    const { bridgeMap: out, bridgeRemapped } = computeDailyLogInboxMigration(journals, [], { ...opts, bridgeMap });
    expect(bridgeRemapped).toBe(0);
    expect(out['journals:2026-04-18']).toBe('already');
  });

  it('returns null bridge map when none provided', () => {
    const { bridgeMap } = computeDailyLogInboxMigration(null, [], opts);
    expect(bridgeMap).toBeNull();
  });
});

describe('migration 081 up()', () => {
  it('converts inbox_log.jsonl → inbox.json and renames the legacy file aside', async () => {
    writeInstanceId('inst-x');
    writeJsonl('inbox_log.jsonl', [
      { id: 'a', capturedText: 'x', status: 'done', capturedAt: '2026-03-01T00:00:00.000Z' },
    ]);

    await migration.up({ rootDir });

    expect(existsSync(join(brainDir, 'inbox.json'))).toBe(true);
    expect(existsSync(join(brainDir, 'inbox_log.jsonl'))).toBe(false);
    expect(existsSync(join(brainDir, 'inbox_log.jsonl.migrated'))).toBe(true);
    const inbox = readJson('inbox.json');
    expect(inbox.records.a.originInstanceId).toBe('inst-x');
    expect(inbox.records.a).not.toHaveProperty('id');
  });

  it('normalizes journals.json in place', async () => {
    writeInstanceId('inst-x');
    writeJson('journals.json', {
      records: { '2026-04-18': { id: 'uuid-1', date: '2026-04-18', content: 'hi', segments: [] } },
    });

    await migration.up({ rootDir });

    const journals = readJson('journals.json');
    expect(journals.records['2026-04-18']).not.toHaveProperty('id');
    expect(journals.records['2026-04-18'].originInstanceId).toBe('inst-x');
  });

  it('is idempotent — a second run finds nothing to do and does not lose data', async () => {
    writeInstanceId('inst-x');
    writeJsonl('inbox_log.jsonl', [
      { id: 'a', capturedText: 'x', status: 'done', capturedAt: '2026-03-01T00:00:00.000Z' },
    ]);
    writeJson('journals.json', {
      records: { '2026-04-18': { id: 'uuid-1', date: '2026-04-18', content: 'hi', segments: [] } },
    });

    await migration.up({ rootDir });
    const inboxAfter1 = readJson('inbox.json');
    const journalsAfter1 = readJson('journals.json');

    // Second run: no legacy jsonl remains, journals already in shape.
    await migration.up({ rootDir });
    expect(readJson('inbox.json')).toEqual(inboxAfter1);
    expect(readJson('journals.json')).toEqual(journalsAfter1);
  });

  it('writes the Obsidian-locations sidecar and strips those fields from journals.json', async () => {
    writeInstanceId('inst-x');
    writeJson('journals.json', {
      records: {
        '2026-04-18': {
          id: 'uuid-1', date: '2026-04-18', content: 'hi', segments: [],
          obsidianPath: 'Daily Log/2026-04-18.md', obsidianVaultId: 'vault-A',
        },
      },
    });

    await migration.up({ rootDir });

    const journals = readJson('journals.json');
    expect(journals.records['2026-04-18']).not.toHaveProperty('obsidianPath');
    expect(journals.records['2026-04-18']).not.toHaveProperty('obsidianVaultId');
    expect(existsSync(join(brainDir, 'journal-obsidian-locations.json'))).toBe(true);
    const sidecar = readJson('journal-obsidian-locations.json');
    expect(sidecar['2026-04-18']).toEqual({
      obsidianPath: 'Daily Log/2026-04-18.md', obsidianVaultId: 'vault-A',
    });
  });

  it('re-keys the on-disk memory-bridge map for journal entries', async () => {
    writeInstanceId('inst-x');
    writeJson('journals.json', {
      records: { '2026-04-18': { id: 'uuid-1', date: '2026-04-18', content: 'hi', segments: [] } },
    });
    writeJson('memory-bridge-map.json', { 'journals:uuid-1': 'mem-1', 'people:p1': 'mem-2' });

    await migration.up({ rootDir });

    const bridge = readJson('memory-bridge-map.json');
    expect(bridge['journals:2026-04-18']).toBe('mem-1');
    expect(bridge).not.toHaveProperty('journals:uuid-1');
    expect(bridge['people:p1']).toBe('mem-2');
  });

  it('leaves originInstanceId absent (not "unknown") when instances.json is missing, so boot-time backfill can repair it', async () => {
    writeJsonl('inbox_log.jsonl', [
      { id: 'a', capturedText: 'x', status: 'done', capturedAt: '2026-03-01T00:00:00.000Z' },
    ]);
    await migration.up({ rootDir });
    // Baking the 'unknown' sentinel onto a live record would be permanent
    // (backfillOriginInstanceId only fills falsy values). Leaving it absent lets
    // the post-ensureSelf backfill stamp the real instance id.
    expect(readJson('inbox.json').records.a).not.toHaveProperty('originInstanceId');
  });
});
