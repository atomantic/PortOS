/**
 * End-to-end cover for the deleted-document tombstone (#3530): a document the
 * user deletes must stay deleted across a peer sync with a machine that still
 * has it, the delete must PROPAGATE to that machine, and a document re-created
 * after a delete must not be permanently suppressed.
 *
 * Exercises the real disk paths (meta.json + the .md files) with PATHS pointed
 * at a temp dir, so the merge, the file reap, and the add-only write all run.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { existsSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { createTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

// `digital-twin-sync.js` and `digital-twin-helpers.js` both capture
// PATHS.digitalTwin at module load, so the root is fixed for the whole file and
// per-test isolation comes from wiping the dir + the meta cache in beforeEach.
const tempRoot = createTempDataRoot('portos-dt-tombstone-');
const twinDir = join(tempRoot, 'digital-twin');

// Lets a test pause a write after its bytes land (see the snapshot pairing test).
let afterAtomicWrite = null;
vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  const atomicWrite = async (path, ...rest) => {
    const result = await actual.atomicWrite(path, ...rest);
    if (afterAtomicWrite) await afterAtomicWrite(path);
    return result;
  };
  return makePathsProxy(actual, { dataRoot: tempRoot, overrides: { atomicWrite } });
});

const { createDocument, updateDocument, deleteDocument } = await import('./digital-twin-documents.js');
const { ensureDocumentInMeta } = await import('./digital-twin-helpers.js');
const { loadMeta, saveMeta, cache, digitalTwinEvents } = await import('./digital-twin-meta.js');
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
  afterAtomicWrite = null;
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

  it('keeps a document edited here after another machine deleted it', async () => {
    const created = await newDoc();
    await updateDocument(created.id, { content: `${CONTENT}\nEdited.\n` });
    const edited = (await loadMeta()).documents.find((d) => d.filename === FILENAME);
    expect(edited.updatedAt).toBeTruthy();

    // The peer's delete predates our edit, so the edit is the user's last word.
    const deletedAt = new Date(Date.parse(edited.updatedAt) - 1_000).toISOString();
    await applyDigitalTwinRemote({ meta: { documents: [], deletedDocuments: [{ filename: FILENAME, deletedAt }] }, documents: {} });

    const meta = await loadMeta();
    expect(meta.documents.map((d) => d.filename)).toContain(FILENAME);
    expect(meta.deletedDocuments).toEqual([]);
    expect(existsSync(docPath)).toBe(true);
  });

  it('re-registering an enrichment target clears a tombstone the peer merged in', async () => {
    const meta = await loadMeta();
    meta.documents.push({ id: 'x', filename: 'MEMORIES.md', title: 'Memories', category: 'enrichment', enabled: true, priority: 30 });
    meta.deletedDocuments = [{ filename: 'MEMORIES.md', deletedAt: new Date().toISOString() }];
    await saveMeta(meta);

    ensureDocumentInMeta(meta, 'MEMORIES.md', 'Memories', 'enrichment');
    expect(meta.deletedDocuments).toEqual([]);
    expect(meta.documents.find((d) => d.filename === 'MEMORIES.md').createdAt).toBeTruthy();
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

it('invalidates only after synchronized document files are available', async () => {
  const observed = [];
  const listener = () => observed.push(existsSync(docPath));
  digitalTwinEvents.on('sync:completed', listener);
  try {
    await applyDigitalTwinRemote({
      meta: { ...(await loadMeta()), documents: [{ id: 'remote-example', filename: FILENAME, title: 'Example', enabled: true }] },
      documents: { [FILENAME]: CONTENT },
    });
    expect(observed).toEqual([true]);
    await applyDigitalTwinRemote({ documents: { [FILENAME]: CONTENT } });
    expect(observed).toEqual([true]);
  } finally {
    digitalTwinEvents.off('sync:completed', listener);
  }
});

describe('digital twin document create failure paths (#11681)', () => {
  const metaPath = join(twinDir, 'meta.json');

  it.each([
    { name: 'new file', orphan: false },
    { name: 'pre-existing orphan', orphan: true },
  ])('retries a $name after a failed metadata write without leaking cached changes', async ({ orphan }) => {
    // Keep cache expiry from hiding an immediate retry's stale-state regression.
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    try {
      await saveMeta({ ...(await loadMeta()), deletedDocuments: [
        { filename: FILENAME, deletedAt: new Date(Date.now() - 60_000).toISOString() },
      ] });
      const before = structuredClone(await loadMeta());
      const persisted = readFileSync(metaPath, 'utf-8');
      if (orphan) writeFileSync(docPath, 'orphan');
      // A directory at the meta path makes the real metadata write fail.
      rmSync(metaPath, { force: true });
      mkdirSync(metaPath);
      await expect(newDoc()).rejects.toThrow();
      expect(existsSync(docPath)).toBe(orphan);
      expect(await loadMeta()).toEqual(before);

      // Repair I/O without resetting the cache, as an immediate user retry would.
      rmSync(metaPath, { recursive: true, force: true });
      writeFileSync(metaPath, persisted);
      const created = await newDoc();
      const saved = JSON.parse(readFileSync(metaPath, 'utf-8'));
      expect(saved.documents).toEqual([expect.objectContaining({ id: created.id, filename: FILENAME })]);
      expect(saved.deletedDocuments).toEqual([]);
      expect(readFileSync(docPath, 'utf-8')).toBe(CONTENT);
    } finally {
      clock.mockRestore();
    }
  });

  it('adopts an orphan file that has no meta entry', async () => {
    writeFileSync(docPath, 'orphan');
    const created = await newDoc();
    expect(readFileSync(docPath, 'utf-8')).toBe(CONTENT);
    expect((await loadMeta()).documents.map(d => d.id)).toContain(created.id);
  });

  it('still rejects a filename that is already in meta', async () => {
    await newDoc();
    await expect(newDoc()).rejects.toThrow(/already exists/);
  });
});

describe('newer peer document text replaces an existing file (#14160)', () => {
  const EDITED = '# Custom Routine\n\nEdited on the peer.\n';
  const at = (base, offsetMs) => new Date(Date.parse(base) + offsetMs).toISOString();
  const localEntry = async () => (await loadMeta()).documents.find((d) => d.filename === FILENAME);
  const peerEdit = (stamp, body = EDITED) => ({
    meta: { documents: [{ id: 'peer-1', filename: FILENAME, title: 'Custom Routine', category: 'lifestyle', updatedAt: stamp }], deletedDocuments: [] },
    documents: { [FILENAME]: body },
  });

  it('writes the peer body and adopts its stamp when the peer edit is newer', async () => {
    const created = await newDoc();
    const stamp = at(created.createdAt, 60_000);
    await applyDigitalTwinRemote(peerEdit(stamp));
    expect(readFileSync(docPath, 'utf-8')).toBe(EDITED);
    expect((await localEntry()).updatedAt).toBe(stamp);
  });

  it.each([
    { name: 'older', offsetMs: -60_000 },
    { name: 'equal', offsetMs: 0 },
  ])('keeps the local body when the peer stamp is $name', async ({ offsetMs }) => {
    const created = await newDoc();
    await updateDocument(created.id, { content: CONTENT });
    const { updatedAt } = await localEntry();
    await applyDigitalTwinRemote(peerEdit(at(updatedAt, offsetMs)));
    expect(readFileSync(docPath, 'utf-8')).toBe(CONTENT);
    expect((await localEntry()).updatedAt).toBe(updatedAt);
  });

  it('never blanks a local file from a newer stamp with no body', async () => {
    const created = await newDoc();
    const stamp = at(created.createdAt, 60_000);
    await applyDigitalTwinRemote({ meta: peerEdit(stamp).meta });
    await applyDigitalTwinRemote(peerEdit(stamp, ''));
    expect(readFileSync(docPath, 'utf-8')).toBe(CONTENT);
  });

  it('puts the previous body back when the metadata write fails', async () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now());
    const metaPath = join(twinDir, 'meta.json');
    try {
      const created = await newDoc();
      rmSync(metaPath, { force: true });
      mkdirSync(metaPath);
      await expect(applyDigitalTwinRemote(peerEdit(at(created.createdAt, 60_000)))).rejects.toThrow();
      expect(readFileSync(docPath, 'utf-8')).toBe(CONTENT);
    } finally {
      rmSync(metaPath, { recursive: true, force: true });
      clock.mockRestore();
    }
  });

  it('snapshots a document mid-edit with a matching stamp and body', async () => {
    const created = await newDoc();
    let bodyWritten;
    const bodyLanded = new Promise((resolve) => { bodyWritten = resolve; });
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    afterAtomicWrite = async (path) => {
      if (path !== docPath) return;
      afterAtomicWrite = null;
      bodyWritten();
      await held;
    };
    const update = updateDocument(created.id, { content: EDITED });
    await bodyLanded;
    const snapshot = getDigitalTwinSnapshot();
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await update;
    const { data } = await snapshot;
    const entry = data.meta.documents.find((d) => d.filename === FILENAME);
    expect(data.documents[FILENAME]).toBe(EDITED);
    expect(entry.updatedAt).toBe((await localEntry()).updatedAt);
  });

  it('stamps an enrichment rewrite of an existing document so an older peer edit cannot replace it', () => {
    const meta = { documents: [{ id: 'x', filename: 'MEMORIES.md', title: 'Memories', createdAt: '2026-01-01T00:00:00.000Z' }], deletedDocuments: [] };
    ensureDocumentInMeta(meta, 'MEMORIES.md', 'Memories', 'enrichment');
    expect(Date.parse(meta.documents[0].updatedAt)).toBeGreaterThan(Date.parse('2026-01-01T00:00:00.000Z'));
  });
});
