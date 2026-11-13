/** A no-song owner drives the public engine workflow without a Music Video record. */
import { afterAll, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../../lib/mockPathsDataRoot.js';
import { normalizeBlenderRecord } from '../../lib/musicVideoBlender.js';
import { createFakeBlender, exampleManifest } from '../musicVideo/blender/__blenderFixture.js';
import { listBlenderFiles, scaffoldBlenderWorkspace } from './sources.js';
import { startBlenderSync } from './sync.js';
import { cancelBlenderJob, enqueueBlenderRenders, resumePendingBlenderRenders } from './queue.js';
import { startBlenderCut } from './cuts.js';
import { getBlenderState } from './state.js';
import { copyBlenderFilm } from './fork.js';
import { listBlenderJobs, __resetBlenderJobsForTests } from './jobs.js';
import { clearBlenderFrames, dropBlenderFramesOutside, getBlenderDiskUsage } from './usage.js';

function ROOT() { return lazyTempDataRoot('film-owner-test-'); }
const runtime = vi.hoisted(() => ({ blender: null, ffmpeg: [] }));
vi.mock('../../lib/paths.js', async (load) => makePathsProxy(await load(), { dataRoot: ROOT }));
vi.mock('../codeAnimation/execution.js', () => ({
  getCodeAnimationExecution: (...args) => runtime.blender.getCodeAnimationExecution(...args),
  resolveBlenderTool: (...args) => runtime.blender.resolveBlenderTool(...args),
}));
vi.mock('../../lib/ffmpeg.js', async (load) => ({
  ...await load(), findFfmpeg: vi.fn(async () => '/opt/example/ffmpeg'), bt709TagFilter: vi.fn(async () => null),
  runFfmpegProcess: vi.fn(async ({ args }) => {
    runtime.ffmpeg.push(args);
    writeFileSync(args.at(-1), 'video');
    return { ok: true };
  }),
}));
afterAll(() => { __resetBlenderJobsForTests(); cleanupTempDataRoots(); });
beforeEach(() => {
  __resetBlenderJobsForTests(); cleanupTempDataRoots();
  runtime.blender = createFakeBlender();
  runtime.blender.control.manifest = exampleManifest();
});

function createOwner() {
  let record = normalizeBlenderRecord({});
  let durationSec = 6;
  const events = [];
  return { owner: {
    kind: 'standalone-test', id: 'example-film', workspaceDir: join(ROOT(), 'standalone', 'example-film'),
    timeline: async () => ({ durationSec, fps: record.settings.fps }),
    song: async () => null,
    readRecord: async () => record,
    writeRecord: async (change) => { record = { ...record, ...change(record) }; return record; },
    emit: (event) => events.push(event),
  }, events, setDuration: (value) => { durationSec = value; } };
}
const settled = (owner, ids, status = 'done') => vi.waitFor(() => {
  const jobs = listBlenderJobs({ ...owner }).filter((job) => ids.includes(job.id));
  expect(jobs).toHaveLength(ids.length);
  expect(jobs.map((job) => job.status)).toEqual(ids.map(() => status));
}, { timeout: 20_000, interval: 20 });

it('syncs against an independent timeline, renders stills, resumes old batch intent and joins a silent cut', async () => {
  const { owner, events, setDuration } = createOwner();
  await scaffoldBlenderWorkspace(owner);
  for (const shot of runtime.blender.control.manifest.shots) {
    writeFileSync(join(owner.workspaceDir, 'src', 'shots', `${shot.id}.py`), '# example shot');
  }
  await settled(owner, [(await startBlenderSync(owner)).job.id]);
  const song = JSON.parse(readFileSync(join(owner.workspaceDir, 'song.json')));
  expect(song).toMatchObject({ durationSec: 6, audio: { master: null, vocalStem: null }, analysis: { beats: [], sections: [], bpm: null }, lyrics: { cues: [], markers: [] } });
  expect((await getBlenderState(owner)).manifest.problems).toEqual([]);
  setDuration(7);
  expect((await getBlenderState(owner)).manifest.problems.length).toBeGreaterThan(0);
  setDuration(6);
  await settled(owner, (await enqueueBlenderRenders(owner, { quality: 'still', shotIds: ['s010'], times: [1] })).jobs.map((job) => job.id));
  expect((await getBlenderState(owner)).renders.s010.stills).toHaveLength(1);
  // Exact pre-extraction on-disk shape: no owner metadata or migration required.
  const pending = join(owner.workspaceDir, 'renders', 'pending.json');
  mkdirSync(join(owner.workspaceDir, 'renders'), { recursive: true });
  writeFileSync(pending, JSON.stringify([{ quality: 'preview', shotIds: ['s010', 's020', 's030'], attempt: 0 }]));
  await resumePendingBlenderRenders([{ ...owner }], 2);
  await settled(owner, listBlenderJobs(owner).filter((job) => job.quality === 'preview').map((job) => job.id));
  expect(existsSync(pending)).toBe(false);
  await settled(owner, [(await startBlenderCut(owner, { quality: 'preview' })).job.id]);
  const state = await getBlenderState(owner);
  expect(state.cuts[0]).toMatchObject({ durationSec: 6, missing: [], stale: [], filmLook: false });
  expect(runtime.ffmpeg.at(-1)).toContain('-an');
  expect(events.some((event) => event.kind === 'state')).toBe(true);
  expect(listBlenderJobs({ ...owner, kind: 'another-domain' })).toEqual([]);
});

// These public cleanup operations must never follow authored symlinks outside the workspace.
it('refuses symlinked frame cleanup without deleting the external target', async () => {
  const { owner } = createOwner();
  await scaffoldBlenderWorkspace(owner);
  await settled(owner, [(await startBlenderSync(owner)).job.id]);
  const external = join(ROOT(), 'external');
  const retained = join(external, 'frames', 'keep.png');
  mkdirSync(join(external, 'frames'), { recursive: true });
  writeFileSync(retained, 'keep');
  writeFileSync(join(external, 'render.json'), JSON.stringify({ complete: true }));
  writeFileSync(join(external, 'shot.mp4'), 'video');
  const shot = join(owner.workspaceDir, 'renders', 's010');
  mkdirSync(shot, { recursive: true });
  symlinkSync(external, join(shot, 'preview'), 'dir');
  await expect(dropBlenderFramesOutside(owner, [])).rejects.toMatchObject({ code: 'MUSIC_VIDEO_BLENDER_PATH' });
  await expect(clearBlenderFrames(owner)).rejects.toMatchObject({ code: 'MUSIC_VIDEO_BLENDER_PATH' });
  expect(readFileSync(retained, 'utf8')).toBe('keep');
});

it('indexes contact sheets from negative-time lead-in shots', async () => {
  const { owner } = createOwner();
  await scaffoldBlenderWorkspace(owner);
  runtime.blender.control.manifest.shots.unshift({ id: 'lead', start: -1, end: 0, label: 'Lead-in', deps: ['film.py'] });
  await settled(owner, [(await startBlenderSync(owner)).job.id]);
  await settled(owner, (await enqueueBlenderRenders(owner, { quality: 'sheet', shotIds: ['lead'], sheet: { every: 6, columns: 2 } })).jobs.map((job) => job.id));
  expect((await getBlenderState(owner)).renders.lead.sheets).toEqual([
    expect.objectContaining({ firstFrame: -24, lastFrame: -6, file: 'lead/sheets/sheet--24--6-e6.jpg' }),
  ]);
});

it('reports the layer cache bytes that frame cleanup will actually remove', async () => {
  const { owner } = createOwner();
  await scaffoldBlenderWorkspace(owner);
  await settled(owner, [(await startBlenderSync(owner)).job.id]);
  await settled(owner, (await enqueueBlenderRenders(owner, { quality: 'preview', shotIds: ['s010'] })).jobs.map((job) => job.id));
  const layers = join(owner.workspaceDir, 'renders', 's010', 'preview', 'layers', '0');
  mkdirSync(layers, { recursive: true });
  writeFileSync(join(layers, 'frame_000000.png'), Buffer.alloc(1000));
  const before = await getBlenderDiskUsage(owner);
  const cleared = await clearBlenderFrames(owner);
  expect(cleared.freedBytes).toBe(before.clearableBytes);
  expect(cleared.usage.clearableBytes).toBe(0);
  expect(existsSync(layers)).toBe(false);
});

it('holds render admission until frame cleanup finishes', async () => {
  const { owner } = createOwner();
  await scaffoldBlenderWorkspace(owner);
  await settled(owner, [(await startBlenderSync(owner)).job.id]);
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  let entered;
  const reading = new Promise((resolve) => { entered = resolve; });
  const read = owner.readRecord;
  owner.readRecord = async () => { owner.readRecord = read; entered(); await hold; return read(); };
  const clearing = clearBlenderFrames(owner);
  await reading;
  const rendering = enqueueBlenderRenders(owner, { quality: 'still', shotIds: ['s010'] });
  try {
    // Enqueue must not even read the record while cleanup owns admission.
    const laterRead = vi.spyOn(owner, 'readRecord');
    // Drain admitted work without a clock delay; blocked admission stays pending.
    await new Promise(setImmediate);
    expect(laterRead).not.toHaveBeenCalled();
    expect(listBlenderJobs(owner).some((job) => job.kind === 'render')).toBe(false);
  } finally { release(); }
  await clearing;
  await settled(owner, (await rendering).jobs.map((job) => job.id));
});

it('accepts cancellation after describe but before commit, and refuses it once commit has started', async () => {
  const { owner } = createOwner();
  await scaffoldBlenderWorkspace(owner);
  const timeline = owner.timeline;
  let reads = 0;
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  let entered;
  const described = new Promise((resolve) => { entered = resolve; });
  owner.timeline = async () => {
    reads += 1;
    // Preparation, silent song, then the returned manifest's coverage check.
    if (reads === 3) { entered(); await hold; }
    return timeline();
  };
  const first = (await startBlenderSync(owner)).job;
  await described;
  expect(await cancelBlenderJob(owner, first.id)).toBe(true);
  release();
  await settled(owner, [first.id], 'canceled');
  expect(existsSync(join(owner.workspaceDir, 'manifest.json'))).toBe(false);
  owner.timeline = timeline;
  let releaseCommit;
  const commitHold = new Promise((resolve) => { releaseCommit = resolve; });
  let committing;
  const commitStarted = new Promise((resolve) => { committing = resolve; });
  owner.onSynced = async (_, { change }) => { committing(); await commitHold; await owner.writeRecord(change); };
  const second = (await startBlenderSync(owner)).job;
  await commitStarted;
  try { expect(await cancelBlenderJob(owner, second.id)).toBe(false); }
  finally { releaseCommit(); }
  await settled(owner, [second.id]);
  expect((await getBlenderState(owner)).manifest.shots).toHaveLength(3);
});

// A capped listing must not become a successful partial fork or render-source hash.
it('refuses an oversized supported source tree before listing or copying a partial film', async () => {
  const { owner } = createOwner();
  const src = join(owner.workspaceDir, 'src');
  mkdirSync(src, { recursive: true });
  for (let index = 0; index < 5000; index += 1) writeFileSync(join(src, `asset${index}.json`), '{}');
  expect((await listBlenderFiles(owner)).files).toHaveLength(5000);
  writeFileSync(join(src, 'overflow.json'), '{}');
  const refusal = { code: 'MUSIC_VIDEO_BLENDER_SOURCE_LIMIT', status: 413 };
  await expect(listBlenderFiles(owner)).rejects.toMatchObject(refusal);
  const target = { ...owner, id: 'copy', workspaceDir: join(ROOT(), 'copy') };
  await expect(copyBlenderFilm(owner, target)).rejects.toMatchObject(refusal);
  expect(existsSync(target.workspaceDir)).toBe(false);
});
