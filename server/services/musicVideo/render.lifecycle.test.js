// Engine mechanics are isolated from the review contract, covered in route/orchestration suites.
vi.mock('./productionReview.js', async (load) => ({ ...await load(), assertProductionApproval: vi.fn() }));
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #18647: the three final-render pipelines (footage concat, composed, seeked) run in one job
// lifecycle (finalRenderJob.js). Every case below runs against all three through the public
// `renderMusicVideo` boundary and records, in order, what an observer can see as the job ends:
// the terminal project write, the superseded-finals cleanup, the pipeline's post-publish step,
// the `render` and `document-render` events, the terminal SSE frame and the job's close. Each
// record carries whether the project's render slot was still held at that moment, so a job that
// released its slot before settling the row, or announced itself before releasing it, fails here.

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
  const spawn = (_cmd, args) => {
    const p = makeEmitter();
    p.args = args;
    p.stderr = makeEmitter();
    p.kill = () => {};
    procs.push(p);
    return p;
  };
  return { procs, spawn, timeline: [], segments: null, seeked: null };
});

vi.mock('../../lib/childProcess.js', async (importOriginal) => ({ ...(await importOriginal()), spawn: h.spawn }));
vi.mock('fs', () => ({ existsSync: vi.fn(() => true) }));
vi.mock('fs/promises', () => ({ unlink: vi.fn(async () => {}), readdir: vi.fn(async () => []), rm: vi.fn(async () => {}) }));
vi.mock('../../lib/fileUtils.js', () => ({
  ensureDir: vi.fn(async () => {}),
  PATHS: { videos: '/data/videos', videoThumbnails: '/data/thumbs', music: '/data/music', images: '/data/images', data: '/data' },
}));
vi.mock('../../lib/sseUtils.js', () => ({ broadcastSse: vi.fn(), attachSseClient: vi.fn(), closeJobAfterDelay: vi.fn() }));
vi.mock('../../lib/ffmpeg.js', () => ({
  findFfmpeg: vi.fn(async () => '/usr/bin/ffmpeg'),
  safeUnder: (root, name) => (name ? `${root}/${name}` : null),
  generateThumbnail: vi.fn(async (_path, jobId) => `${jobId}.jpg`),
  probeVideoDuration: vi.fn(async () => 30),
}));
vi.mock('../../lib/processEnv.js', () => ({ safeChildProcessOptions: (options = {}) => ({ ...options, env: {}, windowsHide: true }) }));
vi.mock('../../lib/killWithEscalation.js', () => ({ killWithEscalation: vi.fn() }));
// A backup cut asks the database maintenance journal first; no journal is under test here.
vi.mock('../../lib/databaseMaintenanceJournal.js', () => ({ assertDatabaseAdmission: () => {} }));
vi.mock('../videoGen/history.js', async (load) => ({ ...(await load()), loadHistory: vi.fn(), mutateVideoHistory: vi.fn(async (fn) => fn([])) }));
vi.mock('../tracks/index.js', () => ({ getTrack: vi.fn() }));
vi.mock('../instanceIdentity.js', () => ({ ensureInstanceId: vi.fn(async () => 'inst-self') }));
vi.mock('../mediaCollectionRules.js', () => ({ fileOwnedMediaBestEffort: vi.fn(async () => {}), videoItem: (id) => ({ id }) }));
vi.mock('./statsOutro.js', () => ({ appendStatsOutro: vi.fn(async () => 0), sweepStatsOutroScratch: vi.fn(async () => {}) }));
vi.mock('./codeRender.js', async (load) => ({ ...await load(), writeCodeProofSheet: vi.fn(async () => null) }));
vi.mock('./projects.js', () => ({ getProject: vi.fn(), listProjects: vi.fn(async () => []), updateProject: vi.fn(), mutateProjectRecord: vi.fn() }));
vi.mock('./renderCleanup.js', () => ({ cleanupSupersededFinals: vi.fn(async () => ({})) }));
// A composed render's shot work, held open until a case settles it or the render's abort signal fires.
vi.mock('./shotSegments.js', () => ({
  planShotSegments: vi.fn(async (project) => ({ project, songSec: 2, width: 910, height: 512, fps: 24, segments: [{ sceneId: 's1', path: '/data/seg/a.mp4', frames: 48 }], outro: null })),
  renderMissingSegments: vi.fn((plan, { signal }) => new Promise((resolve, reject) => {
    h.segments = { resolve, reject };
    signal.addEventListener('abort', () => reject(Object.assign(new Error('Render cancelled'), { code: 'CANCELED' })), { once: true });
  })),
  stitchSegments: vi.fn(async () => ({ durationSec: 2, songSec: 2, leadSec: 0 })),
  pruneSegments: vi.fn(async () => { h.timeline.push({ step: 'published', active: h.active() }); return 0; }),
}));
// A seeked mode whose encode a case settles by hand, registered under the `code` render style.
vi.mock('./seekedRenderers.js', async (load) => {
  const renderer = {
    label: 'code', modelId: 'music-video-code',
    prepare: async () => ({ plan: { durationSec: 2, fps: 24 } }),
    encode: ({ signal }) => new Promise((resolve, reject) => {
      h.seeked = { resolve, reject };
      signal.addEventListener('abort', () => reject(Object.assign(new Error('Render cancelled'), { code: 'CANCELED' })), { once: true });
    }),
    recordFinal: async (input) => { h.timeline.push({ step: 'published', active: h.active(), input }); },
  };
  return { ...await load(), seekedRendererFor: (project) => (project?.composition?.mode === 'code' ? renderer : null) };
});

