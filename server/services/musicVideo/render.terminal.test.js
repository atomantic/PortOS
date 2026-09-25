import { describe, it, expect, vi, beforeEach } from 'vitest';

// #2386 — exactly-once terminal handling for the music-video renderer that
// distinguishes a pre-spawn failure (finalize immediately) from a post-spawn
// error such as a failed kill (retain process + project-mutex ownership until
// 'close'). These tests drive a fake ffmpeg child process and emit the
// error/close sequences before AND after 'spawn'.

// A tiny synchronous event emitter — avoids pulling `events` into the hoisted
// mock factory (which runs before imports resolve).
const h = vi.hoisted(() => {
  const procs = [];
  const makeEmitter = () => {
    const listeners = {};
    return {
      on(ev, fn) { (listeners[ev] ||= []).push(fn); return this; },
      emit(ev, ...args) {
        const fns = listeners[ev] || [];
        for (const fn of fns) fn(...args);
        return fns.length > 0;
      },
    };
  };
  const spawn = () => {
    const p = makeEmitter();
    p.stderr = makeEmitter();
    p.kill = () => {};
    procs.push(p);
    return p;
  };
  return { procs, spawn };
});

vi.mock('../../lib/childProcess.js', () => ({ spawn: h.spawn }));
vi.mock('fs', () => ({ existsSync: vi.fn(() => true) }));
vi.mock('fs/promises', () => ({ unlink: vi.fn(async () => {}) }));
vi.mock('../../lib/fileUtils.js', () => ({
  ensureDir: vi.fn(async () => {}),
  PATHS: { videos: '/data/videos', videoThumbnails: '/data/thumbs', music: '/data/music', data: '/data' },
}));
vi.mock('../../lib/sseUtils.js', () => ({
  broadcastSse: vi.fn(),
  attachSseClient: vi.fn(),
  closeJobAfterDelay: vi.fn(),
}));
vi.mock('../../lib/ffmpeg.js', () => ({
  findFfmpeg: vi.fn(async () => '/usr/bin/ffmpeg'),
  safeUnder: (root, name) => (name ? `${root}/${name}` : null),
  generateThumbnail: vi.fn(async () => 'thumb.jpg'),
  probeVideoDuration: vi.fn(async () => 30),
}));
vi.mock('../../lib/processEnv.js', () => ({
  safeChildProcessOptions: (options = {}) => ({ ...options, env: {}, windowsHide: true }),
}));
vi.mock('../../lib/killWithEscalation.js', () => ({ killWithEscalation: vi.fn() }));
vi.mock('../videoGen/local.js', () => ({
  loadHistory: vi.fn(),
  mutateVideoHistory: vi.fn(async (fn) => fn([])),
}));
vi.mock('../tracks/index.js', () => ({ getTrack: vi.fn() }));
vi.mock('./projects.js', () => ({ getProject: vi.fn(), listProjects: vi.fn(async () => []), updateProject: vi.fn(async () => ({})) }));

import { renderMusicVideo, getRenderJobStatus } from './render.js';
import { findFfmpeg } from '../../lib/ffmpeg.js';
import { loadHistory } from '../videoGen/local.js';
import { getTrack } from '../tracks/index.js';
import { getProject, listProjects, updateProject } from './projects.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const lastProc = () => h.procs[h.procs.length - 1];

const prime = (projectId) => {
  getProject.mockResolvedValue({
    id: projectId, name: 'P', trackId: 't1', status: 'ready',
    scenes: [{ sceneId: 's1', order: 0, videoHistoryId: 'h1' }],
  });
  getTrack.mockResolvedValue({ audioFilename: 'song.wav' });
  loadHistory.mockResolvedValue([{ id: 'h1', filename: 'a.mp4', width: 768, height: 512, fps: 24, numFrames: 48 }]);
  findFfmpeg.mockResolvedValue('/usr/bin/ffmpeg');
};

beforeEach(() => {
  vi.clearAllMocks();
  h.procs.length = 0;
});

