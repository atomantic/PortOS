/**
 * Music Video cameos (#14821) through the real routers and the file-backed
 * project store: one chosen still fills every linked shot without its own take,
 * a new still refills them, a shot's own take wins, variants and unlinking
 * release the inherited still, a roll call's worth of cameos fits, and the
 * composition document reads the cameos and a cameo without a still as data.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';

const ROOT = () => lazyTempDataRoot('mv-cameos-route-test-');
vi.mock('../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), { dataRoot: ROOT }));
vi.mock('../services/settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));

const { default: cameoRoutes } = await import('./musicVideoCameos.js');
const { default: musicVideoRoutes } = await import('./musicVideo.js');
const projects = await import('../services/musicVideo/projects.js');
const { buildDocumentData } = await import('../services/musicVideo/documentRender.js');
const { musicVideoCameoCoverage } = await import('../lib/musicVideoCameos.js');

const app = express();
app.use(express.json());
app.use('/api/music-video', cameoRoutes);
app.use('/api/music-video', musicVideoRoutes);
app.use(errorMiddleware);

function seedImage(name) {
  mkdirSync(join(ROOT(), 'images'), { recursive: true });
  writeFileSync(join(ROOT(), 'images', name), 'png-bytes');
}

let project;
let shots;
beforeEach(async () => {
  rmSync(join(ROOT(), 'music-video-projects.json'), { force: true });
  rmSync(join(ROOT(), 'images'), { recursive: true, force: true });
  writeFileSync(join(ROOT(), 'video-history.json'), '[]');
  project = await projects.createProject({ name: 'Example Roll Call' });
  shots = [];
  for (const prompt of ['dog one', 'dog two', 'dog three']) shots.push(await projects.addProjectScene(project.id, { prompt }));
});
afterAll(cleanupTempDataRoots);

const expectStatus = async (pending, status) => {
  const res = await pending;
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res;
};
const base = () => `/api/music-video/${project.id}`;
const reload = () => projects.getProject(project.id);
const sceneOf = (stored, sceneId) => stored.scenes.find((s) => s.sceneId === sceneId);
async function addCameo(name = 'Example Dog', extra = {}) {
  const res = await request(app).post(`${base()}/cameos`).send({ cameos: [{ name, ...extra }] });
  expect(res.status).toBe(201);
  return res.body.created[0];
}

describe('music video cameos', () => {
  it('fills linked shots from the chosen still, refills on change, and keeps a shot\'s own take', async () => {
    seedImage('still-a.png');
    seedImage('still-b.png');
    seedImage('own.png');
    const cameo = await addCameo();
    const [one, two, three] = shots;
    await expectStatus(request(app).post(`${base()}/scenes/${three.sceneId}/takes`).send({ kind: 'image', assetId: 'own.png', source: 'generated' }), 201);

    const linked = await request(app).post(`${base()}/cameos/${cameo.cameoId}/shots`).send({ sceneIds: [one.sceneId, two.sceneId, three.sceneId] });
    expect(linked.status).toBe(200);
    // No still yet: linked, nothing filled, and coverage says so.
    let stored = await reload();
    expect(sceneOf(stored, one.sceneId)).toMatchObject({ cameoId: cameo.cameoId, referenceImageId: null });
    expect(musicVideoCameoCoverage(stored).cameos)
      .toEqual([expect.objectContaining({ cameoId: cameo.cameoId, shots: 3, needs: ['research', 'references', 'still'] })]);

    await expectStatus(request(app).patch(`${base()}/cameos/${cameo.cameoId}`).send({ stillImageId: 'still-a.png' }), 200);
    stored = await reload();
    expect([one, two, three].map((s) => sceneOf(stored, s.sceneId).referenceImageId)).toEqual(['still-a.png', 'still-a.png', 'own.png']);

    const res = await request(app).patch(`${base()}/cameos/${cameo.cameoId}`).send({ stillImageId: 'still-b.png' });
    expect(res.body.scenes.find((s) => s.sceneId === one.sceneId).referenceImageId).toBe('still-b.png');
    stored = await reload();
    const first = sceneOf(stored, one.sceneId);
    expect(first.referenceImageId).toBe('still-b.png');
    // The replaced cameo still leaves no stale candidate behind.
    expect(first.takes.map((t) => [t.assetId, t.source])).toEqual([['still-b.png', 'cameo']]);
    expect(sceneOf(stored, three.sceneId).referenceImageId).toBe('own.png');
  });

  it('a variant fills only the shots that pick it, and unlinking drops the inherited still', async () => {
    seedImage('main.png');
    seedImage('costume.png');
    const cameo = await addCameo('Example Doodle');
    await expectStatus(request(app).patch(`${base()}/cameos/${cameo.cameoId}`).send({ stillImageId: 'main.png' }), 200);
    const added = await request(app).post(`${base()}/cameos/${cameo.cameoId}/variants`).send({ label: 'Costume' });
    const variantId = added.body.cameos[0].variants[0].variantId;
    const [one, two] = shots;
    await expectStatus(request(app).post(`${base()}/cameos/${cameo.cameoId}/shots`).send({ sceneIds: [one.sceneId] }), 200);
    await expectStatus(request(app).post(`${base()}/cameos/${cameo.cameoId}/shots`).send({ sceneIds: [two.sceneId], variantId }), 200);
    let stored = await reload();
    expect(sceneOf(stored, two.sceneId)).toMatchObject({ cameoVariantId: variantId, referenceImageId: null });
    expect(musicVideoCameoCoverage(stored).cameos[0].needs).toContain('variant');

    await expectStatus(request(app).patch(`${base()}/cameos/${cameo.cameoId}/variants/${variantId}`).send({ imageId: 'costume.png' }), 200);
    stored = await reload();
    expect([one, two].map((s) => sceneOf(stored, s.sceneId).referenceImageId)).toEqual(['main.png', 'costume.png']);

    await expectStatus(request(app).post(`${base()}/cameo-links/clear`).send({ sceneIds: [one.sceneId] }), 200);
    stored = await reload();
    expect(sceneOf(stored, one.sceneId).cameoId).toBeUndefined();
    expect(sceneOf(stored, one.sceneId).referenceImageId).toBeNull();
  });

  it('a shot\'s own still can become the cameo still for every other linked shot', async () => {
    seedImage('refined.png');
    const cameo = await addCameo();
    const [one, two] = shots;
    await expectStatus(request(app).post(`${base()}/cameos/${cameo.cameoId}/shots`).send({ sceneIds: [one.sceneId, two.sceneId] }), 200);
    await expectStatus(request(app).post(`${base()}/scenes/${one.sceneId}/takes`).send({ kind: 'image', assetId: 'refined.png', source: 'generated' }), 201);
    await expectStatus(request(app).post(`${base()}/cameos/${cameo.cameoId}/still-from-shot`).send({ sceneId: one.sceneId }), 200);
    const stored = await reload();
    expect(stored.cameos[0].stillImageId).toBe('refined.png');
    expect(sceneOf(stored, two.sceneId).referenceImageId).toBe('refined.png');
  });

  it('links a cameo through the shot editor PATCH and refuses unknown cameos and missing images', async () => {
    seedImage('still.png');
    const cameo = await addCameo();
    await expectStatus(request(app).patch(`${base()}/cameos/${cameo.cameoId}`).send({ stillImageId: 'still.png' }), 200);
    const patched = await request(app).patch(`${base()}/scenes/${shots[0].sceneId}`).send({ cameoId: cameo.cameoId });
    expect(patched.status).toBe(200);
    expect(patched.body).toMatchObject({ cameoId: cameo.cameoId, referenceImageId: 'still.png' });
    await expectStatus(request(app).patch(`${base()}/scenes/${shots[1].sceneId}`).send({ cameoId: 'mvcam-missing' }), 404);
    await expectStatus(request(app).patch(`${base()}/cameos/${cameo.cameoId}`).send({ stillImageId: 'nope.png' }), 404);
  });

  it('holds a roll call of 300 cameos and hands the document their ids and placeholder labels', async () => {
    const res = await request(app).post(`${base()}/cameos`)
      .send({ cameos: Array.from({ length: 300 }, (_, i) => ({ name: `Dog ${i + 1}`, ...(i === 0 ? { label: 'Alias' } : {}) })) });
    expect(res.status).toBe(201);
    const first = res.body.created[0];
    await expectStatus(request(app).post(`${base()}/cameos/${first.cameoId}/shots`).send({ sceneIds: [shots[0].sceneId, shots[1].sceneId] }), 200);
    // A second shot of the same cameo shows it under another name (an alias).
    await expectStatus(request(app).patch(`${base()}/scenes/${shots[1].sceneId}`).send({ cameoLabel: 'Other Name' }), 200);
    const stored = await reload();
    expect(stored.cameos).toHaveLength(300);
    const data = buildDocumentData(stored, { frame: { width: 1920, height: 1080 }, clock: { fps: 24, frames: 24, durationSec: 1 }, songDurationSec: 1 });
    expect(data.cameos[0]).toEqual({ cameoId: first.cameoId, name: 'Dog 1', label: 'Alias', hasStill: false, variants: [] });
    expect(data.scenes.find((s) => s.sceneId === shots[0].sceneId)).toMatchObject({ cameoId: first.cameoId, cameoLabel: 'Alias', media: null });
    expect(data.scenes.find((s) => s.sceneId === shots[1].sceneId)).toMatchObject({ cameoId: first.cameoId, cameoLabel: 'Other Name' });
  });
});
