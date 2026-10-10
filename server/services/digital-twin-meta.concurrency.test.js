/**
 * Concurrent metadata mutations (#10939): documents, personas and settings all
 * load -> mutate -> saveMeta against one meta.json. When the cache is cold (TTL
 * expiry, a peer-sync apply) each overlapping caller reads its own copy from
 * disk, so without a shared lock the last saveMeta silently drops the others'
 * records and tombstones. Real disk paths, PATHS pointed at a temp dir.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { readdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { createTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

const tempRoot = createTempDataRoot('portos-dt-meta-concurrency-');
const twinDir = join(tempRoot, 'digital-twin');

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return makePathsProxy(actual, { dataRoot: tempRoot });
});

const { createDocument, updateDocument, deleteDocument } = await import('./digital-twin-documents.js');
const { createPersona, deletePersona } = await import('./digital-twin-personas.js');
const { loadMeta, saveMeta, updateSettings, cache, digitalTwinEvents } = await import('./digital-twin-meta.js');

const coldCache = () => {
  cache.meta.data = null;
  cache.meta.timestamp = 0;
};

beforeEach(async () => {
  rmSync(twinDir, { recursive: true, force: true });
  await saveMeta({ version: '1.0.0', documents: [], deletedDocuments: [], personas: [], deletedPersonas: [], settings: {} });
  coldCache();
  // Every save drops the cache again, so each overlapping caller that is not
  // serialized re-reads its own snapshot from disk.
  digitalTwinEvents.removeAllListeners('meta:changed');
  digitalTwinEvents.on('meta:changed', coldCache);
});

afterAll(() => {
  digitalTwinEvents.removeAllListeners('meta:changed');
  rmSync(tempRoot, { recursive: true, force: true });
});

describe('digital twin meta write serialization (#10939)', () => {
  it('keeps every persona, tombstone and setting from overlapping mutations', async () => {
    const seed = await createPersona({ name: 'Seed', instructions: 'Seed persona.' });
    coldCache();

    const [a, b] = await Promise.all([
      createPersona({ name: 'A', instructions: 'Persona A.' }),
      createPersona({ name: 'B', instructions: 'Persona B.' }),
      deletePersona(seed.id),
      updateSettings({ maxContextTokens: 1234 }),
    ]);

    const meta = JSON.parse(readFileSync(join(twinDir, 'meta.json'), 'utf-8'));
    expect(meta.personas.map((p) => p.id).sort()).toEqual([a.id, b.id].sort());
    expect(meta.deletedPersonas.map((t) => t.id)).toEqual([seed.id]);
    expect(meta.settings.maxContextTokens).toBe(1234);
  });

  it('keeps concurrent document creates and deletes, writing files atomically', async () => {
    const first = await createDocument({ filename: 'FIRST.md', title: 'First', category: 'core', content: '# First\n' });
    coldCache();

    await Promise.all([
      createDocument({ filename: 'SECOND.md', title: 'Second', category: 'core', content: '# Second\n' }),
      createDocument({ filename: 'THIRD.md', title: 'Third', category: 'core', content: '# Third\n' }),
      deleteDocument(first.id),
    ]);

    const meta = JSON.parse(readFileSync(join(twinDir, 'meta.json'), 'utf-8'));
    expect(meta.documents.map((d) => d.filename).sort()).toEqual(['SECOND.md', 'THIRD.md']);
    expect(meta.deletedDocuments.map((t) => t.filename)).toEqual(['FIRST.md']);

    const second = meta.documents.find((d) => d.filename === 'SECOND.md');
    await updateDocument(second.id, { content: '# Second v2\n' });
    expect(readFileSync(join(twinDir, 'SECOND.md'), 'utf-8')).toBe('# Second v2\n');
    // atomicWrite renames a temp file into place; nothing may be left behind.
    expect(readdirSync(twinDir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
    expect((await loadMeta()).documents).toHaveLength(2);
  });
});
