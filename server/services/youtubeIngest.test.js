import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readdir, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { basename, join } from 'path';

const testDoubles = vi.hoisted(() => ({
  spawn: vi.fn(),
  downloadAudioToTempMp3: vi.fn(),
  copyFileGuarded: vi.fn(),
  unlinkGuarded: vi.fn(),
  rename: vi.fn(),
}));

// The ingest module pulls in the brain/cos/media graphs at import time for its
// spawn path. Stub the heavy edges so this suite exercises the service-level
// contracts (URL gate, cancel) without a live store. The pure formatting and
// parsing contracts moved to `lib/youtubeIngestFormat.test.js`, which needs
// none of this.
vi.mock('./apps.js', () => ({ getAppById: vi.fn(), PORTOS_APP_ID: 'portos-default' }));
vi.mock('./brain.js', () => ({ createLinkFromUrl: vi.fn() }));
vi.mock('./brainStorage.js', () => ({ getLinkById: vi.fn(), getLinkByUrl: vi.fn() }));
vi.mock('./brainJournal.js', () => ({ getSettings: vi.fn(async () => ({ obsidianVaultId: null })) }));
vi.mock('./cosTaskStore.js', () => ({ addTask: vi.fn() }));
vi.mock('./humanActivity.js', () => ({ recordEvents: vi.fn() }));
vi.mock('./videoGen/history.js', () => ({ mutateVideoHistory: vi.fn() }));
vi.mock('./videoGen/events.js', () => ({ videoGenEvents: { emit: vi.fn() } }));
vi.mock('./videoDownload.js', () => ({ buildDownloadHistoryEntry: vi.fn() }));
vi.mock('../lib/childProcess.js', async (importOriginal) => ({
  ...(await importOriginal()),
  spawn: (...args) => testDoubles.spawn(...args),
}));
vi.mock('../lib/ffmpeg.js', async (importOriginal) => ({
  ...(await importOriginal()),
  findFfmpeg: vi.fn(async () => '/test/ffmpeg'),
}));
vi.mock('../lib/ytdlp.js', async (importOriginal) => ({
  ...(await importOriginal()),
  findYtDlp: vi.fn(async () => '/test/yt-dlp'),
}));
vi.mock('../lib/backupSnapshotBoundary.js', () => ({ withBackupAssetPublication: vi.fn((work) => work()) }));
vi.mock('fs/promises', async (importOriginal) => ({
  ...(await importOriginal()),
  rename: (...args) => testDoubles.rename(...args),
}));
vi.mock('../lib/fileUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  const { lazyTempDataRoot, makePathsProxy } = await import('../lib/mockPathsDataRoot.js');
  const proxied = makePathsProxy(actual, { dataRoot: () => lazyTempDataRoot('youtube-ingest-workflow-') });
  return new Proxy(proxied, {
    get(target, prop, receiver) {
      if (prop === 'copyFileGuarded') return testDoubles.copyFileGuarded;
      if (prop === 'unlinkGuarded') return testDoubles.unlinkGuarded;
      return Reflect.get(target, prop, receiver);
    },
  });
});
vi.mock('./ytdlpAudioImport.js', async (importOriginal) => ({
  ...(await importOriginal()),
  downloadAudioToTempMp3: (...args) => testDoubles.downloadAudioToTempMp3(...args),
}));

import {
  startYoutubeIngest,
  YOUTUBE_INGEST_URL_RE,
  assertYoutubeIngestUrl,
  cancelYoutubeIngest,
  __testing,
} from './youtubeIngest.js';

afterAll(async () => {
  const { cleanupTempDataRoots } = await import('../lib/mockPathsDataRoot.js');
  cleanupTempDataRoots();
});

describe('YouTube ingest URL allowlist', () => {
  it('accepts every single-video URL shape', () => {
    for (const url of [
      'https://youtu.be/oCnxnaVg0bY',
      'https://www.youtube.com/watch?v=oCnxnaVg0bY',
      'https://m.youtube.com/watch?v=oCnxnaVg0bY&t=42s',
      'https://music.youtube.com/watch?v=oCnxnaVg0bY',
      'https://youtube.com/shorts/oCnxnaVg0bY',
      'https://www.youtube.com/live/oCnxnaVg0bY',
      'https://www.youtube.com/embed/oCnxnaVg0bY',
    ]) {
      expect(YOUTUBE_INGEST_URL_RE.test(url)).toBe(true);
      expect(() => assertYoutubeIngestUrl(url)).not.toThrow();
    }
  });

  it('rejects playlists, channels, handles, and non-YouTube URLs', () => {
    for (const url of [
      'https://www.youtube.com/playlist?list=PLabcdefghij',
      'https://www.youtube.com/@somechannel',
      'https://www.youtube.com/c/somechannel',
      'https://vimeo.com/123456789',
      'https://x.com/someone/status/123',
      'not a url',
    ]) {
      expect(() => assertYoutubeIngestUrl(url)).toThrow(/single-video YouTube URL/);
    }
  });
});