import { renderMusicVideo, getRenderJobStatus, getActiveRenderJobId, cancelRender } from './render.js';
import { findFfmpeg, generateThumbnail } from '../../lib/ffmpeg.js';
import { loadHistory, mutateVideoHistory } from '../videoGen/history.js';
import { getTrack } from '../tracks/index.js';
import { getProject, updateProject, mutateProjectRecord } from './projects.js';
import { unlink } from 'fs/promises';
import { join } from 'node:path';
import { musicVideoEvents } from './events.js';
import { broadcastSse, closeJobAfterDelay } from '../../lib/sseUtils.js';
import { fileOwnedMediaBestEffort } from '../mediaCollectionRules.js';
import { cleanupSupersededFinals } from './renderCleanup.js';
import { maintenance } from '../../lib/maintenanceAdmission.js';
import { acquireBackupSnapshotCut } from '../../lib/backupSnapshotBoundary.js';

const lastProc = () => h.procs[h.procs.length - 1];
const ENCODED = { width: 640, height: 360, fps: 24, durationSec: 2, boundaryTimes: [0] };

// How a case reaches into each pipeline's encode. `publishes`: when its post-publish step runs.
const PIPELINES = [
  {
    name: 'footage', composition: undefined, publishes: 'never', failure: 'ffmpeg exit 1',
    started: async () => { lastProc().emit('spawn'); },
    succeed: () => lastProc().emit('close', 0, null),
    fail: () => lastProc().emit('close', 1, null),
    // The kill is doubled, so the cancelled child's exit is delivered by hand.
    afterCancel: () => lastProc().emit('close', 255, null),
  },
  {
    name: 'composed', composition: { version: 1, mode: 'composed', textCues: [], style: { color: '#ffffff', font: 'sans' }, posterSec: null },
    publishes: 'always', failure: 'boom',
    started: () => expect.poll(() => Boolean(h.segments)).toBe(true),
    succeed: () => h.segments.resolve(0),
    fail: () => h.segments.reject(new Error('boom')),
    afterCancel: () => {},
  },
  {
    name: 'seeked', composition: { mode: 'code' }, publishes: 'settled', failure: 'Code render failed: boom',
    started: () => expect.poll(() => Boolean(h.seeked)).toBe(true),
    succeed: () => h.seeked.resolve(ENCODED),
    fail: () => h.seeked.reject(new Error('boom')),
    afterCancel: () => {},
  },
];

// One in-memory row per project behind the store's read, patch and mutation.
const rows = new Map();
let pid = '';
let failWrite = () => false;
h.active = () => getActiveRenderJobId(pid);
const at = (step, extra = {}) => h.timeline.push({ step, active: h.active(), row: rows.get(pid)?.status, ...extra });
const steps = () => h.timeline.map((entry) => entry.step);
const only = (step) => h.timeline.filter((entry) => entry.step === step);

