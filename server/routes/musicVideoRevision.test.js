/**
 * Music Video selective section revision (#8987), through the real router,
 * revisionService.js, excerptRender.js and the real file-backed project store.
 * Only the process boundaries are doubled: the ffmpeg child (a fake emitter
 * the test finishes), the render prep that needs a real ffmpeg + song, and the
 * media-job queue — whose `enqueueJob` is the PAID generation sink, asserted
 * never to be reached, and whose `listJobs` feeds the in-flight check.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';

const ROOT = () => lazyTempDataRoot('mv-revision-route-test-');
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
  return { procs, spawn, jobs: [], enqueueJob: vi.fn() };
});

vi.mock('../lib/childProcess.js', async (importOriginal) => ({ ...(await importOriginal()), spawn: h.spawn }));
vi.mock('../lib/sseUtils.js', () => ({ broadcastSse: vi.fn(), attachSseClient: vi.fn(() => true), closeJobAfterDelay: vi.fn() }));
vi.mock('../lib/killWithEscalation.js', () => ({ killWithEscalation: vi.fn((proc) => proc.emit('close', null, 'SIGTERM')) }));
vi.mock('../services/htmlComposition/encode.js', () => ({ encodeFileContactSheetAtTimes: vi.fn(async () => {}) }));
vi.mock('../services/mediaJobQueue/index.js', () => ({
  listJobs: vi.fn(({ kind } = {}) => h.jobs.filter((j) => !kind || j.kind === kind)),
  enqueueJob: h.enqueueJob,
}));
// Three 10s sections: footage s1, footage s2, still s3 (a composed render).
const CLIPS = [
  { sceneId: 's1', videoPath: '/v/a.mp4', width: 640, height: 360, fps: 24, inSec: 0, outSec: 10, duration: 10, sourceSec: 10, loop: true },
  { sceneId: 's2', videoPath: '/v/b.mp4', width: 640, height: 360, fps: 24, inSec: 0, outSec: 10, duration: 10, sourceSec: 10, loop: true },
  { sceneId: 's3', layer: 'still', imagePath: '/i/c.png', move: 'hold', inSec: 0, outSec: 10, duration: 10, sourceSec: 10 },
];
vi.mock('../services/musicVideo/render.js', async (importOriginal) => ({
  ...(await importOriginal()),
  planMusicVideoRender: vi.fn(async () => ({ ffmpeg: 'ffmpeg', audioPath: '/a/song.wav', composed: true, clips: CLIPS, audioDurationSec: 30 })),
}));

const { default: musicVideoRoutes } = await import('./musicVideo.js');
const projects = await import('../services/musicVideo/projects.js');
const { recoverStuckMusicVideoExcerpts } = await import('../services/musicVideo/excerptRender.js');

const app = express();
app.use(express.json());
app.use('/api/music-video', musicVideoRoutes);
app.use(errorMiddleware);

const base = (id) => `/api/music-video/${id}`;
const tick = () => new Promise((r) => setTimeout(r, 0));
const lastProc = () => h.procs[h.procs.length - 1];
const settle = async () => { for (let i = 0; i < 5; i += 1) await tick(); };

beforeEach(() => {
  rmSync(join(ROOT(), 'music-video-projects.json'), { force: true });
  h.procs.length = 0;
  h.jobs.length = 0;
  vi.clearAllMocks();
});
afterAll(cleanupTempDataRoots);

const scene = (sceneId, order, media) => ({ sceneId, order, prompt: `shot ${sceneId}`, takes: [], ...media });

// A reviewed draft of [5, 25): s1 [5,10), s2 [10,20), s3 [20,25). One flagged
// note lands in s2 (excerpt time 8 → song time 13), one approval in s1.
async function reviewedProject(noteOverrides = []) {
  const project = await projects.createProject({ name: 'Example Video' });
  return projects.updateProject(project.id, {
    scenes: [
      scene('s1', 0, { referenceImageId: 'f1.png', videoHistoryId: 'clip-1' }),
      scene('s2', 1, { referenceImageId: 'f2.png', videoHistoryId: 'clip-2' }),
      scene('s3', 2, { referenceImageId: 'still-3.png', visualLayer: 'still' }),
    ],
    excerpts: [{
      id: 'mve-draft', startSec: 5, endSec: 25, status: 'complete', jobId: null,
      filename: 'music-video-excerpt-draft.mp4', contactSheetFilename: null, partialFilename: null, error: null,
      sections: [
        { sceneId: 's1', layer: 'footage', startSec: 5, endSec: 10 },
        { sceneId: 's2', layer: 'footage', startSec: 10, endSec: 20 },
        { sceneId: 's3', layer: 'still', startSec: 20, endSec: 25 },
      ],
      notes: [
        { id: 'mvn-bad', atSec: 8, note: 'the camera jitters', verdict: 'flagged' },
        { id: 'mvn-good', atSec: 1, note: 'great open', verdict: 'approved' },
        ...noteOverrides,
      ],
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    }],
  });
}

// What the scene-video completion hook does when a regenerated clip lands.
const landNewTake = (projectId, sceneId, assetId) =>
  projects.appendSceneTakes(projectId, sceneId, [{ kind: 'video', assetId, source: 'generated', provider: 'portos', jobId: `job-${assetId}` }]);

describe('selective section revision (#8987)', () => {
  it('rejects only the flagged section and leaves every approved section untouched', async () => {
    const project = await reviewedProject();
    const r = await request(app).post(`${base(project.id)}/excerpt/mve-draft/revisions`).send({});
    expect(r.status).toBe(201);
    const { revision } = r.body;
    expect(revision.sections.map((s) => [s.sceneId, s.verdict])).toEqual([['s1', 'approved'], ['s2', 'rejected'], ['s3', 'approved']]);
    expect(revision.sections[1]).toMatchObject({ kind: 'video', rejectedAssetId: 'clip-2', noteIds: ['mvn-bad'] });

    const reloaded = await projects.getProject(project.id);
    const [s1, s2, s3] = reloaded.scenes;
    expect(s2.videoHistoryId).toBeNull(); // the rejected clip no longer fills the slot
    expect(s2.referenceImageId).toBe('f2.png'); // its reference frame is kept for the regeneration
    expect(s2.takes.find((t) => t.assetId === 'clip-2').status).toBe('rejected');
    // Approved sections: byte-identical to before the revision.
    expect(s1).toEqual(project.scenes[0]);
    expect(s3).toEqual(project.scenes[2]);
  });

  it('resumes to generate only the rejected section, and never hands a section out twice', async () => {
    const project = await reviewedProject();
    const { body: { revision } } = await request(app).post(`${base(project.id)}/excerpt/mve-draft/revisions`).send({});

    // Two overlapping resumes (two tabs, a double submit): exactly one hands
    // s2 out for generation; the other sees it claimed.
    const [a, b] = await Promise.all([
      request(app).post(`${base(project.id)}/revisions/${revision.id}/resume`),
      request(app).post(`${base(project.id)}/revisions/${revision.id}/resume`),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect([a.body.needsGeneration, b.body.needsGeneration]).toContainEqual([{ sceneId: 's2', kind: 'video' }]);
    expect([a.body.needsGeneration, b.body.needsGeneration]).toContainEqual([]);
    expect(a.body.render).toBeNull();
    expect(b.body.render).toBeNull();
    expect(h.procs).toHaveLength(0); // nothing renders until every rejected section has a take
    expect(h.enqueueJob).not.toHaveBeenCalled();
  });

  it('re-offers a claimed section only once its lease lapses with no job in the queue', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const project = await reviewedProject();
      const { body: { revision } } = await request(app).post(`${base(project.id)}/excerpt/mve-draft/revisions`).send({});
      await request(app).post(`${base(project.id)}/revisions/${revision.id}/resume`);

      // The board submitted s2; while its job is live, a resume long after the
      // lease (e.g. after a restart) still asks for nothing new.
      vi.setSystemTime(Date.now() + 10 * 60_000);
      h.jobs.push({ id: 'job-live', kind: 'video', status: 'running', queuedAt: new Date().toISOString(), params: { musicVideo: { projectId: project.id, sceneId: 's2' } } });
      const live = await request(app).post(`${base(project.id)}/revisions/${revision.id}/resume`);
      expect(live.body.needsGeneration).toEqual([]);
      expect(live.body.generating).toEqual([{ sceneId: 's2', kind: 'video' }]);

      // That job failed and produced nothing: s2 is offered again.
      h.jobs[0].status = 'failed';
      const failed = await request(app).post(`${base(project.id)}/revisions/${revision.id}/resume`);
      expect(failed.body.needsGeneration).toEqual([{ sceneId: 's2', kind: 'video' }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a failed render without re-submitting any generation, then completes', async () => {
    const project = await reviewedProject();
    const { body: { revision } } = await request(app).post(`${base(project.id)}/excerpt/mve-draft/revisions`).send({});
    await landNewTake(project.id, 's2', 'clip-2b');

    const renderStart = await request(app).post(`${base(project.id)}/revisions/${revision.id}/resume`);
    expect(renderStart.status).toBe(200);
    expect(renderStart.body.needsGeneration).toEqual([]);
    expect(renderStart.body.render.excerptId).toMatch(/^mve-/);
    expect(renderStart.body.revision.status).toBe('rendering');
    // The draft re-renders the same window through the same clips.
    const firstRender = renderStart.body.render.excerptId;
    const proc = lastProc();
    proc.emit('spawn');
    proc.emit('close', 1, null); // ffmpeg fails
    await settle();

    let reloaded = await projects.getProject(project.id);
    expect(reloaded.revisions[0]).toMatchObject({ status: 'open', renderAttempts: 1 });
    expect(reloaded.excerpts.find((e) => e.id === firstRender)).toMatchObject({ status: 'error', partialFilename: null });

    // Retry: s2 already holds its new take, so the retry renders straight away.
    const retry = await request(app).post(`${base(project.id)}/revisions/${revision.id}/resume`);
    expect(retry.body.needsGeneration).toEqual([]);
    expect(retry.body.generating).toEqual([]);
    expect(h.procs).toHaveLength(2);
    lastProc().emit('spawn');
    lastProc().emit('close', 0, null);
    await settle();

    reloaded = await projects.getProject(project.id);
    expect(reloaded.revisions[0]).toMatchObject({ status: 'complete', renderAttempts: 2 });
    expect(reloaded.scenes[1].videoHistoryId).toBe('clip-2b');
    expect(reloaded.scenes[0].videoHistoryId).toBe('clip-1'); // approved section still untouched
    expect(h.enqueueJob).not.toHaveBeenCalled(); // zero paid (re)submissions across the retry
  });

  it('after a restart mid-draft, deletes the partial output and resumes from the checkpoint', async () => {
    const project = await reviewedProject();
    const { body: { revision } } = await request(app).post(`${base(project.id)}/excerpt/mve-draft/revisions`).send({});
    await landNewTake(project.id, 's2', 'clip-2b');
    // The record exactly as a process killed mid-encode left it: the draft
    // re-render still 'rendering' with its partial file on disk, the revision
    // 'rendering' — and (being a fresh process) no live job for either.
    const partial = 'music-video-excerpt-crashed.mp4';
    mkdirSync(join(ROOT(), 'videos'), { recursive: true });
    writeFileSync(join(ROOT(), 'videos', partial), 'half-an-mp4');
    await projects.mutateProjectRecord(project.id, (current) => ({
      project: {
        ...current,
        excerpts: [...current.excerpts, { id: 'mve-crashed', startSec: 5, endSec: 25, status: 'rendering', jobId: 'mve-crashed', filename: null, contactSheetFilename: null, partialFilename: partial, sections: null, error: null, notes: [] }],
        revisions: current.revisions.map((r) => ({ ...r, status: 'rendering', renderExcerptId: 'mve-crashed', renderAttempts: 1 })),
      },
    }));

    await recoverStuckMusicVideoExcerpts();

    expect(existsSync(join(ROOT(), 'videos', partial))).toBe(false);
    let reloaded = await projects.getProject(project.id);
    expect(reloaded.excerpts.find((e) => e.id === 'mve-crashed')).toMatchObject({ status: 'error', partialFilename: null });
    expect(reloaded.revisions[0]).toMatchObject({ status: 'open', error: expect.stringMatching(/restart/) });

    const resumed = await request(app).post(`${base(project.id)}/revisions/${revision.id}/resume`);
    expect(resumed.body.needsGeneration).toEqual([]);
    expect(resumed.body.render).toBeTruthy();
    reloaded = await projects.getProject(project.id);
    expect(reloaded.revisions[0]).toMatchObject({ status: 'rendering', renderAttempts: 2 });
    expect(h.enqueueJob).not.toHaveBeenCalled();
    lastProc().emit('spawn');
    lastProc().emit('close', 0, null);
    await settle();
  });

  it('cancels a rendering revision, stopping its draft render and removing the partial output', async () => {
    const project = await reviewedProject();
    const { body: { revision } } = await request(app).post(`${base(project.id)}/excerpt/mve-draft/revisions`).send({});
    await landNewTake(project.id, 's2', 'clip-2b');
    const { body: { render } } = await request(app).post(`${base(project.id)}/revisions/${revision.id}/resume`);
    lastProc().emit('spawn');

    const canceled = await request(app).post(`${base(project.id)}/revisions/${revision.id}/cancel`);
    expect(canceled.status).toBe(200);
    expect(canceled.body.revision.status).toBe('canceled');
    await settle();

    const reloaded = await projects.getProject(project.id);
    expect(reloaded.revisions[0].status).toBe('canceled'); // the render's own cancel doesn't reopen it
    expect(reloaded.excerpts.find((e) => e.id === render.excerptId)).toMatchObject({ status: 'canceled', partialFilename: null });
    const resume = await request(app).post(`${base(project.id)}/revisions/${revision.id}/resume`);
    expect(resume.status).toBe(409);
  });

  it('refuses a second open revision, a section outside the draft, and a draft without a section map', async () => {
    const project = await reviewedProject();
    const first = await request(app).post(`${base(project.id)}/excerpt/mve-draft/revisions`).send({ sceneIds: ['s1'] });
    expect(first.status).toBe(201);
    const second = await request(app).post(`${base(project.id)}/excerpt/mve-draft/revisions`).send({});
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('REVISION_IN_PROGRESS');

    const outside = await request(app).post(`${base(project.id)}/revisions/${first.body.revision.id}/cancel`);
    expect(outside.status).toBe(200);
    const notInDraft = await request(app).post(`${base(project.id)}/excerpt/mve-draft/revisions`).send({ sceneIds: ['s9'] });
    expect(notInDraft.status).toBe(422);

    const legacy = await projects.createProject({ name: 'Legacy' });
    await projects.updateProject(legacy.id, {
      excerpts: [{ id: 'mve-old', startSec: 0, endSec: 5, status: 'complete', notes: [{ id: 'n', atSec: 1, note: 'x', verdict: 'flagged' }] }],
    });
    const noMap = await request(app).post(`${base(legacy.id)}/excerpt/mve-old/revisions`).send({});
    expect(noMap.status).toBe(422);
    expect(noMap.body.code).toBe('EXCERPT_SECTIONS_UNKNOWN');
  });
});
