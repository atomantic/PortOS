import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const TEST_DATA_ROOT = mkdtempSync(join(tmpdir(), 'portos-rapid-reader-'));

vi.mock('../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, PATHS: { ...actual.PATHS, data: TEST_DATA_ROOT } };
});

vi.mock('../lib/safeUrlFetch.js', () => ({ fetchPublicText: vi.fn() }));

const service = await import('./rapidReader.js');
const { fetchPublicText } = await import('../lib/safeUrlFetch.js');

const CACHE_FILE = join(TEST_DATA_ROOT, 'cache', 'accelerando.html');
const SOURCE_HTML = `<!doctype html>
<html><body>
  <h1>Accelerando</h1>
  <div id="book">
    <p>A novel by Charles Stross</p>
    <p>Creative Commons Attribution-NonCommercial-NoDerivs 2.5</p>
    <h3>Chapter 1: Example</h3>
    <p>Café &ndash; déjà vu. &copy; Charles Stross.</p>
    <!-- this comment must not become reader text -->
  </div>
</body></html>`;

const NESTED_SOURCE_HTML = SOURCE_HTML.replace(
  '  </div>\n</body>',
  '    <div class="nested"><p>Chapter 9: Finale</p></div>\n  </div>\n</body>',
);

beforeEach(() => {
  vi.clearAllMocks();
  rmSync(CACHE_FILE, { force: true });
});

afterAll(() => rmSync(TEST_DATA_ROOT, { recursive: true, force: true }));

describe('extractAccelerandoText', () => {
  it('extracts readable text and decodes the official HTML entities', () => {
    const text = service.extractAccelerandoText(SOURCE_HTML);

    expect(text).toContain('A novel by Charles Stross');
    expect(text).toContain('Café – déjà vu. © Charles Stross.');
    expect(text).not.toContain('this comment must not become reader text');
  });

  it('rejects a page that does not contain the recognized book body', () => {
    expect(service.extractAccelerandoText('<html><body>Temporary error</body></html>')).toBe('');
    expect(service.extractAccelerandoText(null)).toBe('');
  });

  it('keeps the full book body when the source contains nested divs', () => {
    expect(service.extractAccelerandoText(NESTED_SOURCE_HTML)).toContain('Chapter 9: Finale');
  });
});

describe('getAccelerandoBook', () => {
  it('fetches the fixed official source and caches the raw edition', async () => {
    fetchPublicText.mockResolvedValue(SOURCE_HTML);

    const book = await service.getAccelerandoBook();

    expect(book).toMatchObject({
      id: 'accelerando',
      title: 'Accelerando',
      author: 'Charles Stross',
      sourceUrl: 'http://www.antipope.org/charlie/blog-static/fiction/accelerando/accelerando.html',
      licenseName: 'CC BY-NC-ND 2.5',
      licenseUrl: 'https://creativecommons.org/licenses/by-nc-nd/2.5/',
      cached: false,
      wordCount: expect.any(Number),
    });
    expect(fetchPublicText).toHaveBeenCalledWith(
      service.ACCELERANDO_BOOK.sourceUrl,
      expect.objectContaining({
        blockPrivate: true,
        maxBytes: 2 * 1024 * 1024,
        throwOnUnsafe: false,
      }),
    );
    expect(readFileSync(CACHE_FILE, 'utf8')).toBe(SOURCE_HTML);
  });

  it('uses a valid local cache without making another remote request', async () => {
    fetchPublicText.mockResolvedValue(SOURCE_HTML);
    await service.getAccelerandoBook();
    fetchPublicText.mockClear();

    const book = await service.getAccelerandoBook();

    expect(book.cached).toBe(true);
    expect(fetchPublicText).not.toHaveBeenCalled();
  });

  it('does not trust an invalid cached source', async () => {
    mkdirSync(join(TEST_DATA_ROOT, 'cache'), { recursive: true });
    writeFileSync(CACHE_FILE, '<html><body>not a book</body></html>');
    fetchPublicText.mockResolvedValue(SOURCE_HTML);

    const book = await service.getAccelerandoBook();

    expect(book.cached).toBe(false);
    expect(fetchPublicText).toHaveBeenCalledOnce();
  });

  it('fails closed when the remote source is unavailable or unrecognized', async () => {
    fetchPublicText.mockResolvedValueOnce(null);
    await expect(service.getAccelerandoBook()).rejects.toMatchObject({
      code: 'ACCELERANDO_FETCH_FAILED',
      status: 502,
    });

    fetchPublicText.mockResolvedValueOnce('<html><body>not a book</body></html>');
    await expect(service.getAccelerandoBook()).rejects.toMatchObject({
      code: 'ACCELERANDO_SOURCE_INVALID',
      status: 502,
    });
  });
});
