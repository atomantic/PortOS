import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';
import { request } from '../../lib/testHelper.js';

const tempRoot = createTempDataRoot('digital-twin-import-filenames-');
const twinDir = join(tempRoot, 'digital-twin');

vi.mock('../../lib/fileUtils.js', async original =>
  makePathsProxy(await original(), { dataRoot: tempRoot }));
vi.mock('../../services/promptRunner.js', () => ({ runPromptThroughProvider: vi.fn() }));
vi.mock('../../services/spotifyBrowserImport.js', () => ({}));
// Keep the import/save and document writers real; unrelated routes need no services.
vi.mock('../../services/digital-twin.js', async () => ({
  saveImportAsDocument: (await import('../../services/digital-twin-import.js')).saveImportAsDocument,
  createDocument: (await import('../../services/digital-twin-documents.js')).createDocument,
}));

const { default: importRouter } = await import('./import.js');
const { default: documentRouter } = await import('./documents.js');
const { createDocument, updateDocument } = await import('../../services/digital-twin-documents.js');
const { saveImportAsDocument } = await import('../../services/digital-twin-import.js');
const { cache, loadMeta, saveMeta } = await import('../../services/digital-twin-meta.js');

const app = express();
app.use(express.json());
app.use('/api/digital-twin', importRouter, documentRouter);

const content = '# Synthetic profile\n';
const suggestedDoc = filename => ({ filename, title: 'Synthetic profile', category: 'core', content });
const invalidNames = [
  '../escaped.md', join(tempRoot, 'absolute.md'), 'nested/profile.md',
  '..\\escaped.md', 'nested\\profile.md', 'C:\\profile.md',
  '..', '.hidden.md', 'profile.txt', 'profile.md\0suffix',
];

beforeEach(() => {
  for (const entry of readdirSync(tempRoot)) rmSync(join(tempRoot, entry), { recursive: true, force: true });
  cache.meta.data = null;
  cache.meta.timestamp = 0;
});
afterAll(() => rmSync(tempRoot, { recursive: true, force: true }));

describe('Digital Twin document filename boundary (#11271)', () => {
  it('refuses unsafe import HTTP filenames before any file or metadata is created', async () => {
    for (const filename of invalidNames) {
      const res = await request(app).post('/api/digital-twin/import/save')
        .send({ source: 'synthetic', suggestedDoc: suggestedDoc(filename) });
      expect(res.status, filename).toBe(400);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(readdirSync(tempRoot), filename).toEqual([]);
    }
  });

  it('protects direct document and import service callers before directory initialization', async () => {
    for (const filename of invalidNames) {
      await expect(createDocument(suggestedDoc(filename))).rejects.toThrow();
      await expect(saveImportAsDocument('synthetic', suggestedDoc(filename))).rejects.toThrow();
      expect(readdirSync(tempRoot), filename).toEqual([]);
    }
  });

  it('creates and updates safe Markdown imports and preserves ordinary document creation', async () => {
    const first = await request(app).post('/api/digital-twin/import/save')
      .send({ source: 'synthetic', suggestedDoc: suggestedDoc('Profile Notes.MD') });
    expect(first.status).toBe(200);
    expect(readFileSync(join(twinDir, 'Profile Notes.MD'), 'utf8')).toBe(content);

    const updatedContent = '# Revised synthetic profile\n';
    const updated = await request(app).post('/api/digital-twin/import/save').send({
      source: 'synthetic', suggestedDoc: { ...suggestedDoc('Profile Notes.MD'), content: updatedContent },
    });
    expect(updated.status).toBe(200);
    expect(updated.body.document.id).toBe(first.body.document.id);
    expect(readFileSync(join(twinDir, 'Profile Notes.MD'), 'utf8')).toBe(updatedContent);

    const normal = await request(app).post('/api/digital-twin/documents').send(suggestedDoc('ordinary.md'));
    expect(normal.status).toBe(201);
    expect(readFileSync(join(twinDir, 'ordinary.md'), 'utf8')).toBe(content);
    expect((await loadMeta()).documents).toHaveLength(2);
  });

  it('refuses an unsafe stored filename on update without changing file or metadata', async () => {
    await saveMeta({ version: '1.0.0', documents: [{ id: 'legacy', ...suggestedDoc('../escaped.md') }] });
    const metaBefore = readFileSync(join(twinDir, 'meta.json'), 'utf8');
    expect(await updateDocument('legacy', { content: '# Rejected update' })).toBeNull();
    expect(existsSync(join(tempRoot, 'escaped.md'))).toBe(false);
    expect(readFileSync(join(twinDir, 'meta.json'), 'utf8')).toBe(metaBefore);
  });
});
