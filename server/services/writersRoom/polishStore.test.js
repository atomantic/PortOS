import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { vi } from 'vitest';
import { makePathsProxy } from '../../lib/mockPathsDataRoot.js';

let tempRoot;

vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  return makePathsProxy(actual, { dataRoot: () => tempRoot });
});

const local = await import('./local.js');
const store = await import('./polishStore.js');
const { createWork, saveDraftBody, getWorkWithBody } = local;
const {
  writeSnapshot, readSnapshotBody, listSnapshots, appendPolishRun,
  getPolishHistory, revertToSnapshot, loadPolishIndex,
} = store;

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'wr-polish-test-'));
});

afterEach(() => {
  if (tempRoot && existsSync(tempRoot)) rmSync(tempRoot, { recursive: true, force: true });
});

async function newWork(body = 'Original prose body.') {
  const w = await createWork({ title: 'Test Work', kind: 'short-story' });
  await saveDraftBody(w.id, body);
  return w.id;
}

describe('polish snapshot store', () => {
  it('an empty work has an empty polish index', async () => {
    const id = await newWork();
    expect(await loadPolishIndex(id)).toEqual({ snapshots: [], runs: [] });
    expect(await listSnapshots(id)).toEqual([]);
  });

  it('writes an immutable snapshot and reads its body back (round-trip)', async () => {
    const id = await newWork();
    const meta = await writeSnapshot(id, { body: 'Snapshot A body', label: 'Pre-polish', score: 92 });
    expect(meta.id).toMatch(/^wr-snap-/);
    expect(meta.label).toBe('Pre-polish');
    expect(meta.score).toBe(92);
    expect(meta.wordCount).toBe(3);
    expect(await readSnapshotBody(id, meta.id)).toBe('Snapshot A body');
  });

  it('lists snapshots newest-first', async () => {
    const id = await newWork();
    const a = await writeSnapshot(id, { body: 'a', label: 'first' });
    // Force a distinct createdAt so the sort is deterministic.
    await new Promise((r) => setTimeout(r, 5));
    const b = await writeSnapshot(id, { body: 'b', label: 'second' });
    const list = await listSnapshots(id);
    expect(list.map((s) => s.id)).toEqual([b.id, a.id]);
  });

  it('rejects reading an unknown snapshot id', async () => {
    const id = await newWork();
    await expect(readSnapshotBody(id, 'wr-snap-does-not-exist')).rejects.toThrow(/not found/i);
  });

  it('rejects a path-traversal-shaped work id', async () => {
    await expect(writeSnapshot('../../etc', { body: 'x' })).rejects.toThrow(/work id/i);
  });

  it('revert restores a snapshot body into the active draft (round-trip)', async () => {
    const id = await newWork('First body.');
    const snap = await writeSnapshot(id, { body: 'Reverted body content.', label: 'baseline' });

    // Draft moves on...
    await saveDraftBody(id, 'A totally different later draft.');
    expect((await getWorkWithBody(id)).body).toBe('A totally different later draft.');

    // ...then revert pulls the snapshot back into the active draft.
    const { body } = await revertToSnapshot(id, snap.id);
    expect(body).toBe('Reverted body content.');
    expect((await getWorkWithBody(id)).body).toBe('Reverted body content.');
  });

  it('appends run history (metadata only) and returns it newest-first', async () => {
    const id = await newWork();
    await appendPolishRun(id, { id: 'run-1', startedAt: '2026-01-01T00:00:00Z', status: 'complete', cycles: [] });
    await appendPolishRun(id, { id: 'run-2', startedAt: '2026-01-02T00:00:00Z', status: 'complete', cycles: [] });
    const history = await getPolishHistory(id);
    expect(history.runs.map((r) => r.id)).toEqual(['run-2', 'run-1']);
  });

  it('caps retained snapshots and prunes the oldest .md bodies', async () => {
    const id = await newWork();
    // MAX_SNAPSHOTS is 50 — write 55 and confirm only the newest 50 survive.
    let firstId;
    for (let i = 0; i < 55; i += 1) {
      const m = await writeSnapshot(id, { body: `body ${i}`, label: `s${i}` });
      if (i === 0) firstId = m.id;
    }
    const index = await loadPolishIndex(id);
    expect(index.snapshots.length).toBe(50);
    // The oldest snapshot was pruned (index + body).
    expect(index.snapshots.some((s) => s.id === firstId)).toBe(false);
    await expect(readSnapshotBody(id, firstId)).rejects.toThrow(/not found/i);
  });
});
