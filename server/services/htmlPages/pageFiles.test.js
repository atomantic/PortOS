import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const root = await mkdtemp(join(tmpdir(), 'portos-html-pages-'));
vi.mock('../../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, PATHS: { ...actual.PATHS, htmlPages: root } };
});

const { ensurePageFile, pageFileName, pageFilePath, removeRunFiles, writePageFile } = await import('./pageFiles.js');

const RUN = 'htmlpages-0f8a1c2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b';
const dir = join(root, RUN);

beforeEach(() => rm(dir, { recursive: true, force: true }));
afterAll(() => rm(root, { recursive: true, force: true }));

describe('pageFileName', () => {
  it('numbers the page and slugs the first line of its brief', () => {
    expect(pageFileName(0, '- look stunning\n- original')).toBe('1-look-stunning.html');
    expect(pageFileName(2, 'A Lighthouse at Dusk: café edition!')).toBe('3-a-lighthouse-at-dusk-cafe-edition.html');
    expect(pageFileName(1, '\n\n   ')).toBe('2-page.html');
  });
});

describe('page files', () => {
  it('writes a page, and a retried page with a different brief replaces its earlier file', async () => {
    const path = await writePageFile(RUN, 0, 'First brief', '<html>one</html>');
    expect(path).toBe(join(dir, '1-first-brief.html'));
    await writePageFile(RUN, 1, 'Second', '<html>two</html>');
    await writePageFile(RUN, 0, 'Edited brief', '<html>again</html>');
    expect((await readdir(dir)).sort()).toEqual(['1-edited-brief.html', '2-second.html']);
    expect(await readFile(join(dir, '1-edited-brief.html'), 'utf8')).toBe('<html>again</html>');
  });

  it('writes a missing file from the stored record when first asked, and leaves an existing one alone', async () => {
    const run = { id: RUN, pages: [{ theme: 'Old run', html: '<html>from the record</html>' }, { theme: 'No html', html: '' }] };
    const path = await ensurePageFile(run, 0);
    expect(path).toBe(pageFilePath(RUN, 0, 'Old run'));
    expect(await readFile(path, 'utf8')).toBe('<html>from the record</html>');

    await writeFile(path, '<html>already there</html>');
    await ensurePageFile(run, 0);
    expect(await readFile(path, 'utf8')).toBe('<html>already there</html>');

    expect(await ensurePageFile(run, 1)).toBeNull();
    expect(await ensurePageFile(run, 5)).toBeNull();
  });

  it('removes a run folder, and removing one that never existed is fine', async () => {
    await writePageFile(RUN, 0, 'x', '<html></html>');
    await removeRunFiles(RUN);
    await expect(readdir(dir)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(removeRunFiles(RUN)).resolves.toBeUndefined();
  });

  it('never turns something other than a minted run id into a path', async () => {
    for (const bad of ['../etc', 'htmlpages-../../x', '', 'other-0f8a1c2e-3b4d-4e5f-8a9b-0c1d2e3f4a5b']) {
      await expect(writePageFile(bad, 0, 'x', 'y')).rejects.toThrow(/Not an HTML pages run id/);
      expect(() => pageFilePath(bad, 0, 'x')).toThrow(/Not an HTML pages run id/);
    }
  });
});
