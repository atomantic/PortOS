import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the two heavy service deps so this stays a fast unit test — series.js
// pulls in the store + sharing graph, issues.js the issue store.
const getSeries = vi.fn();
const setSeriesCoverImage = vi.fn();
const listIssues = vi.fn();

vi.mock('./series.js', () => ({
  getSeries: (...a) => getSeries(...a),
  setSeriesCoverImage: (...a) => setSeriesCoverImage(...a),
}));
vi.mock('./issues.js', () => ({
  listIssues: (...a) => listIssues(...a),
}));

const {
  pickVolumeCoverFilename,
  pickIssueCoverFilename,
  deriveSeriesCoverImage,
  refreshSeriesCoverImage,
} = await import('./seriesCoverImage.js');

// A cover-like record with a rendered image in the given slot.
const final = (filename) => ({ finalImage: { filename } });
const proof = (filename) => ({ proofImage: { filename } });

describe('pickVolumeCoverFilename', () => {
  it('returns the first rendered season cover in season order', () => {
    const seasons = [
      { cover: null },
      { cover: final('vol2.png') },
      { cover: final('vol3.png') },
    ];
    expect(pickVolumeCoverFilename(seasons)).toBe('vol2.png');
  });

  it('prefers finalImage but falls back to proofImage', () => {
    expect(pickVolumeCoverFilename([{ cover: proof('proof.png') }])).toBe('proof.png');
  });

  it('returns null when no season has a rendered cover', () => {
    expect(pickVolumeCoverFilename([{ cover: null }, { cover: { script: 'x' } }])).toBeNull();
  });

  it('tolerates a non-array', () => {
    expect(pickVolumeCoverFilename(undefined)).toBeNull();
    expect(pickVolumeCoverFilename(null)).toBeNull();
  });
});

describe('pickIssueCoverFilename', () => {
  const issue = (number, cover, extra = {}) => ({ number, stages: { comicPages: { cover } }, ...extra });

  it('returns the earliest-numbered rendered issue cover regardless of input order', () => {
    const issues = [
      issue(3, final('iss3.png')),
      issue(1, final('iss1.png')),
      issue(2, final('iss2.png')),
    ];
    expect(pickIssueCoverFilename(issues)).toBe('iss1.png');
  });

  it('skips issues without a rendered cover and deleted issues', () => {
    const issues = [
      issue(1, null),
      issue(2, final('iss2.png'), { deleted: true }),
      issue(3, final('iss3.png')),
    ];
    expect(pickIssueCoverFilename(issues)).toBe('iss3.png');
  });

  it('returns null when no issue has a rendered cover', () => {
    expect(pickIssueCoverFilename([issue(1, null), issue(2, { script: 'x' })])).toBeNull();
  });

  it('tolerates a non-array and missing stages', () => {
    expect(pickIssueCoverFilename(null)).toBeNull();
    expect(pickIssueCoverFilename([{ number: 1 }])).toBeNull();
  });
});

describe('deriveSeriesCoverImage', () => {
  it('prefers a volume cover over an issue cover', () => {
    const out = deriveSeriesCoverImage({
      seasons: [{ cover: final('vol.png') }],
      issues: [{ number: 1, stages: { comicPages: { cover: final('iss.png') } } }],
    });
    expect(out).toBe('vol.png');
  });

  it('falls back to the issue cover when no volume cover exists', () => {
    const out = deriveSeriesCoverImage({
      seasons: [{ cover: null }],
      issues: [{ number: 1, stages: { comicPages: { cover: final('iss.png') } } }],
    });
    expect(out).toBe('iss.png');
  });

  it('returns null when neither exists', () => {
    expect(deriveSeriesCoverImage({ seasons: [], issues: [] })).toBeNull();
    expect(deriveSeriesCoverImage()).toBeNull();
  });
});

describe('refreshSeriesCoverImage', () => {
  beforeEach(() => {
    getSeries.mockReset();
    setSeriesCoverImage.mockReset();
    listIssues.mockReset();
    setSeriesCoverImage.mockResolvedValue(undefined);
  });

  it('uses the volume cover and does NOT scan issues when one exists', async () => {
    getSeries.mockResolvedValue({ id: 'ser-1', coverImage: null, seasons: [{ cover: final('vol.png') }] });
    await refreshSeriesCoverImage('ser-1');
    expect(setSeriesCoverImage).toHaveBeenCalledWith('ser-1', 'vol.png');
    expect(listIssues).not.toHaveBeenCalled();
  });

  it('falls back to scanning issues when there is no volume cover', async () => {
    getSeries.mockResolvedValue({ id: 'ser-1', coverImage: null, seasons: [] });
    listIssues.mockResolvedValue([
      { number: 2, stages: { comicPages: { cover: final('iss2.png') } } },
      { number: 1, stages: { comicPages: { cover: final('iss1.png') } } },
    ]);
    await refreshSeriesCoverImage('ser-1');
    expect(listIssues).toHaveBeenCalledWith({ seriesId: 'ser-1' });
    expect(setSeriesCoverImage).toHaveBeenCalledWith('ser-1', 'iss1.png');
  });

  it('no-ops the write when the derived cover is unchanged', async () => {
    getSeries.mockResolvedValue({ id: 'ser-1', coverImage: 'vol.png', seasons: [{ cover: final('vol.png') }] });
    await refreshSeriesCoverImage('ser-1');
    expect(setSeriesCoverImage).not.toHaveBeenCalled();
  });

  it('clears a stale pointer to null when no cover remains', async () => {
    getSeries.mockResolvedValue({ id: 'ser-1', coverImage: 'old.png', seasons: [] });
    listIssues.mockResolvedValue([]);
    await refreshSeriesCoverImage('ser-1');
    expect(setSeriesCoverImage).toHaveBeenCalledWith('ser-1', null);
  });

  it('is a no-op for a missing series or empty id', async () => {
    getSeries.mockResolvedValue(null);
    await refreshSeriesCoverImage('ser-x');
    await refreshSeriesCoverImage('');
    expect(setSeriesCoverImage).not.toHaveBeenCalled();
  });
});
