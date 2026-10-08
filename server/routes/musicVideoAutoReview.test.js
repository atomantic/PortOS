/**
 * Music Video opt-in automatic review/retries (#8988), through the real
 * router, autoReviewService.js, revisionService.js, excerptRender.js and the
 * real file-backed project store. Only the process boundaries are doubled:
 * the ffmpeg/ffprobe children (a fake encode the test finishes, and canned
 * analysis output), the render prep that needs a real ffmpeg + song, the
 * media-job queue, and the reviewer's provider call (an injected verdict
 * sequence whose call count is the review spend).
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import express from 'express';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
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
    procs, spawn, jobs: [], verdicts: [], settings: null, submitError: null, submits: [], review: null, temporalInstalled: false, temporalCapability: null, temporalResult: null, temporalCalls: [], analysisAvailable: true, freezeStderr: '',
  };
});

vi.mock('../lib/childProcess.js', async (importOriginal) => {
  const real = await importOriginal();
  // The continuous-excerpt analysis: ffprobe stream lengths + ffmpeg freezedetect.
  const execFile = Object.assign(() => { throw new Error('execFile is only used promisified here'); }, {
    [promisify.custom]: async (bin, args, options) => {
      if (bin === 'temporal-analyzer-test') {
        h.temporalCalls.push({ args, options });
        return { stdout: JSON.stringify(args[0] === '--capabilities' ? h.temporalCapability : h.temporalResult), stderr: '' };
      }
      return (bin === 'ffprobe'
      ? { stdout: 'video,20.000000\naudio,20.010000\n', stderr: '' }
      : { stdout: '', stderr: h.freezeStderr });
    },
  });
  return { ...real, spawn: h.spawn, execFile };
});
vi.mock('../lib/processEnv.js', async (importOriginal) => ({
  ...(await importOriginal()),
  findCommandOnPath: (name) => name === 'portos-temporal-analyzer' && h.temporalInstalled ? 'temporal-analyzer-test' : null,
}));
vi.mock('../lib/ffmpeg.js', async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    findFfmpeg: vi.fn(async () => (h.analysisAvailable ? 'ffmpeg' : null)),
    findFfprobe: vi.fn(async () => (h.analysisAvailable ? 'ffprobe' : null)),
    probeVideoStreamInfo: vi.fn(async () => ({ width: 640, height: 360, fps: 24, frameCount: null })),
  };
});
vi.mock('../lib/sseUtils.js', async (importOriginal) => ({ ...(await importOriginal()), broadcastSse: vi.fn(), attachSseClient: vi.fn(() => true), closeJobAfterDelay: vi.fn() }));
vi.mock('../services/instanceIdentity.js', () => ({ ensureInstanceId: vi.fn(async () => 'inst-test') }));
vi.mock('../lib/killWithEscalation.js', () => ({ killWithEscalation: vi.fn((proc) => proc.emit('close', null, 'SIGTERM')) }));
// Real sheet files, so the reviewer sees a non-empty continuous strip.
vi.mock('../services/htmlComposition/encode.js', async () => {
  const { writeFileSync: write, mkdirSync: mkdir } = await import('fs');
  const { dirname } = await import('path');
  return { encodeFileContactSheetAtTimes: vi.fn(async (_video, out) => { mkdir(dirname(out), { recursive: true }); write(out, 'jpg'); }) };
});
vi.mock('../services/mediaJobQueue/index.js', async () => ({
  mediaJobEvents: new (await import('events')).EventEmitter(),
  listJobs: vi.fn(({ kind } = {}) => h.jobs.filter((j) => !kind || j.kind === kind)),
  // The frame lane's queue write — the revision guard already ran in front of it.
  enqueueJob: vi.fn(async ({ kind, params, owner }) => {
    const job = { id: `job-${h.jobs.length + 1}`, kind, owner, status: 'queued', queuedAt: new Date().toISOString(), params };
    h.jobs.push(job);
    return { jobId: job.id };
  }),
  cancelJob: vi.fn(async () => {}),
}));
// The video submit service's contract the dispatch relies on: the revision guard
// runs last before the queue write; a refusal never reaches the queue.
vi.mock('../services/videoGen/submitJob.js', () => ({
  submitVideoGenJob: vi.fn(async (body) => {
    h.submits.push(body);
    if (h.submitError) throw h.submitError;
    const { assertRevisionOpen: guard } = await import('../services/musicVideo/revisionService.js');
    await guard(body.musicVideo.projectId, body.musicVideo.revisionId, { sceneId: body.musicVideo.sceneId, kind: 'video' });
    const job = { id: `job-${h.jobs.length + 1}`, kind: 'video', status: 'queued', queuedAt: new Date().toISOString(), params: { musicVideo: body.musicVideo } };
    h.jobs.push(job);
    return { jobId: job.id };
  }),
}));
vi.mock('../services/settings.js', async (importOriginal) => ({ ...(await importOriginal()), getSettings: vi.fn(async () => h.settings) }));
vi.mock('../services/videoGen/modelSelection.js', () => ({
  resolveVideoModelSelection: vi.fn(async () => ({ model: { id: 'ltx-example' }, modelId: 'ltx-example' })),
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
const { __testing: autoReviewBackground } = await import('../services/musicVideo/autoReviewService.js');

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
  h.settings = { imageGen: { mode: 'local', local: { pythonPath: '/opt/example/python' }, codex: { enabled: true } } };
  h.submitError = null;
  h.submits.length = 0;
  h.freezeStderr = '';
  h.temporalInstalled = false;
  h.temporalCapability = { protocolVersion: 1, id: 'example-analyzer', version: '1.0', ready: true, temporalLipSync: true, localOnly: true };
  h.temporalResult = null;
  h.temporalCalls.length = 0;
  vi.clearAllMocks();
});
// A run advances in the background; let it go quiet before the next test
// resets the shared doubles, so one test's late step can never land in the
// next test's queue (#10467).
afterEach(() => autoReviewBackground.settleBackground());
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
    await projects.updateProject(p.id, { scenes: p.scenes.map((scene) => scene.sceneId === 's1'
      ? { ...scene, startSec: 0, endSec: 10, direction: { actionContract: { version: 1, purpose: 'The listener decides to stay',
        reactions: [{ startSec: 6, endSec: 8, subject: 'Listener', description: 'Turns back' }], acceptanceCriteria: ['Both people remain visible'] } } }
      : scene.sceneId === 's2' ? { ...scene, startSec: 10, endSec: 20, visualIntent: 'The chorus lifts off' } : scene) });
    h.verdicts.push(FAIL_S2, PASS);
    const r = await start(p.id, { maxAttempts: 2, maxGenerations: 1 });
    expect(r.status).toBe(201);
    expect(r.body.run).toMatchObject({ status: 'running', limits: { maxAttempts: 2, maxGenerations: 1 } });

    await finishDraft(p.id, 1);
    // Attempt 1 reviewed: its finding became a flagged, timecoded note and a
    // revision rejected s2 only.
    let current = await settled(p.id, (x) => expect(run(x).attempts[0].revisionId).toBeTruthy());
    const attempt1 = run(current).attempts[0];
    const reviewerPrompt = runPromptThroughProvider.mock.calls[0][0].prompt;
    expect(reviewerPrompt).toContain('The listener decides to stay');
    expect(reviewerPrompt).toContain('Both people remain visible');
    expect(reviewerPrompt).toContain('"sceneStartSec":-5');
    expect(reviewerPrompt).toContain('Still frames cannot prove completion');
    // A shot without an action contract still carries its own prompt, so it is judged on it.
    expect(reviewerPrompt).toContain('"shotPrompt":"shot s2"');
    expect(reviewerPrompt).toContain('"phraseIntent":"The chorus lifts off"');
    expect(attempt1.review).toMatchObject({ verdict: 'revise', checks: { composition: 'fail', audioSync: 'pass', motion: 'pass' } });
    expect(attempt1.review.evidence).toMatchObject({ continuous: true, continuousFrames: 12 });
    const draft = current.excerpts.find((e) => e.id === attempt1.excerptId);
    expect(draft.notes).toEqual([expect.objectContaining({ atSec: 8, verdict: 'flagged', note: expect.stringMatching(/^\[auto-review\] .*hands warp/) })]);
    const revision = current.revisions.find((rv) => rv.id === attempt1.revisionId);
    expect(revision.sections.filter((s) => s.verdict === 'rejected').map((s) => s.sceneId)).toEqual(['s2']);

    // The server submits s2 itself — no board is connected: the enqueue guard
    // charged it, and tagged it with the revision. A double submit while its
    // job is live, and any further paid job past the run's spend limit, are
    // refused BEFORE they reach the queue.
    const s2 = { sceneId: 's2', kind: 'video' };
    await vi.waitFor(() => expect(h.jobs).toHaveLength(1), { timeout: 5000, interval: 20 });
    expect(h.submits).toHaveLength(1);
    expect(h.submits[0]).toMatchObject({ backend: 'local', mode: 'image', sourceImageFile: 'f2.png', musicVideo: { projectId: p.id, sceneId: 's2', revisionId: revision.id } });
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
    // The server submits the flagged section before the director pauses.
    // Compare the jobs' identity (not just the count) so a flake that enqueues a
    // second job prints which section it was for, instead of a collapsed array (#10467).
    await vi.waitFor(() => expect(h.jobs.map((j) => ({ id: j.id, kind: j.kind, sceneId: j.params.musicVideo.sceneId }))).toEqual([{ id: 'job-1', kind: 'video', sceneId: 's2' }]), { timeout: 5000, interval: 20 });

    expect((await request(app).post(`${base(p.id)}/auto-reviews/${runId}/stop`)).body.run.status).toBe('stopped');
    // The take the board already paid for still lands — but a stopped run
    // does not advance on it: no re-render, no review.
    await landTake(p.id, 's2', 'clip-2b');
    await autoReviewBackground.settleBackground();
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
    // The one generation was the server's own submission of the flagged section
    // (before the pause); resuming does not pay for it again.
    expect(run(current).usage).toEqual({ reviews: 2, generations: 1 });
    expect(h.submits).toHaveLength(1);
    expect(h.procs).toHaveLength(2);
  });

  it('pauses (not retries) when a server-submitted revised generation fails', async () => {
    const p = await project();
    h.verdicts.push(FAIL_S2);
    await start(p.id, { maxAttempts: 2, maxGenerations: 2 });
    await finishDraft(p.id, 1);
    let current = await settled(p.id, (x) => expect(run(x).attempts[0].revisionId).toBeTruthy());
    const revisionId = run(current).attempts[0].revisionId;
    await vi.waitFor(() => expect(h.jobs).toHaveLength(1), { timeout: 5000, interval: 20 });
    expect(run(await projects.getProject(p.id)).usage.generations).toBe(1);

    // The provider fails the queued job: the run pauses for the director
    // instead of paying for a retry on its own.
    const job = { ...h.jobs[0], status: 'failed', error: 'provider error' };
    mediaJobEvents.emit('failed', job);
    current = await settled(p.id, (x) => expect(run(x).status).toBe('stopped'));
    expect(run(current).stopReason).toMatch(/generation failed: provider error/);
    expect(run(current).usage.generations).toBe(1);
    expect(current.revisions.find((rv) => rv.id === revisionId).sections.find((s) => s.sceneId === 's2').claimedAt).toBeNull();
    // That job DID reach the queue, so a later release never refunds it.
    await request(app).post(`${base(p.id)}/revisions/${revisionId}/release`).send({ sceneId: 's2' });
    expect(run(await projects.getProject(p.id)).usage.generations).toBe(1);
  });

  it('parks the run needs-human and refunds the charge when a revised section cannot reach the queue', async () => {
    const p = await project();
    h.verdicts.push(FAIL_S2);
    h.submitError = Object.assign(new Error('The local video runtime refused the clip'), { status: 422, code: 'VIDEO_INVALID' });
    await start(p.id, { maxAttempts: 2, maxGenerations: 2 });
    await finishDraft(p.id, 1);
    const current = await settled(p.id, (x) => expect(run(x).status).toBe('needs-human'));
    expect(run(current).stopReason).toMatch(/clip for "s2" was refused: The local video runtime refused the clip/);
    expect(h.jobs).toHaveLength(0);
    expect(run(current).usage.generations).toBe(0); // never reached the queue → nothing spent
    // Released, so resuming the revision hands it straight out again once the cause is fixed.
    const revision = current.revisions.find((rv) => rv.id === run(current).attempts[0].revisionId);
    expect(revision.status).toBe('open');
    expect(revision.sections.find((s) => s.sceneId === 's2').claimedAt).toBeNull();
    // Once the cause is fixed, resuming the open revision (the banner's Continue) re-derives the step and hands the section out again.
    const resumed = await request(app).post(`${base(p.id)}/revisions/${revision.id}/resume`);
    expect(resumed.body.needsGeneration).toEqual([expect.objectContaining({ sceneId: 's2', kind: 'video' })]);
  });

  it('parks the run needs-human, naming the section, when its clip cannot be generated without the board', async () => {
    const p = await project();
    await projects.updateProject(p.id, { videoSettings: { backend: 'local', generationMode: 'audioReactive' } });
    h.verdicts.push(FAIL_S2);
    await start(p.id, { maxAttempts: 2, maxGenerations: 2 });
    await finishDraft(p.id, 1);
    const current = await settled(p.id, (x) => expect(run(x).status).toBe('needs-human'));
    expect(run(current).stopReason).toMatch(/clip for "s2" cannot be generated automatically: .*audio-reactive/);
    expect(h.submits).toHaveLength(0);
    expect(h.jobs).toHaveLength(0);
    expect(run(current).usage.generations).toBe(0);
  });

  it('parks the run needs-human when the pinned video backend is not usable here, never substituting another', async () => {
    vi.stubEnv('FAL_KEY', '');
    const p = await project();
    await projects.updateProject(p.id, { videoSettings: { backend: 'fal' } });
    h.verdicts.push(FAIL_S2);
    await start(p.id, { maxAttempts: 2, maxGenerations: 2 });
    await finishDraft(p.id, 1);
    const current = await settled(p.id, (x) => expect(run(x).status).toBe('needs-human'));
    expect(run(current).stopReason).toMatch(/clip for "s2" cannot be generated automatically: .*fal.*not usable/);
    expect(h.submits).toHaveLength(0);
    expect(run(current).usage.generations).toBe(0);
    vi.unstubAllEnvs();
  });

  it('dispatches a revised frame on the project\'s pinned image backend, tagged and charged like the board\'s lane', async () => {
    const p = await project();
    await projects.updateProject(p.id, { imageMode: 'codex' });
    // A blocking problem at excerpt time 17s — inside the still s3 (song time 22s).
    h.verdicts.push({ ...FAIL_S2, findings: [{ ...FAIL_S2.findings[0], atSec: 17 }] });
    await start(p.id, { maxAttempts: 2, maxGenerations: 2 });
    await finishDraft(p.id, 1);
    const current = await settled(p.id, (x) => expect(run(x).attempts[0].revisionId).toBeTruthy());
    const revisionId = run(current).attempts[0].revisionId;
    expect(current.revisions.find((rv) => rv.id === revisionId).sections.filter((s) => s.verdict === 'rejected')).toEqual([expect.objectContaining({ sceneId: 's3', kind: 'image' })]);

    await vi.waitFor(() => expect(h.jobs).toHaveLength(1), { timeout: 5000, interval: 20 });
    expect(h.submits).toHaveLength(0); // a frame never touches the video lane
    expect(h.jobs[0]).toMatchObject({ kind: 'image', owner: `music-video-auto-review:${revisionId}`, params: { mode: 'codex', musicVideo: { projectId: p.id, sceneId: 's3', revisionId } } });
    expect(run(await projects.getProject(p.id)).usage.generations).toBe(1);
    // The same section is not handed out twice while its job is live.
    await expect(assertRevisionOpen(p.id, revisionId, { sceneId: 's3', kind: 'image' })).rejects.toMatchObject({ code: 'AUTO_REVIEW_SECTION_IN_FLIGHT' });
  });

  it('cancelling a run closes its open revision in the same write — nothing more is charged or allowed', async () => {
    const p = await project();
    h.verdicts.push(FAIL_S2);
    await start(p.id, { maxAttempts: 2, maxGenerations: 2 });
    await finishDraft(p.id, 1);
    const before = await settled(p.id, (x) => expect(run(x).attempts[0].revisionId).toBeTruthy());
    const revisionId = run(before).attempts[0].revisionId;

    const r = await request(app).post(`${base(p.id)}/auto-reviews/${run(before).id}/cancel`);
    expect(r.status).toBe(200);
    const after = await projects.getProject(p.id);
    expect(run(after).status).toBe('canceled');
    expect(after.revisions.find((rv) => rv.id === revisionId).status).toBe('canceled');
    await expect(assertRevisionOpen(p.id, revisionId, { sceneId: 's2', kind: 'video' })).rejects.toMatchObject({ code: 'REVISION_CLOSED' });
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
    // A recorded review is an intermediate checkpoint: the background run
    // still opens its revision and persists the spend-limit stop afterward.
    // Wait for that terminal write before afterAll removes the data root.
    const current = await settled(p.id, (x) => expect(run(x).status).toBe('limit-reached'));
    const { review } = run(current).attempts[0];
    expect(review.checks.motion).toBe('fail');
    expect(review.findings).toEqual([expect.objectContaining({ atSec: 6, check: 'motion', source: 'analysis' })]);
  });
});


it('cloning an active draft cannot give recovery ownership of the source render', async () => {
  const { startExcerptRender, recoverStuckMusicVideoExcerpts } = await import('../services/musicVideo/excerptRender.js');
  const p = await project();
  await startExcerptRender(p.id, { startSec: 5, endSec: 25 });
  await finishDraft(p.id, 1);
  const completed = (await projects.getProject(p.id)).excerpts[0];

  await startExcerptRender(p.id, { startSec: 5, endSec: 25 });
  const proc = h.procs[1];
  const outputPath = proc.args[proc.args.length - 1];
  writeFileSync(outputPath, 'partial-mp4');
  try {
    const response = await request(app).post(`${base(p.id)}/clone`).send({});
    expect(response.status).toBe(201);
    await recoverStuckMusicVideoExcerpts();
    // The source still owns the running encoder; recovery on its clone must
    // never remove the output that encoder is writing.
    expect(existsSync(outputPath)).toBe(true);
    const cloned = await projects.getProject(response.body.id);
    expect(cloned.excerpts).toHaveLength(1);
    expect(cloned.excerpts[0]).toMatchObject({
      id: completed.id, status: 'complete', filename: completed.filename,
      contactSheetFilename: completed.contactSheetFilename, notes: completed.notes,
    });
    expect((await projects.getProject(p.id)).excerpts[1].status).toBe('rendering');
  } finally {
    await finishDraft(p.id, 2);
  }
});

// Public workflow regressions: stream parity never certifies mouth timing,
// and uncertain temporal evidence cannot hand out another paid generation.
describe('temporal performance evidence (#9347)', () => {
  const performanceProject = async () => {
    const p = await project();
    const master = 'synthetic unchanged song';
    mkdirSync(join(ROOT(), 'music'), { recursive: true });
    writeFileSync(join(ROOT(), 'music', 'example-song.wav'), master);
    await projects.updateScene(p.id, 's1', { shotMode: 'performance', performanceSpeaker: 'Example Singer', startSec: 0, endSec: 10 });
    await projects.updateProject(p.id, { performanceConditioningSource: 'clean-singer-stem', uploadedAudioFilename: 'example-song.wav' });
    await projects.mutateProjectRecord(p.id, (current) => ({ project: {
      ...current, scenes: current.scenes.map((s) => s.sceneId !== 's1' ? s : { ...s, takes: [{
        kind: 'video', assetId: 'clip-1', shotInstruction: {
          version: 2, shotMode: 'performance', speaker: 'Example Singer', edit: { inSec: 1, outSec: 6 }, songInterval: { startSec: 0, endSec: 10 },
          audio: { sha256: createHash('sha256').update(master).digest('hex'), conditioning: { source: 'clean-singer-stem', filename: 'singer.wav', sha256: 'a'.repeat(64), selection: 'user', voiceIsolation: 'unverified' } },
        },
      }] }),
    } }));
    return projects.getProject(p.id);
  };

  it.each([
    ['missing analyzer', false, null],
    ['missing evidence', true, null],
    ['unknown span status', true, { spans: [{ startSec: 0, endSec: 5, status: 'pass', offsetSec: 0, confidence: 1 }] }],
    ['out-of-bounds evidence', true, { spans: [{ startSec: 0, endSec: 20, status: 'verified', offsetSec: 0, confidence: 1 }] }],
    ['gapped evidence', true, { spans: [{ startSec: 1, endSec: 5, status: 'verified', offsetSec: 0, confidence: 1 }] }],
    ['low confidence', true, { spans: [{ startSec: 0, endSec: 5, status: 'verified', offsetSec: 0, confidence: 0.2 }] }],
  ])('%s stops for a human even when a visual finding could trigger retries', async (_name, installed, result) => {
    const p = await performanceProject();
    h.temporalInstalled = installed;
    h.temporalResult = result;
    h.verdicts.push(FAIL_S2);
    await start(p.id, { maxAttempts: 3, maxGenerations: 5 });
    await finishDraft(p.id, 1);
    const saved = await settled(p.id, (x) => expect(run(x).status).toBe('needs-human'));
    expect(run(saved).usage).toEqual({ reviews: 1, generations: 0 });
    expect(run(saved).attempts[0]).toMatchObject({ revisionId: null, review: {
      verdict: 'inconclusive', checks: { audioSync: 'pass', lipSync: 'unverified' },
      evidence: { temporal: { status: 'unverified' } },
    } });
    expect(saved.revisions || []).toHaveLength(0);
    expect(h.procs).toHaveLength(1);
  });

  it('a legacy draft with missing section provenance cannot silently pass as having no performances', async () => {
    const p = await performanceProject();
    h.verdicts.push(PASS);
    await start(p.id, { maxAttempts: 2, maxGenerations: 5 });
    await vi.waitFor(() => expect(h.procs).toHaveLength(1));
    await projects.mutateProjectRecord(p.id, (current) => ({ project: {
      ...current, excerpts: current.excerpts.map((excerpt) => ({ ...excerpt, sections: null })),
    } }));
    await finishDraft(p.id, 1);
    const saved = await settled(p.id, (x) => expect(run(x).status).toBe('needs-human'));
    expect(run(saved).attempts[0].review.checks).toMatchObject({ audioSync: 'pass', lipSync: 'unverified' });
    expect(run(saved).usage.generations).toBe(0);
  });

  it('equal-length synthetic output with measured mouth offset fails only the temporal check', async () => {
    const p = await performanceProject();
    h.temporalInstalled = true;
    h.temporalResult = { spans: [{ startSec: 0, endSec: 5, status: 'verified', offsetSec: 0.6, confidence: 0.95 }] };
    h.verdicts.push(PASS);
    await start(p.id, { maxAttempts: 1, maxGenerations: 0 });
    await finishDraft(p.id, 1);
    const saved = await settled(p.id, (x) => expect(run(x).attempts[0].review).toBeTruthy());
    expect(run(saved).attempts[0].review).toMatchObject({
      verdict: 'revise', checks: { audioSync: 'pass', lipSync: 'fail' },
      evidence: { temporal: { analyzer: { id: 'example-analyzer', version: '1.0' },
        shots: [{ sceneId: 's1', takeId: 'clip-1', speaker: 'Example Singer', conditioning: { source: 'clean-singer-stem', voiceIsolation: 'unverified' }, spans: [{ offsetSec: 0.6, confidence: 0.95 }] }] } },
    });
    expect(h.temporalCalls[1].args).toEqual(expect.arrayContaining(['--audio-start-sec', '0', '--start-sec', '0', '--end-sec', '5']));
    expect(h.temporalCalls[1].options.env).not.toHaveProperty('PORTOS_API_TOKEN');
  });

  it('complete confident temporal evidence passes when its rendered dependencies remain current', async () => {
    const p = await performanceProject();
    h.temporalInstalled = true;
    h.temporalResult = { spans: [{ startSec: 0, endSec: 5, status: 'verified', offsetSec: 0.02, confidence: 0.95 }] };
    h.verdicts.push(PASS);
    await start(p.id, { maxAttempts: 1, maxGenerations: 0 });
    await finishDraft(p.id, 1);
    const saved = await settled(p.id, (x) => expect(run(x).status).toBe('passed'));
    expect(run(saved).attempts[0].review).toMatchObject({ verdict: 'pass', dependencyState: { status: 'current' }, checks: { lipSync: 'pass', audioSync: 'pass' } });
  });

  it('keeps temporal evidence on its original take after an encoding-time edit without approving the changed board', async () => {
    const p = await performanceProject();
    h.temporalInstalled = true;
    h.temporalResult = { spans: [{ startSec: 0, endSec: 5, status: 'verified', offsetSec: 0.02, confidence: 0.95 }] };
    h.verdicts.push(PASS);
    await start(p.id, { maxAttempts: 1, maxGenerations: 0 });
    await vi.waitFor(() => expect(h.procs).toHaveLength(1));
    // Editing the board while its older take is encoding cannot relabel the output.
    await projects.updateScene(p.id, 's1', { shotMode: 'cutaway', performanceSpeaker: 'Another Singer', videoHistoryId: 'another-take' });
    await finishDraft(p.id, 1);
    const saved = await settled(p.id, (x) => expect(run(x).status).toBe('needs-human'));
    expect(run(saved).attempts[0].review).toMatchObject({ verdict: 'inconclusive', dependencyState: { status: 'stale' } });
    expect(run(saved).attempts[0].review.evidence.temporal.shots[0]).toMatchObject({ speaker: 'Example Singer', conditioning: { selection: 'user', voiceIsolation: 'unverified' } });
    const reloaded = (await request(app).get(base(p.id))).body;
    expect(reloaded.performanceConditioningSource).toBe('clean-singer-stem');
    expect(reloaded.scenes[0].performanceSpeaker).toBe('Another Singer');
    expect(run(reloaded).attempts[0].review).toEqual(run(saved).attempts[0].review);
    expect(run(reloaded).attempts[0].review.checks).toMatchObject({ lipSync: 'pass', audioSync: 'pass' });
  });
});
