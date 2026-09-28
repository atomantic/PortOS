/**
 * Music Video opt-in automatic review/retries (#8988), through the real
 * router, autoReviewService.js, revisionService.js, excerptRender.js and the
 * real file-backed project store. Only the process boundaries are doubled:
 * the ffmpeg/ffprobe children (a fake encode the test finishes, and canned
 * analysis output), the render prep that needs a real ffmpeg + song, the
 * media-job queue, and the reviewer's provider call (an injected verdict
 * sequence whose call count is the review spend).
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { promisify } from 'util';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';

const ROOT = () => lazyTempDataRoot('mv-auto-review-route-test-');
vi.mock('../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), { dataRoot: ROOT }));

const h = vi.hoisted(() => {
  const procs = [];
  const makeEmitter = () => {
    const listeners = {};
    return {
      on(ev, fn) { (listeners[ev] ||= []).push(fn); return this; },
      emit(ev, ...args) { for (const fn of listeners[ev] || []) fn(...args); },
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
  return {
    procs, spawn, jobs: [], verdicts: [], review: null, analysisAvailable: true, freezeStderr: '',
  };
});

vi.mock('../lib/childProcess.js', async (importOriginal) => {
  const real = await importOriginal();
  // The continuous-excerpt analysis: ffprobe stream lengths + ffmpeg freezedetect.
  const execFile = Object.assign(() => { throw new Error('execFile is only used promisified here'); }, {
    [promisify.custom]: async (bin) => (bin === 'ffprobe'
      ? { stdout: 'video,20.000000\naudio,20.010000\n', stderr: '' }
      : { stdout: '', stderr: h.freezeStderr }),
  });
  return { ...real, spawn: h.spawn, execFile };
});
vi.mock('../lib/ffmpeg.js', async (importOriginal) => {
  const real = await importOriginal();
  const { writeFileSync: write, mkdirSync: mkdir } = await import('fs');
  const { join: joinPath } = await import('path');
  const { PATHS } = await import('../lib/fileUtils.js');
  return {
    ...real,
    findFfmpeg: vi.fn(async () => (h.analysisAvailable ? 'ffmpeg' : null)),
    findFfprobe: vi.fn(async () => (h.analysisAvailable ? 'ffprobe' : null)),
    // Real frame files, so the reviewer sees a non-empty continuous strip.
    extractEvaluationFrames: vi.fn(async (_path, id, count) => {
      mkdir(PATHS.videoThumbnails, { recursive: true });
      return Array.from({ length: count }, (_, i) => {
        const name = `${id}-f${i + 1}.jpg`;
        write(joinPath(PATHS.videoThumbnails, name), 'jpg');
        return name;
      });
    }),
  };
});
vi.mock('../lib/sseUtils.js', () => ({ broadcastSse: vi.fn(), attachSseClient: vi.fn(() => true), closeJobAfterDelay: vi.fn() }));
vi.mock('../services/instanceIdentity.js', () => ({ ensureInstanceId: vi.fn(async () => 'inst-test') }));
vi.mock('../lib/killWithEscalation.js', () => ({ killWithEscalation: vi.fn((proc) => proc.emit('close', null, 'SIGTERM')) }));
vi.mock('../services/htmlComposition/encode.js', () => ({ encodeFileContactSheetAtTimes: vi.fn(async () => {}) }));
vi.mock('../services/mediaJobQueue/index.js', async () => ({
  mediaJobEvents: new (await import('events')).EventEmitter(),
  listJobs: vi.fn(({ kind } = {}) => h.jobs.filter((j) => !kind || j.kind === kind)),
  enqueueJob: vi.fn(),
  cancelJob: vi.fn(async () => {}),
}));
vi.mock('../services/promptRunner.js', () => ({
  resolveProviderAndModel: vi.fn(async () => ({ provider: { id: 'reviewer', name: 'Reviewer', type: 'api' }, selectedModel: 'vision-1' })),
  assertVisionRunUsedImages: vi.fn((_result, provider) => provider),
  runPromptThroughProvider: vi.fn(async () => ({ text: JSON.stringify(h.verdicts.shift()) })),
}));
// Three 10s sections: footage s1, footage s2, still s3 (a composed render).
const CLIPS = [
  { sceneId: 's1', videoPath: '/v/a.mp4', width: 640, height: 360, fps: 24, inSec: 0, outSec: 10, duration: 10, sourceSec: 10, loop: true },
  { sceneId: 's2', videoPath: '/v/b.mp4', width: 640, height: 360, fps: 24, inSec: 0, outSec: 10, duration: 10, sourceSec: 10, loop: true },
  { sceneId: 's3', layer: 'still', imagePath: '/i/c.png', move: 'hold', inSec: 0, outSec: 10, duration: 10, sourceSec: 10 },
];
vi.mock('../services/musicVideo/render.js', async (importOriginal) => ({
  ...(await importOriginal()),
  planMusicVideoRender: vi.fn(async () => ({ ffmpeg: 'ffmpeg', audioPath: '/a/song.wav', composed: true, clips: CLIPS, audioDurationSec: 30, soundBed: null })),
}));

const { default: musicVideoRoutes } = await import('./musicVideo.js');
const projects = await import('../services/musicVideo/projects.js');
const { assertRevisionOpen } = await import('../services/musicVideo/revisionService.js');
const { musicVideoEvents } = await import('../services/musicVideo/events.js');
const { runPromptThroughProvider } = await import('../services/promptRunner.js');
const { mediaJobEvents } = await import('../services/mediaJobQueue/index.js');

const app = express();
app.use(express.json());
app.use('/api/music-video', musicVideoRoutes);
app.use(errorMiddleware);

const base = (id) => `/api/music-video/${id}`;
const scene = (sceneId, order, media) => ({ sceneId, order, prompt: `shot ${sceneId}`, takes: [], ...media });
const PASS = { checks: { composition: 'pass', continuity: 'pass', motion: 'pass' }, findings: [], summary: 'Reads well.' };
// A blocking problem at excerpt time 8s — inside s2 (song time 13s of the [5, 25) window).
const FAIL_S2 = {
  checks: { composition: 'fail', continuity: 'pass', motion: 'pass' },
  findings: [{ atSec: 8, check: 'composition', severity: 'blocking', note: 'The subject\'s hands warp.' }],
  summary: 'One shot is broken.',
};

const project = async () => {
  const created = await projects.createProject({ name: 'Example Video' });
  return projects.updateProject(created.id, {
    scenes: [
      scene('s1', 0, { referenceImageId: 'f1.png', videoHistoryId: 'clip-1' }),
      scene('s2', 1, { referenceImageId: 'f2.png', videoHistoryId: 'clip-2' }),
      scene('s3', 2, { referenceImageId: 'still-3.png', visualLayer: 'still' }),
    ],
  });
};

const settled = (projectId, check) => vi.waitFor(async () => {
  const p = await projects.getProject(projectId);
  check(p);
  return p;
}, { timeout: 5000, interval: 20 });
const run = (p) => p.autoReviews[p.autoReviews.length - 1];

// Finish the in-flight draft encode: the fake ffmpeg "writes" its output and exits 0.
async function finishDraft(projectId, renders) {
  await vi.waitFor(() => expect(h.procs).toHaveLength(renders), { timeout: 5000, interval: 20 });
  const proc = h.procs[renders - 1];
  const outputPath = proc.args[proc.args.length - 1];
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, 'mp4');
  proc.emit('spawn');
  proc.emit('close', 0, null);
  await settled(projectId, (p) => expect(p.excerpts.filter((e) => e.status === 'complete')).toHaveLength(renders));
}

// What the scene-video completion hook does when a regenerated clip lands.
async function landTake(projectId, sceneId, assetId) {
  await projects.appendSceneTakes(projectId, sceneId, [{ kind: 'video', assetId, source: 'generated', provider: 'portos', jobId: `job-${assetId}` }]);
  musicVideoEvents.emit('scene-video', { projectId, sceneId, videoHistoryId: assetId });
}

const start = (projectId, limits) => request(app).post(`${base(projectId)}/auto-reviews`).send({ startSec: 5, endSec: 25, limits });

beforeEach(() => {
  rmSync(join(ROOT(), 'music-video-projects.json'), { force: true });
  h.procs.length = 0;
  h.jobs.length = 0;
  h.verdicts.length = 0;
  h.analysisAvailable = true;
  h.freezeStderr = '';
  vi.clearAllMocks();
});
afterAll(cleanupTempDataRoots);

describe('opt-in automatic review/retries (#8988)', () => {
  it('requires explicit limits — a run never picks its own budget', async () => {
    const p = await project();
    const r = await request(app).post(`${base(p.id)}/auto-reviews`).send({ startSec: 5, endSec: 25 });
    expect(r.status).toBe(400);
    expect(h.procs).toHaveLength(0);
    expect(runPromptThroughProvider).not.toHaveBeenCalled();
  });

  it('reviews, revises only the flagged section, enforces the spend limit at enqueue, and passes the re-rendered draft', async () => {
    const p = await project();
    h.verdicts.push(FAIL_S2, PASS);
    const r = await start(p.id, { maxAttempts: 2, maxGenerations: 1 });
    expect(r.status).toBe(201);
    expect(r.body.run).toMatchObject({ status: 'running', limits: { maxAttempts: 2, maxGenerations: 1 } });

    await finishDraft(p.id, 1);
    // Attempt 1 reviewed: its finding became a flagged, timecoded note and a
    // revision rejected s2 only.
    let current = await settled(p.id, (x) => expect(run(x).attempts[0].revisionId).toBeTruthy());
    const attempt1 = run(current).attempts[0];
    expect(attempt1.review).toMatchObject({ verdict: 'revise', checks: { composition: 'fail', audioSync: 'pass', motion: 'pass' } });
    expect(attempt1.review.evidence).toMatchObject({ continuous: true, continuousFrames: 12 });
    const draft = current.excerpts.find((e) => e.id === attempt1.excerptId);
    expect(draft.notes).toEqual([expect.objectContaining({ atSec: 8, verdict: 'flagged', note: expect.stringMatching(/^\[auto-review\] .*hands warp/) })]);
    const revision = current.revisions.find((rv) => rv.id === attempt1.revisionId);
    expect(revision.sections.filter((s) => s.verdict === 'rejected').map((s) => s.sceneId)).toEqual(['s2']);

    // The board submits s2: the enqueue guard charges it. A double submit
    // while its job is live, and any further paid job past the run's spend
    // limit, are refused BEFORE they reach the queue.
    const s2 = { sceneId: 's2', kind: 'video' };
    await assertRevisionOpen(p.id, revision.id, s2);
    h.jobs.push({ id: 'job-s2', kind: 'video', status: 'running', queuedAt: new Date().toISOString(), params: { musicVideo: { projectId: p.id, sceneId: 's2', revisionId: revision.id } } });
    await expect(assertRevisionOpen(p.id, revision.id, s2)).rejects.toMatchObject({ code: 'AUTO_REVIEW_SECTION_IN_FLIGHT' });
    await expect(assertRevisionOpen(p.id, revision.id, { sceneId: 's1', kind: 'video' })).rejects.toMatchObject({ code: 'AUTO_REVIEW_SPEND_LIMIT' });
    h.jobs[0].status = 'completed';
    current = await projects.getProject(p.id);
    expect(run(current).usage).toEqual({ reviews: 1, generations: 1 });

    // The new take lands → the run re-renders the window and reviews attempt 2.
    await landTake(p.id, 's2', 'clip-2b');
    await finishDraft(p.id, 2);
    current = await settled(p.id, (x) => expect(run(x).status).toBe('passed'));
    expect(run(current).attempts).toHaveLength(2);
    expect(run(current).attempts[1].review.verdict).toBe('pass');
    expect(run(current).usage).toEqual({ reviews: 2, generations: 1 });
    expect(runPromptThroughProvider).toHaveBeenCalledTimes(2);
    expect(current.scenes[0].videoHistoryId).toBe('clip-1'); // the approved section was never touched
  });

  it('a stopped run ignores completion events, then resumes from its checkpoint without repeating a completed attempt', async () => {
    const p = await project();
    h.verdicts.push(FAIL_S2, PASS);
    await start(p.id, { maxAttempts: 1, maxGenerations: 3 });
    await finishDraft(p.id, 1);
    let current = await settled(p.id, (x) => expect(run(x).attempts[0].revisionId).toBeTruthy());
    const runId = run(current).id;
    const reviewed = run(current).attempts[0].review;

    expect((await request(app).post(`${base(p.id)}/auto-reviews/${runId}/stop`)).body.run.status).toBe('stopped');
    // The take the board already paid for still lands — but a stopped run
    // does not advance on it: no re-render, no review.
    await landTake(p.id, 's2', 'clip-2b');
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(h.procs).toHaveLength(1);

    // Resume: the revision renders (its section already holds a take — no
    // generation), and the next draft hits the 1-review attempt limit.
    await request(app).post(`${base(p.id)}/auto-reviews/${runId}/resume`).send({});
    await finishDraft(p.id, 2);
    current = await settled(p.id, (x) => expect(run(x).status).toBe('limit-reached'));
    expect(runPromptThroughProvider).toHaveBeenCalledTimes(1);

    // Raising the limit reviews ONLY the new draft; attempt 1 keeps its review.
    await request(app).post(`${base(p.id)}/auto-reviews/${runId}/resume`).send({ limits: { maxAttempts: 2 } });
    current = await settled(p.id, (x) => expect(run(x).status).toBe('passed'));
    expect(runPromptThroughProvider).toHaveBeenCalledTimes(2);
    expect(run(current).attempts[0].review).toEqual(reviewed);
    expect(run(current).usage).toEqual({ reviews: 2, generations: 0 });
    expect(h.procs).toHaveLength(2);
  });

  it('refunds a kickoff that never reached the queue, and pauses (not retries) when a revised generation fails', async () => {
    const p = await project();
    h.verdicts.push(FAIL_S2);
    await start(p.id, { maxAttempts: 2, maxGenerations: 2 });
    await finishDraft(p.id, 1);
    let current = await settled(p.id, (x) => expect(run(x).attempts[0].revisionId).toBeTruthy());
    const revisionId = run(current).attempts[0].revisionId;
    const s2 = { sceneId: 's2', kind: 'video' };

    // The board's kickoff was charged but failed before the queue: releasing
    // the section returns the generation to the budget.
    await assertRevisionOpen(p.id, revisionId, s2);
    expect(run(await projects.getProject(p.id)).usage.generations).toBe(1);
    await request(app).post(`${base(p.id)}/revisions/${revisionId}/release`).send({ sceneId: 's2' });
    expect(run(await projects.getProject(p.id)).usage.generations).toBe(0);

    // Resubmitted, queued, and the provider fails it: the run pauses for the
    // director instead of paying for a retry on its own.
    await assertRevisionOpen(p.id, revisionId, s2);
    const job = { id: 'job-s2', kind: 'video', status: 'failed', error: 'provider error', queuedAt: new Date().toISOString(), params: { musicVideo: { projectId: p.id, sceneId: 's2', revisionId } } };
    mediaJobEvents.emit('failed', job);
    current = await settled(p.id, (x) => expect(run(x).status).toBe('stopped'));
    expect(run(current).stopReason).toMatch(/generation failed: provider error/);
    expect(run(current).usage.generations).toBe(1);
    expect(current.revisions.find((rv) => rv.id === revisionId).sections.find((s) => s.sceneId === 's2').claimedAt).toBeNull();
  });

  it('stops before handing out a revision the remaining spend cannot cover', async () => {
    const p = await project();
    h.verdicts.push(FAIL_S2);
    await start(p.id, { maxAttempts: 2, maxGenerations: 0 });
    await finishDraft(p.id, 1);
    const current = await settled(p.id, (x) => expect(run(x).status).toBe('limit-reached'));
    expect(run(current).stopReason).toMatch(/spend limit/);
    const revision = current.revisions.find((rv) => rv.id === run(current).attempts[0].revisionId);
    expect(revision.sections.find((s) => s.sceneId === 's2').claimedAt).toBeUndefined(); // nothing was handed out
  });

  it('a frame-only look cannot pass: without the continuous analysis the run stops for a human', async () => {
    const p = await project();
    h.analysisAvailable = false;
    h.verdicts.push(PASS);
    await start(p.id, { maxAttempts: 3, maxGenerations: 3 });
    await finishDraft(p.id, 1);
    const current = await settled(p.id, (x) => expect(run(x).status).toBe('needs-human'));
    expect(run(current).attempts[0].review).toMatchObject({
      verdict: 'inconclusive',
      checks: { composition: 'pass', continuity: 'pass', motion: 'unverified', audioSync: 'unverified' },
      evidence: { continuous: false },
    });
    expect(run(current).stopReason).toMatch(/frames alone cannot prove motion or audio sync/);
  });

  it('frozen footage found in the continuous excerpt fails motion even when the frames looked fine', async () => {
    const p = await project();
    // Excerpt timeline: s1 0–5, s2 5–15 (footage), s3 15–20 (still). A freeze
    // at 6–8.5s stalls footage s2…
    h.freezeStderr = '[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 6.0\n[freezedetect @ 0x1] lavfi.freezedetect.freeze_end: 8.5\n'
      // …and a freeze inside the still section (excerpt 15–20) is planned, not a stall.
      + '[freezedetect @ 0x1] lavfi.freezedetect.freeze_start: 15.5\n[freezedetect @ 0x1] lavfi.freezedetect.freeze_end: 19.5\n';
    h.verdicts.push(PASS);
    await start(p.id, { maxAttempts: 1, maxGenerations: 0 });
    await finishDraft(p.id, 1);
    const current = await settled(p.id, (x) => expect(run(x).attempts[0].review).toBeTruthy());
    const { review } = run(current).attempts[0];
    expect(review.checks.motion).toBe('fail');
    expect(review.findings).toEqual([expect.objectContaining({ atSec: 6, check: 'motion', source: 'analysis' })]);
  });
});