describe('renderMusicVideo terminal handling (#2386)', () => {
  it('finalizes immediately on a PRE-spawn error and releases the project slot', async () => {
    const pid = 'pre-1';
    prime(pid);
    const { jobId } = await renderMusicVideo(pid);
    const proc = lastProc();

    // No 'spawn' event → genuine spawn failure. 'close' will not follow.
    proc.emit('error', new Error('spawn ENOENT'));
    await tick();

    expect(getRenderJobStatus(jobId).status).toBe('error');
    expect(getRenderJobStatus(jobId).error).toMatch(/Failed to spawn ffmpeg/);
    expect(updateProject).toHaveBeenCalledWith(pid, { status: 'failed' });

    // Slot released — a re-render reaches spawn again instead of 409ing.
    const again = await renderMusicVideo(pid);
    expect(again.jobId).toBeTruthy();
    expect(again.jobId).not.toBe(jobId);
  });

  it('retains the slot on a POST-spawn error until close (no overlapping render)', async () => {
    const pid = 'post-1';
    prime(pid);
    const { jobId } = await renderMusicVideo(pid);
    const proc = lastProc();

    proc.emit('spawn'); // child is live
    proc.emit('error', new Error('kill EPERM')); // failed kill, process still running
    await tick();

    // NOT finalized: status stays running, project not marked failed, slot held.
    expect(getRenderJobStatus(jobId).status).toBe('running');
    expect(updateProject).not.toHaveBeenCalledWith(pid, { status: 'failed' });
    await expect(renderMusicVideo(pid)).rejects.toMatchObject({
      status: 409, code: 'RENDER_IN_PROGRESS', context: { jobId },
    });

    // 'close' is the sole terminal handler for the post-spawn error.
    proc.emit('close', 1, null);
    await tick();
    expect(getRenderJobStatus(jobId).status).toBe('error');
    expect(updateProject).toHaveBeenCalledWith(pid, { status: 'failed' });

    // Slot now released.
    const again = await renderMusicVideo(pid);
    expect(again.jobId).not.toBe(jobId);
  });

  it('handles terminal state exactly once (a stray close after a pre-spawn error is a no-op)', async () => {
    const pid = 'once-1';
    prime(pid);
    const { jobId } = await renderMusicVideo(pid);
    const proc = lastProc();

    proc.emit('error', new Error('spawn ENOENT'));
    await tick();
    proc.emit('close', 1, null); // must not re-finalize / double-release
    await tick();

    // updateProject('failed') fired exactly once for this project.
    const failedCalls = updateProject.mock.calls.filter(
      ([id, patch]) => id === pid && patch && patch.status === 'failed',
    );
    expect(failedCalls).toHaveLength(1);
    expect(getRenderJobStatus(jobId).status).toBe('error');
  });

  it('a late stray error after a successful close does not clobber the completed job', async () => {
    const pid = 'late-1';
    prime(pid);
    const { jobId } = await renderMusicVideo(pid);
    const proc = lastProc();

    proc.emit('spawn');
    proc.emit('close', 0, null); // clean success
    await tick();
    expect(getRenderJobStatus(jobId).status).toBe('complete');

    // A stray post-close 'error' (e.g. ESRCH from a kill on the dead pid) must
    // be a no-op — not overwrite lastError on the completed job.
    proc.emit('error', new Error('kill ESRCH'));
    await tick();
    expect(getRenderJobStatus(jobId).status).toBe('complete');
    expect(getRenderJobStatus(jobId).error).toBeUndefined();
  });
});


describe('status write failures are logged, not swallowed (#8430)', () => {
  it('logs a failed status→complete write and still finishes the job', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const pid = 'write-1';
    prime(pid);
    updateProject.mockImplementation(async (_id, patch) => {
      if (patch.status === 'complete') throw new Error('disk full');
      return {};
    });
    const { jobId } = await renderMusicVideo(pid);
    const proc = lastProc();
    proc.emit('spawn');
    proc.emit('close', 0, null);
    await tick();

    expect(getRenderJobStatus(jobId).status).toBe('complete');
    expect(errorSpy.mock.calls.some(([line]) => line.includes(jobId.slice(0, 8))
      && line.includes(pid) && line.includes('status→complete'))).toBe(true);
    updateProject.mockImplementation(async () => ({}));
    errorSpy.mockRestore();
  });
});

describe('recoverStuckMusicVideoRenders (#8430)', () => {
  it('demotes stale renders by history, skips live jobs and other statuses', async () => {
    const { recoverStuckMusicVideoRenders } = await import('./render.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    prime('live-1');
    await renderMusicVideo('live-1');
    updateProject.mockClear();
    listProjects.mockResolvedValueOnce([
      { id: 'done-1', status: 'rendering', renderHistoryId: 'hist-1' },
      { id: 'fresh-1', status: 'rendering' },
      { id: 'live-1', status: 'rendering' },
      { id: 'idle-1', status: 'ready' },
    ]);

    await recoverStuckMusicVideoRenders();

    expect(updateProject.mock.calls).toEqual([
      ['done-1', { status: 'complete' }],
      ['fresh-1', { status: 'ready' }],
    ]);
    expect(logSpy.mock.calls.some(([line]) => line.includes('demoted 2/2'))).toBe(true);
    logSpy.mockRestore();
  });

  it('propagates a list failure instead of reporting zero recovered', async () => {
    const { recoverStuckMusicVideoRenders } = await import('./render.js');
    listProjects.mockRejectedValueOnce(new Error('DB unavailable'));
    await expect(recoverStuckMusicVideoRenders()).rejects.toThrow('DB unavailable');
    expect(updateProject).not.toHaveBeenCalled();
  });

  it('logs a failed demotion and keeps recovering the rest', async () => {
    const { recoverStuckMusicVideoRenders } = await import('./render.js');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    listProjects.mockResolvedValueOnce([
      { id: 'bad-1', status: 'rendering' },
      { id: 'good-1', status: 'rendering' },
    ]);
    updateProject.mockRejectedValueOnce(new Error('write failed'));

    await recoverStuckMusicVideoRenders();

    expect(updateProject).toHaveBeenCalledWith('good-1', { status: 'ready' });
    expect(errorSpy.mock.calls.some(([line]) => line.includes('bad-1'))).toBe(true);
    expect(logSpy.mock.calls.some(([line]) => line.includes('demoted 1/2'))).toBe(true);
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });
});
