/**
 * Writers Room store dispatcher — file-backend behavior (#1017).
 *
 * NODE_ENV=test selects the file backend (the legacy on-disk JSON layout over a
 * real tmpdir), so this exercises the dispatcher WITHOUT a database: the uniform
 * folders/works/exercises surface local.js calls, the manifest-with-drafts[]
 * shape the file backend persists verbatim (no decomposition on this backend),
 * and the corrupted-manifest tolerance the library depends on.
 */

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'wr-store-test-'));

vi.mock('../../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, PATHS: { ...actual.PATHS, data: TEST_DATA_ROOT } };
});

const { writersRoomStore, _resetWritersRoomStore } = await import('./store.js');

const WR = join(TEST_DATA_ROOT, 'writers-room');

const manifest = (id, extra = {}) => ({
  id, title: id, kind: 'short-story', status: 'drafting',
  activeDraftVersionId: 'wr-draft-a',
  drafts: [{ id: 'wr-draft-a', label: 'Draft 1', contentFile: 'drafts/wr-draft-a.md', contentHash: 'h', wordCount: 0, segmentIndex: [], createdAt: '2026-01-01T00:00:00.000Z' }],
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', ...extra,
});

describe('Writers Room store dispatcher — file backend', () => {
  beforeEach(() => {
    rmSync(WR, { recursive: true, force: true });
    _resetWritersRoomStore();
  });
  afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

  it('selects the file backend under NODE_ENV=test', async () => {
    const s = writersRoomStore();
    await s.listFolders();
    expect(s.getBackendName()).toBe('file');
  });

  it('folders round-trip through write/list/delete', async () => {
    const s = writersRoomStore();
    await s.writeFolder({ id: 'wr-folder-1', name: 'A', parentId: null, sortOrder: 0 });
    await s.writeFolder({ id: 'wr-folder-2', name: 'B', parentId: null, sortOrder: 1 });
    expect((await s.listFolders()).map((f) => f.id).sort()).toEqual(['wr-folder-1', 'wr-folder-2']);
    await s.deleteFolder('wr-folder-1');
    expect((await s.listFolders()).map((f) => f.id)).toEqual(['wr-folder-2']);
  });

  it('works persist with their embedded drafts[] (no decomposition on file backend)', async () => {
    const s = writersRoomStore();
    await s.writeWork(manifest('wr-work-1'));
    const back = await s.readWork('wr-work-1');
    expect(back.title).toBe('wr-work-1');
    expect(back.drafts.map((d) => d.id)).toEqual(['wr-draft-a']);
    expect(await s.listWorkIds()).toEqual(['wr-work-1']);
    expect((await s.listWorks()).map((w) => w.id)).toEqual(['wr-work-1']);
  });

  it('readWork returns null for a missing work', async () => {
    const s = writersRoomStore();
    expect(await s.readWork('wr-work-deadbeef')).toBeNull();
  });

  it('listWorks drops a work with a corrupted manifest but keeps the rest', async () => {
    const s = writersRoomStore();
    await s.writeWork(manifest('wr-work-aaa'));
    // Hand-corrupt a second work's manifest on disk.
    const badDir = join(WR, 'works', 'wr-work-bbb');
    mkdirSync(join(badDir, 'drafts'), { recursive: true });
    writeFileSync(join(badDir, 'manifest.json'), '{ not valid json');
    const list = await s.listWorks();
    expect(list.map((w) => w.id)).toEqual(['wr-work-aaa']);
    // A direct read of the corrupted work surfaces CORRUPTED_MANIFEST.
    await expect(s.readWork('wr-work-bbb')).rejects.toMatchObject({ code: 'CORRUPTED_MANIFEST' });
  });

  it('exercises round-trip through write/list', async () => {
    const s = writersRoomStore();
    await s.writeExercise({ id: 'wr-ex-1', workId: 'wr-work-1', status: 'running', startedAt: '2026-01-03T00:00:00.000Z' });
    await s.writeExercise({ id: 'wr-ex-1', workId: 'wr-work-1', status: 'finished', startedAt: '2026-01-03T00:00:00.000Z', finishedAt: '2026-01-03T01:00:00.000Z' });
    const all = await s.listExercises();
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe('finished');
  });

  it('listDraftVersionsForCoherence enumerates every draft across works', async () => {
    const s = writersRoomStore();
    await s.writeWork(manifest('wr-work-1'));
    const coh = await s.listDraftVersionsForCoherence();
    expect(coh.map((c) => c.id)).toEqual(['wr-draft-a']);
    expect(coh[0]).toMatchObject({ workId: 'wr-work-1', contentFile: 'drafts/wr-draft-a.md' });
  });
});