musicVideoEvents.on('render', (event) => { if (event.projectId === pid) at('event', { event }); });
musicVideoEvents.on('document-render', (event) => { if (event.projectId === pid) at('production', { event }); });

const blockersSince = (count) => maintenance.status().blockers.slice(count)
  .map(({ kind, resource, unsettled }) => ({ kind, resource, ...(unsettled ? { unsettled } : {}) }));
const OWN_PERMIT = () => ({ kind: 'music-video', resource: pid, unsettled: true });
const PUBLICATION = { kind: 'settlement', resource: 'Output publication', unsettled: true };

let sequence = 0;
let blockersBefore = 0;
afterEach(() => { vi.restoreAllMocks(); });
beforeEach(() => {
  vi.clearAllMocks();
  h.procs.length = 0;
  h.timeline.length = 0;
  h.segments = null;
  h.seeked = null;
  rows.clear();
  failWrite = () => false;
  blockersBefore = maintenance.status().blockers.length;
  getTrack.mockResolvedValue({ audioFilename: 'song.wav' });
  loadHistory.mockResolvedValue([{ id: 'h1', filename: 'a.mp4', width: 768, height: 512, fps: 24, numFrames: 48 }]);
  findFfmpeg.mockResolvedValue('/usr/bin/ffmpeg');
  getProject.mockImplementation(async (id) => rows.get(id));
  updateProject.mockImplementation(async (id, patch) => { rows.set(id, { ...rows.get(id), ...patch }); return rows.get(id); });
  mutateProjectRecord.mockImplementation(async (id, transform) => {
    const outcome = await transform(rows.get(id));
    if (failWrite(outcome.project)) throw new Error('disk full');
    rows.set(id, outcome.project);
    at('write', { status: outcome.project.status });
    return outcome;
  });
  broadcastSse.mockImplementation((job, frame) => { if (job.projectId === pid && frame.type !== 'progress') at('frame', { frame }); });
  closeJobAfterDelay.mockImplementation(() => at('close'));
  cleanupSupersededFinals.mockImplementation(async () => { at('retire'); return {}; });
});

