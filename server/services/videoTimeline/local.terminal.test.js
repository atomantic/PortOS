import { describe, it, expect, vi, beforeEach } from 'vitest';

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

vi.mock('child_process', () => ({ spawn: h.spawn }));
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
  findFfprobe: vi.fn(async () => null), // → probeAudio returns false without spawning
  safeUnder: (root, name) => (name ? `${root}/${name}` : null),
  generateThumbnail: vi.fn(async () => 'thumb.jpg'),
}));
vi.mock('../../lib/processEnv.js', () => ({ safeChildProcessEnv: () => ({}) }));
vi.mock('../../lib/killWithEscalation.js', () => ({ killWithEscalation: vi.fn() }));
vi.mock('../videoGen/local.js', () => ({
  loadHistory: vi.fn(),
  mutateVideoHistory: vi.fn(async (fn) => fn([])),
}));

import { renderProject, getRenderJobStatus } from './local.js';
import { readJSONFile } from '../../lib/fileUtils.js';
import { loadHistory } from '../videoGen/local.js';

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

describe('renderProject terminal handling (#2386)', () => {
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
});
