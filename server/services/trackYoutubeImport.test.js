import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../lib/ytdlp.js', () => ({ findYtDlp: vi.fn(async () => '/usr/local/bin/yt-dlp') }));
vi.mock('../lib/ffmpeg.js', () => ({
  findFfmpeg: vi.fn(async () => '/usr/local/bin/ffmpeg'),
  probeVideoDuration: vi.fn(async () => 120),
}));
vi.mock('./pipeline/musicLibrary.js', () => ({
  importUploadedTrack: vi.fn(async () => ({ filename: 'music-x.mp3', sizeBytes: 10 })),
  MUSIC_UPLOAD_MAX_BYTES: 50 * 1024 * 1024,
}));
vi.mock('./tracks/index.js', () => ({
  createTrack: vi.fn(async (input) => ({ id: 'track-new', ...input })),
  DURATION_MAX_SEC: 3600,
}));
vi.mock('child_process', async (importOriginal) => ({ ...(await importOriginal()), spawn: vi.fn() }));

const { findYtDlp } = await import('../lib/ytdlp.js');
const { findFfmpeg } = await import('../lib/ffmpeg.js');
const { spawn } = await import('child_process');
const {
  YOUTUBE_URL_RE, assertYoutubeUrl, startYoutubeImport,
} = await import('./trackYoutubeImport.js');

// A fake yt-dlp child that immediately closes with the given exit code —
// enough to exercise the argv construction without a real download.
function fakeChild(code = 0) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  setImmediate(() => proc.emit('close', code, null));
  return proc;
}

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

describe('startYoutubeImport — yt-dlp argv', () => {
  it('bounds the download with --max-filesize / --match-filters mirroring the existing media limits', async () => {
    spawn.mockReturnValue(fakeChild(0));
    await startYoutubeImport('https://youtu.be/dQw4w9WgXcQ');
    // The kickoff spawns inside a fire-and-forget IIFE — flush a couple of
    // microtask turns so it runs past the spawn() call before asserting.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    expect(spawn).toHaveBeenCalledOnce();
    const [, args] = spawn.mock.calls[0];
    expect(args).toEqual(expect.arrayContaining(['--max-filesize', String(50 * 1024 * 1024)]));
    expect(args).toEqual(expect.arrayContaining(['--match-filters', 'duration <= 3600']));
  });
});