describe('cancelYoutubeIngest', () => {
  beforeEach(() => __testing.ingestJobs.clear());

  it('returns false for an unknown job', () => {
    expect(cancelYoutubeIngest('nope')).toBe(false);
  });

  it('flags a job with no live child so the between-steps cancel is still honored', () => {
    // An ingest is a chain of steps; cancelling between two of them (or during
    // the non-spawn persist phase) has no process to signal, so the flag — not
    // the kill — is what stops it.
    const job = { id: 'j', clients: [], process: null, canceled: false };
    __testing.ingestJobs.set('j', job);
    expect(cancelYoutubeIngest('j')).toBe(true);
    expect(job.canceled).toBe(true);
  });

  it('signals the running yt-dlp child and escalates if it survives the grace window', () => {
    vi.useFakeTimers();
    const proc = { exitCode: null, signalCode: null, kill: vi.fn() };
    const job = { id: 'j', clients: [], process: proc, canceled: false };
    __testing.ingestJobs.set('j', job);

    expect(cancelYoutubeIngest('j')).toBe(true);
    expect(job.canceled).toBe(true);
    expect(proc.kill).toHaveBeenCalledWith('SIGTERM');

    vi.advanceTimersByTime(8000);
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
    vi.useRealTimers();
  });
});

// A stale target must fail before downloads or a CoS dispatch can start.
describe('analysis app admission', () => {
  it('rejects a missing or archived target instead of falling back to PortOS', async () => {
    const { getAppById } = await import('./apps.js');
    for (const app of [null, { id: 'example', repoPath: '/example', archived: true }]) {
      getAppById.mockResolvedValue(app);
      await expect(startYoutubeIngest({
        url: 'https://youtu.be/oCnxnaVg0bY', agentPrompt: 'Improve search.', targetAppId: 'example',
      })).rejects.toMatchObject({ code: 'APP_NOT_FOUND' });
      expect(getAppById).toHaveBeenLastCalledWith('example');
    }
  });
});

