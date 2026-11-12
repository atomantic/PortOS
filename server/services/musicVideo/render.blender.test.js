/**
 * A Blender film at the render-dispatch boundary: the final render
 * (renderMusicVideo) and a song-window excerpt (startExcerptRender) for
 * `composition.mode === 'blender'`, through the real job, history and settling
 * path and the real Blender film engine over a temp data root. Blender, ffmpeg,
 * the film look's browser pass and the title card's browser capture are doubled.
 */
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';
import { createFakeBlender, exampleManifest } from './blender/__blenderFixture.js';

const ROOT = () => lazyTempDataRoot('portos-mv-blender-render-');
const blender = vi.hoisted(() => ({ fake: null, ffmpeg: [] }));

vi.mock('../../lib/paths.js', async (load) => makePathsProxy(await load(), { dataRoot: ROOT }));
vi.mock('./productionReview.js', async (load) => ({ ...await load(), assertProductionApproval: vi.fn() }));
vi.mock('../../lib/ffmpeg.js', async (load) => ({
  ...await load(),
  findFfmpeg: vi.fn(async () => '/opt/example/ffmpeg'),
  bt709TagFilter: vi.fn(async () => null),
  generateThumbnail: vi.fn(async () => 'thumb.jpg'),
  runFfmpegProcess: vi.fn(async ({ args }) => {
    const { writeFileSync: write } = await import('node:fs');
    blender.ffmpeg.push(args);
    write(args.at(-1), 'video');
    return { ok: true };
  }),
}));
vi.mock('../instanceIdentity.js', () => ({ ensureInstanceId: vi.fn(async () => 'test-instance') }));
vi.mock('../videoGen/local.js', () => ({ loadHistory: vi.fn(async () => []), mutateVideoHistory: vi.fn(async () => {}) }));
vi.mock('./codeRender.js', async (load) => ({ ...await load(), writeCodeProofSheet: vi.fn(async () => null) }));
vi.mock('../codeAnimation/execution.js', () => ({
  getCodeAnimationExecution: (...args) => blender.fake.getCodeAnimationExecution(...args),
  resolveBlenderTool: (...args) => blender.fake.resolveBlenderTool(...args),
}));
vi.mock('./filmLookFinish.js', async (load) => ({ ...await load(), applyFilmLookFinish: vi.fn(async () => true) }));
// The title card capture drives a browser; here it answers one clip per window it was asked to capture.
vi.mock('./compositionRender.js', async (load) => {
  const actual = await load();
  return {
    ...actual,
    removeCompositionScratch: vi.fn(async () => {}),
    renderTypographyOverlays: vi.fn(async ({ jobId, cues, fps, durationSec, window }) => actual.typographyOverlayWindows({ cues, fps, durationSec, window })
      .flatMap(({ windows }) => windows.map((span, index) => ({ path: `/captures/${jobId}-${index}.mov`, startSec: span.startSec, durationSec: span.frames / fps })))),
  };
});

const projects = await import('./projects.js');
const { renderMusicVideo, recoverStuckMusicVideoRenders } = await import('./render.js');
const { startExcerptRender } = await import('./excerptRender.js');
const { applyFilmLookFinish } = await import('./filmLookFinish.js');
const { removeCompositionScratch, renderTypographyOverlays } = await import('./compositionRender.js');
const { mutateVideoHistory } = await import('../videoGen/local.js');
const { musicVideoEvents } = await import('./events.js');
const { startBlenderSync } = await import('./blender/sync.js');
const { enqueueBlenderRenders, cancelBlenderProjectJobs, resumePendingBlenderRenders } = await import('./blender/queue.js');
const { saveBlenderSettings } = await import('./blender/record.js');
const { listBlenderJobs } = await import('./blender/jobs.js');
const { blenderFilmReadState } = await import('./blender/renderIndex.js');
const { writeBlenderFile } = await import('./blender/sources.js');
const { __resetBlenderJobsForTests } = await import('./blender/jobs.js');

afterAll(cleanupTempDataRoots);

// Background jobs: a loaded CI worker can take seconds over a step that takes milliseconds here.
const WAIT = { timeout: 20_000, interval: 20 };
let id;
const ended = [];
musicVideoEvents.on('blender', (event) => { if (event.kind === 'job' && ['done', 'error', 'canceled'].includes(event.job.status)) ended.push(event.job); });