describe.each(PIPELINES)('final render job lifecycle: $name pipeline', (pipeline) => {
  const start = async (project = {}) => {
    pid = `${pipeline.name.slice(0, 4)}-${++sequence}`;
    rows.set(pid, {
      id: pid, name: 'P', trackId: 't1', status: 'ready',
      scenes: [{ sceneId: 's1', order: 0, videoHistoryId: 'h1' }],
      ...(pipeline.composition ? { composition: pipeline.composition } : {}), ...project,
    });
    const { jobId } = await renderMusicVideo(pid, { productionRunId: 'run-1', productionRenderAttemptId: 'attempt-1' });
    await pipeline.started();
    expect(getActiveRenderJobId(pid)).toBe(jobId);
    expect(rows.get(pid)).toMatchObject({ status: 'rendering', renderingOn: 'inst-self', renderPartialFilename: expect.stringMatching(/^music-video-/) });
    return jobId;
  };
  // The close is the lifecycle's last observable step; the permit finishes right behind it.
  const ended = async (jobId, retained = []) => {
    await expect.poll(() => steps().includes('close'), { timeout: 5000 }).toBe(true);
    await expect.poll(() => blockersSince(blockersBefore), { timeout: 5000 }).toEqual(retained);
    expect(getActiveRenderJobId(pid)).toBeNull();
    expect(cancelRender(jobId)).toBe(false);
  };
  const outputPath = () => expect.stringMatching(/music-video-.*\.mp4$/);
  // Every announcement comes after the slot is free, reading the row the job last settled.
  const expectAnnouncedAfterRelease = (row) => {
    for (const entry of h.timeline.filter(({ step }) => ['event', 'production', 'frame', 'close'].includes(step))) {
      expect(entry, entry.step).toMatchObject({ active: null, row });
    }
  };

  it('publishes, retires older finals, then releases the slot before any listener hears of it', async () => {
    const jobId = await start();
    pipeline.succeed();
    await ended(jobId);

    const published = pipeline.publishes === 'never' ? [] : ['published'];
    expect(steps()).toEqual(['write', 'retire', ...published, 'event', 'production', 'frame', 'close']);
    // The slot is held through the write, the cleanup and the pipeline's own bookkeeping.
    for (const step of ['write', 'retire', ...published]) expect(only(step)[0], step).toMatchObject({ active: jobId });
    expectAnnouncedAfterRelease('complete');
    expect(rows.get(pid)).toMatchObject({ status: 'complete', renderHistoryId: jobId, renderError: null, renderingOn: null, renderPartialFilename: null });
    expect(only('event')[0].event).toEqual({ projectId: pid, jobId, status: 'completed', error: null });
    expect(only('production')[0].event).toEqual({ projectId: pid, runId: 'run-1', attemptId: 'attempt-1', jobId, status: 'completed', error: null });
    const { frame } = only('frame')[0];
    expect(frame).toMatchObject({ type: 'complete', result: { id: jobId, filename: expect.stringMatching(/^music-video-/), thumbnail: `${jobId}.jpg` } });
    // Only a seeked render makes a proof sheet; the other frames keep their shape.
    expect('proof' in frame.result).toBe(pipeline.name === 'seeked');
    expect(generateThumbnail).toHaveBeenCalledOnce();
    expect(mutateVideoHistory).toHaveBeenCalledOnce();
    expect(fileOwnedMediaBestEffort).toHaveBeenCalledOnce();
    expect(unlink).not.toHaveBeenCalledWith(outputPath());
    expect(getRenderJobStatus(jobId)).toEqual({ status: 'complete', error: undefined });
    if (pipeline.name === 'seeked') expect(only('published')[0].input).toEqual({ projectId: pid, jobId, encoded: expect.objectContaining(ENCODED) });
  });

  it('a finished render waits out a backup cut far longer than the default publication wait', async () => {
    const jobId = await start();
    const release = await acquireBackupSnapshotCut();
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      pipeline.succeed();
      // The boundary's default wait is two minutes; a backup's file copy and dump run longer.
      await vi.advanceTimersByTimeAsync(20 * 60_000);
      // Still encoded and unpublished: nothing written, announced or removed, and the slot is held.
      expect(steps()).toEqual([]);
      expect(getRenderJobStatus(jobId)).toEqual({ status: 'complete', error: undefined });
      expect(getActiveRenderJobId(pid)).toBe(jobId);
      expect(unlink).not.toHaveBeenCalled();
      expect(mutateVideoHistory).not.toHaveBeenCalled();
      // The wait says what it is waiting on rather than sitting silent at a full progress bar.
      expect(logSpy.mock.calls.some(([line]) => String(line).includes(jobId.slice(0, 8)) && String(line).includes('waiting for the backup'))).toBe(true);
    } finally {
      vi.useRealTimers();
      release();
    }
    await ended(jobId);
    expect(rows.get(pid)).toMatchObject({ status: 'complete', renderHistoryId: jobId });
    expect(only('frame')[0].frame).toMatchObject({ type: 'complete' });
  });

  it('a cancel during the encode restores a complete project, removes the output and settles before releasing', async () => {
    const jobId = await start({ status: 'complete', renderHistoryId: 'earlier-final' });
    expect(cancelRender(jobId)).toBe(true);
    pipeline.afterCancel();
    await ended(jobId);

    expect(steps()).toEqual(['write', 'event', 'production', 'frame', 'close']);
    // A render started the moment the slot frees must find this job's write already landed.
    expect(only('write')[0]).toMatchObject({ status: 'complete', active: jobId });
    expectAnnouncedAfterRelease('complete');
    expect(rows.get(pid)).toMatchObject({ status: 'complete', renderHistoryId: 'earlier-final', renderError: null, renderingOn: null, renderPartialFilename: null });
    expect(only('event')[0].event).toEqual({ projectId: pid, jobId, status: 'canceled', error: 'Render cancelled' });
    expect(only('production')[0].event).toMatchObject({ status: 'failed', error: 'Render cancelled' });
    expect(only('frame')[0].frame).toEqual({ type: 'canceled', error: 'Render cancelled' });
    expect(unlink).toHaveBeenCalledWith(outputPath());
    expect(generateThumbnail).not.toHaveBeenCalled();
    expect(mutateVideoHistory).not.toHaveBeenCalled();
    expect(getRenderJobStatus(jobId)).toEqual({ status: 'canceled', error: 'Render cancelled' });
  });

  it('a cancel accepted as the encode finishes still wins: nothing is published', async () => {
    const jobId = await start({ status: 'complete', renderHistoryId: 'earlier-final' });
    // The encode has its result, but the job has not committed it yet.
    pipeline.succeed();
    expect(cancelRender(jobId)).toBe(true);
    await ended(jobId);

    expect(steps()).toEqual(['write', 'event', 'production', 'frame', 'close']);
    expect(rows.get(pid)).toMatchObject({ status: 'complete', renderHistoryId: 'earlier-final', renderingOn: null });
    expect(only('frame')[0].frame).toEqual({ type: 'canceled', error: 'Render cancelled' });
    expect(unlink).toHaveBeenCalledWith(outputPath());
    expect(generateThumbnail).not.toHaveBeenCalled();
    expect(mutateVideoHistory).not.toHaveBeenCalled();
  });

  it('an encode failure marks the project failed with its reason before the slot is released', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const jobId = await start();
    pipeline.fail();
    await ended(jobId);

    expect(steps()).toEqual(['write', 'event', 'production', 'frame', 'close']);
    expect(only('write')[0]).toMatchObject({ status: 'failed', active: jobId });
    expectAnnouncedAfterRelease('failed');
    expect(rows.get(pid)).toMatchObject({ status: 'failed', renderError: pipeline.failure, renderingOn: null, renderPartialFilename: null });
    expect(only('event')[0].event).toEqual({ projectId: pid, jobId, status: 'failed', error: pipeline.failure });
    expect(only('frame')[0].frame).toEqual({ type: 'error', error: pipeline.failure });
    expect(unlink).toHaveBeenCalledWith(outputPath());
    expect(mutateVideoHistory).not.toHaveBeenCalled();
    expect(getRenderJobStatus(jobId)).toEqual({ status: 'error', error: pipeline.failure });
  });

  it('a settle that fails after the history entry landed reports an error and keeps the output', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const jobId = await start();
    failWrite = (project) => project.status === 'complete';
    pipeline.succeed();
    await ended(jobId, [OWN_PERMIT()]);

    // No write landed and nothing was retired: the earlier finals are still the project's.
    expect(steps()).toEqual(['event', 'production', 'frame', 'close']);
    expectAnnouncedAfterRelease('rendering');
    expect(only('event')[0].event).toEqual({ projectId: pid, jobId, status: 'failed', error: expect.stringContaining('saving the project record failed') });
    expect(only('production')[0].event).toMatchObject({ status: 'failed' });
    expect(only('frame')[0].frame).toEqual({ type: 'error', error: expect.stringContaining('saving the project record failed') });
    expect(mutateVideoHistory).toHaveBeenCalledOnce();
    expect(unlink).not.toHaveBeenCalled();
    expect(getRenderJobStatus(jobId).status).toBe('error');
  });

  it('a publish step that fails before the history entry removes the output and marks the project failed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const jobId = await start();
    generateThumbnail.mockRejectedValueOnce(new Error('no poster'));
    pipeline.succeed();
    await ended(jobId, [PUBLICATION]);

    expect(steps()).toEqual(['write', 'event', 'production', 'frame', 'close']);
    expect(only('write')[0]).toMatchObject({ status: 'failed', active: jobId });
    expectAnnouncedAfterRelease('failed');
    expect(rows.get(pid)).toMatchObject({ status: 'failed', renderError: 'Finalize failed: no poster', renderingOn: null });
    expect(rows.get(pid).renderHistoryId).toBeUndefined();
    expect(only('event')[0].event).toEqual({ projectId: pid, jobId, status: 'failed', error: 'Finalize failed: no poster' });
    expect(only('frame')[0].frame).toEqual({ type: 'error', error: 'Finalize failed: no poster' });
    // Nothing names the file, so it would be an orphan.
    expect(unlink).toHaveBeenCalledWith(outputPath());
    expect(mutateVideoHistory).not.toHaveBeenCalled();
  });

  it('a rejected history write removes every unpublished artifact', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const jobId = await start();
    const filename = rows.get(pid).renderPartialFilename;
    mutateVideoHistory.mockRejectedValueOnce(new Error('history unavailable'));
    pipeline.succeed();
    await ended(jobId, [PUBLICATION]);

    expect(unlink.mock.calls.map(([path]) => path)).toEqual([
      join('/data/videos', filename),
      ...(pipeline.name === 'seeked' ? [join('/data/thumbs', filename.replace(/\.mp4$/, '-proof.png'))] : []),
      join('/data/thumbs', `${jobId}.jpg`),
    ]);
    expect(rows.get(pid)).toMatchObject({ status: 'failed', renderError: 'Finalize failed: history unavailable' });
    expect(rows.get(pid).renderHistoryId).toBeUndefined();
  });

  it('a publish step that fails after the history entry keeps the output the history names', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const jobId = await start();
    fileOwnedMediaBestEffort.mockRejectedValueOnce(new Error('filing unavailable'));
    pipeline.succeed();
    await ended(jobId, [PUBLICATION]);

    expect(steps()).toEqual(['write', 'write', 'event', 'production', 'frame', 'close']);
    expect(only('write').map(({ status, active }) => ({ status, active }))).toEqual([{ status: 'complete', active: jobId }, { status: 'failed', active: jobId }]);
    expectAnnouncedAfterRelease('failed');
    expect(only('frame')[0].frame).toEqual({ type: 'error', error: 'Finalize failed: filing unavailable' });
    expect(mutateVideoHistory).toHaveBeenCalledOnce();
    expect(unlink).not.toHaveBeenCalled();
  });

  it('a song change during the render abandons the finished film without applying its status', async () => {
    const jobId = await start();
    // A peer changed the song and took the mark: this job's file is finished but is no longer the project's film.
    rows.set(pid, { ...rows.get(pid), audioRevision: 1, renderingOn: 'inst-peer' });
    pipeline.succeed();
    await ended(jobId);

    const published = pipeline.publishes === 'always' ? ['published'] : [];
    expect(steps()).toEqual(['write', 'retire', ...published, 'event', 'production', 'frame', 'close']);
    expect(rows.get(pid)).toMatchObject({ status: 'rendering', audioRevision: 1, renderingOn: 'inst-peer' });
    expect(rows.get(pid).renderHistoryId).toBeUndefined();
    expect(only('event')[0].event).toEqual({ projectId: pid, jobId, status: 'completed', error: null, abandoned: true });
    expect(only('production')[0].event).toMatchObject({ status: 'completed', abandoned: true });
    // The file stays in the history, marked as the abandoned render it is.
    const [, markAbandoned] = mutateVideoHistory.mock.calls.map(([fn]) => fn);
    expect(markAbandoned([{ id: jobId }, { id: 'other' }])).toEqual([{ id: jobId, abandonedReason: 'audio-changed' }, { id: 'other' }]);
    expect(unlink).not.toHaveBeenCalledWith(outputPath());
  });

  it('a render that fails after a song change tells listeners the project no longer names it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const jobId = await start();
    rows.set(pid, { ...rows.get(pid), audioRevision: 1, renderingOn: 'inst-peer' });
    pipeline.fail();
    await ended(jobId);

    // The failure is not applied to a project that has moved on to another song.
    expect(rows.get(pid)).toMatchObject({ status: 'rendering', audioRevision: 1, renderingOn: 'inst-peer' });
    expect(rows.get(pid).renderError ?? null).toBeNull();
    expect(only('event')[0].event).toEqual({ projectId: pid, jobId, status: 'failed', error: pipeline.failure, abandoned: true });
    // A production run reads the flag to report the song change rather than the encoder's error.
    expect(only('production')[0].event).toMatchObject({ status: 'failed', abandoned: true });
  });
});
