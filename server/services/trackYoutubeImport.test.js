import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/ytdlp.js', () => ({ findYtDlp: vi.fn(async () => '/usr/local/bin/yt-dlp') }));
vi.mock('../lib/ffmpeg.js', () => ({
  findFfmpeg: vi.fn(async () => '/usr/local/bin/ffmpeg'),
  probeVideoDuration: vi.fn(async () => 120),
}));
vi.mock('./pipeline/musicLibrary.js', () => ({
  importUploadedTrack: vi.fn(async () => ({ filename: 'music-x.mp3', sizeBytes: 10 })),
}));
vi.mock('./tracks/index.js', () => ({
  createTrack: vi.fn(async (input) => ({ id: 'track-new', ...input })),
}));

const { findYtDlp } = await import('../lib/ytdlp.js');
const { findFfmpeg } = await import('../lib/ffmpeg.js');
const {
  YOUTUBE_URL_RE, assertYoutubeUrl, startYoutubeImport,
} = await import('./trackYoutubeImport.js');

beforeEach(() => {
  vi.clearAllMocks();
  findYtDlp.mockResolvedValue('/usr/local/bin/yt-dlp');
  findFfmpeg.mockResolvedValue('/usr/local/bin/ffmpeg');
});

describe('YOUTUBE_URL_RE / assertYoutubeUrl', () => {
  it('accepts a standard watch URL', () => {
    expect(YOUTUBE_URL_RE.test('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true);
    expect(() => assertYoutubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).not.toThrow();
  });

  it('accepts a youtu.be short link', () => {
    expect(YOUTUBE_URL_RE.test('https://youtu.be/dQw4w9WgXcQ')).toBe(true);
  });

  it('accepts an m.youtube.com link', () => {
    expect(YOUTUBE_URL_RE.test('https://m.youtube.com/watch?v=dQw4w9WgXcQ')).toBe(true);
  });

  it('accepts a watch URL with extra query params before v=', () => {
    expect(YOUTUBE_URL_RE.test('https://www.youtube.com/watch?list=PL123&v=dQw4w9WgXcQ')).toBe(true);
  });

  it('rejects a non-YouTube host', () => {
    expect(YOUTUBE_URL_RE.test('https://vimeo.com/12345')).toBe(false);
    expect(() => assertYoutubeUrl('https://vimeo.com/12345')).toThrow(/YouTube/);
  });

  it('rejects a youtube.com URL with no video id', () => {
    expect(YOUTUBE_URL_RE.test('https://www.youtube.com/watch?list=PL123')).toBe(false);
  });

  it('rejects a non-string input', () => {
    expect(() => assertYoutubeUrl(null)).toThrow();
    expect(() => assertYoutubeUrl(42)).toThrow();
  });
});

describe('startYoutubeImport — pre-spawn guards', () => {
  it('throws YTDLP_MISSING when yt-dlp is not found on PATH', async () => {
    findYtDlp.mockResolvedValue(null);
    await expect(startYoutubeImport('https://youtu.be/dQw4w9WgXcQ'))
      .rejects.toMatchObject({ status: 500, code: 'YTDLP_MISSING' });
  });

  it('throws FFMPEG_MISSING when ffmpeg is not found on PATH', async () => {
    findFfmpeg.mockResolvedValue(null);
    await expect(startYoutubeImport('https://youtu.be/dQw4w9WgXcQ'))
      .rejects.toMatchObject({ status: 500, code: 'FFMPEG_MISSING' });
  });

  it('rejects a non-YouTube URL before touching yt-dlp/ffmpeg discovery', async () => {
    await expect(startYoutubeImport('https://vimeo.com/12345'))
      .rejects.toMatchObject({ status: 400, code: 'YOUTUBE_URL_INVALID' });
    expect(findYtDlp).not.toHaveBeenCalled();
  });
});
