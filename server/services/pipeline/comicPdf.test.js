import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdir, writeFile, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

const TEST_HOME = join(tmpdir(), `portos-comicpdf-test-${process.pid}-${Date.now()}`);
const FAKE_IMAGES_DIR = join(TEST_HOME, 'images');

vi.mock('../../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../../lib/fileUtils.js');
  return {
    ...actual,
    PATHS: { ...actual.PATHS, images: FAKE_IMAGES_DIR },
  };
});

// 1×1 RGBA PNG — smallest valid PNG pdf-lib will accept via embedPng.
const TINY_PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41,
  0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

const mockIssue = {
  id: 'iss-test',
  seriesId: 'ser-test',
  number: 3,
  title: 'The Brass Key',
  stages: {
    comicPages: {
      cover: { filename: 'cover.png' },
      pages: [
        { filename: 'page1.png' },
        { filename: 'page2.png' },
      ],
    },
  },
};

const mockSeries = {
  id: 'ser-test',
  name: 'Bone Walker',
  logline: 'A cult, a city, a child.',
};

const getIssueMock = vi.fn(async () => structuredClone(mockIssue));
const getSeriesMock = vi.fn(async () => structuredClone(mockSeries));
vi.mock('./issues.js', () => ({
tryReadFile: vi.fn().mockResolvedValue(null),
  getIssue: (...a) => getIssueMock(...a),
  VISUAL_STAGE_IDS: ['comicPages', 'storyboards', 'episodeVideo'],
  STAGE_IDS: ['idea', 'prose', 'comicScript', 'teleplay', 'comicPages', 'storyboards', 'episodeVideo'],
}));
vi.mock('./series.js', () => ({
  getSeries: (...a) => getSeriesMock(...a),
}));

const { buildComicPdf, PAGE_SIZES, DEFAULT_PAGE_SIZE, ERR_NO_RENDERED_PAGES } = await import('./comicPdf.js');

beforeEach(async () => {
  await mkdir(FAKE_IMAGES_DIR, { recursive: true });
  await writeFile(join(FAKE_IMAGES_DIR, 'cover.png'), TINY_PNG);
  await writeFile(join(FAKE_IMAGES_DIR, 'page1.png'), TINY_PNG);
  await writeFile(join(FAKE_IMAGES_DIR, 'page2.png'), TINY_PNG);
  getIssueMock.mockClear();
  getSeriesMock.mockClear();
});

afterEach(async () => {
  await rm(TEST_HOME, { recursive: true, force: true }).catch(() => {});
});

describe('PAGE_SIZES catalog', () => {
  it('exposes the three named paper sizes with non-zero dimensions', () => {
    expect(Object.keys(PAGE_SIZES)).toEqual(['us-letter', 'a4', 'tabloid']);
    for (const k of Object.keys(PAGE_SIZES)) {
      expect(PAGE_SIZES[k].width).toBeGreaterThan(0);
      expect(PAGE_SIZES[k].height).toBeGreaterThan(0);
    }
  });

  it('DEFAULT_PAGE_SIZE is a valid catalog key', () => {
    expect(PAGE_SIZES[DEFAULT_PAGE_SIZE]).toBeTruthy();
  });
});

describe('buildComicPdf — happy path', () => {
  it('produces a PDF with cover + 2 pages + colophon = 4 pages', async () => {
    const { bytes, pageCount, filename } = await buildComicPdf('iss-test');
    expect(pageCount).toBe(4);
    expect(filename).toBe('bone-walker-03-the-brass-key.pdf');
    expect(bytes.length).toBeGreaterThan(100);
    expect(Buffer.from(bytes).subarray(0, 4).toString()).toBe('%PDF');
  });

  it('omits the colophon when includeColophon=false', async () => {
    const { pageCount } = await buildComicPdf('iss-test', { includeColophon: false });
    expect(pageCount).toBe(3);
  });

  it('omits the cover when includeCover=false', async () => {
    const { pageCount } = await buildComicPdf('iss-test', { includeCover: false });
    expect(pageCount).toBe(3); // 2 pages + colophon
  });

  it('falls back to default size for unknown size keys', async () => {
    const a4 = await buildComicPdf('iss-test', { size: 'a4' });
    const fallback = await buildComicPdf('iss-test', { size: 'not-a-size' });
    expect(a4.pageCount).toBe(fallback.pageCount);
  });

  it('skips pages whose file is missing but still produces the PDF', async () => {
    getIssueMock.mockResolvedValueOnce({
      ...structuredClone(mockIssue),
      stages: {
        comicPages: {
          cover: { filename: 'cover.png' },
          pages: [
            { filename: 'page1.png' },
            { filename: 'does-not-exist.png' },
          ],
        },
      },
    });
    const { pageCount } = await buildComicPdf('iss-test');
    expect(pageCount).toBe(3); // cover + page1 + colophon — page2 (missing) skipped
  });

  it('uses series name + issue number in the filename when no title', async () => {
    getIssueMock.mockResolvedValueOnce({
      ...structuredClone(mockIssue),
      title: '',
    });
    const { filename } = await buildComicPdf('iss-test');
    expect(filename).toBe('bone-walker-03.pdf');
  });

  it('appends backCover after pages (cover → pages → back → colophon)', async () => {
    await writeFile(join(FAKE_IMAGES_DIR, 'back.png'), TINY_PNG);
    getIssueMock.mockResolvedValueOnce({
      ...structuredClone(mockIssue),
      stages: {
        comicPages: {
          cover: { filename: 'cover.png' },
          pages: [{ filename: 'page1.png' }, { filename: 'page2.png' }],
          backCover: { filename: 'back.png' },
        },
      },
    });
    const { pageCount } = await buildComicPdf('iss-test');
    expect(pageCount).toBe(5); // cover + 2 pages + back + colophon
  });

  it('omits the back cover when includeBackCover=false', async () => {
    await writeFile(join(FAKE_IMAGES_DIR, 'back.png'), TINY_PNG);
    getIssueMock.mockResolvedValueOnce({
      ...structuredClone(mockIssue),
      stages: {
        comicPages: {
          cover: { filename: 'cover.png' },
          pages: [{ filename: 'page1.png' }],
          backCover: { filename: 'back.png' },
        },
      },
    });
    const { pageCount } = await buildComicPdf('iss-test', { includeBackCover: false });
    expect(pageCount).toBe(3); // cover + page1 + colophon — back skipped
  });
});

describe('buildComicPdf — rejection paths', () => {
  it('throws ERR_NO_RENDERED_PAGES when neither cover nor pages have filenames', async () => {
    getIssueMock.mockResolvedValueOnce({
      ...structuredClone(mockIssue),
      stages: { comicPages: { cover: null, pages: [{ filename: '' }] } },
    });
    await expect(buildComicPdf('iss-test')).rejects.toMatchObject({ code: ERR_NO_RENDERED_PAGES });
  });

  it('throws ERR_NO_RENDERED_PAGES when every page-file embed fails', async () => {
    getIssueMock.mockResolvedValueOnce({
      ...structuredClone(mockIssue),
      stages: {
        comicPages: {
          cover: null,
          pages: [
            { filename: 'missing-1.png' },
            { filename: 'missing-2.png' },
          ],
        },
      },
    });
    await expect(buildComicPdf('iss-test', { includeColophon: false }))
      .rejects.toMatchObject({ code: ERR_NO_RENDERED_PAGES });
  });
});
