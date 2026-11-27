import { describe, it, expect, vi, beforeEach } from 'vitest';
import { acquireBackupSnapshotCut, _backupSnapshotWaitersForTests } from '../../lib/backupSnapshotBoundary.js';

// #2386 — exactly-once terminal handling for the timeline renderer that
// distinguishes a pre-spawn failure (finalize immediately) from a post-spawn
// error such as a failed kill (retain process + project-mutex ownership until
// 'close'). Drives a fake ffmpeg child process through error/close sequences
// before AND after 'spawn'.

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
    p.stdout = makeEmitter();
    p.stderr = makeEmitter();
    p.kill = () => {};
    procs.push(p);
    return p;
  };
  return { procs, spawn };
});

vi.mock('../../lib/childProcess.js', () => ({ spawn: h.spawn }));
// The file mocks below cannot read a real maintenance journal.
vi.mock('../../lib/databaseMaintenanceJournal.js', async importOriginal => ({
  ...await importOriginal(),
  assertDatabaseAdmission: () => {},
}));
vi.mock('fs', () => ({ existsSync: vi.fn(() => true) }));
vi.mock('fs/promises', () => ({ unlink: vi.fn(async () => {}) }));
vi.mock('../../lib/fileUtils.js', () => ({
  ensureDir: vi.fn(async () => {}),
  atomicWrite: vi.fn(async () => {}),
  readJSONFile: vi.fn(async () => []),
  PATHS: { videos: '/data/videos', videoThumbnails: '/data/thumbs', data: '/data' },
}));
vi.mock('../../lib/sseUtils.js', () => ({
  broadcastSse: vi.fn(),
  attachSseClient: vi.fn(),
  closeJobAfterDelay: vi.fn(),
}));
vi.mock('../../lib/ffmpeg.js', () => ({
  findFfmpeg: vi.fn(async () => '/usr/bin/ffmpeg'),
  hasAudioStream: vi.fn(async () => false),
  safeUnder: (root, name) => (name ? `${root}/${name}` : null),
  generateThumbnail: vi.fn(async () => 'thumb.jpg'),
  probeVideoDuration: vi.fn(async () => null), // no bed probing in these render-lifecycle cases
  bt709TagFilter: vi.fn(async () => null), // no setparams on this stub build
  BT709_CONTAINER_ARGS: ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'],
}));
vi.mock('../../lib/processEnv.js', () => ({
  safeChildProcessOptions: (options = {}) => ({ ...options, env: {}, windowsHide: true }),
}));
vi.mock('../../lib/killWithEscalation.js', () => ({ killWithEscalation: vi.fn() }));
vi.mock('../videoGen/history.js', () => ({
  loadHistory: vi.fn(),
  mutateVideoHistory: vi.fn(async (fn) => fn([])),
}));

import { renderProject, getRenderJobStatus, cancelRender } from './local.js';
import { unlink } from 'fs/promises';
import { CANCEL_ALREADY_TERMINAL } from '../../lib/cancelResponse.js';
import { findFfmpeg } from '../../lib/ffmpeg.js';
import { killWithEscalation } from '../../lib/killWithEscalation.js';
import { broadcastSse } from '../../lib/sseUtils.js';
import { readJSONFile } from '../../lib/fileUtils.js';
import { loadHistory, mutateVideoHistory } from '../videoGen/history.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const lastProc = () => h.procs[h.procs.length - 1];

const prime = (projectId) => {
  readJSONFile.mockResolvedValue([
    { id: projectId, name: 'P', clips: [{ clipId: 'c1', inSec: 0, outSec: 2 }] },
  ]);
  loadHistory.mockResolvedValue([
    { id: 'c1', filename: 'a.mp4', numFrames: 48, fps: 24, width: 768, height: 512 },
  ]);
};

beforeEach(() => {
  vi.clearAllMocks();
  h.procs.length = 0;
});

