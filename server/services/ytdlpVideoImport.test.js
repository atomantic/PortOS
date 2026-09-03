/**
 * The shared yt-dlp video core's output detection.
 *
 * These cases moved here from videoDownload.test.js when the yt-dlp spawn was
 * extracted for the YouTube brain ingest: the "don't assume .mp4, don't pick up
 * an intermediate" rule is a property of the core both callers use, not of the
 * Dev Tools downloader that used to own it.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'fs/promises';
import { EventEmitter } from 'events';
import { join } from 'path';
import { tmpdir } from 'os';

vi.mock('../lib/childProcess.js', async (importOriginal) => ({ ...(await importOriginal()), spawn: vi.fn() }));

const { spawn } = await import('../lib/childProcess.js');
const { findProducedFile, cleanupProducedFiles, downloadVideoToDir } = await import('./ytdlpVideoImport.js');

describe('findProducedFile (robust output detection)', () => {
  let dir;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'viddl-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('prefers an exact .mp4 over other candidates', async () => {
    await writeFile(join(dir, 'downloaded-x.mp4'), 'v');
    await writeFile(join(dir, 'downloaded-x.webm'), 'v');
    expect(await findProducedFile('downloaded-x', dir)).toBe('downloaded-x.mp4');
  });

  it('finds a non-mp4 single-file result (the .mp4-assumption bug)', async () => {
    await writeFile(join(dir, 'downloaded-y.webm'), 'v');
    expect(await findProducedFile('downloaded-y', dir)).toBe('downloaded-y.webm');
  });

  it('ignores in-progress and format-fragment intermediates', async () => {
    await writeFile(join(dir, 'downloaded-z.f137.mp4'), 'v'); // fragment
    await writeFile(join(dir, 'downloaded-z.mp4.part'), 'v'); // partial
    await writeFile(join(dir, 'downloaded-z.webm.ytdl'), 'v'); // sidecar
    expect(await findProducedFile('downloaded-z', dir)).toBeNull();
  });

  it('does not match a different job id', async () => {
    await writeFile(join(dir, 'downloaded-other.mp4'), 'v');
    expect(await findProducedFile('downloaded-mine', dir)).toBeNull();
  });

  it('returns null for a directory that does not exist', async () => {
    expect(await findProducedFile('downloaded-x', join(dir, 'nope'))).toBeNull();
  });
});

describe('cleanupProducedFiles', () => {
  let dir;
  beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'viddl-clean-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  it('removes every file the prefix touched, including intermediates, and spares others', async () => {
    for (const name of ['downloaded-a.mp4', 'downloaded-a.f137.mp4', 'downloaded-a.mp4.part', 'downloaded-b.mp4']) {
      await writeFile(join(dir, name), 'v');
    }
    await cleanupProducedFiles('downloaded-a', dir);
    // The whole point of globbing the prefix: a cancelled run leaves fragments
    // whose exact names aren't knowable up front.
    expect(await findProducedFile('downloaded-a', dir)).toBeNull();
    expect(await findProducedFile('downloaded-b', dir)).toBe('downloaded-b.mp4');
  });
});

describe('downloadVideoToDir — argv and failure prose', () => {
  let dir;
  beforeEach(async () => { vi.clearAllMocks(); dir = await mkdtemp(join(tmpdir(), 'viddl-run-')); });
  afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

  const baseArgs = () => ({
    url: 'https://example.com/clip',
    ytDlp: '/usr/local/bin/yt-dlp',
    ffmpeg: '/usr/local/bin/ffmpeg',
    outDir: dir,
    filePrefix: 'downloaded-run',
    maxBytes: 2 * 1024 * 1024 * 1024,
    maxDurationSec: 1800,
    onProgress: () => {},
    registerProcess: () => {},
  });

  // Built inside mockImplementation, not handed to mockReturnValue: downloadVideoToDir
  // awaits ensureDir before spawning, so a child constructed up front would fire its
  // close during that await, before any listener is attached.
  const mockChild = ({ code = 0, signal = null } = {}) => spawn.mockImplementation(() => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    setImmediate(() => proc.emit('close', code, signal));
    return proc;
  });

  it('keeps the video format chain and both --match-filters alongside the shared marker args', async () => {
    mockChild({ code: 1 });
    await downloadVideoToDir(baseArgs());

    const [bin, args] = spawn.mock.calls[0];
    expect(bin).toBe('/usr/local/bin/yt-dlp');
    expect(args).toEqual(expect.arrayContaining(['--merge-output-format', 'mp4']));
    expect(args).toEqual(expect.arrayContaining(['--remux-video', 'mp4']));
    expect(args).toEqual(expect.arrayContaining(['--match-filters', 'duration <= 1800']));
    expect(args).toEqual(expect.arrayContaining(['--match-filters', '!duration']));
    expect(args).toEqual(expect.arrayContaining(['--print', 'PORTOS_TITLE:%(title)s']));
    expect(args[args.length - 1]).toBe('https://example.com/clip');
  });

  it('names the duration and size bounds when a clean exit produced nothing', async () => {
    mockChild({ code: 0 });
    const result = await downloadVideoToDir(baseArgs());
    expect(result.outcome).toBe('failed');
    expect(result.reason).toMatch(/no video was produced/);
    expect(result.reason).toMatch(/30 minutes/);
    expect(result.reason).toMatch(/2GB/);
  });

  it('reports canceled on SIGTERM', async () => {
    mockChild({ code: null, signal: 'SIGTERM' });
    await expect(downloadVideoToDir(baseArgs())).resolves.toEqual({ outcome: 'canceled' });
  });
});
