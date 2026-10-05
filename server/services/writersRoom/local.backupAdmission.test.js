/**
 * Writers Room draft bodies against a backup cut (#9982). A draft body is a
 * `.md` file under `data/` and its hash, word count and version history are a
 * manifest row, so a cut that copies files before it dumps rows must never land
 * between the two writes: it would dump a row for prose its copy missed, or copy
 * prose its dumped row does not describe. These run the real file backend over a
 * temp data root and hold the row write at its commit point.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makePathsProxy } from '../../lib/mockPathsDataRoot.js';

let tempRoot;
let beforeWorkWrite = async () => {};

vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  return makePathsProxy(actual, { dataRoot: () => tempRoot });
});
vi.mock('../../lib/databaseMaintenanceJournal.js', () => ({ assertDatabaseAdmission: () => {} }));
// Pause the manifest row write at its commit point, after the file write before it.
vi.mock('./store.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    writersRoomStore: () => {
      const real = actual.writersRoomStore();
      return { ...real, writeWork: async (manifest) => { await beforeWorkWrite(manifest); return real.writeWork(manifest); } };
    },
  };
});

const { createWork, deleteWork, getWork, saveDraftBody, snapshotDraft, contentHash } = await import('./local.js');
const { wrDraftPath, wrWorkDir, wrWorksDir } = await import('./_shared.js');
const { acquireBackupSnapshotCut } = await import('../../lib/backupSnapshotBoundary.js');

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
const bodyOf = (work, draftId = work.activeDraftVersionId) => readFileSync(wrDraftPath(work.id, draftId), 'utf-8');

beforeEach(() => {
  tempRoot = mkdtempSync(join(tmpdir(), 'wr-backup-admission-'));
  beforeWorkWrite = async () => {};
});
afterEach(() => {
  rmSync(tempRoot, { recursive: true, force: true });
});

/** Start `operation` while a cut is held; it must not change a store until the cut is released. */
async function startDuringCut(operation, assertUntouched) {
  const release = await acquireBackupSnapshotCut();
  let settled = false;
  const pending = operation().then((value) => { settled = true; return value; });
  try {
    await settle();
    expect(settled, 'operation ran during the cut').toBe(false);
    assertUntouched();
  } finally {
    release();
  }
  return pending;
}

describe('Writers Room draft bodies and a backup cut', () => {
  it('drains a cut behind a draft save that replaced the body but has not committed its row', async () => {
    const work = await createWork({ title: 'Example Work' });
    let reachedRow;
    const reached = new Promise((resolve) => { reachedRow = resolve; });
    let finishRow;
    const rowDone = new Promise((resolve) => { finishRow = resolve; });
    beforeWorkWrite = async () => { reachedRow(); await rowDone; };

    const save = saveDraftBody(work.id, 'Fresh prose for the chapter.');
    await reached;
    expect(bodyOf(work)).toBe('Fresh prose for the chapter.');

    let cutReady = false;
    const cut = acquireBackupSnapshotCut().then((release) => { cutReady = true; return release; });
    try {
      await settle();
      expect(cutReady, 'cut acquired between the .md write and its row').toBe(false);
      finishRow();
      const release = await cut;
      // The cut sees the replaced prose AND the row that describes it.
      const stored = await getWork(work.id);
      expect(stored.drafts[0].contentHash).toBe(contentHash('Fresh prose for the chapter.'));
      release();
    } finally {
      finishRow();
      (await cut)();
    }
    await save;
  });

  it('holds a draft save until the cut closes, leaving the old prose and row in the snapshot', async () => {
    const work = await createWork({ title: 'Example Work' });
    await saveDraftBody(work.id, 'Original prose.');
    const saved = await startDuringCut(
      () => saveDraftBody(work.id, 'Replacement prose.'),
      () => expect(bodyOf(work)).toBe('Original prose.'),
    );
    expect(saved.body).toBe('Replacement prose.');
    expect(bodyOf(work)).toBe('Replacement prose.');
    expect((await getWork(work.id)).drafts[0].contentHash).toBe(contentHash('Replacement prose.'));
  });

  it('holds a new version snapshot until the cut closes', async () => {
    const work = await createWork({ title: 'Example Work' });
    await saveDraftBody(work.id, 'Prose to keep.');
    const draftsDir = join(wrWorkDir(work.id), 'drafts');
    const manifest = await startDuringCut(
      () => snapshotDraft(work.id, { label: 'Checkpoint' }),
      () => expect(readdirSync(draftsDir)).toHaveLength(1),
    );
    expect(readdirSync(draftsDir)).toHaveLength(2);
    expect(manifest.drafts).toHaveLength(2);
    expect(bodyOf(work, manifest.activeDraftVersionId)).toBe('Prose to keep.');
  });

  it('holds work creation until the cut closes, so no directory exists without its row', async () => {
    const created = await startDuringCut(
      () => createWork({ title: 'Brand New Work' }),
      () => expect(existsSync(wrWorksDir())).toBe(false),
    );
    expect(bodyOf(created)).toBe('');
    expect((await getWork(created.id)).title).toBe('Brand New Work');
  });

  it('holds the removal of a corrupted work directory until the cut closes', async () => {
    const work = await createWork({ title: 'Broken Work' });
    writeFileSync(join(wrWorkDir(work.id), 'manifest.json'), '{not json');
    await startDuringCut(
      () => deleteWork(work.id),
      () => expect(existsSync(wrDraftPath(work.id, work.activeDraftVersionId))).toBe(true),
    );
    expect(existsSync(wrWorkDir(work.id))).toBe(false);
  });
});
