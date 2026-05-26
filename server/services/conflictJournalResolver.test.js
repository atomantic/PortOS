import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { mockNoPeerSync, mockNoPeers, makePathsProxy } from '../lib/mockPathsDataRoot.js';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'cj-resolver-test-'));

vi.mock('../lib/fileUtils.js', async (importOriginal) =>
  makePathsProxy(await importOriginal(), { dataRoot: TEST_DATA_ROOT }));
vi.mock('./instances.js', () => mockNoPeers());
vi.mock('./sharing/peerSync.js', () => mockNoPeerSync());

let uuidCounter = 0;
vi.mock('crypto', async () => {
  const actual = await vi.importActual('crypto');
  return { ...actual, randomUUID: () => `uuid-${String(++uuidCounter).padStart(8, '0')}` };
});

const resolver = await import('./conflictJournalResolver.js');
const universeSvc = await import('./universeBuilder.js');
const cj = await import('../lib/conflictJournal.js');

afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

// Seed a pending journal entry whose localSnapshot holds the "lost" values.
const seedEntry = async (recordId, localSnapshot) => {
  const id = `entry-${++uuidCounter}`;
  await cj.conflictJournalStore().saveOne(id, {
    id, recordKind: 'universe', recordId, detectedAt: '2026-05-01T00:00:00Z',
    source: { via: 'sync' }, baseHash: 'b', localHash: 'l', remoteHash: 'r',
    localSnapshot, remoteSnapshot: {}, localUpdatedAt: null, remoteUpdatedAt: null,
    diffSummary: [], status: 'pending', resolvedAt: null, resolution: null,
  });
  return id;
};

describe('conflictJournalResolver', () => {
  beforeEach(() => {
    rmSync(TEST_DATA_ROOT, { recursive: true, force: true });
    mkdirSync(TEST_DATA_ROOT, { recursive: true });
    uuidCounter = 0;
    cj.__resetBaseHashCacheForTests();
  });

  it('restore-all re-applies the archived snapshot content (bumps updatedAt)', async () => {
    const u = await universeSvc.createUniverse({ name: 'Clandestiny', starterPrompt: 'REMOTE won' });
    const entryId = await seedEntry(u.id, { id: u.id, name: 'Clandestiny', starterPrompt: 'MY local prompt' });

    const resolved = await resolver.resolveConflict(entryId, { action: 'restore-all' });
    expect(resolved.status).toBe('resolved');
    expect(resolved.resolution).toBe('restore-all');

    const fresh = await universeSvc.getUniverse(u.id);
    expect(fresh.starterPrompt).toBe('MY local prompt');
    expect(fresh.updatedAt >= u.updatedAt).toBe(true);
  });

  it('merge-fields overlays only the chosen fields onto the current record', async () => {
    const u = await universeSvc.createUniverse({ name: 'Keep', starterPrompt: 'REMOTE prompt', logline: 'remote logline' });
    const entryId = await seedEntry(u.id, { id: u.id, name: 'Keep', starterPrompt: 'local prompt', logline: 'local logline' });

    await resolver.resolveConflict(entryId, { action: 'merge-fields', fields: ['logline'] });
    const fresh = await universeSvc.getUniverse(u.id);
    expect(fresh.logline).toBe('local logline');  // overlaid
    expect(fresh.starterPrompt).toBe('REMOTE prompt'); // untouched
  });

  it('merge-fields rejects fields outside the restorable allowlist', async () => {
    const u = await universeSvc.createUniverse({ name: 'X' });
    const entryId = await seedEntry(u.id, { id: u.id, name: 'X' });
    await expect(resolver.resolveConflict(entryId, { action: 'merge-fields', fields: ['id'] }))
      .rejects.toMatchObject({ code: resolver.ERR_VALIDATION });
  });

  it('discard marks resolved without touching the record', async () => {
    const u = await universeSvc.createUniverse({ name: 'X', starterPrompt: 'REMOTE' });
    const entryId = await seedEntry(u.id, { id: u.id, name: 'X', starterPrompt: 'local' });
    await resolver.resolveConflict(entryId, { action: 'discard' });
    expect((await universeSvc.getUniverse(u.id)).starterPrompt).toBe('REMOTE');
    expect((await resolver.getConflict(entryId)).status).toBe('resolved');
  });

  it('re-resolving an already-resolved entry fails', async () => {
    const u = await universeSvc.createUniverse({ name: 'X' });
    const entryId = await seedEntry(u.id, { id: u.id, name: 'X' });
    await resolver.resolveConflict(entryId, { action: 'discard' });
    await expect(resolver.resolveConflict(entryId, { action: 'discard' }))
      .rejects.toMatchObject({ code: resolver.ERR_VALIDATION });
  });

  it('listConflicts filters by status; deleteConflict removes the entry', async () => {
    const u = await universeSvc.createUniverse({ name: 'X' });
    const e1 = await seedEntry(u.id, { id: u.id, name: 'X' });
    expect(await resolver.listConflicts({ status: 'pending' })).toHaveLength(1);
    await resolver.deleteConflict(e1);
    expect(await resolver.listConflicts()).toHaveLength(0);
    await expect(resolver.getConflict(e1)).rejects.toMatchObject({ code: resolver.ERR_NOT_FOUND });
  });
});
