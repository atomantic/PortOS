import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => {
  const emitter = () => {
    const listeners = {};
    return {
      on(event, fn) { (listeners[event] ||= []).push(fn); return this; },
      emit(event, ...args) { for (const fn of listeners[event] || []) fn(...args); },
    };
  };
  const procs = [];
  const spawn = () => {
    const proc = { ...emitter(), stderr: emitter(), kill: vi.fn() };
    procs.push(proc);
    return proc;
  };
  const store = new Map();
  const overlays = { resolve: null };
  return { procs, spawn, store, overlays };
});

vi.mock('../../lib/childProcess.js', () => ({ spawn: h.spawn, execFile: vi.fn(), exec: vi.fn() }));
vi.mock('../../lib/processEnv.js', () => ({ safeChildProcessOptions: (options) => ({ ...options, env: {} }) }));
vi.mock('fs/promises', () => ({ unlink: vi.fn(async () => {}) }));
vi.mock('../../lib/fileUtils.js', () => ({
  ensureDir: vi.fn(async () => {}),
  PATHS: { videos: '/test/videos', videoThumbnails: '/test/thumbnails' },
}));
vi.mock('../../lib/sseUtils.js', () => ({ broadcastSse: vi.fn(), attachSseClient: vi.fn(), closeJobAfterDelay: vi.fn() }));
vi.mock('../../lib/killWithEscalation.js', () => ({ killWithEscalation: vi.fn() }));
vi.mock('../instanceIdentity.js', () => ({ ensureInstanceId: vi.fn(async () => 'test-instance') }));
vi.mock('../htmlComposition/encode.js', () => ({ encodeFileContactSheetAtTimes: vi.fn(async () => {}) }));
vi.mock('./projects.js', () => ({
  getProject: vi.fn(async (id) => h.store.get(id)),
  listProjects: vi.fn(async () => []),
  mutateProjectRecord: vi.fn(async (id, transform) => {
    const outcome = transform(h.store.get(id));
    h.store.set(id, outcome.project);
    return outcome;
  }),
}));
vi.mock('./render.js', () => ({
  planMusicVideoRender: vi.fn(async (project) => ({ ffmpeg: 'ffmpeg', audioPath: '/test/song.wav', clips: [], composed: !!project.composition, audioDurationSec: 4, soundBed: null })),
  buildMusicVideoFfmpegArgs: vi.fn(() => ({ args: [], totalDuration: 4, canonW: 64, canonH: 64, fps: 24, sections: [] })),
  excerptBoundaryTimes: vi.fn(() => [0]),
  isLocalRenderMark: vi.fn(() => true),
  assertCurrentClipDependencies: vi.fn(),
  resolveMasterAudioPath: vi.fn(),
  resolveSoundBedPath: vi.fn(),
}));
vi.mock('./compositionRender.js', () => ({
  removeCompositionScratch: vi.fn(async () => {}),
  renderTypographyOverlays: vi.fn(({ signal }) => new Promise((resolve, reject) => {
    h.overlays.resolve = resolve;
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  })),
}));

import { startExcerptRender, cancelExcerptRender } from './excerptRender.js';
import { unlink } from 'fs/promises';
import { broadcastSse } from '../../lib/sseUtils.js';
import { removeCompositionScratch } from './compositionRender.js';
import { musicVideoEvents } from './events.js';

const prime = (id, composition = null) => h.store.set(id, { id, name: 'Test', scenes: [], excerpts: [], composition });
const lastProc = () => h.procs.at(-1);
const excerpt = (id, excerptId) => h.store.get(id).excerpts.find((record) => record.id === excerptId);
const terminalFrames = (jobId) => broadcastSse.mock.calls.filter(([job, frame]) => job.id === jobId && ['canceled', 'error', 'complete'].includes(frame.type)).map(([, frame]) => frame);

beforeEach(() => {
  vi.clearAllMocks();
  h.procs.length = 0;
  h.store.clear();
});

