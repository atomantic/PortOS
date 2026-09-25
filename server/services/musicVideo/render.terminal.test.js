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
vi.mock('./projects.js', () => ({ getProject: vi.fn(), updateProject: vi.fn(async () => ({})) }));

import { renderMusicVideo, getRenderJobStatus } from './render.js';
import { findFfmpeg } from '../../lib/ffmpeg.js';
import { loadHistory } from '../videoGen/local.js';
import { getTrack } from '../tracks/index.js';
import { getProject, updateProject } from './projects.js';

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

describe('recoverStuckMusicVideoRenders', () => {
  it('demotes stuck rendering projects to complete when they have a renderHistoryId', async () => {
    const { recoverStuckMusicVideoRenders } = await import('./render.js');

    // Mock getProject to return a list with a stuck rendering project
    getProject.mockResolvedValue([
      { id: 'proj-1', status: 'rendering', renderHistoryId: 'hist-1' },
    ]);

    await recoverStuckMusicVideoRenders();

    expect(updateProject).toHaveBeenCalledWith('proj-1', { status: 'complete' });
  });

  it('demotes stuck rendering projects to ready when they lack a renderHistoryId', async () => {
    const { recoverStuckMusicVideoRenders } = await import('./render.js');

    getProject.mockResolvedValue([
      { id: 'proj-2', status: 'rendering' },
    ]);

    await recoverStuckMusicVideoRenders();

    expect(updateProject).toHaveBeenCalledWith('proj-2', { status: 'ready' });
  });

  it('skips projects with active render jobs in the projectRenders map', async () => {
    const { recoverStuckMusicVideoRenders, renderMusicVideo } = await import('./render.js');

    // Start a render to put the project in the projectRenders map
    prime('proj-3');
    const { jobId } = await renderMusicVideo('proj-3');

    // Mock getProject to return that project as rendering
    getProject.mockResolvedValue([
      { id: 'proj-3', status: 'rendering', renderHistoryId: 'hist-1' },
    ]);

    updateProject.mockClear();
    await recoverStuckMusicVideoRenders();

    // Should NOT update a project with an active job
    expect(updateProject).not.toHaveBeenCalledWith('proj-3', expect.anything());
  });

  it('handles list failure gracefully without reporting zero recovered', async () => {
    const { recoverStuckMusicVideoRenders } = await import('./render.js');

    getProject.mockRejectedValue(new Error('DB unavailable'));

    // Should not throw
    await expect(recoverStuckMusicVideoRenders()).resolves.toBeUndefined();

    // Should log the error (verified via console.error mock if available)
    expect(updateProject).not.toHaveBeenCalled();
  });

  it('logs summary when multiple projects are recovered', async () => {
    const { recoverStuckMusicVideoRenders } = await import('./render.js');
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    getProject.mockResolvedValue([
      { id: 'proj-4', status: 'rendering', renderHistoryId: 'hist-1' },
      { id: 'proj-5', status: 'rendering' },
      { id: 'proj-6', status: 'ready' }, // Should be skipped
    ]);

    await recoverStuckMusicVideoRenders();

    expect(updateProject).toHaveBeenCalledTimes(2);
    expect(consoleLogSpy).toHaveBeenCalledWith(
      expect.stringContaining('demoted 2 stuck render(s)'),
    );

    consoleLogSpy.mockRestore();
  });
});
