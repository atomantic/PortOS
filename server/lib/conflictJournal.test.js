import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makePathsProxy } from './mockPathsDataRoot.js';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'conflict-journal-test-'));

vi.mock('./fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: TEST_DATA_ROOT }));

const cj = await import('./conflictJournal.js');

afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

// Minimal universe-shaped records (sanitizeRecordForWire needs an id; universe
// adds the soft-delete pair). Distinct content → distinct content hashes.
const uni = (over = {}) => ({ id: 'u-1', name: 'X', starterPrompt: 'base', updatedAt: '2026-05-01T00:00:00Z', ...over });

const pendingEntries = async () => cj.conflictJournalStore().loadAll();

describe('conflictJournal', () => {
  beforeEach(() => {
    rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
    mkdirSync(TEST_DATA_ROOT, { recursive: true });
    cj.__resetBaseHashCacheForTests();
  });

  it('contentHashForRecord is stable and null for an ephemeral non-tombstone', () => {
    const h1 = cj.contentHashForRecord('universe', uni());
    const h2 = cj.contentHashForRecord('universe', uni());
    expect(h1).toBe(h2);
    expect(cj.contentHashForRecord('universe', uni({ ephemeral: true }))).toBeNull();
  });

  it('no base → treated as clean (no journal), base seeded for next time', async () => {
    const local = uni({ starterPrompt: 'local', updatedAt: '2026-05-01T00:00:00Z' });
    const remote = uni({ starterPrompt: 'remote', updatedAt: '2026-05-02T00:00:00Z' });
    await cj.maybeJournalBeforeOverwrite({ kind: 'universe', id: 'u-1', local, remote, source: { via: 'sync' } });
    await cj.flushBaseHashes();
    expect(await pendingEntries()).toHaveLength(0);
    expect(await cj.getSyncBaseHash('universe', 'u-1')).toBe(cj.contentHashForRecord('universe', remote));
  });

  it('clean sequential update (local == base) → no journal', async () => {
    const base = uni({ starterPrompt: 'base' });
    await cj.setSyncBaseHash('universe', 'u-1', cj.contentHashForRecord('universe', base));
    // local untouched since base; remote is a newer edit.
    const remote = uni({ starterPrompt: 'remote-edit', updatedAt: '2026-05-03T00:00:00Z' });
    await cj.maybeJournalBeforeOverwrite({ kind: 'universe', id: 'u-1', local: base, remote, source: { via: 'sync' } });
    expect(await pendingEntries()).toHaveLength(0);
  });

  it('true 3-way divergence → exactly one journal entry; convergence base advances', async () => {
    const base = uni({ starterPrompt: 'base' });
    await cj.setSyncBaseHash('universe', 'u-1', cj.contentHashForRecord('universe', base));
    const local = uni({ starterPrompt: 'LOCAL edit', updatedAt: '2026-05-02T00:00:00Z' });   // diverged
    const remote = uni({ starterPrompt: 'REMOTE edit', updatedAt: '2026-05-03T00:00:00Z' });  // diverged + newer

    await cj.maybeJournalBeforeOverwrite({ kind: 'universe', id: 'u-1', local, remote, source: { via: 'push', peerId: 'peer-A' } });
    const entries = await pendingEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ recordKind: 'universe', recordId: 'u-1', status: 'pending' });
    expect(entries[0].localSnapshot.starterPrompt).toBe('LOCAL edit');
    expect(entries[0].remoteSnapshot.starterPrompt).toBe('REMOTE edit');
    expect(entries[0].diffSummary.some((d) => d.field === 'starterPrompt')).toBe(true);
    // Base advanced to remote → an idempotent replay must NOT re-journal.
    expect(await cj.getSyncBaseHash('universe', 'u-1')).toBe(cj.contentHashForRecord('universe', remote));
  });

  it('idempotent snapshot replay does not create a second entry', async () => {
    const base = uni({ starterPrompt: 'base' });
    await cj.setSyncBaseHash('universe', 'u-1', cj.contentHashForRecord('universe', base));
    const local = uni({ starterPrompt: 'LOCAL', updatedAt: '2026-05-02T00:00:00Z' });
    const remote = uni({ starterPrompt: 'REMOTE', updatedAt: '2026-05-03T00:00:00Z' });
    await cj.maybeJournalBeforeOverwrite({ kind: 'universe', id: 'u-1', local, remote, source: { via: 'sync' } });
    // After the (simulated) overwrite, local == remote; replay the same remote.
    await cj.maybeJournalBeforeOverwrite({ kind: 'universe', id: 'u-1', local: remote, remote, source: { via: 'sync' } });
    expect(await pendingEntries()).toHaveLength(1);
  });

  it('diffSummary surfaces only restorable content fields, never server-owned ones', async () => {
    const base = uni({ starterPrompt: 'base' });
    await cj.setSyncBaseHash('universe', 'u-1', cj.contentHashForRecord('universe', base));
    // Differ in a restorable field (starterPrompt) AND a non-restorable one
    // (schemaVersion). Only the restorable field may be offered to the UI —
    // otherwise merge-fields would reject the whole request server-side.
    const local = uni({ starterPrompt: 'LOCAL', schemaVersion: 4, updatedAt: '2026-05-02T00:00:00Z' });
    const remote = uni({ starterPrompt: 'REMOTE', schemaVersion: 5, updatedAt: '2026-05-03T00:00:00Z' });
    await cj.maybeJournalBeforeOverwrite({ kind: 'universe', id: 'u-1', local, remote, source: { via: 'sync' } });
    const [entry] = await pendingEntries();
    const fields = entry.diffSummary.map((d) => d.field);
    expect(fields).toContain('starterPrompt');
    expect(fields).not.toContain('schemaVersion');
    expect(fields).not.toContain('id');
  });

  it('does NOT journal when the local side is a tombstone (no content to lose)', async () => {
    const base = uni({ starterPrompt: 'base' });
    await cj.setSyncBaseHash('universe', 'u-1', cj.contentHashForRecord('universe', base));
    const localTombstone = uni({ deleted: true, deletedAt: '2026-05-02T00:00:00Z', updatedAt: '2026-05-02T00:00:00Z' });
    const remote = uni({ starterPrompt: 'REMOTE', updatedAt: '2026-05-03T00:00:00Z' });
    await cj.maybeJournalBeforeOverwrite({ kind: 'universe', id: 'u-1', local: localTombstone, remote, source: { via: 'sync' } });
    expect(await pendingEntries()).toHaveLength(0);
  });

  it('journals when a remote DELETE would erase a diverged local edit', async () => {
    const base = uni({ starterPrompt: 'base' });
    await cj.setSyncBaseHash('universe', 'u-1', cj.contentHashForRecord('universe', base));
    const local = uni({ starterPrompt: 'precious local edit', updatedAt: '2026-05-02T00:00:00Z' });
    const remoteTombstone = uni({ deleted: true, deletedAt: '2026-05-03T00:00:00Z', updatedAt: '2026-05-03T00:00:00Z' });
    await cj.maybeJournalBeforeOverwrite({ kind: 'universe', id: 'u-1', local, remote: remoteTombstone, source: { via: 'sync' } });
    const entries = await pendingEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0].localSnapshot.starterPrompt).toBe('precious local edit');
  });
});