describe('excerpt render cancellation', () => {
  it('keeps a canceled encode owned until close, removes partial output, and settles once', async () => {
    const id = 'excerpt-cancel';
    prime(id);
    const events = [];
    const onRender = (event) => events.push(event);
    musicVideoEvents.on('excerpt-render', onRender);
    const { jobId, excerptId } = await startExcerptRender(id, { startSec: 0, endSec: 2 });
    const partialFilename = excerpt(id, excerptId).partialFilename;
    const proc = lastProc();
    proc.emit('spawn');
    expect(cancelExcerptRender(jobId)).toBe(true);
    proc.emit('error', new Error('kill EPERM'));
    expect(excerpt(id, excerptId).status).toBe('rendering');
    await expect(startExcerptRender(id, { startSec: 0, endSec: 2 })).rejects.toMatchObject({ code: 'EXCERPT_RENDER_IN_PROGRESS' });
    proc.emit('close', 255, null);
    await vi.waitFor(() => expect(terminalFrames(jobId)).toHaveLength(1));
    proc.emit('close', 255, null);
    musicVideoEvents.off('excerpt-render', onRender);
    expect(terminalFrames(jobId)).toEqual([{ type: 'canceled', error: 'Render cancelled' }]);
    expect(excerpt(id, excerptId)).toMatchObject({ status: 'canceled', filename: null, partialFilename: null, jobId: null, renderingOn: null, error: null });
    expect(unlink.mock.calls).toEqual([[`/test/videos/${partialFilename}`]]);
    expect(events).toEqual([{ projectId: id, excerptId, status: 'canceled' }]);
    expect(cancelExcerptRender(jobId)).toBe(false);
    const again = await startExcerptRender(id, { startSec: 0, endSec: 2 });
    lastProc().emit('close', 1, null);
    await vi.waitFor(() => expect(terminalFrames(again.jobId)).toHaveLength(1));
  });

  it.each([{ code: 255, status: 'error' }, { code: 0, status: 'complete' }])('retains $status for an uncanceled close($code, null)', async ({ code, status }) => {
    const id = `excerpt-close-${code}`;
    prime(id);
    const { jobId, excerptId } = await startExcerptRender(id, { startSec: 0, endSec: 2 });
    lastProc().emit('spawn');
    lastProc().emit('close', code, null);
    await vi.waitFor(() => expect(terminalFrames(jobId)).toHaveLength(1));
    expect(excerpt(id, excerptId).status).toBe(status);
    expect(terminalFrames(jobId)[0].type).toBe(status);
  });

  it('retains zero-exit success after a cancellation request', async () => {
    const id = 'excerpt-cancel-success';
    prime(id);
    const { jobId, excerptId } = await startExcerptRender(id, { startSec: 0, endSec: 2 });
    lastProc().emit('spawn');
    expect(cancelExcerptRender(jobId)).toBe(true);
    lastProc().emit('close', 0, null);
    await vi.waitFor(() => expect(terminalFrames(jobId)).toHaveLength(1));
    expect(excerpt(id, excerptId).status).toBe('complete');
    expect(terminalFrames(jobId)[0].type).toBe('complete');
  });

  it('aborts overlay capture without spawning and releases scratch and the excerpt slot', async () => {
    const id = 'excerpt-capture';
    prime(id, { mode: 'composed', textCues: [{ id: 'cue', text: 'Test', startSec: 0, endSec: 2 }], style: {} });
    const { jobId, excerptId } = await startExcerptRender(id, { startSec: 0, endSec: 2 });
    expect(h.procs).toHaveLength(0);
    expect(cancelExcerptRender(jobId)).toBe(true);
    expect(cancelExcerptRender(jobId)).toBe(false);
    await vi.waitFor(() => expect(terminalFrames(jobId)).toHaveLength(1));
    expect(excerpt(id, excerptId).status).toBe('canceled');
    expect(removeCompositionScratch).toHaveBeenCalledExactlyOnceWith(jobId);
    expect(h.procs).toHaveLength(0);
    const again = await startExcerptRender(id, { startSec: 0, endSec: 2 });
    expect(again.jobId).not.toBe(jobId);
    cancelExcerptRender(again.jobId);
    await vi.waitFor(() => expect(terminalFrames(again.jobId)).toHaveLength(1));
  });
});
