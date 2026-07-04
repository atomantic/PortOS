import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

vi.mock('../lib/ytdlp.js', () => ({ findYtDlp: vi.fn(async () => '/usr/local/bin/yt-dlp') }));
vi.mock('../lib/ffmpeg.js', () => ({ findFfmpeg: vi.fn(async () => '/usr/local/bin/ffmpeg') }));
vi.mock('child_process', async (importOriginal) => ({ ...(await importOriginal()), spawn: vi.fn() }));

const { findYtDlp } = await import('../lib/ytdlp.js');
const { findFfmpeg } = await import('../lib/ffmpeg.js');
const { spawn } = await import('child_process');
const { resolveYtDlpBinaries, downloadAudioToTempMp3 } = await import('./ytdlpAudioImport.js');

// A fake yt-dlp child. `emit` optionally pushes stdout/stderr lines before the
// close, letting a test exercise the progress/title marker parsing.
function fakeChild({ code = 0, signal = null, stdout = [] } = {}) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  setImmediate(() => {
    stdout.forEach((line) => proc.stdout.emit('data', Buffer.from(`${line}\n`)));
    proc.emit('close', code, signal);
  });
  return proc;
}

const baseArgs = {
  url: 'https://example.com/clip',
  ytDlp: '/usr/local/bin/yt-dlp',
  ffmpeg: '/usr/local/bin/ffmpeg',
  tempPrefix: 'portos-test-abc',
  maxBytes: 60 * 1024 * 1024,
  maxDurationSec: 1200,
  onProgress: () => {},
  registerProcess: () => {},
};

beforeEach(() => {
  vi.clearAllMocks();
  findYtDlp.mockResolvedValue('/usr/local/bin/yt-dlp');
  findFfmpeg.mockResolvedValue('/usr/local/bin/ffmpeg');
});

describe('resolveYtDlpBinaries', () => {
  it('returns both binary paths when present', async () => {
    await expect(resolveYtDlpBinaries()).resolves.toEqual({
      ytDlp: '/usr/local/bin/yt-dlp',
      ffmpeg: '/usr/local/bin/ffmpeg',
    });
  });

  it('throws YTDLP_MISSING when yt-dlp is absent', async () => {
    findYtDlp.mockResolvedValue(null);
    await expect(resolveYtDlpBinaries()).rejects.toMatchObject({ status: 500, code: 'YTDLP_MISSING' });
  });

  it('throws FFMPEG_MISSING when ffmpeg is absent', async () => {
    findFfmpeg.mockResolvedValue(null);
    await expect(resolveYtDlpBinaries()).rejects.toMatchObject({ status: 500, code: 'FFMPEG_MISSING' });
  });
});

describe('downloadAudioToTempMp3 — argv', () => {
  it('extracts audio to mp3 and bounds the download with the passed caps', async () => {
    spawn.mockReturnValue(fakeChild({ code: 0 }));
    await downloadAudioToTempMp3(baseArgs);

    expect(spawn).toHaveBeenCalledOnce();
    const [bin, args] = spawn.mock.calls[0];
    expect(bin).toBe('/usr/local/bin/yt-dlp');
    expect(args).toEqual(expect.arrayContaining(['-x', '--audio-format', 'mp3']));
    expect(args).toEqual(expect.arrayContaining(['--max-filesize', String(60 * 1024 * 1024)]));
    expect(args).toEqual(expect.arrayContaining(['--match-filters', 'duration <= 1200']));
    expect(args[args.length - 1]).toBe('https://example.com/clip'); // url is last
  });
});

describe('downloadAudioToTempMp3 — outcomes', () => {
  it('reports canceled on SIGTERM', async () => {
    spawn.mockReturnValue(fakeChild({ code: null, signal: 'SIGTERM' }));
    const result = await downloadAudioToTempMp3(baseArgs);
    expect(result.outcome).toBe('canceled');
  });

  it('reports failed (no output file) with a bounds-aware reason on a clean exit that produced nothing', async () => {
    spawn.mockReturnValue(fakeChild({ code: 0 })); // exit 0 but no temp mp3 exists
    const result = await downloadAudioToTempMp3(baseArgs);
    expect(result.outcome).toBe('failed');
    expect(result.reason).toMatch(/no audio was produced/);
  });

  it('reports failed with the exit code when yt-dlp errors', async () => {
    spawn.mockReturnValue(fakeChild({ code: 1 }));
    const result = await downloadAudioToTempMp3(baseArgs);
    expect(result.outcome).toBe('failed');
    expect(result.reason).toMatch(/yt-dlp exited 1/);
  });

  it('parses PORTOS_PROGRESS markers into onProgress percents', async () => {
    const seen = [];
    spawn.mockReturnValue(fakeChild({ code: 1, stdout: ['PORTOS_PROGRESS: 42.0%', 'PORTOS_PROGRESS:not-a-number'] }));
    await downloadAudioToTempMp3({ ...baseArgs, onProgress: (p) => seen.push(p) });
    expect(seen).toContainEqual({ percent: 42 });
    // A non-numeric percent is ignored, not forwarded as NaN.
    expect(seen.some((p) => Number.isNaN(p.percent))).toBe(false);
  });

  it('registers the process then clears it on exit', async () => {
    const registered = [];
    spawn.mockReturnValue(fakeChild({ code: 1 }));
    await downloadAudioToTempMp3({ ...baseArgs, registerProcess: (p) => registered.push(p) });
    expect(registered).toHaveLength(2);
    expect(registered[0]).not.toBeNull(); // the child
    expect(registered[1]).toBeNull(); // cleared after close
  });
});
