/**
 * Music Video render spend (#16506), through the real media job events, spend hook, file-backed
 * project store and router. Each case is a render the take-only total used to miss: a priced
 * Higgsfield shot-card clip, a generic-route fal clip and image that never became a take, a lane
 * with no price, and a manual true-up. Importing a counted render as a take carries its cost to the
 * shot without counting it twice.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';
import { buildHiggsfieldVideoRequest } from '../lib/higgsfieldVideoModels.js';

const ROOT = () => lazyTempDataRoot('mv-spend-route-test-');
vi.mock('../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), { dataRoot: ROOT }));
vi.mock('../services/settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));

const { default: musicVideoRoutes } = await import('./musicVideo.js');
const projects = await import('../services/musicVideo/projects.js');
const { mediaJobEvents } = await import('../services/mediaJobQueue/index.js');
const { initMusicVideoRenderSpendHook, __testing: hook } = await import('../services/musicVideoRenderSpendHook.js');
const { musicVideoEvents } = await import('../services/musicVideo/events.js');

const app = express();
app.use(express.json());
app.use('/api/music-video', musicVideoRoutes);
app.use(errorMiddleware);
initMusicVideoRenderSpendHook();

let project;
let scene;
let history;
const seedClip = (id, estimatedCostUsd, modelId) => {
  history.push({ id, filename: `${id}.mp4`, modelId, estimatedCostUsd });
  writeFileSync(join(ROOT(), 'video-history.json'), JSON.stringify(history));
};
const seedImage = (filename, metadata) => {
  mkdirSync(join(ROOT(), 'images'), { recursive: true });
  writeFileSync(join(ROOT(), 'images', filename), 'png-bytes');
  writeFileSync(join(ROOT(), 'images', filename.replace('.png', '.metadata.json')), JSON.stringify(metadata));
};
const complete = async (job) => {
  mediaJobEvents.emit('completed', { status: 'completed', completedAt: '2026-11-16T00:00:00.000Z', ...job });
  await hook.drain();
};
const spend = async () => (await request(app).get(`/api/music-video/${project.id}/spend`)).body;
const laneRow = (body, lane) => body.spend.lanes.find((row) => row.lane === lane);

beforeEach(async () => {
  rmSync(join(ROOT(), 'music-video-projects.json'), { force: true });
  rmSync(join(ROOT(), 'music-video-render-spend.json'), { force: true });
  rmSync(join(ROOT(), 'images'), { recursive: true, force: true });
  history = [];
  writeFileSync(join(ROOT(), 'video-history.json'), '[]');
  project = await projects.createProject({ name: 'Example Video' });
  ({ scenes: [scene] } = await projects.addProjectScenes(project.id, [{ prompt: 'a lighthouse at dusk' }]));
});
afterAll(cleanupTempDataRoots);

describe('music video render spend', () => {
  it("adds a Higgsfield shot-card clip at the catalog's list price and pushes the new summary", async () => {
    const planned = buildHiggsfieldVideoRequest({ modelId: 'bytedance/seedance-2.5', prompt: 'waves', seconds: 5, resolution: '720p', imageUrl: 'pending:image' });
    expect(planned.estimatedCostUsd).toBe(1.3235);
    seedClip('job-hf', planned.estimatedCostUsd, `higgsfield:${planned.endpointId}`);
    const pushed = [];
    const onSpend = (event) => pushed.push(event);
    musicVideoEvents.on('render-spend', onSpend);
    await complete({ id: 'job-hf', kind: 'video', params: { mode: 'higgsfield', musicVideo: { projectId: project.id, sceneId: scene.sceneId } } });
    musicVideoEvents.off('render-spend', onSpend);

    const body = await spend();
    expect(body.spend.spentUsd).toBe(1.3235);
    expect(laneRow(body, 'higgsfield')).toMatchObject({ usd: 1.3235, count: 1, unpriced: 0 });
    expect(pushed).toEqual([{ projectId: project.id, renderSpend: body.renderSpend }]);
    // A project read carries the same summary, so the header pill shows it without a spend call.
    const read = await request(app).get(`/api/music-video/${project.id}`);
    expect(read.body.renderSpend).toEqual(body.renderSpend);
  });

  it('counts generic-route renders that never became a take, and prices an import once', async () => {
    seedClip('job-fal', 0.45, 'fal:fal-ai/minimax/hailuo-02/standard/image-to-video');
    seedImage('frame-1.png', { modelId: 'fal-ai/flux-pro', estimatedCostUsd: 0.05 });
    await complete({ id: 'job-fal', kind: 'video', params: { mode: 'fal', musicVideoProjectId: project.id } });
    await complete({ id: 'job-img', kind: 'image', result: { filename: 'frame-1.png' }, params: { mode: 'fal', musicVideoProjectId: project.id } });
    // A local render costs nothing and another project's render is not this one's.
    await complete({ id: 'job-local', kind: 'video', params: { mode: 'local', musicVideoProjectId: project.id } });
    await complete({ id: 'job-other', kind: 'video', params: { mode: 'fal', musicVideoProjectId: 'mv-other' } });

    const before = await spend();
    expect(before.spend.spentUsd).toBe(0.5);
    expect(laneRow(before, 'fal')).toMatchObject({ usd: 0.5, count: 2, unpriced: 0 });

    const imported = await request(app).post(`/api/music-video/${project.id}/scenes/${scene.sceneId}/takes`).send({ kind: 'video', assetId: 'job-fal' });
    expect(imported.status).toBe(201);
    expect(imported.body.take).toMatchObject({
      jobId: 'job-fal', costUsd: 0.45, spendKind: 'manual', costModelId: 'fal-ai/minimax/hailuo-02/standard/image-to-video',
    });
    expect((await spend()).spend.spentUsd).toBe(0.5);
  });

  it('shows a count of unpriced renders for a lane with no price instead of adding $0 silently', async () => {
    seedImage('sheet-1.png', { modelId: 'soul-2', estimatedCostUsd: null });
    await complete({ id: 'job-sheet', kind: 'image', result: { filename: 'sheet-1.png' }, params: { mode: 'higgsfield', musicVideo: { projectId: project.id } } });
    const body = await spend();
    expect(body.spend).toMatchObject({ spentUsd: 0, unpriced: 1 });
    expect(laneRow(body, 'higgsfield')).toMatchObject({ usd: 0, count: 1, unpriced: 1 });
  });

  it('keeps a take priced before the ledger existed in the total', async () => {
    seedClip('old-clip', 1.2, 'fal:fal-ai/example');
    await projects.appendSceneTakes(project.id, scene.sceneId, [{ kind: 'video', assetId: 'old-clip', source: 'generated', jobId: 'old-job', costUsd: 1.2, spendKind: 'manual' }]);
    const body = await spend();
    expect(body.spend).toMatchObject({ spentUsd: 1.2, manual: 1.2 });
    expect(laneRow(body, 'earlier')).toMatchObject({ usd: 1.2 });
  });

  it('stores, shows and removes a manual true-up, through the API', async () => {
    seedClip('job-fal', 3.95, 'fal:fal-ai/example');
    await complete({ id: 'job-fal', kind: 'video', params: { mode: 'fal', musicVideoProjectId: project.id } });

    const added = await request(app).post(`/api/music-video/${project.id}/spend/adjustments`).send({ lane: 'fal', actualUsd: 39, note: 'fal dashboard' });
    expect(added.status).toBe(201);
    expect(added.body.adjustment).toMatchObject({ lane: 'fal', usd: 35.05, statedUsd: 39, note: 'fal dashboard' });
    expect(added.body.spend.spentUsd).toBe(39);
    expect(laneRow(added.body, 'fal')).toMatchObject({ usd: 3.95, adjustmentUsd: 35.05, totalUsd: 39 });

    const shown = await spend();
    expect(shown.renderSpend.adjustments).toEqual([expect.objectContaining({ id: added.body.adjustment.id, usd: 35.05 })]);

    const removed = await request(app).delete(`/api/music-video/${project.id}/spend/adjustments/${encodeURIComponent(added.body.adjustment.id)}`);
    expect(removed.status).toBe(200);
    expect(removed.body.spend.spentUsd).toBe(3.95);
    // A recorded render is not an adjustment and cannot be deleted as one.
    expect((await request(app).delete(`/api/music-video/${project.id}/spend/adjustments/render:job-fal`)).status).toBe(404);
  });

  it('refuses an adjustment naming both or neither amount', async () => {
    const both = await request(app).post(`/api/music-video/${project.id}/spend/adjustments`).send({ lane: 'fal', actualUsd: 5, usd: 1 });
    const neither = await request(app).post(`/api/music-video/${project.id}/spend/adjustments`).send({ lane: 'fal' });
    expect([both.status, neither.status]).toEqual([400, 400]);
  });
});