describe('renderProject admission and cancellation', () => {
  it('reserves a project before async setup and only offers an attachable job ID', async () => {
    const pid = 'timeline-concurrent';
    prime(pid);
    const entered = Promise.withResolvers();
    const resume = Promise.withResolvers();
    findFfmpeg.mockImplementationOnce(() => {
      entered.resolve();
      return resume.promise;
    });

    const firstRender = renderProject(pid);
    try {
      await entered.promise;
      const conflict = await renderProject(pid).catch((err) => err);
      expect(conflict).toMatchObject({ status: 409, code: 'RENDER_IN_PROGRESS' });
      expect(conflict.context.jobId).toBeUndefined();
      expect(h.procs).toHaveLength(0);
    } finally {
      resume.resolve('/usr/bin/ffmpeg');
    }

    const { jobId } = await firstRender;
    expect(h.procs).toHaveLength(1);
    await expect(renderProject(pid)).rejects.toMatchObject({ status: 409, code: 'RENDER_IN_PROGRESS', context: { jobId } });
    lastProc().emit('close', 0, null);
    await vi.waitFor(() => expect(getRenderJobStatus(jobId).status).toBe('complete'));
  });

  it('releases the reservation when setup fails before spawn', async () => {
    const pid = 'timeline-setup-error';
    prime(pid);
    findFfmpeg.mockResolvedValueOnce(null);
    await expect(renderProject(pid)).rejects.toMatchObject({ code: 'FFMPEG_MISSING' });

    const { jobId } = await renderProject(pid);
    expect(h.procs).toHaveLength(1);
    lastProc().emit('close', 0, null);
    await vi.waitFor(() => expect(getRenderJobStatus(jobId).status).toBe('complete'));
  });

  it('holds the project until ffmpeg exits and discards the canceled encode', async () => {
    const pid = 'timeline-cancel';
    prime(pid);
    const { jobId } = await renderProject(pid);
    const proc = lastProc();
    proc.emit('spawn');

    expect(cancelRender(jobId)).toBe(true);
    expect(killWithEscalation).toHaveBeenCalledWith(proc, expect.objectContaining({ stillRunning: expect.any(Function) }));
    await expect(renderProject(pid)).rejects.toMatchObject({ code: 'RENDER_IN_PROGRESS', context: { jobId } });
    proc.emit('close', 255, null); // ffmpeg handled SIGTERM and chose an exit code
    await vi.waitFor(() => expect(broadcastSse).toHaveBeenCalledWith(expect.objectContaining({ id: jobId }), { type: 'canceled', error: 'Render cancelled' }));
    expect(unlink).toHaveBeenCalledOnce();
    expect(mutateVideoHistory).not.toHaveBeenCalled();
    expect(cancelRender(jobId)).toBe(CANCEL_ALREADY_TERMINAL);
    expect(cancelRender('missing-job')).toBe(false);
  });
});

describe('renderProject terminal handling (#2386)', () => {
  it('keeps a finished encode pending through a long cut and records it after release', async () => {
    const pid = 'timeline-backup';
    prime(pid);
    const { jobId } = await renderProject(pid);
    const proc = lastProc();
    proc.emit('spawn');
    const release = await acquireBackupSnapshotCut();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      proc.emit('close', 0, null);
      await vi.waitFor(() => expect(_backupSnapshotWaitersForTests().publications).toBe(1));
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(mutateVideoHistory).not.toHaveBeenCalled();
      expect(getRenderJobStatus(jobId).status).toBe('running');
      expect(cancelRender(jobId)).toBe(CANCEL_ALREADY_TERMINAL);
    } finally {
      release();
      vi.useRealTimers();
    }
    await vi.waitFor(() => expect(getRenderJobStatus(jobId).status).toBe('complete'));
    expect(mutateVideoHistory).toHaveBeenCalledOnce();
  });
  it('finalizes immediately on a PRE-spawn error and releases the project slot', async () => {
    const pid = 'tpre-1';
    prime(pid);
    const { jobId } = await renderProject(pid);
    const proc = lastProc();

    proc.emit('error', new Error('spawn ENOENT')); // no 'spawn' first
    await tick();

    expect(getRenderJobStatus(jobId).status).toBe('error');
    expect(getRenderJobStatus(jobId).error).toMatch(/Failed to spawn ffmpeg/);

    // Slot released — a re-render reaches spawn again instead of 409ing.
    const again = await renderProject(pid);
    expect(again.jobId).toBeTruthy();
    expect(again.jobId).not.toBe(jobId);
  });

  it('retains the slot on a POST-spawn error until close (no overlapping render)', async () => {
    const pid = 'tpost-1';
    prime(pid);
    const { jobId } = await renderProject(pid);
    const proc = lastProc();

    proc.emit('spawn');
    proc.emit('error', new Error('kill EPERM')); // failed kill, process still running
    await tick();

    expect(getRenderJobStatus(jobId).status).toBe('running');
    await expect(renderProject(pid)).rejects.toMatchObject({
      status: 409, code: 'RENDER_IN_PROGRESS', context: { jobId },
    });

    proc.emit('close', 1, null); // sole terminal handler for the post-spawn error
    await tick();
    expect(getRenderJobStatus(jobId).status).toBe('error');

    const again = await renderProject(pid);
    expect(again.jobId).not.toBe(jobId);
  });

  it('handles terminal state exactly once (a stray close after a pre-spawn error is a no-op)', async () => {
    const pid = 'tonce-1';
    prime(pid);
    const { jobId } = await renderProject(pid);
    const proc = lastProc();

    proc.emit('error', new Error('spawn ENOENT'));
    await tick();
    const afterError = getRenderJobStatus(jobId);
    proc.emit('close', 1, null); // must not re-finalize
    await tick();

    // Status unchanged by the stray close; still the pre-spawn error outcome.
    expect(afterError.status).toBe('error');
    expect(getRenderJobStatus(jobId).status).toBe('error');
    expect(getRenderJobStatus(jobId).error).toMatch(/Failed to spawn ffmpeg/);
  });

  it('a late stray error after a successful close does not clobber the completed job', async () => {
    const pid = 'tlate-1';
    prime(pid);
    const { jobId } = await renderProject(pid);
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