async function renderShots(quality, shotIds = null, { force = false } = {}) {
  ended.length = 0;
  const { jobs } = await enqueueBlenderRenders(id, { quality, force, ...(shotIds ? { shotIds } : {}) });
  await vi.waitFor(() => expect(ended.filter((job) => job.kind === 'render')).toHaveLength(jobs.length), WAIT);
  expect(ended.map((job) => job.error).filter(Boolean)).toEqual([]);
}

// The job's own settled event: by then the history, the project row and the retiring of older finals are all done.
const settledRenders = [];
musicVideoEvents.on('render', (event) => settledRenders.push(event));
const finished = async (jobId) => {
  await vi.waitFor(() => expect(settledRenders).toContainEqual(expect.objectContaining({ jobId, status: 'completed' })), WAIT);
  expect((await projects.getProject(id)).renderHistoryId).toBe(jobId);
};
// Likewise for an excerpt: its record reads complete before its slot and backup lease are released.
const settledExcerpts = [];
musicVideoEvents.on('excerpt-render', (event) => settledExcerpts.push(event));
const excerptDone = async (excerptId) => {
  await vi.waitFor(() => expect(settledExcerpts).toContainEqual(expect.objectContaining({ excerptId })), WAIT);
  expect((await projects.getProject(id)).excerpts.find((excerpt) => excerpt.id === excerptId).status).toBe('complete');
};

beforeEach(async () => {
  rmSync(join(ROOT(), 'music-video-projects.json'), { force: true });
  rmSync(join(ROOT(), 'music-video'), { recursive: true, force: true });
  __resetBlenderJobsForTests();
  vi.clearAllMocks();
  blender.fake = createFakeBlender();
  blender.fake.control.manifest = exampleManifest();
  blender.ffmpeg.length = 0;
  mkdirSync(join(ROOT(), 'music'), { recursive: true });
  writeFileSync(join(ROOT(), 'music', 'example-song.wav'), Buffer.alloc(64));
  const project = await projects.createProject({ name: 'Example Film', uploadedAudioFilename: 'example-song.wav', composition: { mode: 'blender' } });
  id = project.id;
  await projects.mutateProjectRecord(id, (current) => ({ project: { ...current, audioAnalysis: { durationSec: 6, beats: [], downbeats: [], sections: [] } } }));
  for (const path of ['film.py', 'shots/s010.py', 'shots/s020.py', 'shots/s030.py']) await writeBlenderFile(id, path, `# ${path}\n`);
  ended.length = 0;
  await startBlenderSync(id);
  await vi.waitFor(() => expect(ended.map((job) => [job.kind, job.status])).toEqual([['sync', 'done']]), WAIT);
});

it('refuses the final render until every shot has a complete, current final render, then joins them with the song as the project\'s final', async () => {
  await expect(renderMusicVideo(id)).rejects.toMatchObject({ status: 409, code: 'MUSIC_VIDEO_BLENDER_SHOTS_NOT_READY', context: { missing: ['s010', 's020', 's030'], stale: [] } });
  // Previews do not count: the final video is made of final renders.
  await renderShots('preview');
  await expect(renderMusicVideo(id)).rejects.toMatchObject({ code: 'MUSIC_VIDEO_BLENDER_SHOTS_NOT_READY', context: { missing: ['s010', 's020', 's030'] } });
  await renderShots('final');
  await writeBlenderFile(id, 'shots/s020.py', '# reworked\n');
  await expect(renderMusicVideo(id)).rejects.toMatchObject({ code: 'MUSIC_VIDEO_BLENDER_SHOTS_NOT_READY', context: { missing: [], stale: ['s020'] } });
  // A refusal releases the project's render slot.
  await renderShots('final', ['s020']);

  blender.ffmpeg.length = 0;
  const { jobId } = await renderMusicVideo(id);
  await finished(jobId);
  const [joined, mux] = blender.ffmpeg;
  // Whole, current shot videos join by stream copy: no re-encode, no black, no conforming.
  expect(blender.ffmpeg).toHaveLength(2);
  expect(joined).toEqual(expect.arrayContaining(['-f', 'concat', '-c', 'copy']));
  expect(mux).toEqual(expect.arrayContaining(['-i', join(ROOT(), 'music', 'example-song.wav'), '-c:v', 'copy', '-c:a', 'aac', '-t', '6']));
  expect(mux.at(-1)).toMatch(/music-video-.*\.mp4\.part\.mp4$/);
  const history = mutateVideoHistory.mock.calls.map(([mutate]) => mutate([])).flat();
  expect(history).toContainEqual(expect.objectContaining({ id: jobId, modelId: 'music-video-blender', width: 1920, height: 1080, fps: 24, numFrames: 144, musicVideoProjectId: id }));
  expect(await projects.getProject(id)).toMatchObject({ status: 'complete', renderHistoryId: jobId });
  // A neutral look leaves the joined picture untouched.
  expect(applyFilmLookFinish).not.toHaveBeenCalled();

  // The film records which shot renders the final was joined from. A shot rendered again
  // afterwards leaves the final behind, even though every shot is complete and current again.
  expect((await projects.getProject(id)).blender.final).toEqual({ jobId, signature: expect.any(String) });
  expect(await blenderFilmReadState(await projects.getProject(id))).toEqual({ shots: { total: 3, finalReady: 3, ready: true }, finalStale: false });
  await renderShots('final', ['s010'], { force: true });
  expect(await blenderFilmReadState(await projects.getProject(id))).toEqual({ shots: { total: 3, finalReady: 3, ready: true }, finalStale: true });
  // A new final catches up.
  const again = await renderMusicVideo(id);
  await finished(again.jobId);
  expect((await blenderFilmReadState(await projects.getProject(id))).finalStale).toBe(false);
});

