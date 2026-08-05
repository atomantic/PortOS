/**
 * End-to-end cover for the deleted-document tombstone (#3530): a document the
 * user deletes must stay deleted across a peer sync with a machine that still
 * has it, the delete must PROPAGATE to that machine, and a document re-created
 * after a delete must not be permanently suppressed.
 *
 * Exercises the real disk paths (meta.json + the .md files) with PATHS pointed
 * at a temp dir, so the merge, the file reap, and the add-only write all run.
 */

import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';
import { createTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

// `digital-twin-sync.js` and `digital-twin-helpers.js` both capture
// PATHS.digitalTwin at module load, so the root is fixed for the whole file and
// per-test isolation comes from wiping the dir + the meta cache in beforeEach.
const tempRoot = createTempDataRoot('portos-dt-tombstone-');
const twinDir = join(tempRoot, 'digital-twin');

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makePathsProxy(actual, {
    dataRoot: tempRoot,
    extraOverrides: (root) => ({ digitalTwin: join(root, 'digital-twin') }),
  });
});

const { createDocument, deleteDocument } = await import('./digital-twin-documents.js');
const { loadMeta, saveMeta, cache } = await import('./digital-twin-meta.js');
const { applyDigitalTwinRemote, getDigitalTwinSnapshot } = await import('./digital-twin-sync.js');

const FILENAME = 'CUSTOM_ROUTINE.md';
const CONTENT = '# Custom Routine\n\nExample content.\n';
const docPath = join(twinDir, FILENAME);

const newDoc = () => createDocument({ filename: FILENAME, title: 'Custom Routine', category: 'lifestyle', content: CONTENT });

/** The snapshot a peer that still holds the document would ship. */
const peerSnapshotWithDoc = (meta) => ({
  meta: { ...meta, deletedDocuments: [] },
  documents: { [FILENAME]: CONTENT },
});

beforeEach(async () => {
  rmSync(twinDir, { recursive: true, force: true });
  cache.meta.data = null;
  cache.meta.timestamp = 0;
  await saveMeta({ version: '1.0.0', documents: [], deletedDocuments: [] });
});

afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

describe('digital twin document tombstones (#3530)', () => {
  it('records a tombstone on delete and keeps the document deleted through a peer sync', async () => {
    const created = await newDoc();
    const peer = peerSnapshotWithDoc(await loadMeta());
    expect(existsSync(docPath)).toBe(true);

    expect(await deleteDocument(created.id)).toBe(true);
    const afterDelete = await loadMeta();
    expect(afterDelete.documents.map((d) => d.filename)).not.toContain(FILENAME);
    expect(afterDelete.deletedDocuments.map((t) => t.filename)).toEqual([FILENAME]);
    expect(existsSync(docPath)).toBe(false);

    // The peer still has the document and ships it back — the pre-#3530 bug.
    await applyDigitalTwinRemote(peer);

    const afterSync = await loadMeta();
    expect(afterSync.documents.map((d) => d.filename)).not.toContain(FILENAME);
    expect(existsSync(docPath)).toBe(false);
    // …and it stays deleted on every subsequent cycle, not just the first.
    await applyDigitalTwinRemote(peer);
    expect((await loadMeta()).documents.map((d) => d.filename)).not.toContain(FILENAME);
    expect(existsSync(docPath)).toBe(false);
  });

  it('ships tombstones in the snapshot so peers can see the delete', async () => {
    const created = await newDoc();
    await deleteDocument(created.id);
    const { data } = await getDigitalTwinSnapshot();
    expect(data.meta.deletedDocuments.map((t) => t.filename)).toEqual([FILENAME]);
    expect(Object.keys(data.documents)).not.toContain(FILENAME);
  });

  it('propagates a peer\'s delete: removes the local metadata entry AND the .md file', async () => {
    await newDoc();
    expect(existsSync(docPath)).toBe(true);

    // The peer deleted it after our copy was created.
    const { applied } = await applyDigitalTwinRemote({
      meta: { documents: [], deletedDocuments: [{ filename: FILENAME, deletedAt: new Date(Date.now() + 60_000).toISOString() }] },
      documents: {},
    });

    expect(applied).toBe(true);
    const meta = await loadMeta();
    expect(meta.documents.map((d) => d.filename)).not.toContain(FILENAME);
    expect(meta.deletedDocuments.map((t) => t.filename)).toEqual([FILENAME]);
    expect(existsSync(docPath)).toBe(false);
  });

  it('does not suppress a document re-created after the delete, and drops the stale tombstone', async () => {
    const created = await newDoc();
    await deleteDocument(created.id);
    const staleTombstone = (await loadMeta()).deletedDocuments;
    expect(staleTombstone).toHaveLength(1);

    const recreated = await newDoc();
    expect(recreated.createdAt > staleTombstone[0].deletedAt).toBe(true);
    expect((await loadMeta()).deletedDocuments).toEqual([]);

    // A peer that has not seen the re-create still ships the old tombstone.
    await applyDigitalTwinRemote({ meta: { documents: [], deletedDocuments: staleTombstone }, documents: {} });

    const meta = await loadMeta();
    expect(meta.documents.map((d) => d.filename)).toContain(FILENAME);
    expect(meta.deletedDocuments).toEqual([]);
    expect(existsSync(docPath)).toBe(true);
  });

  it('still accepts a document the peer has that was never deleted here', async () => {
    await applyDigitalTwinRemote({
      meta: { documents: [{ id: 'peer-1', filename: FILENAME, title: 'Custom Routine', category: 'lifestyle' }], deletedDocuments: [] },
      documents: { [FILENAME]: CONTENT },
    });
    expect((await loadMeta()).documents.map((d) => d.filename)).toContain(FILENAME);
    expect(existsSync(docPath)).toBe(true);
  });
});
