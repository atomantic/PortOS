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
const collSvc = await import('./mediaCollections.js');
const issueSvc = await import('./pipeline/issues.js');
const cj = await import('../lib/conflictJournal.js');

afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

// Seed a pending journal entry whose localSnapshot holds the "lost" values.
const seedEntry = async (recordId, localSnapshot, recordKind = 'universe') => {
  const id = `entry-${++uuidCounter}`;
  await cj.conflictJournalStore().saveOne(id, {
    id, recordKind, recordId, detectedAt: '2026-05-01T00:00:00Z',
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

  it('restore-all REPLACES universe categories wholesale — a category the live record gained since the conflict is dropped', async () => {
    const u = await universeSvc.createUniverse({ name: 'Cats' });
    // Post-conflict, the live record gained a custom category the snapshot never had.
    await universeSvc.updateUniverse(u.id, { categories: { gadgets: { variations: [{ label: 'Ray', prompt: 'a ray gun' }] } } });
    expect((await universeSvc.getUniverse(u.id)).categories.gadgets).toBeTruthy();
    const entryId = await seedEntry(u.id, {
      id: u.id, name: 'Cats',
      categories: { landscapes: { variations: [{ label: 'Hill', prompt: 'a green hill' }] } },
    });

    await resolver.resolveConflict(entryId, { action: 'restore-all' });
    const fresh = await universeSvc.getUniverse(u.id);
    expect(fresh.categories.gadgets).toBeUndefined();               // faithful replace dropped the live-only category
    expect(fresh.categories.landscapes.variations).toHaveLength(1);  // the snapshot's category landed
  });

  it('merge-fields KEEPS a live-only category (additive overlay, not a replace)', async () => {
    const u = await universeSvc.createUniverse({ name: 'Cats2' });
    await universeSvc.updateUniverse(u.id, { categories: { gadgets: { variations: [{ label: 'Ray', prompt: 'a ray gun' }] } } });
    const entryId = await seedEntry(u.id, {
      id: u.id, name: 'Cats2',
      categories: { landscapes: { variations: [{ label: 'Hill', prompt: 'a green hill' }] } },
    });

    await resolver.resolveConflict(entryId, { action: 'merge-fields', fields: ['categories'] });
    const fresh = await universeSvc.getUniverse(u.id);
    expect(fresh.categories.gadgets).toBeTruthy();                   // additive: live-only category preserved
    expect(fresh.categories.landscapes.variations).toHaveLength(1);  // snapshot's category merged in
  });

  it('restore-all re-applies an archived ISSUE snapshot (title + prose stage)', async () => {
    const issue = await issueSvc.createIssue({ seriesId: 'ser-restore', title: 'Remote Title' });
    // Remote LWW-overwrote both the title and the prose output.
    await issueSvc.updateIssue(issue.id, { title: 'Remote Title', stages: { prose: { status: 'ready', output: 'REMOTE prose' } } });
    const entryId = await seedEntry(
      issue.id,
      { id: issue.id, seriesId: 'ser-restore', title: 'MY Title', stages: { prose: { status: 'ready', output: 'MY prose' } } },
      'issue',
    );

    const resolved = await resolver.resolveConflict(entryId, { action: 'restore-all' });
    expect(resolved.status).toBe('resolved');

    const fresh = await issueSvc.getIssue(issue.id);
    expect(fresh.title).toBe('MY Title');
    expect(fresh.stages.prose.output).toBe('MY prose');
  });

  it('issue restore-all overwrites a stage value the live record gained since the conflict (faithful without a replace flag)', async () => {
    const issue = await issueSvc.createIssue({ seriesId: 'ser-faithful', title: 'T' });
    // Post-conflict, the live record gained prose content the snapshot never had.
    await issueSvc.updateIssue(issue.id, { stages: { prose: { status: 'ready', output: 'live-added prose' } } });
    expect((await issueSvc.getIssue(issue.id)).stages.prose.output).toBe('live-added prose');
    // The archived snapshot's prose was empty (the user's version had no prose).
    const entryId = await seedEntry(
      issue.id,
      { id: issue.id, seriesId: 'ser-faithful', title: 'T', stages: { prose: { status: 'draft', output: '' } } },
      'issue',
    );
    await resolver.resolveConflict(entryId, { action: 'restore-all' });
    // The snapshot's empty prose overwrote the live addition — the closed stage-id
    // set makes the per-key overlay equivalent to a wholesale replace, so issue
    // stages need no replaceStages flag (unlike universe categories' open key set).
    expect((await issueSvc.getIssue(issue.id)).stages.prose.output).toBe('');
  });

  it('issue merge-fields overlays only the chosen field; unsupported kind is rejected', async () => {
    const issue = await issueSvc.createIssue({ seriesId: 'ser-merge', title: 'Keep Title' });
    await issueSvc.updateIssue(issue.id, { stages: { prose: { status: 'ready', output: 'REMOTE prose' } } });
    const entryId = await seedEntry(
      issue.id,
      { id: issue.id, seriesId: 'ser-merge', title: 'IGNORED local title', stages: { prose: { status: 'ready', output: 'MY prose' } } },
      'issue',
    );
    await resolver.resolveConflict(entryId, { action: 'merge-fields', fields: ['stages'] });
    const fresh = await issueSvc.getIssue(issue.id);
    expect(fresh.stages.prose.output).toBe('MY prose'); // overlaid
    expect(fresh.title).toBe('Keep Title');             // untouched

    // `number` is server-owned — not in RESTORABLE_FIELDS.issue, so it's rejected.
    const e2 = await seedEntry(issue.id, { id: issue.id, number: 99 }, 'issue');
    await expect(resolver.resolveConflict(e2, { action: 'merge-fields', fields: ['number'] }))
      .rejects.toMatchObject({ code: resolver.ERR_VALIDATION });
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

  it('translates a deleted target record into ERR_TARGET_GONE (not the raw NOT_FOUND)', async () => {
    // Entry points at a universe id that no longer exists (tombstoned between
    // archive and resolution). updateUniverse throws NOT_FOUND; the resolver
    // must surface ERR_TARGET_GONE so the route maps it to 409, not 500.
    const entryId = await seedEntry('does-not-exist', { id: 'does-not-exist', name: 'Ghost', starterPrompt: 'local' });
    await expect(resolver.resolveConflict(entryId, { action: 'restore-all' }))
      .rejects.toMatchObject({ code: resolver.ERR_TARGET_GONE });
  });

  it('listConflicts filters by status; deleteConflict removes the entry', async () => {
    const u = await universeSvc.createUniverse({ name: 'X' });
    const e1 = await seedEntry(u.id, { id: u.id, name: 'X' });
    expect(await resolver.listConflicts({ status: 'pending' })).toHaveLength(1);
    await resolver.deleteConflict(e1);
    expect(await resolver.listConflicts()).toHaveLength(0);
    await expect(resolver.getConflict(e1)).rejects.toMatchObject({ code: resolver.ERR_NOT_FOUND });
  });

  it('deleteConflict rejects a path-traversal id without probing the filesystem', async () => {
    await expect(resolver.deleteConflict('../../etc/passwd')).rejects.toMatchObject({ code: resolver.ERR_NOT_FOUND });
    await expect(resolver.deleteConflict('..')).rejects.toMatchObject({ code: resolver.ERR_NOT_FOUND });
  });

  // --- mediaCollection conflicts ---

  const seedCollectionEntry = async (recordId, localSnapshot) => {
    const id = `entry-${++uuidCounter}`;
    await cj.conflictJournalStore().saveOne(id, {
      id, recordKind: 'mediaCollection', recordId, detectedAt: '2026-05-01T00:00:00Z',
      source: { via: 'sync' }, baseHash: 'b', localHash: 'l', remoteHash: 'r',
      localSnapshot, remoteSnapshot: {}, localUpdatedAt: null, remoteUpdatedAt: null,
      diffSummary: [], status: 'pending', resolvedAt: null, resolution: null,
    });
    return id;
  };

  it('restore-all re-applies a STANDALONE collection’s archived scalars (name, description)', async () => {
    const c = await collSvc.createCollection({ name: 'Remote Name', description: 'remote desc' });
    const entryId = await seedCollectionEntry(c.id, { id: c.id, name: 'Local Name', description: 'local desc', coverKey: null });
    await resolver.resolveConflict(entryId, { action: 'restore-all' });
    const fresh = await collSvc.getCollection(c.id);
    expect(fresh.name).toBe('Local Name');      // standalone → name restorable
    expect(fresh.description).toBe('local desc');
  });

  it('restore-all on a LINKED collection skips the locked name but applies description', async () => {
    const u = await universeSvc.createUniverse({ name: 'Verse' });
    const c = await collSvc.findOrCreateUniverseCollection({ universeId: u.id, universeName: 'Verse', description: 'remote desc' });
    const ownerName = c.name; // universe-derived, locked
    const entryId = await seedCollectionEntry(c.id, { id: c.id, name: 'Stale Name', description: 'local desc', coverKey: null });
    // Must NOT throw on the locked name — name is dropped, description applies.
    await resolver.resolveConflict(entryId, { action: 'restore-all' });
    const fresh = await collSvc.getCollection(c.id);
    expect(fresh.name).toBe(ownerName);          // unchanged (locked to universe)
    expect(fresh.description).toBe('local desc'); // freely-editable scalar restored
  });

  it('translates a deleted collection target into ERR_TARGET_GONE', async () => {
    const entryId = await seedCollectionEntry('ghost-collection', { id: 'ghost-collection', name: 'Ghost', description: 'x', coverKey: null });
    await expect(resolver.resolveConflict(entryId, { action: 'restore-all' }))
      .rejects.toMatchObject({ code: resolver.ERR_TARGET_GONE });
  });
});