it('runs the project film look as a finishing pass on a Blender final and its excerpts, and paints the grade at the join', async () => {
  await renderShots('final');
  await projects.updateProject(id, { filmLook: { version: 2, preset: 'custom', grain: 0.4 }, composition: { mode: 'blender', grade: { preset: 'teal-night', grain: 0 } } });
  blender.ffmpeg.length = 0;
  const { jobId } = await renderMusicVideo(id);
  await finished(jobId);
  expect(applyFilmLookFinish).toHaveBeenCalledTimes(1);
  expect(applyFilmLookFinish.mock.calls[0][0]).toMatchObject({ jobId, path: expect.stringMatching(/music-video-.*\.mp4$/), project: { id } });
  // The grade is painted over the joined shots before the song is laid under them.
  const graded = blender.ffmpeg.find((args) => args.includes('-filter_complex') && !args.includes('-c:a'));
  expect(graded[graded.indexOf('-filter_complex') + 1]).toMatch(/^\[0:v\]format=gbrp,lutrgb=.*scale=out_color_matrix=bt709:out_range=tv,format=yuv420p\[v\]$/);
  expect(blender.ffmpeg.map((args) => args.includes('-filter_complex'))).toEqual([false, true, true]);

  // An excerpt takes the look on song time, as a footage excerpt does.
  const { excerptId } = await startExcerptRender(id, { startSec: 1, endSec: 3 });
  await excerptDone(excerptId);
  expect(applyFilmLookFinish).toHaveBeenCalledTimes(2);
  expect(applyFilmLookFinish.mock.calls[1][0]).toMatchObject({ offsetSec: 1, jobId: excerptId });
});

