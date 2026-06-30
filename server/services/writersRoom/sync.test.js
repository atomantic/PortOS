/**
 * Writers Room federation facade (#1565) — file-backend round-trip.
 *
 * Mirrors creativeDirector/projectsFile.test.js: runs against a tmpdir in the
 * normal (non-DB) suite so it covers the work-specific sync side effects without
 * Postgres — LWW merge (insert / older-loses / newer-wins), soft-delete
 * tombstone (dropped from live reads, surfaced to federation), tombstone hard-
 * prune (the .md dir + base hash gone), and the file-primary draft-body manifest
 * build + receiver diff. The PostgreSQL backend shares the same `mergeWorkRecord`
 * decision (db.js), so its gated round-trip doesn't need to re-pin these.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'wr-sync-test-'));

vi.mock('../../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, PATHS: { ...actual.PATHS, data: TEST_DATA_ROOT } };
});

const sync = await import('./sync.js');
const { writersRoomStore, _resetWritersRoomStore } = await import('./store.js');
const cj = await import('../../lib/conflictJournal.js');
const { wrWorkDir, wrDraftPath } = await import('./_shared.js');

const WR = join(TEST_DATA_ROOT, 'writers-room');
const WORK = 'wr-work-11111111-1111-1111-1111-111111111111';
const DRAFT = 'wr-draft-22222222-2222-2222-2222-222222222222';

const work = (extra = {}) => ({
  id: WORK,
  title: 'A Tale',
  kind: 'short-story',
  status: 'drafting',
  activeDraftVersionId: DRAFT,
  drafts: [{ id: DRAFT, label: 'Draft 1', contentFile: `drafts/${DRAFT}.md`, contentHash: 'h', wordCount: 3, segmentIndex: [], createdAt: '2026-01-01T00:00:00.000Z' }],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-02T00:00:00.000Z',
  ...extra,
});

function writeBody(text) {
  mkdirSync(join(wrWorkDir(WORK), 'drafts'), { recursive: true });
  writeFileSync(wrDraftPath(WORK, DRAFT), text);
}

describe('Writers Room federation facade — file backend', () => {
  beforeEach(() => {
    rmSync(WR, { recursive: true, force: true });
    _resetWritersRoomStore();
    cj.__resetBaseHashCacheForTests();
  });
  afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

  it('inserts a remote work and seeds its base hash', async () => {
    const res = await sync.mergeWorksFromSync([work()]);
    expect(res).toEqual({ applied: true, count: 1 });
    const got = await sync.getWorkForSync(WORK);
    expect(got.title).toBe('A Tale');
    expect(got.drafts).toHaveLength(1);
  });

  it('LWW: older remote loses, newer wins', async () => {
    await sync.mergeWorksFromSync([work({ updatedAt: '2026-01-02T00:00:00.000Z', title: 'Local' })]);
    const older = await sync.mergeWorksFromSync([work({ updatedAt: '2026-01-01T00:00:00.000Z', title: 'Older' })]);
    expect(older).toEqual({ applied: false, count: 0 });
    expect((await sync.getWorkForSync(WORK)).title).toBe('Local');
    const newer = await sync.mergeWorksFromSync([work({ updatedAt: '2026-01-03T00:00:00.000Z', title: 'Newer' })]);
    expect(newer).toEqual({ applied: true, count: 1 });
    expect((await sync.getWorkForSync(WORK)).title).toBe('Newer');
  });

  it('a newer tombstone overwrites a live local and hides it from live reads', async () => {
    await sync.mergeWorksFromSync([work({ updatedAt: '2026-01-02T00:00:00.000Z' })]);
    await sync.mergeWorksFromSync([work({ updatedAt: '2026-01-05T00:00:00.000Z', deleted: true, deletedAt: '2026-01-05T00:00:00.000Z' })]);
    expect(await writersRoomStore().readWork(WORK)).toBeNull(); // live read filters it
    const tomb = await sync.getWorkForSync(WORK);
    expect(tomb.deleted).toBe(true);
    expect((await writersRoomStore().listWorkIds())).not.toContain(WORK); // live-only listing
    expect((await sync.listWorkIdsForSync({ includeDeleted: true }))).toContain(WORK);
  });

  it('pruneTombstonedWorks rm\'s the dir for an old tombstone and leaves a fresh one', async () => {
    await sync.mergeWorksFromSync([work({ updatedAt: '2026-01-05T00:00:00.000Z', deleted: true, deletedAt: '2026-01-05T00:00:00.000Z' })]);
    expect(existsSync(wrWorkDir(WORK))).toBe(true);
    // Cutoff before the tombstone → not pruned.
    expect(await sync.pruneTombstonedWorks(Date.parse('2026-01-04T00:00:00.000Z'))).toEqual({ pruned: 0 });
    expect(existsSync(wrWorkDir(WORK))).toBe(true);
    // Cutoff after the tombstone → pruned + dir gone.
    expect(await sync.pruneTombstonedWorks(Date.parse('2026-02-01T00:00:00.000Z'))).toEqual({ pruned: 1 });
    expect(existsSync(wrWorkDir(WORK))).toBe(false);
    expect(await sync.getWorkForSync(WORK)).toBeNull();
  });

  it('builds a draft-body manifest from the on-disk .md and diffs it against local', async () => {
    writeBody('Once upon a time.');
    const manifest = await sync.buildWorkBodyManifest(work());
    expect(manifest).toHaveLength(1);
    expect(manifest[0]).toMatchObject({ kind: 'writers-room-draft', workId: WORK, draftId: DRAFT });
    expect(typeof manifest[0].sha256).toBe('string');

    // Identical hash → nothing missing (present + match, regardless of the gate).
    expect(await sync.diffWorkBodyManifest(manifest)).toEqual([]);
    expect(await sync.diffWorkBodyManifest(manifest, { includeMismatched: true })).toEqual([]);

    // Present-but-different local body:
    const stale = [{ ...manifest[0], sha256: 'f'.repeat(64) }];
    const expected = stale.map((e) => ({ kind: e.kind, workId: e.workId, draftId: e.draftId, sha256: e.sha256 }));
    // …default (the work merge did NOT accept the remote) → NOT pulled, so a
    // stale push can't clobber the newer local prose.
    expect(await sync.diffWorkBodyManifest(stale)).toEqual([]);
    // …includeMismatched (remote won the record merge) → pulled to overwrite.
    expect(await sync.diffWorkBodyManifest(stale, { includeMismatched: true })).toEqual(expected);
  });

  it('diffWorkBodyManifest reports an absent local body as missing and rejects bad ids', async () => {
    const entry = { kind: 'writers-room-draft', workId: WORK, draftId: DRAFT, sha256: 'a'.repeat(64) };
    expect(await sync.diffWorkBodyManifest([entry])).toEqual([entry]); // no .md on disk
    // Path-traversal / malformed ids never reach an FS op.
    expect(await sync.diffWorkBodyManifest([{ ...entry, workId: '../etc' }])).toEqual([]);
    expect(await sync.diffWorkBodyManifest([{ ...entry, draftId: 'x/../y' }])).toEqual([]);
  });
});

// ---------- folders + exercises (body-less records, #1645) ----------

const FOLDER = 'wr-folder-44444444-4444-4444-4444-444444444444';
const EXERCISE = 'wr-ex-55555555-5555-5555-5555-555555555555';
const folder = (extra = {}) => ({
  id: FOLDER, name: 'Drafts', parentId: null, sortOrder: 0,
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', ...extra,
});
const exercise = (extra = {}) => ({
  id: EXERCISE, workId: null, prompt: 'Write fast', durationSeconds: 600,
  startingWords: 0, endingWords: null, wordsAdded: null, appendedText: null,
  status: 'running', startedAt: '2026-01-01T00:00:00.000Z', finishedAt: null, ...extra,
});

describe('Writers Room folder federation facade — file backend', () => {
  beforeEach(() => {
    rmSync(WR, { recursive: true, force: true });
    _resetWritersRoomStore();
    cj.__resetBaseHashCacheForTests();
  });
  afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

  it('inserts a remote folder; LWW older-loses / newer-wins', async () => {
    expect(await sync.mergeFoldersFromSync([folder()])).toEqual({ applied: true, count: 1 });
    expect((await sync.getFolderForSync(FOLDER)).name).toBe('Drafts');
    expect(await sync.mergeFoldersFromSync([folder({ updatedAt: '2026-01-01T00:00:00.000Z', name: 'Older' })])).toEqual({ applied: false, count: 0 });
    expect(await sync.mergeFoldersFromSync([folder({ updatedAt: '2026-01-03T00:00:00.000Z', name: 'Newer' })])).toEqual({ applied: true, count: 1 });
    expect((await sync.getFolderForSync(FOLDER)).name).toBe('Newer');
  });

  it('a newer tombstone hides the folder from live reads and prunes after the cutoff', async () => {
    await sync.mergeFoldersFromSync([folder({ updatedAt: '2026-01-02T00:00:00.000Z' })]);
    await sync.mergeFoldersFromSync([folder({ updatedAt: '2026-01-05T00:00:00.000Z', deleted: true, deletedAt: '2026-01-05T00:00:00.000Z' })]);
    expect(await writersRoomStore().readFolder(FOLDER)).toBeNull(); // live read filters it
    expect((await sync.listFolderIdsForSync())).not.toContain(FOLDER);
    expect((await sync.listFolderIdsForSync({ includeDeleted: true }))).toContain(FOLDER);
    expect(await sync.pruneTombstonedFolders(Date.parse('2026-01-04T00:00:00.000Z'))).toEqual({ pruned: 0 });
    expect(await sync.pruneTombstonedFolders(Date.parse('2026-02-01T00:00:00.000Z'))).toEqual({ pruned: 1 });
    expect(await sync.getFolderForSync(FOLDER)).toBeNull();
  });
});

describe('Writers Room exercise federation facade — file backend', () => {
  beforeEach(() => {
    rmSync(WR, { recursive: true, force: true });
    _resetWritersRoomStore();
    cj.__resetBaseHashCacheForTests();
  });
  afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

  it('inserts a remote exercise; the finish transition (finishedAt advances) wins LWW', async () => {
    expect(await sync.mergeExercisesFromSync([exercise()])).toEqual({ applied: true, count: 1 });
    // listExercisesForSync derives updatedAt from finishedAt ?? startedAt.
    expect((await sync.listExercisesForSync()).find((e) => e.id === EXERCISE).updatedAt).toBe('2026-01-01T00:00:00.000Z');
    const finished = await sync.mergeExercisesFromSync([exercise({ status: 'finished', finishedAt: '2026-01-01T00:10:00.000Z', wordsAdded: 42 })]);
    expect(finished).toEqual({ applied: true, count: 1 });
    expect((await sync.getExerciseForSync(EXERCISE)).status).toBe('finished');
  });

  it('an older exercise push loses LWW against the finished local', async () => {
    await sync.mergeExercisesFromSync([exercise({ status: 'finished', finishedAt: '2026-01-01T00:10:00.000Z' })]);
    // A stale "running" push (older derived key) must not resurrect the running state.
    expect(await sync.mergeExercisesFromSync([exercise()])).toEqual({ applied: false, count: 0 });
    expect((await sync.getExerciseForSync(EXERCISE)).status).toBe('finished');
  });
});
