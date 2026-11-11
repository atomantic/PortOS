/**
 * The Music Video Blender film routes, through the real router, the real
 * project store and the real engine (workspace, sync, queue, render index, cut
 * assembly) over a temp data root. Only the two processes are doubled: Blender
 * (a fake worker that plays the driver's part) and ffmpeg (records its
 * arguments and writes the output file).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';
import { createFakeBlender, exampleManifest } from '../services/musicVideo/blender/__blenderFixture.js';

const ROOT = () => lazyTempDataRoot('mv-blender-route-test-');
const blender = vi.hoisted(() => ({ fake: null, ffmpeg: [] }));

vi.mock('../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), { dataRoot: ROOT }));
vi.mock('../services/settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));
vi.mock('../services/codeAnimation/execution.js', () => ({
  getCodeAnimationExecution: (...args) => blender.fake.getCodeAnimationExecution(...args),
  resolveBlenderTool: (...args) => blender.fake.resolveBlenderTool(...args),
}));
vi.mock('../lib/ffmpeg.js', async (importOriginal) => ({
  ...await importOriginal(),
  findFfmpeg: vi.fn(async () => '/opt/example/ffmpeg'),
  bt709TagFilter: vi.fn(async () => null),
  runFfmpegProcess: vi.fn(async ({ args }) => {
    const { writeFileSync: write } = await import('node:fs');
    blender.ffmpeg.push(args);
    write(args.at(-1), 'video');
    return { ok: true };
  }),
}));
vi.mock('../lib/launchDetached.js', () => ({ launchDetached: vi.fn(async () => {}) }));
// The film look pass drives a browser; here it only records that it was asked to run.
vi.mock('../services/musicVideo/filmLookFinish.js', async (importOriginal) => ({ ...await importOriginal(), applyFilmLookFinish: vi.fn(async () => true) }));
// So does the title card capture; here it answers one clip for the card's opening window.
vi.mock('../services/musicVideo/compositionRender.js', async (importOriginal) => ({
  ...await importOriginal(),
  removeCompositionScratch: vi.fn(async () => {}),
  renderTypographyOverlays: vi.fn(async ({ jobId, cues }) => [{ path: `/captures/${jobId}.mov`, startSec: cues[0].startSec, durationSec: cues[0].endSec - cues[0].startSec }]),
}));

const { default: musicVideoRoutes } = await import('./musicVideo.js');
const projects = await import('../services/musicVideo/projects.js');
const { musicVideoEvents } = await import('../services/musicVideo/events.js');
const { __resetBlenderJobsForTests } = await import('../services/musicVideo/blender/jobs.js');
const { launchDetached } = await import('../lib/launchDetached.js');
const { applyFilmLookFinish } = await import('../services/musicVideo/filmLookFinish.js');
const { renderTypographyOverlays } = await import('../services/musicVideo/compositionRender.js');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use('/api/music-video', musicVideoRoutes);
app.use(errorMiddleware);

let project;
let events;
const api = (suffix = '') => `/api/music-video/${project.id}/blender${suffix}`;
const workspace = () => join(ROOT(), 'music-video', project.id, 'blender');
const state = async () => (await request(app).get(api())).body;
const onEvent = (event) => events.push(event);
// Jobs run in the background; a test waits for the terminal message of each.
// A loaded CI worker can take seconds over a step that takes milliseconds here.
const WAIT = { timeout: 20_000, interval: 20 };
const settled = (count = 1) => vi.waitFor(() => {
  const ended = events.filter((event) => event.kind === 'job' && ['done', 'error', 'canceled'].includes(event.job.status));
  expect(ended.length).toBeGreaterThanOrEqual(count);
  return ended;
}, WAIT);
const writeSource = (path, content) => request(app).put(api('/file')).send({ path, content });

async function scaffold() {
  expect((await request(app).post(api('/workspace')).send({ template: 'starter' })).status).toBe(201);
  // The example manifest's shots depend on these.
  for (const shot of ['s010', 's020', 's030']) await writeSource(`shots/${shot}.py`, `# ${shot}\n`);
}

// A sync is a background job. This starts one and waits for its end: `job` is the finished job
// and `body` the film state after it. A sync refused before it starts is returned as answered.
async function syncFilm(manifest = exampleManifest(), body = {}) {
  blender.fake.control.manifest = manifest;
  events.length = 0;
  const response = await request(app).post(api('/sync')).send(body);
  if (response.status !== 202) return response;
  expect(response.body.job).toMatchObject({ kind: 'sync', status: 'queued' });
  const [ended] = await settled(1);
  events.length = 0;
  return { status: response.status, job: ended.job, body: await state() };
}

async function renderAll(quality, body = {}) {
  events.length = 0;
  const response = await request(app).post(api('/render')).send({ quality, ...body });
  expect(response.status, JSON.stringify(response.body)).toBe(202);
  await settled(response.body.jobs.length);
  return response.body;
}

beforeEach(async () => {
  rmSync(join(ROOT(), 'music-video-projects.json'), { force: true });
  rmSync(join(ROOT(), 'music-video'), { recursive: true, force: true });
  __resetBlenderJobsForTests();
  blender.fake = createFakeBlender();
  blender.ffmpeg.length = 0;
  events = [];
  musicVideoEvents.off('blender', onEvent);
  musicVideoEvents.on('blender', onEvent);
  mkdirSync(join(ROOT(), 'music'), { recursive: true });
  writeFileSync(join(ROOT(), 'music', 'example-song.wav'), Buffer.alloc(64));
  project = await projects.createProject({ name: 'Example Film', uploadedAudioFilename: 'example-song.wav', composition: { mode: 'blender' } });
  await projects.mutateProjectRecord(project.id, (current) => ({
    project: { ...current, audioAnalysis: { durationSec: 6, bpm: 120, beats: [0.5, 1, 1.5], downbeats: [0.5], sections: [{ label: 'Intro', startSec: 0, endSec: 6, energy: 0.5 }] } },
  }));
});
afterAll(() => {
  musicVideoEvents.off('blender', onEvent);
  return cleanupTempDataRoots();
});

describe('Blender film settings and record', () => {
  it('merges a partial settings save over the defaults and refuses values Blender must never receive', async () => {
    const initial = await state();
    expect(initial.settings).toMatchObject({ engine: 'BLENDER_EEVEE_NEXT', width: 1920, height: 1080, fps: 24, previewScale: 0.5, concurrency: 2, saveBlend: false });
    expect(initial).toMatchObject({ manifest: null, renders: {}, cuts: [], jobs: [], notes: {}, workspace: { exists: false, hasFilm: false, files: 0, dir: `data/music-video/${project.id}/blender` } });

    const saved = await request(app).put(api('/settings')).send({ engine: 'CYCLES', width: 1280, height: 720, finalSamples: 128 });
    expect(saved.status).toBe(200);
    expect(saved.body.settings).toMatchObject({ engine: 'CYCLES', width: 1280, height: 720, fps: 24, finalSamples: 128, previewSamples: 16 });
    expect((await projects.getProject(project.id)).blender.settings.engine).toBe('CYCLES');
    expect(events).toContainEqual({ projectId: project.id, kind: 'state' });

    for (const bad of [{ width: 1281 }, { fps: 500 }, { engine: 'WORKBENCH' }, { concurrency: 9 }, { executable: '/bin/sh' }]) {
      expect((await request(app).put(api('/settings')).send(bad)).status, JSON.stringify(bad)).toBe(400);
    }
    // The install-local field is server-owned: the project PATCH never accepts it.
    const patched = await request(app).patch(`/api/music-video/${project.id}`).send({ blender: { settings: { width: 64 } } });
    expect(patched.status).toBe(400);
    expect((await state()).settings.width).toBe(1280);
  });

  it('reports a contained or unchecked Blender as not ready and refuses to run a film in it', async () => {
    await scaffold();
    blender.fake.control.executionMode = 'contained';
    expect((await state()).tool).toMatchObject({ ready: false, executionMode: 'contained', version: '5.2.3', reason: expect.stringContaining('Trusted local') });
    for (const [path, body] of [['/sync', {}], ['/render', { quality: 'preview' }]]) {
      const refused = await request(app).post(api(path)).send(body);
      expect([refused.status, refused.body.code], path).toEqual([409, 'MUSIC_VIDEO_BLENDER_NEEDS_TRUSTED_LOCAL']);
    }
    blender.fake.control.executionMode = 'trusted-local';
    blender.fake.control.ready = false;
    expect((await state()).tool).toMatchObject({ ready: false, version: null });
    expect((await request(app).post(api('/sync')).send({})).body.code).toBe('CODE_ANIMATION_BLENDER_NOT_READY');
    expect(blender.fake.control.jobs).toEqual([]);
  });
});

describe('Blender film workspace and source files', () => {
  it('scaffolds the starter film once and writes song.json for its author', async () => {
    const created = await request(app).post(api('/workspace')).send({ template: 'starter' });
    expect(created.status).toBe(201);
    expect(created.body.workspace).toMatchObject({ exists: true, hasFilm: true });
    const { files } = (await request(app).get(api('/files'))).body;
    expect(files.map((file) => file.path)).toEqual(expect.arrayContaining(['film.py', 'kit/stage.py', 'shots/wide.py']));
    expect(files.every((file) => file.text && file.bytes > 0)).toBe(true);
    const song = JSON.parse(readFileSync(join(workspace(), 'song.json'), 'utf8'));
    expect(song).toMatchObject({ projectId: project.id, title: 'Example Film', durationSec: 6, fps: 24, analysis: { bpm: 120, beats: [0.5, 1, 1.5] }, lyrics: { cues: [] } });
    expect(song.audio.master).toBe(join(ROOT(), 'music', 'example-song.wav'));

    const again = await request(app).post(api('/workspace')).send({ template: 'starter' });
    expect([again.status, again.body.code]).toEqual([409, 'MUSIC_VIDEO_BLENDER_WORKSPACE_EXISTS']);
  });

  it('reads, writes and deletes one text source file', async () => {
    const written = await writeSource('shots/s010.py', 'print("example")\n');
    expect(written.status).toBe(200);
    expect(written.body.workspace.files).toBe(1);
    expect((await request(app).get(api('/file?path=shots/s010.py'))).body).toEqual({ path: 'shots/s010.py', content: 'print("example")\n' });
    expect((await request(app).get(api('/file?path=missing.py'))).status).toBe(404);
    const removed = await request(app).delete(api('/file?path=shots/s010.py'));
    expect(removed.status).toBe(200);
    expect(existsSync(join(workspace(), 'src', 'shots', 's010.py'))).toBe(false);
  });

  it('refuses every path that could leave the workspace: traversal, absolute, unlisted types and depth', async () => {
    for (const path of ['../escape.py', '/tmp/escape.py', 'a/../../escape.py', '.hidden.py', 'run.sh', 'a/b/c/d/e/f/g.py', 'no-extension', 'shots\\s010.py']) {
      const refused = await writeSource(path, 'x');
      expect(refused.status, path).toBe(400);
      expect((await request(app).get(api(`/file?path=${encodeURIComponent(path)}`))).status, path).toBe(400);
      expect((await request(app).delete(api(`/file?path=${encodeURIComponent(path)}`))).status, path).toBe(400);
    }
    expect(existsSync(join(ROOT(), 'music-video', 'escape.py'))).toBe(false);

    // Binary assets are listed but never sent through the API.
    mkdirSync(join(workspace(), 'src'), { recursive: true });
    writeFileSync(join(workspace(), 'src', 'plate.png'), Buffer.alloc(8));
    expect((await request(app).get(api('/files'))).body.files).toEqual([expect.objectContaining({ path: 'plate.png', text: false })]);
    expect((await request(app).get(api('/file?path=plate.png'))).body.code).toBe('MUSIC_VIDEO_BLENDER_NOT_TEXT');
  });

  // Creating a symlink needs a privilege Windows CI does not grant.
  it.skipIf(process.platform === 'win32')('never follows a symbolic link inside the workspace, so a link an authored script left behind cannot aim a write elsewhere', async () => {
    const outside = join(ROOT(), 'outside');
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'secret.py'), 'secret');
    mkdirSync(join(workspace(), 'src'), { recursive: true });
    symlinkSync(outside, join(workspace(), 'src', 'linked'));
    symlinkSync(join(outside, 'secret.py'), join(workspace(), 'src', 'alias.py'));
    for (const path of ['linked/planted.py', 'alias.py']) {
      const refused = await writeSource(path, 'planted');
      expect([refused.status, refused.body.code], path).toEqual([400, 'MUSIC_VIDEO_BLENDER_PATH']);
      expect((await request(app).get(api(`/file?path=${path}`))).status, path).toBe(400);
    }
    expect(readdirSync(outside)).toEqual(['secret.py']);
    expect(readFileSync(join(outside, 'secret.py'), 'utf8')).toBe('secret');
    // Links are not part of the film: neither listed nor hashed.
    expect((await request(app).get(api('/files'))).body.files).toEqual([]);
    // The same holds for what is served: a link under renders/ is not a render.
    mkdirSync(join(workspace(), 'renders'), { recursive: true });
    symlinkSync(join(outside, 'secret.py'), join(workspace(), 'renders', 'leak.log'));
    expect((await request(app).get(api('/media?path=leak.log'))).status).toBe(400);
  });
});

describe('Blender film sync', () => {
  it('refuses a shot list that breaks the film contract and leaves the Board and manifest untouched', async () => {
    await scaffold();
    const base = exampleManifest();
    const broken = [
      [{ ...base, shots: [base.shots[0], { ...base.shots[1], start: 1.5 }] }, 'before shot s010 ends'],
      [{ ...base, shots: [{ ...base.shots[0], end: 2.02 }] }, 'frame boundary'],
      [{ ...base, shots: [{ ...base.shots[0], id: '../s010' }] }, '"id"'],
      [{ ...base, shots: [{ ...base.shots[2], end: 9 }] }, 'after the song ends'],
      [{ title: 'No shots', shots: [] }, 'no shots'],
    ];
    for (const [manifest, reason] of broken) {
      const { job } = await syncFilm(manifest);
      expect([job.status, job.code], reason).toEqual(['error', 'MUSIC_VIDEO_BLENDER_MANIFEST_INVALID']);
      expect(job.problems.join(' ')).toContain(reason);
    }
    blender.fake.control.describeError = 'NameError: name "stage" is not defined';
    const { job: raised } = await syncFilm();
    expect([raised.status, raised.code]).toEqual(['error', 'MUSIC_VIDEO_BLENDER_DESCRIBE_FAILED']);
    expect(raised.error).toContain('NameError');
    // The traceback a worker result would lose is in the job log, as text a person can read,
    // not as the one-line JSON event the driver reported it in.
    const log = readFileSync(join(workspace(), 'renders', raised.logFile), 'utf8');
    expect(log).toContain('Traceback (most recent call last):\n  example');
    expect(log).not.toContain('"event":"error"');
    expect((await state()).manifest).toBeNull();
    expect((await projects.getProject(project.id)).scenes).toEqual([]);
  });

  it('answers with a job at once, and a describe that never returns can be cancelled without wedging the next sync', async () => {
    await scaffold();
    blender.fake.control.manifest = exampleManifest();
    // The film's describe() hangs: the request must not wait for it.
    let release;
    blender.fake.control.describeHold = new Promise((resolve) => { release = resolve; });
    events.length = 0;
    const started = await request(app).post(api('/sync')).send({});
    expect(started.status).toBe(202);
    await vi.waitFor(async () => expect((await state()).jobs).toEqual([expect.objectContaining({ id: started.body.job.id, kind: 'sync', status: 'running' })]), WAIT);
    const second = await request(app).post(api('/sync')).send({});
    expect([second.status, second.body.code]).toEqual([409, 'MUSIC_VIDEO_BLENDER_SYNC_IN_PROGRESS']);

    expect((await request(app).post(api(`/jobs/${started.body.job.id}/cancel`)).send({})).body).toEqual({ ok: true });
    const [ended] = await settled(1);
    expect(ended.job).toMatchObject({ id: started.body.job.id, status: 'canceled' });
    expect((await state()).manifest).toBeNull();
    release();
    blender.fake.control.describeHold = null;
    expect((await syncFilm()).job.status).toBe('done');
  });

  it('saves the manifest and mirrors each shot onto one Board scene, in song order', async () => {
    await scaffold();
    const synced = await syncFilm();
    expect(synced.job.status, synced.job.error).toBe('done');
    expect(synced.body.manifest).toMatchObject({ title: 'Example Film', problems: [], srcChanged: false, fps: 24, options: [] });
    expect(synced.body.manifest.shots.map((shot) => [shot.id, shot.start, shot.end, shot.frames])).toEqual([['s010', 0, 2, 48], ['s020', 2, 4, 48], ['s030', 4, 6, 48]]);
    const stored = await projects.getProject(project.id);
    expect(stored.scenes.map((scene) => [scene.label, scene.startSec, scene.endSec, scene.visualLayer, scene.beatAligned, scene.order]))
      .toEqual([['Cold open', 0, 2, 'code', true, 0], ['Verse', 2, 4, 'code', true, 1], ['Chorus', 4, 6, 'code', true, 2]]);
    expect(stored.scenes[0]).toMatchObject({ visualIntent: 'The lights come up.', prompt: 'An empty stage.', framePrompt: 'Wide and symmetrical.' });
    expect(synced.body.manifest.shots.map((shot) => shot.sceneId)).toEqual(stored.scenes.map((scene) => scene.sceneId));
    expect(stored.blender).toMatchObject({ sceneMap: { s010: stored.scenes[0].sceneId }, syncedAt: expect.any(String), manifestHash: expect.any(String) });
    // The driver, the helper kit and the song are staged for the job; the film itself is read from the workspace.
    expect(blender.fake.control.jobs[0]).toMatchObject({ mode: 'describe', fps: 24, src: join(workspace(), 'src'), out: join(workspace(), 'renders') });
    expect(blender.fake.control.jobs[0].staged).toEqual(['job.json', 'portos_blender_driver.py', 'portos_film/music.py', 'portos_film/timing.py', 'song.json']);

    // A later edit to the scripts shows until the next sync.
    await writeSource('film.py', '# edited\n');
    expect((await state()).manifest.srcChanged).toBe(true);
  });

  it('keeps a shot\'s scene across syncs, removes the scene of a shot that is gone, and follows a retime', async () => {
    await scaffold();
    await syncFilm();
    const before = (await projects.getProject(project.id)).scenes;
    await request(app).put(api('/shots/s030/note')).send({ text: 'Example note', status: 'review' });
    const base = exampleManifest();
    const resynced = await syncFilm({ ...base, shots: [{ ...base.shots[0], end: 3 }, { ...base.shots[1], start: 3, end: 6, label: 'Verse, longer' }] });
    expect(resynced.job.status, resynced.job.error).toBe('done');
    const after = (await projects.getProject(project.id)).scenes;
    expect(after.map((scene) => [scene.sceneId, scene.label, scene.startSec, scene.endSec]))
      .toEqual([[before[0].sceneId, 'Cold open', 0, 3], [before[1].sceneId, 'Verse, longer', 3, 6]]);
    expect(resynced.body.notes).toEqual({});
    expect(Object.keys((await projects.getProject(project.id)).blender.sceneMap)).toEqual(['s010', 's020']);
  });

  it('refuses to overwrite Board scenes the film did not make unless told to replace them', async () => {
    await scaffold();
    const { scene } = await projects.mutateProjectRecord(project.id, async (current) => {
      const { addScene } = await import('../services/musicVideo/projectsLogic.js');
      return addScene(current, { label: 'Hand-made shot', startSec: 0, endSec: 6 });
    });
    const refused = await syncFilm();
    expect([refused.status, refused.body.code]).toEqual([409, 'MUSIC_VIDEO_BLENDER_SCENES_CONFLICT']);
    expect(refused.body.context).toMatchObject({ count: 1, scenes: [{ sceneId: scene.sceneId, label: 'Hand-made shot' }] });
    // Refused before Blender ran.
    expect(blender.fake.control.jobs).toEqual([]);
    expect((await projects.getProject(project.id)).scenes.map((s) => s.label)).toEqual(['Hand-made shot']);

    const replaced = await syncFilm(exampleManifest(), { replaceScenes: true });
    expect(replaced.job.status, replaced.job.error).toBe('done');
    expect((await projects.getProject(project.id)).scenes.map((s) => s.label)).toEqual(['Cold open', 'Verse', 'Chorus']);
  });
});

describe('Blender film shot renders', () => {
  it('queues one job per shot, streams its progress, encodes the shot video and records what it was made from', async () => {
    await scaffold();
    await syncFilm();
    await request(app).put(api('/settings')).send({ saveBlend: true });
    const { jobs, skipped } = await renderAll('preview');
    expect(skipped).toEqual([]);
    expect(jobs.map((job) => [job.kind, job.shotId, job.quality, job.status])).toEqual([['render', 's010', 'preview', 'queued'], ['render', 's020', 'preview', 'queued'], ['render', 's030', 'preview', 'queued']]);

    const first = events.filter((event) => event.kind === 'job' && event.job.id === jobs[0].id).map((event) => event.job);
    expect(first.map((job) => job.status)).toEqual(expect.arrayContaining(['running', 'encoding', 'done']));
    expect(first.at(-1)).toMatchObject({ status: 'done', index: 48, total: 48, frame: 47, secPerFrame: 0.25, finishedAt: expect.any(String), logFile: `logs/${jobs[0].id}.log` });
    // Frame progress is throttled: far fewer messages than frames.
    expect(first.length).toBeLessThan(12);

    // The job the driver received: preview is scaled, uses the preview samples, and never resumes a fresh render.
    const job = blender.fake.control.jobs.find((entry) => entry.mode === 'render');
    expect(job).toMatchObject({ quality: 'preview', scale: 0.5, samples: 16, width: 1920, height: 1080, fps: 24, engine: 'BLENDER_EEVEE_NEXT', resume: false, saveBlend: true });
    expect(job.shots).toHaveLength(1);

    const encode = blender.ffmpeg.find((args) => args.at(-1).endsWith(join('s010', 'preview', 'shot.mp4.part.mp4')));
    expect(encode).toEqual(expect.arrayContaining(['-framerate', '24', '-start_number', '0', '-frames:v', '48', '-crf', '21', '-g', '24', '-pix_fmt', 'yuv420p', '-an']));
    expect(encode[encode.indexOf('-i') + 1]).toBe(join(workspace(), 'renders', 's010', 'preview', 'frames', 'frame_%06d.jpg'));

    const now = await state();
    // The poster is a small JPEG made from the middle frame when the video is encoded.
    expect(now.renders.s020.preview).toMatchObject({ file: 's020/preview/shot.mp4', frames: 48, complete: true, stale: false, staleReasons: [], poster: 's020/preview/poster.jpg', width: 960, height: 540 });
    const poster = blender.ffmpeg.find((args) => args.at(-1).endsWith(join('s020', 'preview', 'poster.jpg.part.jpg')));
    expect(poster[poster.indexOf('-i') + 1]).toBe(join(workspace(), 'renders', 's020', 'preview', 'frames', 'frame_000072.jpg'));
    expect(now.renders.s020.blend).toBe('s020/shot.blend');
    expect(now.renders.s020.final).toBeUndefined();
    expect(JSON.parse(readFileSync(join(workspace(), 'renders', 's020', 'preview', 'render.json'), 'utf8')))
      .toMatchObject({ shotId: 's020', quality: 'preview', startFrame: 48, endFrame: 96, frameCount: 48, width: 960, height: 540, fps: 24, samples: 16, blenderVersion: '5.2.3', device: 'GPU', complete: true });
    expect(readFileSync(join(workspace(), 'renders', 'logs', `${jobs[0].id}.log`), 'utf8')).toContain('free-form Blender output');

    // Nothing to do: every preview is complete and current.
    expect(await renderAll('preview')).toEqual({ jobs: [], skipped: ['s010', 's020', 's030'] });
    const opened = await request(app).post(api('/shots/s020/open')).send({});
    expect(opened.body).toMatchObject({ opened: true });
    expect(launchDetached).toHaveBeenCalledWith('/opt/example/Blender', ['--disable-autoexec', join(workspace(), 'renders', 's020', 'shot.blend')]);
    expect((await request(app).post(api('/shots/s999/open')).send({})).status).toBe(404);
  });

  it('marks only the shots whose own source changed as stale, and re-renders just those', async () => {
    await scaffold();
    await syncFilm();
    await renderAll('preview');
    await writeSource('shots/s020.py', '# a new idea for the verse\n');
    const edited = await state();
    expect(Object.entries(edited.renders).map(([id, render]) => [id, render.preview.stale, render.preview.staleReasons]))
      .toEqual([['s010', false, []], ['s020', true, ['source']], ['s030', false, []]]);

    blender.fake.control.jobs.length = 0;
    const { jobs, skipped } = await renderAll('preview', { onlyStale: true });
    expect(jobs.map((job) => job.shotId)).toEqual(['s020']);
    expect(skipped).toEqual(['s010', 's030']);
    // Different source: the old frames are not resumed.
    expect(blender.fake.control.jobs[0].resume).toBe(false);
    expect((await state()).renders.s020.preview).toMatchObject({ complete: true, stale: false });
    // "Only stale" means a render that exists and is out of date: no final was ever made, so none is taken.
    expect(await renderAll('final', { onlyStale: true })).toEqual({ jobs: [], skipped: ['s010', 's020', 's030'] });

    // A settings change stales that quality everywhere.
    await request(app).put(api('/settings')).send({ previewSamples: 32 });
    expect(Object.values((await state()).renders).map((render) => render.preview.staleReasons)).toEqual([['settings'], ['settings'], ['settings']]);
    const forced = await renderAll('preview', { shotIds: ['s010'], force: true });
    expect(forced.jobs.map((job) => job.shotId)).toEqual(['s010']);
    expect((await request(app).post(api('/render')).send({ quality: 'preview', shotIds: ['s404'] })).status).toBe(404);

    // A retimed shot says so, and a frame rate the shots were not synced at refuses to render at all.
    const base = exampleManifest();
    await syncFilm({ ...base, shots: [{ ...base.shots[0], end: 1.5 }, { ...base.shots[1], start: 1.5 }, base.shots[2]] });
    expect((await state()).renders.s010.preview.staleReasons).toEqual(['timing']);
    await request(app).put(api('/settings')).send({ fps: 30 });
    const offGrid = await request(app).post(api('/render')).send({ quality: 'preview' });
    expect([offGrid.status, offGrid.body.code]).toEqual([409, 'MUSIC_VIDEO_BLENDER_NOT_SYNCED']);
    expect(offGrid.body.error).toContain('frame rate changed from 24 to 30');
  });

  it('keeps the finished frames of a cancelled render and resumes them, and drops queued jobs on cancel all', async () => {
    await scaffold();
    await syncFilm();
    await request(app).put(api('/settings')).send({ concurrency: 1 });
    let release;
    blender.fake.control.hold = new Promise((resolve) => { release = resolve; });
    events.length = 0;
    const queued = await request(app).post(api('/render')).send({ quality: 'final' });
    expect(queued.body.jobs).toHaveLength(3);
    // One Blender at a time: the first shot renders, the others wait. Its first frame is reported
    // before the hold, so the cancel below lands on a render that has a frame to keep.
    await vi.waitFor(() => expect(events.some((event) => event.job?.id === queued.body.jobs[0].id && event.job.index === 1)).toBe(true), WAIT);
    const renderStatuses = async () => (await state()).jobs.filter((job) => job.kind === 'render').map((job) => job.status);
    expect(await renderStatuses()).toEqual(['running', 'queued', 'queued']);

    const cancelled = await request(app).post(api(`/jobs/${queued.body.jobs[0].id}/cancel`)).send({});
    expect(cancelled.body).toEqual({ ok: true });
    await settled(1);
    // The next shot started once the slot was free; cancel all stops it and drops the last.
    await vi.waitFor(async () => expect(await renderStatuses()).toEqual(['canceled', 'running', 'queued']), WAIT);
    expect((await request(app).post(api('/cancel')).send({})).body).toEqual({ ok: true });
    await settled(3);
    expect(await renderStatuses()).toEqual(['canceled', 'canceled', 'canceled']);
    expect(blender.fake.control.peak).toBe(1);
    expect((await request(app).post(api('/jobs/unknown/cancel')).send({})).body).toEqual({ ok: false });

    // The first frame of shot 1 was written before the cancel and survives it.
    const partial = (await state()).renders.s010.final;
    expect(partial).toMatchObject({ complete: false, stale: false, partialFrames: 1, file: null });
    blender.fake.control.hold = null;
    release();
    blender.fake.control.jobs.length = 0;
    await renderAll('final', { shotIds: ['s010'] });
    expect(blender.fake.control.jobs[0]).toMatchObject({ quality: 'final', resume: true, scale: 1, samples: 64 });
    expect((await state()).renders.s010.final).toMatchObject({ complete: true, stale: false, frames: 48 });
  });

  it('reports the Shots step on project reads from the final renders on disk, without storing it', async () => {
    await scaffold();
    await syncFilm();
    const read = async () => (await request(app).get(`/api/music-video/${project.id}`)).body.blenderShots;
    expect(await read()).toEqual({ total: 3, finalReady: 0, ready: false });
    await renderAll('final');
    expect(await read()).toEqual({ total: 3, finalReady: 3, ready: true });
    await writeSource('shots/s030.py', '# changed after its final\n');
    expect(await read()).toEqual({ total: 3, finalReady: 2, ready: false });
    const listed = (await request(app).get('/api/music-video?summary=1')).body.items.find((item) => item.id === project.id);
    expect(listed.composition).toEqual({ mode: 'blender' });
    expect(await projects.getProject(project.id)).not.toHaveProperty('blenderShots');
  });

  it('reads the project\'s final video as out of date once the shots it was joined from have changed', async () => {
    await scaffold();
    await syncFilm();
    await renderAll('final');
    const readFinal = async () => (await request(app).get(`/api/music-video/${project.id}`)).body.renderDependencyState;
    const joined = async (final) => projects.mutateProjectRecord(project.id, (current) => ({
      project: { ...current, renderHistoryId: 'example-final', renderDependencies: null, blender: { ...current.blender, final } },
    }));
    // A final some other render made (or one made before the film recorded this) is left alone.
    await joined({ jobId: 'another-final', signature: 'x' });
    expect(await readFinal()).toBeUndefined();
    expect((await state()).finalStale).toBeNull();
    // The project's final, joined from other shot renders than the ones on disk now.
    await joined({ jobId: 'example-final', signature: 'the-renders-it-was-joined-from' });
    expect(await readFinal()).toEqual({ status: 'stale', reasons: ['Blender shots changed or were rendered again after this final was joined'] });
    expect((await state()).finalStale).toBe(true);
  });

  it('renders stills at the requested song times and lists them newest first', async () => {
    await scaffold();
    await syncFilm();
    const midpoint = await renderAll('still', { shotIds: ['s020'] });
    expect(midpoint.jobs).toHaveLength(1);
    expect(blender.fake.control.jobs.at(-1)).toMatchObject({ quality: 'still', frames: [72], scale: 1, samples: 64 });
    const timed = await renderAll('still', { times: [0.5, 4.25] });
    expect(timed.jobs.map((job) => job.shotId)).toEqual(['s010', 's030']);
    expect(timed.skipped).toEqual(['s020']);
    const stills = (await state()).renders;
    expect(stills.s020.stills).toEqual([expect.objectContaining({ file: 's020/stills/t000003000.png', timeSec: 3, stale: false })]);
    expect(stills.s030.stills.map((still) => still.timeSec)).toEqual([4.25]);
    expect((await request(app).post(api('/render')).send({ quality: 'still', times: [99] })).status).toBe(400);
    expect((await request(app).post(api('/render')).send({ quality: 'preview', times: [1] })).status).toBe(400);
  });
});

describe('Blender film cuts, notes and media', () => {
  it('assembles a cut with black frames for a shot that has no video, lays the song under it and serves it', async () => {
    await scaffold();
    await syncFilm();
    await renderAll('preview', { shotIds: ['s010', 's030'] });
    blender.ffmpeg.length = 0;
    events.length = 0;
    const started = await request(app).post(api('/cut')).send({ quality: 'preview' });
    expect(started.status).toBe(202);
    expect(started.body.job).toMatchObject({ kind: 'cut', quality: 'preview', status: 'queued' });
    const [ended] = await settled(1);
    expect(ended.job.status, ended.job.error).toBe('done');

    const [black, join_, mux] = blender.ffmpeg;
    // The missing shot is black for exactly its own length, in the cut's frame.
    expect(black).toEqual(expect.arrayContaining(['-f', 'lavfi', '-i', 'color=c=black:s=960x540:r=24', '-frames:v', '48', '-crf', '21']));
    expect(join_).toEqual(expect.arrayContaining(['-f', 'concat', '-safe', '0', '-c', 'copy']));
    expect(mux).toEqual(expect.arrayContaining(['-i', join(ROOT(), 'music', 'example-song.wav'), '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-t', '6']));
    expect(mux[mux.indexOf('-filter_complex') + 1]).toContain('atrim=start=0:end=6');
    expect(blender.ffmpeg).toHaveLength(3);

    const { cuts } = await state();
    expect(cuts).toEqual([expect.objectContaining({ quality: 'preview', durationSec: 6, missing: ['s020'], stale: [], rerendered: [], filmLook: false, file: expect.stringMatching(/^cuts\/preview-.+\.mp4$/) })]);
    expect(readdirSync(join(workspace(), 'renders')).filter((name) => name.startsWith('.'))).toEqual([]);

    const served = await request(app).get(api(`/media?path=${cuts[0].file}`)).set('Range', 'bytes=0-1');
    expect(served.status).toBe(206);
    expect(served.headers).toMatchObject({ 'content-type': 'video/mp4', 'x-content-type-options': 'nosniff', 'content-range': 'bytes 0-1/5' });
    expect(served.headers['content-security-policy']).toContain('sandbox');
    const log = await request(app).get(api(`/media?path=${ended.job.logFile}`));
    expect(log.headers['content-type']).toContain('text/plain');
    expect(log.text).toContain('1 black');
    for (const path of ['../../song.json', 'cuts/cuts.json', '.scratch-x/joined.mp4', 's010/preview/render.json', 'cuts/missing.mp4']) {
      expect([400, 404], path).toContain((await request(app).get(api(`/media?path=${encodeURIComponent(path)}`))).status);
    }

    // A shot rendered after the cut is not in it: the cut says so instead of passing for current.
    await renderAll('preview', { shotIds: ['s020'] });
    expect((await state()).cuts[0]).toMatchObject({ missing: ['s020'], rerendered: ['s020'] });
  });

  it('runs a cut through the project film look only when asked, and only when the look changes the picture', async () => {
    await scaffold();
    await syncFilm();
    await renderAll('preview');
    applyFilmLookFinish.mockClear();
    const cut = async (body) => {
      events.length = 0;
      await request(app).post(api('/cut')).send({ quality: 'preview', ...body });
      const [ended] = await settled(1);
      expect(ended.job.status, ended.job.error).toBe('done');
      return (await state()).cuts[0];
    };
    // A neutral look has nothing to add, whatever was asked.
    expect((await cut({ filmLook: true })).filmLook).toBe(false);
    await projects.updateProject(project.id, { filmLook: { version: 2, preset: 'custom', grain: 0.4 } });
    // The pass is slow, so a cut skips it unless asked.
    expect((await cut({})).filmLook).toBe(false);
    expect(applyFilmLookFinish).not.toHaveBeenCalled();
    const finished = await cut({ filmLook: true });
    expect(finished.filmLook).toBe(true);
    expect(applyFilmLookFinish).toHaveBeenCalledTimes(1);
    expect(applyFilmLookFinish.mock.calls[0][0].path).toBe(join(workspace(), 'renders', finished.file));
  });

  it('lays the project title card over a cut, captured at the cut\'s own frame size', async () => {
    await scaffold();
    await syncFilm();
    await renderAll('preview');
    await projects.updateProject(project.id, { titleCard: { title: 'Example Song', artist: 'Example Artist', style: 'mtv', startSec: 1, endSec: 3 } });
    renderTypographyOverlays.mockClear();
    blender.ffmpeg.length = 0;
    events.length = 0;
    await request(app).post(api('/cut')).send({ quality: 'preview' });
    const [ended] = await settled(1);
    expect(ended.job.status, ended.job.error).toBe('done');
    expect(renderTypographyOverlays).toHaveBeenCalledTimes(1);
    expect(renderTypographyOverlays.mock.calls[0][0]).toMatchObject({ width: 960, height: 540, fps: 24, durationSec: 6, cues: [{ id: 'title-card', startSec: 1, endSec: 3 }] });
    const painted = blender.ffmpeg.find((args) => args.includes('-itsoffset'));
    expect(painted).toEqual(expect.arrayContaining(['-itsoffset', '1', '-i', `/captures/blender-title-${ended.job.id}.mov`, '-crf', '21']));
    expect(painted[painted.indexOf('-filter_complex') + 1]).toContain('[0:v][c0]overlay=eof_action=pass:format=yuv420[v]');
  });

  it('publishes a cut as a new version of one review-draft animatic', async () => {
    await scaffold();
    await syncFilm();
    await renderAll('preview');
    for (const version of [1, 2]) {
      events.length = 0;
      await request(app).post(api('/cut')).send({ quality: 'preview', animatic: true });
      const [ended] = await settled(1);
      expect(ended.job.status, ended.job.error).toBe('done');
      const artifacts = (await projects.getProject(project.id)).devArtifacts.filter((artifact) => !artifact.deleted);
      expect(artifacts.map((artifact) => [artifact.kind, artifact.title, artifact.version, artifact.mimeType])).toEqual([['animatic', 'Blender cut', version, 'video/mp4']]);
    }
  });

  it('saves a director note on a synced shot only', async () => {
    await scaffold();
    await syncFilm();
    const saved = await request(app).put(api('/shots/s020/note')).send({ text: 'Hold the wide a beat longer', status: 'wip' });
    expect(saved.body.notes.s020).toMatchObject({ text: 'Hold the wide a beat longer', status: 'wip', updatedAt: expect.any(String) });
    expect((await request(app).put(api('/shots/s020/note')).send({ status: 'approved' })).body.notes.s020).toMatchObject({ text: 'Hold the wide a beat longer', status: 'approved' });
    expect((await request(app).put(api('/shots/s404/note')).send({ text: 'x' })).status).toBe(404);
    expect((await request(app).put(api('/shots/s020/note')).send({ status: 'shipped' })).status).toBe(400);
    expect((await request(app).put(api('/shots/s020/note')).send({})).status).toBe(400);
  });
});

// A film that lets the operator choose a palette, a debug overlay, a glow amount and a title card.
const optionManifest = () => ({
  ...exampleManifest(),
  options: [
    { key: 'palette', label: 'Palette', type: 'choice', choices: [{ value: 'dusk', label: 'Dusk' }, { value: 'neon' }], default: 'dusk', help: 'Colors of the set.' },
    { key: 'debug', type: 'boolean', default: false },
    { key: 'glow', type: 'number', default: 0.5, min: 0, max: 1, step: 0.1 },
    { key: 'card', type: 'text', default: '' },
  ],
});

describe('Blender film options', () => {
  it('stores what the film declares, saves values through settings, refuses invalid ones whole, and hands every film call the effective set', async () => {
    await scaffold();
    // Nothing is declared before the first sync, so nothing can be checked or saved.
    const early = await request(app).put(api('/settings')).send({ options: { palette: 'neon' } });
    expect([early.status, early.body.code]).toEqual([409, 'MUSIC_VIDEO_BLENDER_NOT_SYNCED']);
    // A value that is already on the record (a fork carries its settings) reaches the first describe as saved.
    await projects.mutateProjectRecord(project.id, (current) => ({ project: { ...current, blender: { settings: { options: { palette: 'neon', gone: 'x' } } } } }));

    const synced = await syncFilm(optionManifest());
    expect(synced.job.status, synced.job.error).toBe('done');
    expect(blender.fake.control.jobs[0]).toMatchObject({ mode: 'describe', options: { palette: 'neon', gone: 'x' } });
    expect(synced.body.manifest.options).toEqual([
      { key: 'palette', label: 'Palette', type: 'choice', help: 'Colors of the set.', choices: [{ value: 'dusk', label: 'Dusk' }, { value: 'neon', label: 'neon' }], default: 'dusk' },
      { key: 'debug', label: 'debug', type: 'boolean', default: false },
      { key: 'glow', label: 'glow', type: 'number', min: 0, max: 1, step: 0.1, default: 0.5 },
      { key: 'card', label: 'card', type: 'text', default: '' },
    ]);
    // The value for a key the film does not declare was dropped by the sync.
    expect(synced.body.settings.options).toEqual({ palette: 'neon' });

    // Only the keys sent change; null clears a saved value back to the film's default.
    const saved = await request(app).put(api('/settings')).send({ options: { glow: 0.8, debug: true } });
    expect(saved.status).toBe(200);
    expect(saved.body.settings.options).toEqual({ palette: 'neon', glow: 0.8, debug: true });
    expect((await request(app).put(api('/settings')).send({ options: { glow: null } })).body.settings.options).toEqual({ palette: 'neon', debug: true });

    for (const [bad, reason] of [
      [{ palette: 'mauve' }, '"palette" must be one of dusk, neon'], [{ debug: 'yes' }, '"debug" must be true or false'],
      [{ glow: 2 }, '"glow" must be at most 1'], [{ card: 5 }, '"card" must be text'], [{ volume: 1 }, '"volume" is not an option of this film'],
    ]) {
      const refused = await request(app).put(api('/settings')).send({ fps: 30, options: { card: 'kept out', ...bad } });
      expect([refused.status, refused.body.code], reason).toEqual([400, 'MUSIC_VIDEO_BLENDER_OPTION_INVALID']);
      expect(refused.body.context.errors).toEqual([reason]);
    }
    // Refused whole: neither the valid option nor the frame rate sent beside the bad value was saved.
    expect((await state()).settings).toMatchObject({ fps: 24, options: { palette: 'neon', debug: true } });

    // A render is built with the declared defaults overlaid with the saved values, and records them.
    blender.fake.control.jobs.length = 0;
    await renderAll('preview', { shotIds: ['s010'] });
    const built = { palette: 'neon', debug: true, glow: 0.5, card: '' };
    expect(blender.fake.control.jobs[0]).toMatchObject({ mode: 'render', options: built });
    expect(JSON.parse(readFileSync(join(workspace(), 'renders', 's010', 'preview', 'render.json'), 'utf8'))).toMatchObject({ options: built, optionsHash: expect.any(String) });
    await renderAll('still', { shotIds: ['s010'] });
    expect((await state()).renders.s010).toMatchObject({ preview: { stale: false }, stills: [{ stale: false }] });

    // Changing an option makes every render built with the old value stale; the frames are not resumed.
    await request(app).put(api('/settings')).send({ options: { palette: 'dusk' } });
    expect((await state()).renders.s010).toMatchObject({ preview: { complete: true, stale: true, staleReasons: ['options'] }, stills: [{ stale: true }] });
    blender.fake.control.jobs.length = 0;
    expect((await renderAll('preview', { onlyStale: true })).jobs.map((job) => job.shotId)).toEqual(['s010']);
    expect(blender.fake.control.jobs[0]).toMatchObject({ resume: false, options: { ...built, palette: 'dusk' } });
    expect((await state()).renders.s010.preview).toMatchObject({ stale: false, staleReasons: [] });
    // Setting it back makes nothing current again by accident: the render on disk was built with dusk.
    await request(app).put(api('/settings')).send({ options: { palette: 'neon' } });
    expect((await state()).renders.s010.preview.staleReasons).toEqual(['options']);

    // A later sync hears the options the last one declared, and drops a value the film stopped accepting.
    blender.fake.control.jobs.length = 0;
    const narrowed = optionManifest();
    narrowed.options = [{ ...narrowed.options[0], choices: [{ value: 'dusk' }, { value: 'gold' }] }, narrowed.options[2]];
    const resynced = await syncFilm(narrowed);
    expect(blender.fake.control.jobs[0]).toMatchObject({ mode: 'describe', options: { palette: 'neon', debug: true, glow: 0.5, card: '' } });
    expect(resynced.body.settings.options).toEqual({});
    expect(resynced.body.manifest.options.map((option) => option.key)).toEqual(['palette', 'glow']);
  });
});

describe('Blender film disk use', () => {
  it('reports what the workspace holds, and clears the frames of finished renders and removed shots while every video stays', async () => {
    await scaffold();
    await syncFilm();
    await request(app).put(api('/settings')).send({ concurrency: 1 });
    await renderAll('final');
    // An interrupted preview: one frame on disk and no video. Clearing waits for renders to end.
    let release;
    blender.fake.control.hold = new Promise((resolve) => { release = resolve; });
    events.length = 0;
    const queued = await request(app).post(api('/render')).send({ quality: 'preview', shotIds: ['s010'] });
    await vi.waitFor(() => expect(events.some((event) => event.job?.id === queued.body.jobs[0].id && event.job.index === 1)).toBe(true), WAIT);
    const busy = await request(app).post(api('/frames/clear')).send({});
    expect([busy.status, busy.body.code]).toEqual([409, 'MUSIC_VIDEO_BLENDER_RENDERS_ACTIVE']);
    await request(app).post(api('/cancel')).send({});
    await settled(1);
    blender.fake.control.hold = null;
    release();

    // A shot that leaves the film keeps its video (it may come back) but not its frames.
    const base = exampleManifest();
    await syncFilm({ ...base, shots: base.shots.slice(0, 2) });
    const shotDir = (shot, ...rest) => join(workspace(), 'renders', shot, ...rest);
    expect(existsSync(shotDir('s030', 'final', 'frames'))).toBe(false);
    expect(existsSync(shotDir('s030', 'final', 'shot.mp4'))).toBe(true);

    const usage = (await request(app).get(api('/usage'))).body;
    expect(usage).toMatchObject({ frameFiles: 48 + 48 + 1, removedShots: ['s030'] });
    expect(usage.clearableBytes).toBeGreaterThan(0);
    expect(usage.rendersBytes).toBeGreaterThanOrEqual(usage.frameBytes);
    expect(usage.sourceBytes).toBeGreaterThan(0);

    const cleared = await request(app).post(api('/frames/clear')).send({});
    expect(cleared.status, JSON.stringify(cleared.body)).toBe(200);
    expect(cleared.body.freedBytes).toBe(usage.clearableBytes);
    // The unfinished preview kept its frame, so it still resumes.
    expect(cleared.body.usage).toMatchObject({ frameFiles: 1, clearableBytes: 0, removedShots: [] });
    expect(existsSync(shotDir('s030'))).toBe(false);
    expect(readdirSync(shotDir('s020', 'final')).sort()).toEqual(['poster.jpg', 'render.json', 'shot.mp4']);
    const after = await state();
    expect(after.renders.s020.final).toMatchObject({ complete: true, stale: false, file: 's020/final/shot.mp4', poster: 's020/final/poster.jpg' });
    expect(after.renders.s010.preview).toMatchObject({ complete: false, partialFrames: 1, poster: 's010/preview/frames/frame_000000.jpg' });
    blender.fake.control.jobs.length = 0;
    await renderAll('preview', { shotIds: ['s010'] });
    expect(blender.fake.control.jobs[0].resume).toBe(true);
  });
});

describe('Blender film fork', () => {
  const blenderOf = async (id) => (await request(app).get(`/api/music-video/${id}/blender`)).body;

  it('gives a new version its own copy of the film, mapped to its own scenes, without the renders or the notes', async () => {
    await scaffold();
    await syncFilm(optionManifest());
    await request(app).put(api('/settings')).send({ finalSamples: 128, options: { palette: 'neon' } });
    await request(app).put(api('/shots/s010/note')).send({ text: 'Example note', status: 'review' });
    await renderAll('preview', { shotIds: ['s010'] });
    const source = project;

    const forked = await request(app).post(`/api/music-video/${source.id}/clone`).send({});
    expect(forked.status, JSON.stringify(forked.body)).toBe(201);
    const forkDir = join(ROOT(), 'music-video', forked.body.id, 'blender');
    expect(readdirSync(forkDir).sort()).toEqual(['manifest.json', 'song.json', 'src']);
    expect(readFileSync(join(forkDir, 'src', 'kit', 'stage.py'), 'utf8')).toBe(readFileSync(join(workspace(), 'src', 'kit', 'stage.py'), 'utf8'));
    expect(JSON.parse(readFileSync(join(forkDir, 'song.json'), 'utf8')).projectId).toBe(forked.body.id);

    const film = await blenderOf(forked.body.id);
    expect(film.settings).toMatchObject({ finalSamples: 128, options: { palette: 'neon' } });
    expect(film.manifest).toMatchObject({ srcChanged: false, options: [{ key: 'palette' }, { key: 'debug' }, { key: 'glow' }, { key: 'card' }] });
    // The shots are mapped to the fork's own Board scenes, so its first sync is not a conflict.
    expect(film.manifest.shots.map((shot) => shot.sceneId)).toEqual(forked.body.scenes.map((scene) => scene.sceneId));
    expect(forked.body.scenes.map((scene) => scene.sceneId)).not.toEqual((await projects.getProject(source.id)).scenes.map((scene) => scene.sceneId));
    expect(film).toMatchObject({ renders: { s010: { stills: [] }, s020: { stills: [] }, s030: { stills: [] } }, notes: {}, cuts: [] });

    // A variant is made in the fork without touching the original.
    project = forked.body;
    await writeSource('shots/s010.py', '# the variant\n');
    expect((await syncFilm(optionManifest())).job.status).toBe('done');
    expect(readFileSync(join(ROOT(), 'music-video', source.id, 'blender', 'src', 'shots', 's010.py'), 'utf8')).toBe('# s010\n');
    const original = await blenderOf(source.id);
    expect(original.manifest.srcChanged).toBe(false);
    expect(original.renders.s010.preview).toMatchObject({ complete: true, stale: false });
    expect(original.notes.s010).toMatchObject({ text: 'Example note', status: 'review' });
  });

  it('forks a project that has no film workspace as before, and a footage adaptation without the film', async () => {
    await request(app).put(api('/settings')).send({ fps: 30 });
    const plain = await request(app).post(`/api/music-video/${project.id}/clone`).send({});
    expect(plain.status).toBe(201);
    expect((await projects.getProject(plain.body.id)).blender).toEqual({ settings: expect.objectContaining({ fps: 30 }) });
    expect(existsSync(join(ROOT(), 'music-video', plain.body.id))).toBe(false);

    await scaffold();
    await syncFilm();
    const footage = await request(app).post(`/api/music-video/${project.id}/clone`).send({ variant: 'video-generation' });
    expect(footage.status).toBe(201);
    expect(footage.body.composition.mode).toBe('composed');
    expect((await projects.getProject(footage.body.id)).blender).not.toHaveProperty('sceneMap');
    expect(existsSync(join(ROOT(), 'music-video', footage.body.id, 'blender'))).toBe(false);
  });
});