// The mtv card here is steady, but no film look pass follows a neutral look: the join is the only place to draw it.
it('lays the project title card over a Blender final and over the part of it an excerpt holds', async () => {
  await renderShots('final');
  await projects.updateProject(id, { titleCard: { title: 'Example Song', artist: 'Example Artist', year: 'MMXXVI', style: 'mtv', startSec: 0.5, endSec: 2, outro: true, outroStartSec: 4, outroEndSec: 5.5 } });
  const overlayInputs = (args) => args.flatMap((arg, index) => (arg === '-itsoffset' ? [[args[index + 1], args[index + 3]]] : []));
  blender.ffmpeg.length = 0;
  const { jobId } = await renderMusicVideo(id);
  await finished(jobId);
  expect(renderTypographyOverlays).toHaveBeenCalledTimes(1);
  expect(renderTypographyOverlays.mock.calls[0][0]).toMatchObject({
    jobId: `blender-title-${jobId}`, width: 1920, height: 1080, fps: 24, durationSec: 6, window: { startFrame: 0, endFrame: 144 },
    cues: [{ id: 'title-card', startSec: 0.5, endSec: 2, titleCard: { style: 'mtv', title: 'Example Song' } }, { id: 'title-card-end', startSec: 4, endSec: 5.5 }],
  });
  // Both windows ride over the joined shots at their song times, in the shot videos' BT.709.
  const painted = blender.ffmpeg.find((args) => args.includes('-itsoffset'));
  expect(overlayInputs(painted)).toEqual([['0.5', `/captures/blender-title-${jobId}-0.mov`], ['4', `/captures/blender-title-${jobId}-1.mov`]]);
  expect(painted[painted.indexOf('-filter_complex') + 1]).toBe([
    '[1:v]scale=out_color_matrix=bt709:out_range=tv,format=yuva420p[c0]', '[0:v][c0]overlay=eof_action=pass:format=yuv420[p0]',
    '[2:v]scale=out_color_matrix=bt709:out_range=tv,format=yuva420p[c1]', '[p0][c1]overlay=eof_action=pass:format=yuv420[v]',
  ].join(';'));
  expect(removeCompositionScratch).toHaveBeenCalledWith(`blender-title-${jobId}`);

  // An excerpt takes only the window that reaches into it, counted from its own first frame.
  blender.ffmpeg.length = 0;
  const { excerptId } = await startExcerptRender(id, { startSec: 1, endSec: 3 });
  await excerptDone(excerptId);
  expect(renderTypographyOverlays).toHaveBeenCalledTimes(2);
  expect(renderTypographyOverlays.mock.calls[1][0]).toMatchObject({ durationSec: 6, window: { startFrame: 24, endFrame: 72 } });
  expect(overlayInputs(blender.ffmpeg.find((args) => args.includes('-itsoffset'))).map(([offset]) => offset)).toEqual(['0']);

  // A window the card never shows in opens no browser and joins as before.
  blender.ffmpeg.length = 0;
  await excerptDone((await startExcerptRender(id, { startSec: 2, endSec: 4 })).excerptId);
  expect(renderTypographyOverlays).toHaveBeenCalledTimes(2);
  expect(blender.ffmpeg.some((args) => args.includes('-itsoffset'))).toBe(false);
});

// Uniquely catches a steady card baked under the film look pass (it would weave and grain with the
// film), one dropped from both the join and the pass, and a card that is not steady handed to the pass.
it('leaves a steady title card out of the join for the film look pass to draw, and bakes a card that is not steady as before', async () => {
  await renderShots('final');
  const card = { title: 'Example Song', artist: 'Example Artist', style: 'mtv', startSec: 0.5, endSec: 2 };
  await projects.updateProject(id, { filmLook: { version: 2, preset: 'custom', grain: 0.4 }, titleCard: card });
  blender.ffmpeg.length = 0;
  const { jobId } = await renderMusicVideo(id);
  await finished(jobId);
  // No capture browser, no overlay at the join: the shots still join by stream copy.
  expect(renderTypographyOverlays).not.toHaveBeenCalled();
  expect(blender.ffmpeg.some((args) => args.includes('-itsoffset'))).toBe(false);
  expect(blender.ffmpeg).toHaveLength(2);
  // The pass draws it instead, and stops it where the six-second film ends.
  expect(applyFilmLookFinish).toHaveBeenCalledTimes(1);
  expect(applyFilmLookFinish.mock.calls[0][0]).toMatchObject({ jobId, titleCard: { title: 'Example Song', style: 'mtv', steady: true, startSec: 0.5, endSec: 2 }, titleCardUntilSec: 6 });

  // An excerpt's pass draws it on song time.
  const { excerptId } = await startExcerptRender(id, { startSec: 1, endSec: 3 });
  await excerptDone(excerptId);
  expect(renderTypographyOverlays).not.toHaveBeenCalled();
  expect(applyFilmLookFinish.mock.calls[1][0]).toMatchObject({ jobId: excerptId, offsetSec: 1, titleCard: { title: 'Example Song', steady: true }, titleCardUntilSec: 6 });

  // Keep steady switched off: the card belongs in the film, so the join bakes it and the look runs over it.
  await projects.updateProject(id, { titleCard: { ...card, steady: false } });
  blender.ffmpeg.length = 0;
  const film = await renderMusicVideo(id);
  await finished(film.jobId);
  expect(renderTypographyOverlays).toHaveBeenCalledTimes(1);
  expect(blender.ffmpeg.some((args) => args.includes('-itsoffset'))).toBe(true);
  expect(applyFilmLookFinish).toHaveBeenCalledTimes(3);
  expect(applyFilmLookFinish.mock.calls[2][0]).not.toHaveProperty('titleCard');
});

