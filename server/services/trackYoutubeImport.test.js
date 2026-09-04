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
vi.mock('../lib/childProcess.js', async (importOriginal) => ({ ...(await importOriginal()), spawn: vi.fn() }));
vi.mock('../lib/sseUtils.js', () => ({
  broadcastSse: vi.fn(),
  attachSseClient: vi.fn(() => true),
  closeJobAfterDelay: vi.fn(),
}));
vi.mock('../lib/killWithEscalation.js', () => ({ killWithEscalation: vi.fn() }));
// Spy that calls through, so the argv test still exercises the real yt-dlp core
// while the cancellation tests can substitute an outcome.
vi.mock('./ytdlpAudioImport.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, downloadAudioToTempMp3: vi.fn(actual.downloadAudioToTempMp3) };
});

const { findYtDlp } = await import('../lib/ytdlp.js');
const { findFfmpeg } = await import('../lib/ffmpeg.js');
const { spawn } = await import('../lib/childProcess.js');
const { broadcastSse } = await import('../lib/sseUtils.js');
const { killWithEscalation } = await import('../lib/killWithEscalation.js');
const { downloadAudioToTempMp3 } = await import('./ytdlpAudioImport.js');
const { importUploadedTrack } = await import('./pipeline/musicLibrary.js');
const { createTrack } = await import('./tracks/index.js');
const {
  YOUTUBE_URL_RE, assertYoutubeUrl, startYoutubeImport, cancelYoutubeImport, __testing,
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

  // #6014: this path used to declare its OWN, older regex that predated
  // music.youtube.com / shorts / live / embed support, so a Music Video track
  // import of a YouTube Music or Shorts link 400'd while the brain ingest and
  // the Takeout importer both accepted it.
  it.each([
    'https://music.youtube.com/watch?v=dQw4w9WgXcQ',
    'https://www.youtube.com/shorts/dQw4w9WgXcQ',
    'https://youtube.com/shorts/dQw4w9WgXcQ',
    'https://www.youtube.com/live/dQw4w9WgXcQ',
    'https://www.youtube.com/embed/dQw4w9WgXcQ',
  ])('accepts %s', (url) => {
    expect(YOUTUBE_URL_RE.test(url)).toBe(true);
    expect(() => assertYoutubeUrl(url)).not.toThrow();
  });

  it('returns the video id so the caller need not re-parse the URL', () => {
    expect(assertYoutubeUrl('https://music.youtube.com/watch?v=dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
    expect(assertYoutubeUrl('https://youtu.be/dQw4w9WgXcQ')).toBe('dQw4w9WgXcQ');
  });

  it.each([
    'https://www.youtube.com/playlist?list=PLabcdefghij',
    'https://www.youtube.com/@somechannel',
    'https://www.youtube.com/feed/history',
  ])('rejects %s — a batch paste must not start a 300-video download', (url) => {
    expect(YOUTUBE_URL_RE.test(url)).toBe(false);
    expect(() => assertYoutubeUrl(url)).toThrow(/single-video YouTube URL/);
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

describe('cancelYoutubeImport', () => {
  it('returns false for an unknown job id', () => {
    expect(cancelYoutubeImport('nope')).toBe(false);
    expect(killWithEscalation).not.toHaveBeenCalled();
  });

  it('records the cancel and returns true even when no child has spawned yet', () => {
    const job = { id: 'j1', status: 'running', clients: [], process: null, canceled: false };
    __testing.importJobs.set('j1', job);
    expect(cancelYoutubeImport('j1')).toBe(true);
    expect(job.canceled).toBe(true);
    // job.process is null during setup and again during post-processing — there
    // is nothing to signal, but the cancel must still be recorded.
    expect(killWithEscalation).not.toHaveBeenCalled();
    __testing.importJobs.delete('j1');
  });

  it('returns false once the job has finished, while it lingers in the map', () => {
    // closeJobAfterDelay evicts on a timer, so a finished job is still present —
    // cancelling it must not report an accepted cancel to the client.
    __testing.importJobs.set('j3', { id: 'j3', status: 'done', clients: [], process: null, canceled: false });
    expect(cancelYoutubeImport('j3')).toBe(false);
    __testing.importJobs.delete('j3');
  });

  it('signals a running child and refuses a second cancel', () => {
    const proc = { pid: 1234 };
    const job = { id: 'j2', status: 'running', clients: [], process: proc, canceled: false };
    __testing.importJobs.set('j2', job);
    expect(cancelYoutubeImport('j2')).toBe(true);
    expect(killWithEscalation).toHaveBeenCalledWith(proc, expect.objectContaining({ label: 'yt-dlp import' }));
    expect(cancelYoutubeImport('j2')).toBe(false);
    expect(killWithEscalation).toHaveBeenCalledOnce();
    __testing.importJobs.delete('j2');
  });
});

describe('startYoutubeImport — cancellation windows', () => {
  it('emits canceled and creates no track when cancelled after the download finished', async () => {
    // Cancel lands while the download is settling: the child has already exited
    // (job.process back to null), so only the flag can carry the cancel.
    // An assertion thrown inside the detached kickoff would be swallowed by its
    // catch, so record the result and assert it out here.
    let canceledOk = null;
    downloadAudioToTempMp3.mockImplementationOnce(async () => {
      const jobId = [...__testing.importJobs.keys()].pop();
      canceledOk = cancelYoutubeImport(jobId);
      return { outcome: 'complete', outPath: '/tmp/x.mp3', title: 'Clip' };
    });

    await startYoutubeImport('https://youtu.be/dQw4w9WgXcQ');
    for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r));

    expect(canceledOk).toBe(true);
    expect(broadcastSse).toHaveBeenCalledWith(expect.anything(), { type: 'canceled' });
    expect(importUploadedTrack).not.toHaveBeenCalled();
    expect(createTrack).not.toHaveBeenCalled();
  });

  it('emits canceled when the core reports the child was killed mid-download', async () => {
    downloadAudioToTempMp3.mockResolvedValueOnce({ outcome: 'canceled' });
    await startYoutubeImport('https://youtu.be/dQw4w9WgXcQ');
    for (let i = 0; i < 6; i += 1) await new Promise((r) => setImmediate(r));

    expect(broadcastSse).toHaveBeenCalledWith(expect.anything(), { type: 'canceled' });
    expect(createTrack).not.toHaveBeenCalled();
  });
});
