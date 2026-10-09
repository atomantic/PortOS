// Engine mechanics are isolated from the review contract, covered in route/orchestration suites.
vi.mock('./productionReview.js', async (load) => ({ ...await load(), assertProductionApproval: vi.fn() }));
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
  const spawn = (_cmd, args) => {
    const p = makeEmitter();
    p.args = args;
    p.stderr = makeEmitter();
    p.kill = () => {};
    procs.push(p);
    return p;
  };
  // #8984 — the overlay capture, held open until a test settles it (or the
  // render's abort signal rejects it, as the real capture does).
  const overlays = { calls: [], resolve: null };
  const renderTypographyOverlays = (options) => new Promise((resolve, reject) => {
    overlays.calls.push(options);
    overlays.resolve = resolve;
    options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
  });
  return { procs, spawn, overlays, renderTypographyOverlays };
});

vi.mock('../../lib/childProcess.js', () => ({ spawn: h.spawn }));
vi.mock('fs', () => ({ existsSync: vi.fn(() => true) }));
vi.mock('fs/promises', () => ({ unlink: vi.fn(async () => {}) }));
vi.mock('../../lib/fileUtils.js', () => ({
  ensureDir: vi.fn(async () => {}),
  PATHS: { videos: '/data/videos', videoThumbnails: '/data/thumbs', music: '/data/music', images: '/data/images', data: '/data' },
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
vi.mock('./compositionRender.js', () => ({
  renderTypographyOverlays: h.renderTypographyOverlays,
  removeCompositionScratch: vi.fn(async () => {}),
  sweepCompositionScratch: vi.fn(async () => {}),
}));
vi.mock('./projects.js', () => ({ getProject: vi.fn(), listProjects: vi.fn(async () => []), updateProject: vi.fn(async () => ({})), mutateProjectRecord: vi.fn() }));
vi.mock('../instanceIdentity.js', () => ({ ensureInstanceId: vi.fn(async () => 'inst-self') }));

import { buildTypographyDocument } from './composition.js';
import { renderMusicVideo, getRenderJobStatus, cancelRender } from './render.js';
import { removeCompositionScratch } from './compositionRender.js';
import { findFfmpeg, generateThumbnail } from '../../lib/ffmpeg.js';
import { loadHistory } from '../videoGen/local.js';
import { getTrack } from '../tracks/index.js';
import { getProject, listProjects, updateProject, mutateProjectRecord } from './projects.js';
import { unlink } from 'fs/promises';
import { musicVideoEvents } from './events.js';
import { broadcastSse } from '../../lib/sseUtils.js';
import { killWithEscalation } from '../../lib/killWithEscalation.js';
import { maintenance } from '../../lib/maintenanceAdmission.js';

const tick = () => new Promise((r) => setTimeout(r, 0));
const lastProc = () => h.procs[h.procs.length - 1];
// A terminal project write: the status plus the cleared in-flight mark (#9010).
const settled = (status, extra = {}) => ({ status, ...extra, renderingOn: null, renderPartialFilename: null });

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
  h.overlays.calls.length = 0;
});

describe('renderMusicVideo terminal handling (#2386)', () => {
  it('finalizes immediately on a PRE-spawn error and releases the project slot', async () => {
    const pid = 'pre-1';
    prime(pid);
    const settledEvents = [];
    const onRender = (e) => settledEvents.push(e);
    musicVideoEvents.on('render', onRender);
    const { jobId } = await renderMusicVideo(pid);
    const proc = lastProc();

    // No 'spawn' event → genuine spawn failure. 'close' will not follow.
    proc.emit('error', new Error('spawn ENOENT'));
    await tick();
    musicVideoEvents.off('render', onRender);
    // An autonomous run waiting on this render learns it failed (and why).
    expect(settledEvents).toEqual([{ projectId: pid, jobId, status: 'failed', error: expect.stringMatching(/Failed to spawn ffmpeg/) }]);

    expect(getRenderJobStatus(jobId).status).toBe('error');
    expect(getRenderJobStatus(jobId).error).toMatch(/Failed to spawn ffmpeg/);
    expect(updateProject).toHaveBeenCalledWith(pid, settled('failed'));

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
    expect(updateProject).not.toHaveBeenCalledWith(pid, settled('failed'));
    await expect(renderMusicVideo(pid)).rejects.toMatchObject({
      status: 409, code: 'RENDER_IN_PROGRESS', context: { jobId },
    });

    // 'close' is the sole terminal handler for the post-spawn error.
    proc.emit('close', 1, null);
    await tick();
    expect(getRenderJobStatus(jobId).status).toBe('error');
    expect(updateProject).toHaveBeenCalledWith(pid, settled('failed'));

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

  it('preserves a completed project when canceled ffmpeg exits 255 without a signal', async () => {
    const pid = 'cancel-close';
    prime(pid);
    getProject.mockResolvedValue({ ...(await getProject(pid)), status: 'complete' });
    const events = [];
    const onRender = (event) => events.push(event);
    musicVideoEvents.on('render', onRender);
    const { jobId } = await renderMusicVideo(pid);
    const proc = lastProc();
    proc.emit('spawn');
    expect(cancelRender(jobId)).toBe(true);
    expect(killWithEscalation).toHaveBeenCalledWith(proc, expect.objectContaining({ label: 'music-video render' }));
    proc.emit('error', new Error('kill EPERM'));
    await tick();
    expect(getRenderJobStatus(jobId).status).toBe('running');
    expect(maintenance.status().blockers).toContainEqual(expect.objectContaining({ kind: 'music-video', resource: pid }));
    await expect(renderMusicVideo(pid)).rejects.toMatchObject({ code: 'RENDER_IN_PROGRESS' });

    proc.emit('close', 255, null);
    await tick();
    proc.emit('close', 255, null);
    await tick();
    musicVideoEvents.off('render', onRender);
    expect(getRenderJobStatus(jobId)).toEqual({ status: 'canceled', error: 'Render cancelled' });
    expect(events).toEqual([{ projectId: pid, jobId, status: 'canceled', error: 'Render cancelled' }]);
    expect(broadcastSse.mock.calls.filter(([job, frame]) => job.id === jobId && ['canceled', 'error'].includes(frame.type)))
      .toEqual([[expect.objectContaining({ id: jobId }), { type: 'canceled', error: 'Render cancelled' }]]);
    expect(updateProject.mock.calls.filter(([id, patch]) => id === pid && patch.status === 'complete')).toEqual([[pid, settled('complete')]]);
    expect(unlink).toHaveBeenCalledWith(expect.stringMatching(/music-video-.*\.mp4$/));
    expect(maintenance.status().blockers).not.toContainEqual(expect.objectContaining({ resource: pid }));
    expect(cancelRender(jobId)).toBe(false);
    const again = await renderMusicVideo(pid);
    expect(again.jobId).not.toBe(jobId);
    lastProc().emit('error', new Error('spawn ENOENT'));
    await tick();
  });

  it('retains zero-exit success when cancellation arrives just before close', async () => {
    const pid = 'cancel-success';
    prime(pid);
    const { jobId } = await renderMusicVideo(pid);
    lastProc().emit('spawn');
    expect(cancelRender(jobId)).toBe(true);
    lastProc().emit('close', 0, null);
    await tick();
    expect(getRenderJobStatus(jobId).status).toBe('complete');
    expect(updateProject).toHaveBeenCalledWith(pid, expect.objectContaining(settled('complete', { renderHistoryId: jobId })));
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

// Recovery re-checks each record under the store's write lock (#9010): back
// both the list and the transform with one in-memory store.
const seedStore = (records) => {
  const store = new Map(records.map((r) => [r.id, r]));
  listProjects.mockResolvedValueOnce(records);
  mutateProjectRecord.mockImplementation(async (id, transform) => {
    const outcome = transform(store.get(id));
    store.set(id, outcome.project);
    return outcome;
  });
  return store;
};
const statusOf = (store) => Object.fromEntries([...store].map(([id, p]) => [id, p.status]));

describe('recoverStuckMusicVideoRenders (#8430)', () => {
  it('demotes stale renders by history, skips live jobs and other statuses', async () => {
    const { recoverStuckMusicVideoRenders } = await import('./render.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    prime('live-1');
    await renderMusicVideo('live-1');
    const store = seedStore([
      { id: 'done-1', status: 'rendering', renderHistoryId: 'hist-1' },
      { id: 'fresh-1', status: 'rendering' },
      { id: 'live-1', status: 'rendering' },
      { id: 'idle-1', status: 'ready' },
    ]);

    await recoverStuckMusicVideoRenders();

    expect(statusOf(store)).toEqual({ 'done-1': 'complete', 'fresh-1': 'ready', 'live-1': 'rendering', 'idle-1': 'ready' });
    expect(store.get('fresh-1')).toMatchObject({ renderingOn: null, renderPartialFilename: null });
    expect(logSpy.mock.calls.some(([line]) => line.includes('demoted 2/2'))).toBe(true);
    logSpy.mockRestore();
  });

  it('stamps the in-flight mark with this instance and the output file it is writing (#9010)', async () => {
    prime('stamp-1');
    await renderMusicVideo('stamp-1');
    expect(updateProject).toHaveBeenCalledWith('stamp-1', {
      status: 'rendering', renderingOn: 'inst-self', renderError: null, renderPartialFilename: expect.stringMatching(/^music-video-stamp-1-\d+\.mp4$/),
    });
  });

  it('leaves a peer-owned render alone, and deletes only its own partial output (#9010)', async () => {
    const { recoverStuckMusicVideoRenders } = await import('./render.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    loadHistory.mockResolvedValue([{ id: 'r-done', filename: 'music-video-finished.mp4' }]);
    const store = seedStore([
      { id: 'mine-1', status: 'rendering', renderingOn: 'inst-self', renderPartialFilename: 'music-video-mine.mp4' },
      { id: 'peer-1', status: 'rendering', renderingOn: 'inst-peer', renderPartialFilename: 'music-video-peer.mp4' },
      { id: 'legacy-1', status: 'rendering' },
      // Its history append landed but the 'complete' write did not: the file is a finished render.
      { id: 'late-1', status: 'rendering', renderingOn: 'inst-self', renderPartialFilename: 'music-video-finished.mp4' },
      // Listed as ours, but a peer sync handed the mark over before the demotion write.
      { id: 'moved-1', status: 'rendering', renderingOn: 'inst-self', renderPartialFilename: 'music-video-moved.mp4' },
    ]);
    const listed = mutateProjectRecord.getMockImplementation();
    mutateProjectRecord.mockImplementation(async (id, transform) => {
      if (id === 'moved-1') store.set(id, { ...store.get(id), renderingOn: 'inst-peer' });
      return listed(id, transform);
    });

    await recoverStuckMusicVideoRenders();

    expect(statusOf(store)).toEqual({ 'mine-1': 'ready', 'peer-1': 'rendering', 'legacy-1': 'ready', 'late-1': 'ready', 'moved-1': 'rendering' });
    expect(store.get('peer-1')).toMatchObject({ renderingOn: 'inst-peer', renderPartialFilename: 'music-video-peer.mp4' });
    expect(unlink.mock.calls).toEqual([['/data/videos/music-video-mine.mp4']]);
    expect(logSpy.mock.calls.some(([line]) => line.includes('demoted 3/4'))).toBe(true);
    logSpy.mockRestore();
  });

  it('excerpt recovery demotes its own and legacy drafts but not a peer\'s (#9010)', async () => {
    const { recoverStuckMusicVideoExcerpts } = await import('./excerptRender.js');
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const draft = (id, extra) => ({ id, status: 'rendering', jobId: id, partialFilename: `${id}.mp4`, notes: [], ...extra });
    const store = seedStore([{
      id: 'mv-x', status: 'complete', revisions: [],
      excerpts: [draft('mve-mine', { renderingOn: 'inst-self' }), draft('mve-peer', { renderingOn: 'inst-peer' }), draft('mve-legacy')],
    }]);

    await recoverStuckMusicVideoExcerpts();

    const byId = Object.fromEntries(store.get('mv-x').excerpts.map((e) => [e.id, e]));
    expect(byId['mve-mine']).toMatchObject({ status: 'error', renderingOn: null, partialFilename: null });
    expect(byId['mve-legacy']).toMatchObject({ status: 'error', partialFilename: null });
    expect(byId['mve-peer']).toMatchObject({ status: 'rendering', renderingOn: 'inst-peer', partialFilename: 'mve-peer.mp4' });
    const unlinked = unlink.mock.calls.map(([p]) => p);
    expect(unlinked).toContain('/data/videos/mve-mine.mp4');
    expect(unlinked).not.toContain('/data/videos/mve-peer.mp4');
    logSpy.mockRestore();
  });

  it('propagates a list failure instead of reporting zero recovered', async () => {
    const { recoverStuckMusicVideoRenders } = await import('./render.js');
    listProjects.mockRejectedValueOnce(new Error('DB unavailable'));
    await expect(recoverStuckMusicVideoRenders()).rejects.toThrow('DB unavailable');
    expect(mutateProjectRecord).not.toHaveBeenCalled();
  });

  it('logs a failed demotion and keeps recovering the rest', async () => {
    const { recoverStuckMusicVideoRenders } = await import('./render.js');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const store = seedStore([
      { id: 'bad-1', status: 'rendering' },
      { id: 'good-1', status: 'rendering' },
    ]);
    const listed = mutateProjectRecord.getMockImplementation();
    mutateProjectRecord.mockImplementation(async (id, transform) => {
      if (id === 'bad-1') throw new Error('write failed');
      return listed(id, transform);
    });

    await recoverStuckMusicVideoRenders();

    expect(statusOf(store)).toEqual({ 'bad-1': 'rendering', 'good-1': 'ready' });
    expect(errorSpy.mock.calls.some(([line]) => line.includes('bad-1'))).toBe(true);
    expect(logSpy.mock.calls.some(([line]) => line.includes('demoted 1/2'))).toBe(true);
    errorSpy.mockRestore();
    logSpy.mockRestore();
  });
});

it('chooses the loudest section midpoint within the rendered duration', async () => {
  prime('poster-section');
  const project = await getProject();
  getProject.mockResolvedValue({ ...project, audioAnalysis: { sections: [
    { startSec: 0, endSec: 1, energy: 0.2 },
    { startSec: 1, endSec: 2, energy: 0.9 },
  ] } });
  const { jobId } = await renderMusicVideo('poster-section');
  lastProc().emit('spawn');
  lastProc().emit('close', 0, null);
  await tick();
  expect(generateThumbnail).toHaveBeenCalledWith(expect.any(String), jobId, { atSec: 1.5 });
  expect(getRenderJobStatus(jobId).status).toBe('complete');
});

// #8964 — loop semantics at the render boundary. A pre-#8964 scene (no `loop`
// key) keeps filling its authored span by repeating the clip; a planned shot
// (`loop: false`) may never silently repeat, so a span its clip cannot cover
// blocks the render with the shots to fix, and never spawns ffmpeg.
describe('renderMusicVideo clip coverage (#8964)', () => {
  const primeScene = (projectId, scene) => {
    prime(projectId);
    getProject.mockResolvedValue({
      id: projectId, name: 'P', trackId: 't1', status: 'ready',
      scenes: [{ sceneId: 's1', order: 0, videoHistoryId: 'h1', beatAligned: true, ...scene }],
    });
  };
  const filterGraph = (args) => args[args.indexOf('-filter_complex') + 1];

  it('keeps looping a legacy scene across a span longer than its clip', async () => {
    primeScene('legacy-1', { startSec: 0, endSec: 20 });
    await renderMusicVideo('legacy-1');
    const { args } = lastProc();
    expect(args.slice(0, 3)).toEqual(['-stream_loop', '-1', '-i']);
    expect(filterGraph(args)).toContain('trim=start=0:end=20');
  });

  it('refuses a non-looping shot its clip cannot cover, naming the fix, without spawning', async () => {
    primeScene('short-1', { startSec: 0, endSec: 20, loop: false });
    const expected = {
      status: 422,
      code: 'INSUFFICIENT_CLIP_COVERAGE',
      context: {
        shortfalls: [{ sceneId: 's1', spanSec: 20, clipSec: 2, shortBySec: 18 }],
        resolutions: ['trim', 'continue', 'replace', 'loop'],
      },
    };
    await expect(renderMusicVideo('short-1')).rejects.toMatchObject(expected);
    expect(h.procs).toHaveLength(0);
    expect(updateProject).not.toHaveBeenCalled();
    // The slot is released: a retry re-checks coverage instead of 409ing.
    await expect(renderMusicVideo('short-1')).rejects.toMatchObject({ code: 'INSUFFICIENT_CLIP_COVERAGE' });
  });

  it('reads a covered non-looping shot once and holds its last frame over a sub-tolerance gap', async () => {
    primeScene('fit-1', { startSec: 0, endSec: 2.2, loop: false });
    await renderMusicVideo('fit-1');
    const { args } = lastProc();
    expect(args).not.toContain('-stream_loop');
    expect(filterGraph(args)).toContain('tpad=stop_mode=clone:stop_duration=0.2,trim=start=0:end=2.2');
  });

  it('repeats a shot the director explicitly set to loop', async () => {
    primeScene('loop-1', { startSec: 0, endSec: 20, loop: true });
    await renderMusicVideo('loop-1');
    const { args } = lastProc();
    expect(args).toContain('-stream_loop');
    expect(filterGraph(args)).not.toContain('tpad');
  });
});

// #8984 — a composed render captures its typography overlay before ffmpeg
// exists. The capture phase must be cancelable and terminal on its own, and a
// project whose manifest has nothing to draw must render exactly as before.
describe('composed render lifecycle (#8984)', () => {
  const cue = { id: 'c1', text: 'Hello', startSec: 0.5, endSec: 1.5, template: 'fade', placement: 'lower', emphasis: 'subtitle' };
  const primeComposed = (projectId, composition) => {
    prime(projectId);
    getProject.mockResolvedValue({
      id: projectId, name: 'P', trackId: 't1', status: 'complete',
      scenes: [{ sceneId: 's1', order: 0, videoHistoryId: 'h1' }],
      composition: { version: 1, style: { color: '#ffffff', font: 'sans' }, posterSec: null, ...composition },
    });
  };

  it('renders a concat-mode manifest through the plain path', async () => {
    primeComposed('plain-1', { mode: 'concat', textCues: [cue] });
    await renderMusicVideo('plain-1');
    expect(h.overlays.calls).toHaveLength(0);
    expect(lastProc().args).not.toContain('-itsoffset');
  });

  it('cancels during overlay capture: no ffmpeg, prior status restored, scratch removed, slot released', async () => {
    primeComposed('cancel-1', { mode: 'composed', textCues: [cue] });
    const { jobId } = await renderMusicVideo('cancel-1');
    expect(h.overlays.calls).toHaveLength(1);
    expect(h.procs).toHaveLength(0);
    expect(cancelRender(jobId)).toBe(true);
    await tick();
    await tick();
    expect(getRenderJobStatus(jobId).status).toBe('canceled');
    expect(h.procs).toHaveLength(0);
    expect(updateProject).toHaveBeenLastCalledWith('cancel-1', settled('complete'));
    expect(removeCompositionScratch).toHaveBeenCalledWith(jobId);
    expect(cancelRender(jobId)).toBe(false);
    const again = await renderMusicVideo('cancel-1');
    expect(again.jobId).not.toBe(jobId);
  });

  it('lays the captured overlays over the cut and honors the chosen poster frame', async () => {
    primeComposed('composed-1', { mode: 'composed', textCues: [cue], posterSec: 1 });
    const { jobId } = await renderMusicVideo('composed-1');
    expect(h.overlays.calls[0]).toMatchObject({ jobId, width: 768, height: 512, fps: 24, cues: [expect.objectContaining({ id: 'c1' })] });
    h.overlays.resolve([{ path: '/data/overlay-0.mov', startSec: 0.5, durationSec: 1 }]);
    await tick();
    const { args } = lastProc();
    expect(args.slice(args.indexOf('-itsoffset'), args.indexOf('-itsoffset') + 4)).toEqual(['-itsoffset', '0.5', '-i', '/data/overlay-0.mov']);
    expect(args[args.indexOf('-filter_complex') + 1]).toContain('[cut0][2:v]overlay=eof_action=pass:format=auto[outv]');
    expect(args[args.indexOf('-map') + 1]).toBe('[outv]');
    lastProc().emit('spawn');
    lastProc().emit('close', 0, null);
    await tick();
    expect(generateThumbnail).toHaveBeenCalledWith(expect.any(String), jobId, { atSec: 1 });
    expect(getRenderJobStatus(jobId).status).toBe('complete');
    expect(removeCompositionScratch).toHaveBeenCalledWith(jobId);
    // Nothing is left to cancel once the render has finished.
    expect(cancelRender(jobId)).toBe(false);
  });
});

// #8985 — per-scene visual layers. A composed render cuts a still (its
// reference frame, moved deterministically) and a code-rendered title card
// into the footage timebase without needing footage for either; a plain
// concat render ignores the layer choice entirely.
describe('layered sections (#8985)', () => {
  const layeredScenes = [
    { sceneId: 's1', order: 0, videoHistoryId: 'h1' },
    { sceneId: 's2', order: 1, visualLayer: 'still', stillMove: 'pan', referenceImageId: 'frame.png', videoHistoryId: 'h1', startSec: 2, endSec: 4 },
    { sceneId: 's3', order: 2, visualLayer: 'card', cardText: 'Verse two', cardColor: '#112233', videoHistoryId: null, startSec: 4, endSec: 5.01 },
  ];
  const primeLayered = (projectId, mode, scenes = layeredScenes) => {
    prime(projectId);
    getProject.mockResolvedValue({
      id: projectId, name: 'P', trackId: 't1', status: 'ready', scenes,
      composition: { version: 1, mode, textCues: [], style: { color: '#ffffff', font: 'sans' }, posterSec: null },
    });
  };
  const filterGraph = (args) => args[args.indexOf('-filter_complex') + 1];

  it('keeps a concat render on footage only: the still scene plays its clip and the footage-less card is skipped', async () => {
    primeLayered('plain-layers', 'concat');
    await renderMusicVideo('plain-layers');
    const { args } = lastProc();
    expect(args).not.toContain('/data/images/frame.png');
    expect(filterGraph(args)).not.toContain('color=');
    expect(filterGraph(args)).toContain('concat=n=2:v=1:a=0[outv]');
    expect(h.overlays.calls).toHaveLength(0);
  });

  it('cuts footage, a still and a titled card on one frame grid and draws the card text over its section', async () => {
    primeLayered('layers-1', 'composed');
    const { jobId } = await renderMusicVideo('layers-1');
    // The card's title is captured for exactly its section: [2s clip][2s still][1.01s card → 24 frames].
    expect(h.overlays.calls[0]).toMatchObject({ jobId, width: 768, height: 512,
      cues: [{ id: 'card-s3', text: 'Verse two', startSec: 4, endSec: 5, placement: 'center', emphasis: 'hero' }] });
    h.overlays.resolve([{ path: '/data/overlay-0.mov', startSec: 4, durationSec: 1 }]);
    await tick();
    const { args } = lastProc();
    expect(args.slice(args.indexOf('-loop'), args.indexOf('-loop') + 6)).toEqual(['-loop', '1', '-framerate', '24', '-i', '/data/images/frame.png']);
    const graph = filterGraph(args);
    expect(graph).toContain('trim=end_frame=48,setpts=PTS-STARTPTS[v0]');
    expect(graph).toMatch(/crop=768:512:x='\(iw-ow\)\*n\/47'.*trim=end_frame=48,setpts=PTS-STARTPTS\[v1\]/);
    expect(graph).toContain('color=c=0x112233:s=768x512:r=24,setsar=1,format=yuv420p,trim=end_frame=24,setpts=PTS-STARTPTS[v2]');
    // The song is still the one and only audio: two section inputs, then the master.
    expect(args[args.lastIndexOf('-map') + 1]).toBe('2:a');
  });

  it.each([['HUD counters', 'pop', 'Menlo'], [undefined, 'fade', 'Georgia']])('applies shared card and font treatment %s at the full render entrypoint', async (graphicLanguage, template, font) => {
    const id = `typography-${template}`;
    primeLayered(id, 'composed');
    const project = await getProject(id);
    getProject.mockResolvedValue({ ...project, composition: { ...project.composition, style: { font: 'serif' } }, treatment: { brief: { graphicLanguage } } });
    const { jobId } = await renderMusicVideo(id);
    const options = h.overlays.calls[0];
    expect(options.cues[0]).toMatchObject({ id: 'card-s3', template });
    expect(options.style).toEqual({ font: 'serif', graphicLanguage });
    expect(buildTypographyDocument(options)).toContain(font);
    cancelRender(jobId);
    await tick();
  });

  it('refuses a still with no reference frame and an untimed card, without spawning', async () => {
    primeLayered('no-frame', 'composed', [{ sceneId: 's1', order: 0, visualLayer: 'still', referenceImageId: null, startSec: 0, endSec: 2 }]);
    await expect(renderMusicVideo('no-frame')).rejects.toMatchObject({ status: 404, code: 'MISSING_STILLS', context: { sceneIds: ['s1'] } });
    primeLayered('untimed', 'composed', [{ sceneId: 's1', order: 0, visualLayer: 'card', cardText: 'Hi', startSec: null, endSec: null }]);
    await expect(renderMusicVideo('untimed')).rejects.toMatchObject({ status: 422, code: 'UNTIMED_SECTIONS', context: { sceneIds: ['s1'] } });
    expect(h.procs).toHaveLength(0);
  });
});