it('cuts an excerpt window out of the best available shot videos and refuses one holding a shot with no video', async () => {
  await renderShots('final', ['s010']);
  await renderShots('preview', ['s020']);
  blender.ffmpeg.length = 0;
  const { excerptId } = await startExcerptRender(id, { startSec: 1, endSec: 3 });
  await excerptDone(excerptId);
  const trims = blender.ffmpeg.filter((args) => args.includes('-vf')).map((args) => [args[args.indexOf('-i') + 1], args[args.indexOf('-vf') + 1]]);
  // The last second of shot 1's final, then the first second of shot 2's preview fitted up to the final frame.
  expect(trims).toEqual([
    [expect.stringContaining(join('s010', 'final', 'shot.mp4')), expect.stringContaining('trim=start_frame=24:end_frame=48')],
    [expect.stringContaining(join('s020', 'preview', 'shot.mp4')), expect.stringMatching(/trim=start_frame=0:end_frame=24.*scale=1920:1080/)],
  ]);
  expect(blender.ffmpeg.at(-1)[blender.ffmpeg.at(-1).indexOf('-filter_complex') + 1]).toContain('atrim=start=1:end=3');
  expect(applyFilmLookFinish).not.toHaveBeenCalled();

  const before = (await projects.getProject(id)).excerpts.length;
  await expect(startExcerptRender(id, { startSec: 3, endSec: 5 })).rejects.toMatchObject({ status: 409, code: 'MUSIC_VIDEO_BLENDER_SHOTS_NOT_READY', context: { missing: ['s030'] } });
  await expect(startExcerptRender(id, { startSec: 1, endSec: 3, aspect: '9:16' })).rejects.toMatchObject({ code: 'EXCERPT_ASPECT_UNSUPPORTED' });
  // Neither refusal leaves an excerpt record or a held slot behind.
  expect((await projects.getProject(id)).excerpts).toHaveLength(before);
  await renderShots('preview', ['s030']);
  await excerptDone((await startExcerptRender(id, { startSec: 3, endSec: 5 })).excerptId);
});

it('starts waiting stills, previews, then finals in stable order without interrupting a running final', async () => {
  await saveBlenderSettings(id, { concurrency: 1 });
  let release;
  blender.fake.control.hold = new Promise((resolve) => { release = resolve; });
  try {
    const finals = await enqueueBlenderRenders(id, { quality: 'final' });
    await vi.waitFor(() => expect(blender.fake.control.jobs.filter((job) => job.mode !== 'describe')).toHaveLength(1), WAIT);
    const firstFinal = finals.jobs[0];
    expect(listBlenderJobs(id).find(({ id: jobId }) => jobId === firstFinal.id).status).toBe('running');

    const previews = await enqueueBlenderRenders(id, { quality: 'preview', shotIds: ['s020', 's030'] });
    const stills = await enqueueBlenderRenders(id, { quality: 'still', shotIds: ['s010', 's020'] });
    // The visible job list remains in creation order even though dispatch priority differs.
    expect(listBlenderJobs(id).map(({ id: jobId }) => jobId).slice(-finals.jobs.length - previews.jobs.length - stills.jobs.length))
      .toEqual([...finals.jobs, ...previews.jobs, ...stills.jobs].map(({ id: jobId }) => jobId));
    expect(blender.fake.control.jobs.filter((job) => job.mode !== 'describe')).toHaveLength(1);
    expect(listBlenderJobs(id).find(({ id: jobId }) => jobId === firstFinal.id).status).toBe('running');

    release();
    const expectedJobs = [
      ['final', 's010'],
      ['still', 's010'], ['still', 's020'],
      ['preview', 's020'], ['preview', 's030'],
      ['final', 's020'], ['final', 's030'],
    ];
    await vi.waitFor(() => expect(blender.fake.control.jobs.filter((job) => job.mode !== 'describe').map(({ quality, shots }) => [quality, shots[0].id]))
      .toEqual(expectedJobs), WAIT);
    await vi.waitFor(() => expect(ended.filter((job) => job.kind === 'render' && ['done', 'error', 'canceled'].includes(job.status))).toHaveLength(7), WAIT);
    expect(ended.filter((job) => job.kind === 'render' && job.error)).toEqual([]);
  } finally {
    vi.useRealTimers();
    release();
    blender.fake.control.hold = null;
  }
});


const pendingPath = () => join(ROOT(), 'music-video', id, 'blender', 'renders', 'pending.json');
const pending = () => JSON.parse(readFileSync(pendingPath(), 'utf8'));

