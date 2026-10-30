/**
 * Update and delete must not let document bytes and meta.json disagree (#14158).
 * A failed saveMeta restores the previous markdown and leaves the cached meta
 * untouched. A delete records its tombstone before unlink, so a crash in
 * between still stops a peer that has the file from resurrecting it.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { existsSync, rmSync, readFileSync } from 'fs';
import { basename, join } from 'path';
import { createTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

const tempRoot = createTempDataRoot('portos-dt-doc-persist-');
const twinDir = join(tempRoot, 'digital-twin');
const state = vi.hoisted(() => ({ failMetaWrite: false, failUnlink: false }));

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  const proxied = makePathsProxy(actual, { dataRoot: tempRoot });
  return new Proxy(proxied, {
    get(target, prop, receiver) {
      if (prop === 'atomicWrite') {
        return async (path, data) => {
          if (state.failMetaWrite && basename(String(path)) === 'meta.json') {
            throw new Error('injected meta failure');
          }
          return actual.atomicWrite(path, data);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
});

vi.mock('fs/promises', async () => {
  const actual = await vi.importActual('fs/promises');
  return {
    ...actual,
    unlink: async (path, ...args) => {
      if (state.failUnlink && basename(String(path)) === 'EXAMPLE_NOTE.md') {
        throw new Error('injected unlink failure');
      }
      return actual.unlink(path, ...args);
    },
  };
});

const { createDocument, updateDocument, deleteDocument } = await import('./digital-twin-documents.js');
const { loadMeta, saveMeta, cache } = await import('./digital-twin-meta.js');
const { applyDigitalTwinRemote } = await import('./digital-twin-sync.js');

const FILENAME = 'EXAMPLE_NOTE.md';
const CONTENT = '# Example note\n\nExample content.\n';
const docPath = join(twinDir, FILENAME);
const metaPath = join(twinDir, 'meta.json');

const newDoc = () => createDocument({
  filename: FILENAME,
  title: 'Example note',
  category: 'lifestyle',
  content: CONTENT,
});

beforeEach(async () => {
  state.failMetaWrite = false;
  state.failUnlink = false;
  rmSync(twinDir, { recursive: true, force: true });
  cache.meta.data = null;
  cache.meta.timestamp = 0;
  await saveMeta({ version: '1.0.0', documents: [], deletedDocuments: [] });
});

afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

describe('digital twin document metadata before bytes (#14158)', () => {
  it('leaves the markdown and meta.json unchanged when a delete cannot save metadata', async () => {
    const created = await newDoc();
    const before = structuredClone(await loadMeta());
    const cached = cache.meta.data;
    const persisted = readFileSync(metaPath, 'utf8');
    state.failMetaWrite = true;
    try {
      await expect(deleteDocument(created.id)).rejects.toThrow('injected meta failure');
    } finally {
      state.failMetaWrite = false;
    }

    expect(readFileSync(docPath, 'utf8')).toBe(CONTENT);
    expect(readFileSync(metaPath, 'utf8')).toBe(persisted);
    expect(cache.meta.data).toBe(cached);
    expect(cache.meta.data).toEqual(before);
    expect((await loadMeta()).deletedDocuments).toEqual([]);
  });

  it('restores the previous markdown when an update cannot save metadata', async () => {
    const created = await newDoc();
    const before = structuredClone(await loadMeta());
    const cached = cache.meta.data;
    const persisted = readFileSync(metaPath, 'utf8');
    state.failMetaWrite = true;
    try {
      await expect(updateDocument(created.id, {
        content: '# Example note\n\nReplacement.\n',
        title: 'Replacement',
      })).rejects.toThrow('injected meta failure');
    } finally {
      state.failMetaWrite = false;
    }

    expect(readFileSync(docPath, 'utf8')).toBe(CONTENT);
    expect(readFileSync(metaPath, 'utf8')).toBe(persisted);
    expect(cache.meta.data).toBe(cached);
    expect(cache.meta.data).toEqual(before);
    expect((await loadMeta()).documents.find((doc) => doc.id === created.id).updatedAt).toBeUndefined();
  });

  it('does not publish a metadata-only edit when saveMeta fails', async () => {
    const created = await newDoc();
    const before = structuredClone(await loadMeta());
    const cached = cache.meta.data;
    state.failMetaWrite = true;
    try {
      await expect(updateDocument(created.id, { title: 'Replacement' })).rejects.toThrow('injected meta failure');
    } finally {
      state.failMetaWrite = false;
    }

    expect(readFileSync(docPath, 'utf8')).toBe(CONTENT);
    expect(cache.meta.data).toBe(cached);
    expect(cache.meta.data).toEqual(before);
    expect((await loadMeta()).documents.find((doc) => doc.id === created.id).title).toBe('Example note');
  });

  it('keeps a durable tombstone when unlink does not run, so a peer file cannot resurrect the document', async () => {
    const created = await newDoc();
    const peer = {
      meta: structuredClone(await loadMeta()),
      documents: { [FILENAME]: CONTENT },
    };
    peer.meta.deletedDocuments = [];
    state.failUnlink = true;
    try {
      await expect(deleteDocument(created.id)).rejects.toThrow('injected unlink failure');
    } finally {
      state.failUnlink = false;
    }

    expect(readFileSync(docPath, 'utf8')).toBe(CONTENT);
    const afterDelete = JSON.parse(readFileSync(metaPath, 'utf8'));
    expect(afterDelete.documents.map((doc) => doc.filename)).not.toContain(FILENAME);
    expect(afterDelete.deletedDocuments.map((tombstone) => tombstone.filename)).toEqual([FILENAME]);
    expect(cache.meta.data.deletedDocuments.map((tombstone) => tombstone.filename)).toEqual([FILENAME]);

    await applyDigitalTwinRemote(peer);

    const afterSync = await loadMeta();
    expect(afterSync.documents.map((doc) => doc.filename)).not.toContain(FILENAME);
    expect(afterSync.deletedDocuments.map((tombstone) => tombstone.filename)).toEqual([FILENAME]);
    expect(existsSync(docPath)).toBe(false);
  });
});
