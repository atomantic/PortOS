import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'portos-rapid-reader-library-'));
const LIBRARY_DIR = join(TEST_DATA_ROOT, 'rapid-reader-library');

vi.mock('../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, PATHS: { ...actual.PATHS, data: TEST_DATA_ROOT, rapidReaderLibrary: LIBRARY_DIR } };
});

vi.mock('../lib/safeUrlFetch.js', () => ({ fetchPublicText: vi.fn() }));

const library = await import('./rapidReaderLibrary.js');
const { fetchPublicText } = await import('../lib/safeUrlFetch.js');

const ACCELERANDO = {
  id: 'accelerando',
  title: 'Accelerando',
  author: 'Charles Stross',
  sourceUrl: 'https://example.com/accelerando',
  text: 'A novel by Charles Stross.',
};

beforeEach(async () => {
  vi.clearAllMocks();
  rmSync(LIBRARY_DIR, { recursive: true, force: true });
  library.rapidReaderLibraryStore.clearCache?.();
});
afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

describe('rapid reader shelf store', () => {
  it('persists a pasted entry and reloads its text from disk', async () => {
    const created = await library.createPastedRapidReaderEntry({ title: '  Notes  ', text: '  alpha bravo charlie  ' });

    expect(created).toMatchObject({ title: 'Notes', sourceType: 'paste', sourceUrl: null, author: null, wordCount: 3, text: 'alpha bravo charlie' });
    expect(created.addedAt).toBe(created.updatedAt);

    const reloaded = await library.getRapidReaderLibraryEntry(created.id);
    expect(reloaded.text).toBe('alpha bravo charlie');
  });

  // The stamp is a once-per-process guard, so this needs a module instance that
  // has not already written the type index for an earlier test's (since-deleted)
  // directory.
  it('stamps the type-level schema version so the boot verifier sees the store', async () => {
    vi.resetModules();
    const fresh = await import('./rapidReaderLibrary.js');
    await fresh.createPastedRapidReaderEntry({ title: 'Notes', text: 'alpha bravo' });

    const index = JSON.parse(readFileSync(join(LIBRARY_DIR, 'index.json'), 'utf8'));
    expect(index).toMatchObject({ type: 'rapid-reader-library', schemaVersion: library.RAPID_READER_LIBRARY_SCHEMA_VERSION });
    await expect(fresh.rapidReaderLibraryStore.verifySchemaVersion()).resolves.toMatchObject({ ok: true, onDisk: fresh.RAPID_READER_LIBRARY_SCHEMA_VERSION });
  });

  it('lists metadata newest-first and never includes the text', async () => {
    const older = await library.createPastedRapidReaderEntry({ title: 'Older', text: 'alpha' });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const newer = await library.createPastedRapidReaderEntry({ title: 'Newer', text: 'bravo' });

    const listed = await library.listRapidReaderLibrary();
    expect(listed.map((entry) => entry.id)).toEqual([newer.id, older.id]);
    expect(listed.every((entry) => !('text' in entry))).toBe(true);
  });

  it('rejects an empty or oversized paste without writing a record', async () => {
    await expect(library.createPastedRapidReaderEntry({ title: 'Empty', text: '   ' })).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    await expect(library.createPastedRapidReaderEntry({ title: '  ', text: 'alpha' })).rejects.toMatchObject({ status: 400 });
    await expect(library.createPastedRapidReaderEntry({ title: 'Big', text: 'x'.repeat(library.MAX_RAPID_READER_TEXT_BYTES + 1) })).rejects.toMatchObject({ status: 400 });

    await expect(library.listRapidReaderLibrary()).resolves.toEqual([]);
  });

  it('404s on an unknown id, and deletes only the requested entry', async () => {
    const kept = await library.createPastedRapidReaderEntry({ title: 'Kept', text: 'alpha' });
    const doomed = await library.createPastedRapidReaderEntry({ title: 'Doomed', text: 'bravo' });

    await expect(library.getRapidReaderLibraryEntry('missing')).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });

    await library.deleteRapidReaderLibraryEntry(doomed.id);
    expect((await library.listRapidReaderLibrary()).map((entry) => entry.id)).toEqual([kept.id]);
    await expect(library.deleteRapidReaderLibraryEntry(doomed.id)).rejects.toMatchObject({ status: 404 });
  });

  describe('URL import', () => {
    it('derives the title from the page <title> and keeps the source URL', async () => {
      fetchPublicText.mockResolvedValue('<html><head><title>  Example Article  </title></head><body><p>alpha bravo</p></body></html>');

      const entry = await library.fetchRapidReaderEntry({ url: 'https://example.com/a' });

      expect(entry).toMatchObject({ title: 'Example Article', sourceType: 'fetch', sourceUrl: 'https://example.com/a', author: null, text: 'alpha bravo' });
      expect(fetchPublicText).toHaveBeenCalledWith('https://example.com/a', { blockPrivate: true, maxBytes: library.MAX_RAPID_READER_TEXT_BYTES, timeoutMs: 20_000 });
    });

    it('prefers a caller title, then falls back to the hostname when the page has none', async () => {
      fetchPublicText.mockResolvedValue('<html><head><title>Ignored</title></head><body><p>alpha</p></body></html>');
      await expect(library.fetchRapidReaderEntry({ url: 'https://example.com/a', title: 'Mine' })).resolves.toMatchObject({ title: 'Mine' });

      fetchPublicText.mockResolvedValue('alpha bravo charlie');
      await expect(library.fetchRapidReaderEntry({ url: 'https://example.com/b' })).resolves.toMatchObject({ title: 'example.com', text: 'alpha bravo charlie' });
    });

    it('writes no record when the fetch fails or converts to empty text', async () => {
      fetchPublicText.mockResolvedValue('');
      await expect(library.fetchRapidReaderEntry({ url: 'https://example.com/a' })).rejects.toMatchObject({ status: 502, code: 'FETCH_FAILED' });

      fetchPublicText.mockResolvedValue('<html><body>   </body></html>');
      await expect(library.fetchRapidReaderEntry({ url: 'https://example.com/b' })).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });

      fetchPublicText.mockRejectedValue(Object.assign(new Error('blocked'), { code: 'UNSAFE_URL' }));
      await expect(library.fetchRapidReaderEntry({ url: 'http://192.0.2.10/a' })).rejects.toMatchObject({ code: 'UNSAFE_URL' });

      await expect(library.listRapidReaderLibrary()).resolves.toEqual([]);
    });

    it('creates a new entry per fetch of the same URL — no dedup', async () => {
      fetchPublicText.mockResolvedValue('<html><body><p>alpha</p></body></html>');

      const first = await library.fetchRapidReaderEntry({ url: 'https://example.com/a' });
      const second = await library.fetchRapidReaderEntry({ url: 'https://example.com/a' });

      expect(second.id).not.toBe(first.id);
      expect(await library.listRapidReaderLibrary()).toHaveLength(2);
    });
  });

  describe('Accelerando upsert', () => {
    it('always uses the fixed id and refreshes the text', async () => {
      const created = await library.upsertAccelerandoShelfEntry(ACCELERANDO);
      expect(created).toMatchObject({ id: 'accelerando', sourceType: 'accelerando', author: 'Charles Stross' });

      const updated = await library.upsertAccelerandoShelfEntry({ ...ACCELERANDO, text: 'A revised novel.' });
      expect(updated.text).toBe('A revised novel.');
      expect(await library.listRapidReaderLibrary()).toHaveLength(1);
    });

    it('preserves the original addedAt across re-upserts', async () => {
      const created = await library.upsertAccelerandoShelfEntry(ACCELERANDO);
      await new Promise((resolve) => setTimeout(resolve, 2));
      const updated = await library.upsertAccelerandoShelfEntry({ ...ACCELERANDO, text: 'A revised novel.' });

      expect(updated.addedAt).toBe(created.addedAt);
      expect(updated.updatedAt > created.updatedAt).toBe(true);
    });
  });
});