it('recovers an interrupted final batch from disk, skips finished shots and removes settled intent', async () => {
  await renderShots('final', ['s010']);
  expect(existsSync(pendingPath())).toBe(false);
  // A restart has forgotten jobs but retained both completed output and batch intent.
  __resetBlenderJobsForTests();
  writeFileSync(pendingPath(), JSON.stringify([{ quality: 'final', shotIds: ['s010', 's020', 's030'], attempt: 0 }]));
  blender.fake.control.jobs.length = 0;
  ended.length = 0;
  let release;
  blender.fake.control.hold = new Promise((resolve) => { release = resolve; });
  try {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    await recoverStuckMusicVideoRenders();
    expect(pending()[0].attempt).toBe(0);
    await vi.advanceTimersByTimeAsync(15_000);
    vi.useRealTimers();
    await vi.waitFor(() => expect(pending()).toEqual([{ quality: 'final', shotIds: ['s020', 's030'], attempt: 1 }]), WAIT);
    release();
    await vi.waitFor(() => expect(ended.filter((job) => job.kind === 'render')).toHaveLength(2), WAIT);
    expect(blender.fake.control.jobs.map((job) => [job.quality, job.shots[0].id]).sort()).toEqual([['final', 's020'], ['final', 's030']]);
    expect(existsSync(pendingPath())).toBe(false);
  } finally {
    vi.useRealTimers();
    release();
    blender.fake.control.hold = null;
  }
});

it('merges concurrent requests, persists both qualities but not stills, and cancel prevents restart resurrection', async () => {
  await saveBlenderSettings(id, { concurrency: 1 });
  let release;
  blender.fake.control.hold = new Promise((resolve) => { release = resolve; });
  try {
    const [first, second] = await Promise.all([
      enqueueBlenderRenders(id, { quality: 'final', shotIds: ['s010', 's020'] }),
      enqueueBlenderRenders(id, { quality: 'final', shotIds: ['s020', 's030'] }),
    ]);
    expect(second.jobs[0].id).toBe(first.jobs[1].id);
    await enqueueBlenderRenders(id, { quality: 'preview', shotIds: ['s020'] });
    await enqueueBlenderRenders(id, { quality: 'still', shotIds: ['s010'] });
    expect(pending()).toEqual([
      { quality: 'final', shotIds: ['s010', 's020', 's030'], attempt: 0 },
      { quality: 'preview', shotIds: ['s020'], attempt: 0 },
    ]);
    expect(await cancelBlenderProjectJobs(id)).toBe(true);
    expect(existsSync(pendingPath())).toBe(false);
    release();
    await vi.waitFor(() => expect(listBlenderJobs(id).filter((job) => !['done', 'error', 'canceled'].includes(job.status))).toHaveLength(0), WAIT);
    const runs = blender.fake.control.jobs.length;
    await resumePendingBlenderRenders([id], 2);
    expect(blender.fake.control.jobs).toHaveLength(runs);
  } finally {
    vi.useRealTimers();
    release();
    blender.fake.control.hold = null;
  }
});

it('removes exhausted or unavailable batches with one diagnostic and allows cancellation during the boot delay', async () => {
  mkdirSync(join(pendingPath(), '..'), { recursive: true });
  const marker = (attempt) => writeFileSync(pendingPath(), JSON.stringify([{ quality: 'preview', shotIds: ['s010', 's020'], attempt }]));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    marker(2);
    await resumePendingBlenderRenders([id], 2);
    expect(existsSync(pendingPath())).toBe(false);
    expect(log.mock.calls.filter(([message]) => message.includes('Blender boot recovery'))).toEqual([[expect.stringContaining('stopped 2 preview shot(s) at the restart limit')]]);
    log.mockClear();
    marker(0);
    blender.fake.control.ready = false;
    await resumePendingBlenderRenders([id], 2);
    expect(existsSync(pendingPath())).toBe(false);
    expect(log.mock.calls.filter(([message]) => message.includes('Blender boot recovery'))).toHaveLength(1);
    marker(0);
    expect(await cancelBlenderProjectJobs(id)).toBe(true);
    await resumePendingBlenderRenders([id], 2);
    expect(blender.fake.control.jobs).toHaveLength(1); // initial sync only
  } finally {
    log.mockRestore();
  }
});


