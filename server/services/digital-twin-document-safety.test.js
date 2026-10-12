import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const calls = vi.hoisted(() => []);
const parent = await mkdtemp(join(tmpdir(), 'digital-twin-safety-'));
const root = join(parent, 'digital-twin');
const outside = join(parent, 'outside.md');
vi.mock('../lib/fileUtils.js', async original => {
  const actual = await original();
  return { ...actual, PATHS: { ...actual.PATHS, digitalTwin: root } };
});
vi.mock('fs/promises', async original => {
  const actual = await original();
  return { ...actual, ...Object.fromEntries(['readFile', 'stat', 'unlink'].map(method => [method, (...args) => {
    calls.push({ method, path: args[0] });
    return actual[method](...args);
  }])) };
});
vi.mock('../lib/databaseMaintenanceJournal.js', () => ({ assertDatabaseAdmission() {} }));
const { applyDigitalTwinRemote, mergeMeta } = await import('./digital-twin-sync.js');
const { getDocuments, getDocumentById, deleteDocument, updateDocument } = await import('./digital-twin-documents.js');
const { DEFAULT_META, cache } = await import('./digital-twin-meta.js');
const doc = (filename, id = filename) => ({ id, filename, title: 'Synthetic', category: 'core', enabled: true,
  priority: 50, weight: 5, createdAt: '2026-01-01T00:00:00.000Z' });
const unsafeNames = () => ['../outside.md', outside, '..\\outside.md', 'C:\\outside.md', 'nested/doc.md',
  'identity.json', '.hidden.md', 'bad\0.md', '', null, 42, {}];
async function seed(documents) {
  await writeFile(join(root, 'meta.json'), JSON.stringify({ ...structuredClone(DEFAULT_META), documents }));
  cache.meta.data = null; cache.meta.timestamp = 0;
}
beforeEach(async () => {
  await rm(root, { recursive: true, force: true }); await mkdir(root);
  await writeFile(outside, 'Synthetic outside sentinel');
  await seed([]); calls.length = 0;
});
afterAll(async () => { await rm(parent, { recursive: true, force: true }); });

describe('Digital Twin document filename boundary', () => {
  it('rejects unsafe peer metadata, bytes and tombstones while retaining valid Markdown names', async () => {
    const valid = doc('My Doc.MD');
    const invalid = unsafeNames().map((filename, i) => doc(filename, `unsafe-${i}`));
    const remote = { meta: { documents: [...invalid, valid], deletedDocuments: invalid.map(({ filename }) =>
      ({ filename, deletedAt: '2025-01-01T00:00:00.000Z' })) },
    documents: { '../outside.md': 'REPLACEMENT', '..\\outside.md': 'REPLACEMENT', 'My Doc.MD': '# Valid peer body' } };
    // Missing local metadata must not bypass the ingress policy either.
    expect(mergeMeta(null, remote.meta).merged.documents).toEqual([valid]);
    await applyDigitalTwinRemote(remote);
    const saved = JSON.parse(await readFile(join(root, 'meta.json'), 'utf8'));
    expect(saved.documents).toEqual([valid]);
    expect(saved.deletedDocuments).toEqual([]);
    expect(await getDocumentById(valid.id)).toMatchObject({ content: '# Valid peer body' });
    expect((await getDocuments()).map(doc => doc.filename)).toEqual(['My Doc.MD']);
    expect(calls.filter(call => call.path === outside)).toEqual([]);
    expect(await readFile(outside, 'utf8')).toBe('Synthetic outside sentinel');
  });

  it('ignores malformed legacy rows before read/stat/update/delete and cleans them on the next peer merge', async () => {
    const valid = doc('Existing.MD');
    const invalid = unsafeNames().map((filename, i) => doc(filename, `legacy-${i}`));
    await writeFile(join(root, valid.filename), '# Existing body');
    await seed([null, ...invalid, valid]);
    expect((await getDocuments()).map(doc => doc.id)).toEqual([valid.id]);
    for (const entry of invalid) {
      expect(await getDocumentById(entry.id)).toBeNull();
      expect(await updateDocument(entry.id, { content: 'REPLACEMENT' })).toBeNull();
      expect(await deleteDocument(entry.id)).toBe(false);
    }
    expect(calls.filter(call => call.path === outside)).toEqual([]);
    expect(await readFile(outside, 'utf8')).toBe('Synthetic outside sentinel');
    await applyDigitalTwinRemote({ meta: { documents: [] } });
    expect(JSON.parse(await readFile(join(root, 'meta.json'), 'utf8')).documents).toEqual([valid]);
    expect(await deleteDocument(valid.id)).toBe(true);
    expect(await getDocuments()).toEqual([]);
    expect(await readFile(outside, 'utf8')).toBe('Synthetic outside sentinel');
  });
});
