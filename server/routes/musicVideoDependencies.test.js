import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { EventEmitter } from 'events';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';
import { captureMusicVideoEvidence } from '../lib/musicVideoDependencies.js';
import { recordAttemptReview, nextAutoReviewStep } from '../services/musicVideo/autoReview.js';

const ROOT = () => lazyTempDataRoot('mv-dependencies-');
vi.mock('../lib/paths.js', async (original) => makePathsProxy(await original(), { dataRoot: ROOT }));
vi.mock('../services/settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));
vi.mock('../services/mediaJobQueue/index.js', () => ({ listJobs: vi.fn(() => []), cancelJob: vi.fn(), mediaJobEvents: new EventEmitter() }));
vi.mock('../services/musicVideo/excerptRender.js', () => ({ startExcerptRender: vi.fn(async () => ({ jobId: 'example-render', excerptId: 'example-excerpt' })), cancelExcerptRender: vi.fn(), attachExcerptRenderSseClient: vi.fn() }));
const { default: router } = await import('./musicVideo.js');
const projects = await import('../services/musicVideo/projects.js');
const { assertRevisionOpen } = await import('../services/musicVideo/revisionService.js');
const app = express();
app.use(express.json());
app.use('/api/music-video', router);
app.use(errorMiddleware);
let project;
const base = () => `/api/music-video/${project.id}`;
const fresh = () => projects.getProject(project.id);
const impact = () => request(app).get(`${base()}/dependency-impact`);

beforeEach(async () => {
  mkdirSync(join(ROOT(), 'images'), { recursive: true });
  for (const image of ['a.png', 'b.png', 'new.png', 'mask.png']) writeFileSync(join(ROOT(), 'images', image), 'synthetic-image');
  writeFileSync(join(ROOT(), 'video-history.json'), JSON.stringify(['clip-a', 'clip-b', 'clip-new'].map((id) => ({ id, filename: `${id}.mp4` }))));
  project = await projects.createProject({ name: 'Example dependency project' });
  await projects.updateProject(project.id, { scenes: ['a', 'b'].map((id, i) => ({ sceneId: id, startSec: i * 5, endSec: i * 5 + 5, visualLayer: 'footage', takes: [] })) });
  for (const id of ['a', 'b']) {
    await request(app).post(`${base()}/scenes/${id}/takes`).send({ kind: 'image', assetId: `${id}.png` });
    await request(app).post(`${base()}/scenes/${id}/takes`).send({ kind: 'video', assetId: `clip-${id}`, sourceImageId: `${id}.png`, source: 'generated' });
  }
  await projects.mutateProjectRecord(project.id, (current) => ({ project: { ...current, excerpts: ['a', 'b'].map((id, i) => ({ id: `excerpt-${id}`, status: 'complete', startSec: i * 5, endSec: i * 5 + 5, dependencies: captureMusicVideoEvidence(current, { startSec: i * 5, endSec: i * 5 + 5 }) })) } }));
});
afterAll(cleanupTempDataRoots);

describe('public dependency save / repair / review workflow', () => {
  it('stales only dependents of a changed plate and keeps history through cancel, restart and duplicate resumes', async () => {
    expect((await impact()).body.shots).toEqual([]);
    await request(app).patch(`${base()}/scenes/a`).send({ referenceImageId: 'new.png' });
    const preview = (await impact()).body;
    expect(preview.shots.map((shot) => shot.sceneId)).toEqual(['a']);
    expect(preview.evidence.map((entry) => entry.id)).toEqual(['excerpt-a']);
    expect(preview.estimate).toMatchObject({ maxGenerations: 1, outputSeconds: 5 });
    expect((await fresh()).scenes[1].takes.find((take) => take.assetId === 'clip-b').dependencyState.status).toBe('current');
    const opened = await request(app).post(`${base()}/dependency-repairs`).send({ basis: preview.basis });
    expect(opened.status).toBe(201);
    expect(opened.body.project.scenes[0].referenceImageId).toBe('new.png');
    expect(opened.body.project.scenes[0].videoHistoryId).toBeNull();
    expect(opened.body.project.scenes[0].takes.some((take) => take.assetId === 'clip-a')).toBe(true);
    const revisionId = opened.body.revision.id;
    const resumed = await request(app).post(`${base()}/revisions/${revisionId}/resume`);
    expect(resumed.body.needsGeneration).toEqual([{ sceneId: 'a', kind: 'video' }]);
    expect((await request(app).post(`${base()}/revisions/${revisionId}/resume`)).body.needsGeneration).toEqual([]);
    await assertRevisionOpen(project.id, revisionId, { sceneId: 'a', kind: 'video' });
    await expect(assertRevisionOpen(project.id, revisionId, { sceneId: 'a', kind: 'video' })).rejects.toMatchObject({ code: 'REVISION_SECTION_IN_FLIGHT' });
    await request(app).post(`${base()}/revisions/${revisionId}/cancel`);
    await expect(assertRevisionOpen(project.id, revisionId, { sceneId: 'a', kind: 'video' })).rejects.toMatchObject({ code: 'REVISION_CLOSED' });
    const restarted = await request(app).post(`${base()}/dependency-repairs`).send({ basis: (await impact()).body.basis });
    expect(restarted.status).toBe(201);
    await request(app).post(`${base()}/scenes/a/takes`).send({ kind: 'video', assetId: 'clip-new', sourceImageId: 'new.png', source: 'generated' });
    expect((await request(app).post(`${base()}/revisions/${restarted.body.revision.id}/resume`)).body.needsGeneration).toEqual([]);
    expect((await fresh()).scenes[0].takes.filter((take) => take.assetId === 'clip-new')).toHaveLength(1);
    expect((await fresh()).scenes[1].videoHistoryId).toBe('clip-b');
  });

  it('refuses a stale preview and invalidates passing reviews including an in-flight review race', async () => {
    const current = await fresh();
    const run = { id: 'run-example', status: 'running', startSec: 0, endSec: 5, usage: { reviews: 1, generations: 0 }, limits: { maxAttempts: 2, maxGenerations: 1 }, attempts: [{ excerptId: 'excerpt-a' }] };
    const before = { ...current, autoReviews: [run] };
    const passed = recordAttemptReview(before, run.id, { verdict: 'pass', findings: [] }).project;
    expect(passed.autoReviews[0].status).toBe('passed');
    await projects.mutateProjectRecord(project.id, () => ({ project: passed }));
    const preview = (await impact()).body;
    await request(app).patch(`${base()}/scenes/a`).send({ referenceImageId: 'new.png' });
    const response = await request(app).post(`${base()}/dependency-repairs`).send({ basis: preview.basis });
    expect(response.status).toBe(409);
    const changed = await fresh();
    expect(changed.autoReviews[0].attempts[0].review.dependencyState.status).toBe('stale');
    expect(nextAutoReviewStep(changed, { ...changed.autoReviews[0], status: 'running' })).toMatchObject({ type: 'halt', status: 'needs-human' });
    const raced = recordAttemptReview({ ...changed, autoReviews: [run] }, run.id, { verdict: 'pass', findings: [] });
    expect(raced.run.status).toBe('needs-human');
    expect(raced.run.attempts[0].review.verdict).toBe('inconclusive');
  });

  it('keeps reused take provenance current when cloning a project', async () => {
    const clone = await projects.cloneProject(project.id);
    expect(clone.scenes[0].sceneId).not.toBe('a');
    const result = await request(app).get(`/api/music-video/${clone.id}/dependency-impact`);
    expect(result.status).toBe(200);
    expect(result.body.shots).toEqual([]);
  });

  it('keeps legacy assets loadable but never blesses a historical review without dependency evidence', async () => {
    await projects.updateProject(project.id, { scenes: [{ sceneId: 'legacy', startSec: 0, endSec: 5, referenceImageId: 'a.png', videoHistoryId: 'clip-a' }], excerpts: [{ id: 'old', status: 'complete', startSec: 0, endSec: 5 }] });
    await request(app).patch(`${base()}/scenes/legacy`).send({ referenceImageId: 'new.png' });
    const result = (await impact()).body;
    expect(result.shots.map((shot) => shot.sceneId)).toEqual(['legacy']);
    expect(result.evidence[0].reasons).toContain('Dependency evidence was not recorded; review again');
    expect((await fresh()).scenes[0].takes.find((take) => take.assetId === 'clip-a').dependencies.version).toBe(1);
  });
});