it('still settles jobs when a full disk prevents clearing pending intent, so retry is not deduplicated to a dead job', async () => {
  await saveBlenderSettings(id, { concurrency: 1 });
  let release;
  blender.fake.control.hold = new Promise((resolve) => { release = resolve; });
  const fileCore = await import('../../lib/fileCore.js');
  const write = fileCore.atomicWrite;
  const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
  let failed = false;
  let writeSpy;
  try {
    const { jobs } = await enqueueBlenderRenders(id, { quality: 'final', shotIds: ['s010', 's020'] });
    writeSpy = vi.spyOn(fileCore, 'atomicWrite').mockImplementation((path, ...args) => {
      if (path === pendingPath() && !failed) {
        failed = true;
        return Promise.reject(Object.assign(new Error('disk full'), { code: 'ENOSPC' }));
      }
      return write(path, ...args);
    });
    release();
    await vi.waitFor(() => expect(jobs.map((job) => listBlenderJobs(id).find((entry) => entry.id === job.id).status)).toEqual(['done', 'done']), WAIT);
    expect(failed).toBe(true);
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('could not clear pending intent: disk full'));
    writeSpy.mockRestore();
    ended.length = 0;
    const retry = await enqueueBlenderRenders(id, { quality: 'final', shotIds: ['s010'], force: true });
    expect(retry.jobs[0].id).not.toBe(jobs[0].id);
    await vi.waitFor(() => expect(ended.filter((job) => job.kind === 'render')).toHaveLength(1), WAIT);
    expect(existsSync(pendingPath())).toBe(false);
  } finally {
    release();
    blender.fake.control.hold = null;
    writeSpy?.mockRestore();
    errorLog.mockRestore();
  }
});


it('retains unstarted batch intent after a transient project-store failure, then resumes it within the retry bound', async () => {
  mkdirSync(join(pendingPath(), '..'), { recursive: true });
  writeFileSync(pendingPath(), JSON.stringify([{ quality: 'preview', shotIds: ['s010'], attempt: 0 }]));
  const read = vi.spyOn(projects, 'getProject').mockRejectedValueOnce(new Error('database temporarily unavailable'));
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await resumePendingBlenderRenders([id], 2);
    expect(pending()).toEqual([{ quality: 'preview', shotIds: ['s010'], attempt: 1 }]);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('retained 1 preview shot(s) after an unexpected failure'));
    expect(blender.fake.control.jobs).toHaveLength(1); // initial sync only
    read.mockRestore();
    ended.length = 0;
    await resumePendingBlenderRenders([id], 2);
    await vi.waitFor(() => expect(ended.filter((job) => job.kind === 'render')).toHaveLength(1), WAIT);
    expect(ended[0].status).toBe('done');
    expect(existsSync(pendingPath())).toBe(false);
  } finally {
    read.mockRestore();
    log.mockRestore();
  }
});


it('refuses a sync that wins admission during the pending write without leaving unaccepted render intent', async () => {
  const fileCore = await import('../../lib/fileCore.js');
  const write = fileCore.atomicWrite;
  let releaseWrite;
  let releaseSync;
  let entered = false;
  const heldWrite = new Promise((resolve) => { releaseWrite = resolve; });
  blender.fake.control.describeHold = new Promise((resolve) => { releaseSync = resolve; });
  const spy = vi.spyOn(fileCore, 'atomicWrite').mockImplementation(async (path, ...args) => {
    if (path === pendingPath() && !entered) {
      entered = true;
      await heldWrite;
    }
    return write(path, ...args);
  });
  try {
    const enqueue = enqueueBlenderRenders(id, { quality: 'final', shotIds: ['s010'] });
    const refused = expect(enqueue).rejects.toMatchObject({ code: 'MUSIC_VIDEO_BLENDER_SYNC_IN_PROGRESS' });
    await vi.waitFor(() => expect(entered).toBe(true), WAIT);
    await startBlenderSync(id);
    releaseWrite();
    await refused;
    expect(existsSync(pendingPath())).toBe(false);
    expect(listBlenderJobs(id).filter((job) => job.kind === 'render')).toHaveLength(0);
    await cancelBlenderProjectJobs(id);
    releaseSync();
    await vi.waitFor(() => expect(listBlenderJobs(id).filter((job) => !['done', 'error', 'canceled'].includes(job.status))).toHaveLength(0), WAIT);
  } finally {
    releaseWrite();
    releaseSync();
    blender.fake.control.describeHold = null;
    spy.mockRestore();
  }
});