describe('YouTube ingest audio handoff', () => {
  let actualFileUtils;
  let actualFs;
  let downloadedPaths;
  let unrelatedTempPath;
  let audioBytes;

  beforeEach(async () => {
    __testing.ingestJobs.clear();
    actualFileUtils = await vi.importActual('../lib/fileUtils.js');
    actualFs = await vi.importActual('fs/promises');
    downloadedPaths = [];
    unrelatedTempPath = null;
    audioBytes = Buffer.from('complete mp3 bytes');

    testDoubles.spawn.mockReset().mockImplementation(() => {
      const proc = new EventEmitter();
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.kill = vi.fn();
      queueMicrotask(() => {
        proc.stdout.end(JSON.stringify({ id: 'oCnxnaVg0bY', title: 'Ingested talk', channel: 'Test channel', duration: 120 }));
        proc.stderr.end();
        proc.emit('close', 0, null);
      });
      return proc;
    });
    testDoubles.downloadAudioToTempMp3.mockReset().mockImplementation(async ({ tempPrefix }) => {
      const outPath = join(tmpdir(), `${tempPrefix}.mp3`);
      const intermediatePath = join(tmpdir(), `${tempPrefix}.webm`);
      await writeFile(outPath, audioBytes);
      await writeFile(intermediatePath, 'yt-dlp intermediate');
      downloadedPaths.push(outPath, intermediatePath);
      return { outcome: 'complete', outPath, title: 'Ingested talk' };
    });
    testDoubles.copyFileGuarded.mockReset().mockImplementation((...args) => actualFileUtils.copyFileGuarded(...args));
    testDoubles.unlinkGuarded.mockReset().mockImplementation((...args) => actualFileUtils.unlinkGuarded(...args));
    testDoubles.rename.mockReset().mockImplementation((from, to) => {
      if (basename(from).startsWith('portos-yt-ingest-')) {
        throw Object.assign(new Error('cross-device rename'), { code: 'EXDEV' });
      }
      return actualFs.rename(from, to);
    });
    const { getLinkById, getLinkByUrl } = await import('./brainStorage.js');
    getLinkById.mockResolvedValue(null);
    getLinkByUrl.mockResolvedValue(null);
    const { createLinkFromUrl } = await import('./brain.js');
    createLinkFromUrl.mockResolvedValue({ id: 'test-link' });
    const { recordEvents } = await import('./humanActivity.js');
    recordEvents.mockResolvedValue(undefined);
  });

  afterEach(async () => {
    await Promise.all([...downloadedPaths, unrelatedTempPath].filter(Boolean).map((path) => rm(path, { force: true })));
  });

  async function runAudioIngest() {
    const { attachIngestSseClient } = await import('./youtubeIngest.js');
    let resolveTerminal;
    const terminal = new Promise((resolve) => { resolveTerminal = resolve; });
    const response = {
      req: new EventEmitter(),
      writeHead: vi.fn(),
      end: vi.fn(),
      write: (frame) => {
        const payload = JSON.parse(frame.replace(/^data: /, '').trim());
        if (['complete', 'error', 'canceled'].includes(payload.type)) {
          // Terminal SSE must not race owned-temp cleanup. Observe files at
          // the public boundary instead of polling after the job completes.
          Promise.all(downloadedPaths.map(async (path) => {
            try { await readFile(path); return true; }
            catch (error) { if (error.code === 'ENOENT') return false; throw error; }
          })).then((tempPresence) => resolveTerminal({ payload, tempPresence }));
        }
      },
    };
    const { jobId } = await startYoutubeIngest({
      url: 'https://youtu.be/oCnxnaVg0bY',
      captureTranscript: false,
      ingestAudio: true,
    });
    expect(attachIngestSseClient(jobId, response)).toBe(true);
    return { terminal, response, jobId };
  }

  it('copies completed audio into the ingest directory without renaming across filesystems', async () => {
    const { terminal } = await runAudioIngest();
    const { payload, tempPresence } = await terminal;
    expect(payload.type).toBe('complete');
    expect(tempPresence).toEqual(downloadedPaths.map(() => false));

    const { PATHS } = await import('../lib/fileUtils.js');
    const audioPath = join(PATHS.brain, 'youtube', 'oCnxnaVg0bY.mp3');
    expect(await readFile(audioPath)).toEqual(audioBytes);
    expect(testDoubles.copyFileGuarded).toHaveBeenCalledWith(downloadedPaths[0], expect.stringContaining('.mp3.part'));
    expect(testDoubles.rename).not.toHaveBeenCalledWith(downloadedPaths[0], audioPath);
    for (const path of downloadedPaths) await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('cleans this job after a post-download copy failure and preserves prior audio', async () => {
    const { PATHS } = await import('../lib/fileUtils.js');
    const audioPath = join(PATHS.brain, 'youtube', 'oCnxnaVg0bY.mp3');
    await actualFs.mkdir(join(PATHS.brain, 'youtube'), { recursive: true });
    await writeFile(audioPath, 'previous durable audio');
    unrelatedTempPath = join(tmpdir(), `portos-yt-ingest-other-${Date.now()}.mp3`);
    await writeFile(unrelatedTempPath, 'other job');
    testDoubles.copyFileGuarded.mockImplementationOnce(async (source, staging) => {
      await actualFileUtils.copyFileGuarded(source, staging);
      await writeFile(staging, 'partial');
      throw new Error('copy interrupted');
    });

    const { terminal } = await runAudioIngest();
    const { payload, tempPresence } = await terminal;
    expect(payload).toMatchObject({ type: 'error', error: 'copy interrupted' });
    expect(tempPresence).toEqual(downloadedPaths.map(() => false));
    expect(await readFile(audioPath, 'utf-8')).toBe('previous durable audio');
    for (const path of downloadedPaths) await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await readFile(unrelatedTempPath, 'utf-8')).toBe('other job');
  });

  it('honors cancellation during staging before replacing prior audio', async () => {
    const { PATHS } = await import('../lib/fileUtils.js');
    const audioPath = join(PATHS.brain, 'youtube', 'oCnxnaVg0bY.mp3');
    await actualFs.mkdir(join(PATHS.brain, 'youtube'), { recursive: true });
    await writeFile(audioPath, 'previous durable audio');

    let copyStarted;
    const started = new Promise((resolve) => { copyStarted = resolve; });
    let releaseCopy;
    const copyGate = new Promise((resolve) => { releaseCopy = resolve; });
    testDoubles.copyFileGuarded.mockImplementationOnce(async (source, staging) => {
      await actualFileUtils.copyFileGuarded(source, staging);
      copyStarted();
      await copyGate;
    });

    const { terminal, jobId } = await runAudioIngest();
    await started;
    expect(cancelYoutubeIngest(jobId)).toBe(true);
    releaseCopy();

    const { payload, tempPresence } = await terminal;
    expect(payload.type).toBe('canceled');
    expect(tempPresence).toEqual(downloadedPaths.map(() => false));
    expect(await readFile(audioPath, 'utf-8')).toBe('previous durable audio');
    await expect(readFile(join(PATHS.brain, 'youtube', `.${jobId}.mp3.part`))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('logs a staging cleanup failure without failing published audio', async () => {
    const cleanupError = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    testDoubles.unlinkGuarded.mockImplementation(async (path) => {
      if (path.endsWith('.mp3.part')) throw cleanupError;
      return actualFileUtils.unlinkGuarded(path);
    });
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const { terminal } = await runAudioIngest();
      const { payload } = await terminal;
      expect(payload.type).toBe('complete');
      expect(errorLog).toHaveBeenCalledWith(expect.stringMatching(/YouTube ingest staging cleanup failed.*permission denied/));

      const { PATHS } = await import('../lib/fileUtils.js');
      const audioPath = join(PATHS.brain, 'youtube', 'oCnxnaVg0bY.mp3');
      expect(await readFile(audioPath)).toEqual(audioBytes);
    } finally {
      errorLog.mockRestore();
      const stagingPath = testDoubles.copyFileGuarded.mock.calls.at(-1)?.[1];
      if (stagingPath) await actualFileUtils.unlinkGuarded(stagingPath).catch(() => {});
    }
  });
});
