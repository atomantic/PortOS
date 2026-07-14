import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

// Mock the heavy service deps + point PATHS.data at a temp dir so the marker
// file writes somewhere disposable.
let DATA_DIR;
const listSeries = vi.fn();
const listAllIssues = vi.fn();
const setSeriesCoverImage = vi.fn();

// Keep the real fileUtils helpers (tryReadFile/atomicWrite/safeJSONParse feed
// migrationMarker.js) and only point PATHS.data at the disposable temp dir, so
// the marker is a real on-disk file the existsSync/readFileSync assertions read.
vi.mock('../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, PATHS: { ...actual.PATHS, get data() { return DATA_DIR; } } };
});
vi.mock('../services/pipeline/series.js', () => ({
  listSeries: (...a) => listSeries(...a),
  setSeriesCoverImage: (...a) => setSeriesCoverImage(...a),
}));
vi.mock('../services/pipeline/issues.js', () => ({
  listAllIssues: (...a) => listAllIssues(...a),
}));

const { backfillSeriesCoverImages } = await import('./backfillSeriesCoverImages.js');

const MARKER = () => join(DATA_DIR, 'series-cover-backfill.applied.json');
const final = (filename) => ({ finalImage: { filename } });
const issue = (seriesId, number, cover) => ({ seriesId, number, stages: { comicPages: { cover } } });

describe('backfillSeriesCoverImages', () => {
  beforeEach(() => {
    DATA_DIR = mkdtempSync(join(tmpdir(), 'cover-backfill-'));
    listSeries.mockReset();
    listAllIssues.mockReset();
    setSeriesCoverImage.mockReset();
    setSeriesCoverImage.mockResolvedValue(undefined);
    listAllIssues.mockResolvedValue([]);
  });

  afterEach(() => {
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it('decorates from a volume cover WITHOUT scanning issues', async () => {
    listSeries.mockResolvedValue([
      { id: 'ser-1', coverImage: null, seasons: [{ cover: final('vol.png') }] },
    ]);
    const res = await backfillSeriesCoverImages();
    expect(listAllIssues).not.toHaveBeenCalled(); // every series had a volume cover
    expect(setSeriesCoverImage).toHaveBeenCalledWith('ser-1', 'vol.png');
    expect(res).toMatchObject({ skipped: false, scanned: 1, decorated: 1 });
    expect(existsSync(MARKER())).toBe(true); // marker written
  });

  it('loads issues once and routes the earliest issue cover to each series', async () => {
    listSeries.mockResolvedValue([
      { id: 'ser-1', coverImage: null, seasons: [] },
      { id: 'ser-2', coverImage: null, seasons: [] },
    ]);
    listAllIssues.mockResolvedValue([
      issue('ser-1', 2, final('s1-iss2.png')),
      issue('ser-1', 1, final('s1-iss1.png')),
      issue('ser-2', 1, final('s2-iss1.png')),
    ]);
    await backfillSeriesCoverImages();
    expect(listAllIssues).toHaveBeenCalledTimes(1); // single grouped scan
    expect(setSeriesCoverImage).toHaveBeenCalledWith('ser-1', 's1-iss1.png'); // earliest by number
    expect(setSeriesCoverImage).toHaveBeenCalledWith('ser-2', 's2-iss1.png');
  });

  it('skips the write when a series already carries the correct cover', async () => {
    listSeries.mockResolvedValue([
      { id: 'ser-1', coverImage: 'vol.png', seasons: [{ cover: final('vol.png') }] },
    ]);
    const res = await backfillSeriesCoverImages();
    expect(setSeriesCoverImage).not.toHaveBeenCalled();
    expect(res.decorated).toBe(1); // still counts as having a cover
  });

  it('is marker-gated: a second run no-ops, force re-runs', async () => {
    listSeries.mockResolvedValue([{ id: 'ser-1', coverImage: null, seasons: [{ cover: final('vol.png') }] }]);
    await backfillSeriesCoverImages();
    listSeries.mockClear();
    const second = await backfillSeriesCoverImages();
    expect(second.skipped).toBe(true);
    expect(listSeries).not.toHaveBeenCalled(); // gated off
    const forced = await backfillSeriesCoverImages({ force: true });
    expect(forced.skipped).toBe(false);
    expect(listSeries).toHaveBeenCalled(); // force re-ran the walk
  });

  it('leaves the marker unwritten (retry next boot) when the issue scan fails', async () => {
    listSeries.mockResolvedValue([{ id: 'ser-1', coverImage: null, seasons: [] }]); // no volume cover → needs issue scan
    listAllIssues.mockRejectedValue(new Error('db down'));
    const res = await backfillSeriesCoverImages();
    expect(res).toMatchObject({ skipped: false, issueScanFailed: true });
    expect(existsSync(MARKER())).toBe(false); // not applied — will retry
  });

  it('writes the marker even when there are no series', async () => {
    listSeries.mockResolvedValue([]);
    const res = await backfillSeriesCoverImages();
    expect(res).toMatchObject({ skipped: false, scanned: 0, decorated: 0 });
    const marker = JSON.parse(readFileSync(MARKER(), 'utf-8'));
    expect(marker.version).toBe(1);
  });
});
