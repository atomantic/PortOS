/**
 * Project saves answer with the board edit result (#16402), through the real router and the real
 * file-backed store: creative setup, style references, the visual spec, the automation brief and the
 * lyric imports reply `{ edit }` instead of the project, and that result folded into the record
 * `GET /:id` returned before the save equals what `GET /:id` returns after it, readiness included.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';
import { applyMusicVideoEdit } from '../lib/musicVideo/musicVideoEditResult.js';

const ROOT = () => lazyTempDataRoot('mv-project-edit-result-');
vi.mock('../lib/paths.js', async (original) => makePathsProxy(await original(), { dataRoot: ROOT }));
vi.mock('../services/settings.js', () => ({ getSettings: vi.fn(async () => ({})) }));
vi.mock('../services/tracks/index.js', async (original) => ({
  ...(await original()),
  getTrack: vi.fn(async (id) => (id === 'track-example' ? { id, title: 'Example song', lyrics: '[Verse]\nFirst sung line\nSecond sung line' } : null)),
}));
vi.mock('../services/musicVideo/referenceLabels.js', async (original) => {
  const actual = await original();
  return { ...actual, labelProjectReferences: vi.fn(actual.labelProjectReferences) };
});
const { labelProjectReferences } = await import('../services/musicVideo/referenceLabels.js');
const { default: router } = await import('./musicVideo.js');
const projects = await import('../services/musicVideo/projects.js');
const { recordEvents } = await import('../services/sharing/recordEvents.js');
const { productionReviewBasis } = await import('../services/musicVideo/productionReview.js');

const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.portosAuthContext = { enabled: false }; next(); });
app.use('/api/music-video', router);
app.use(errorMiddleware);

let project;
const base = () => `/api/music-video/${project.id}`;
const read = async () => (await request(app).get(base())).body;
afterAll(cleanupTempDataRoots);

beforeEach(async () => {
  project = await projects.createProject({ name: 'Example project edit' });
  await projects.updateProject(project.id, { audioAnalysis: { durationSec: 15, bpm: 120, beats: [], sections: [] } });
  // An approved art direction, so a save that changes its inputs has a notice to raise.
  await projects.mutateProjectRecord(project.id, (current) => ({ project: { ...current, productionReview: { ...current.productionReview,
    approvals: { ...current.productionReview?.approvals, art: { basis: productionReviewBasis(current).art, approvedAt: '2026-01-01T00:00:00.000Z' } } } } }));
});

// The save's reply, folded into the read before it, is the read after it.
async function expectReloadParity(send, { changes = null } = {}) {
  const before = await read();
  const reply = await send();
  expect(reply.status).toBe(200);
  expect(reply.body).not.toHaveProperty('project');
  expect(reply.body.edit).toMatchObject({ sceneIds: expect.any(Array), scenes: expect.any(Array), project: expect.any(Object), removed: expect.any(Array) });
  const after = await read();
  expect(applyMusicVideoEdit(before, reply.body.edit)).toEqual(after);
  expect(reply.body.edit.baseUpdatedAt).toBe(before.updatedAt);
  if (changes) expect(Object.keys(reply.body.edit.project)).toEqual(expect.arrayContaining(changes));
  return { before, after, reply: reply.body };
}
const save = (patch, origin = null) => {
  const call = request(app).patch(`${base()}?edit=1`);
  return (origin ? call.set('X-PortOS-Origin', origin) : call).send(patch);
};

describe('project saves carry what a reload would show', () => {
  it('a creative-setup save that casts subjects answers with the edit, not the project', async () => {
    const { after, reply } = await expectReloadParity(() => save({
      concept: { subjects: [{ id: 'sub-1', kind: 'object', name: 'Glass guitar', description: 'Transparent blue glass' }] },
      productionPolicy: { strategy: 'code-first', maxGeneratedVideoPercent: 0 },
    }), { changes: ['concept', 'productionPolicy'] });
    expect(after.concept.subjects).toHaveLength(1);
    expect(reply.edit.updatedAt).toBe(after.updatedAt);
  });

  // Uniquely catches a reply built before the art approval's inputs moved: the board would keep showing it current.
  it('the art notice comes from the reply when the save changes what the art approval rests on', async () => {
    expect((await read()).productionReadiness.art.stale).toBeNull();
    const { after, reply } = await expectReloadParity(() => save({ visualSpec: { references: [{ id: 'r1', imageId: 'a.png', role: 'mood', condition: false }] } }));
    expect(after.productionReadiness.art.stale).not.toBeNull();
    expect(reply.edit.project.productionReadiness.art.stale).toEqual(after.productionReadiness.art.stale);
  });

  // Uniquely catches an edit taken before the reference naming write, which would leave the label off the board until a reload.
  it('a reference named from the catalog after the save is in the reply', async () => {
    labelProjectReferences.mockImplementationOnce(async (id) => {
      const { project: saved } = await projects.mutateProjectRecord(id, (current) => ({ project: { ...current,
        visualSpec: { ...current.visualSpec, references: current.visualSpec.references.map((ref) => ({ ...ref, label: 'Harbor at night' })) } } }));
      return { project: saved, labels: {} };
    });
    const { after, reply } = await expectReloadParity(() => save({ visualSpec: { references: [{ id: 'r1', imageId: 'a.png', role: 'mood', condition: false }] } }));
    expect(after.visualSpec.references[0].label).toBe('Harbor at night');
    expect(reply.edit.project.visualSpec.references[0].label).toBe('Harbor at night');
  });

  it('a style-reference save answers with the edit and stales the art approval', async () => {
    const { after, reply } = await expectReloadParity(() => save({ styleReferences: [{ imageId: 'grain.png', caption: 'Fine grain' }] }), { changes: ['styleReferences'] });
    expect(after.styleReferences).toEqual([{ imageId: 'grain.png', caption: 'Fine grain' }]);
    expect(reply.edit.project.productionReadiness.art.stale).not.toBeNull();
  });

  it('a visual-spec field save answers with the edit', async () => {
    const { after } = await expectReloadParity(() => save({ visualSpec: { palette: ['#102030', '#ffeedd'] } }), { changes: ['visualSpec'] });
    expect(after.visualSpec.palette).toEqual(['#102030', '#ffeedd']);
  });

  it('an automation save answers with the edit, mode included', async () => {
    const { after } = await expectReloadParity(() => save({ automation: { tools: ['image:local'], guidance: 'noir', budgetUsd: 5 }, mode: 'autonomous' }), { changes: ['automation', 'mode'] });
    expect(after).toMatchObject({ mode: 'autonomous', automation: { guidance: 'noir' } });
  });

  it('a save without ?edit=1 still answers with the project', async () => {
    const reply = await request(app).patch(base()).send({ visualSpec: { palette: ['#102030'] } });
    expect(reply.body).toMatchObject({ id: project.id, visualSpec: { palette: ['#102030'] } });
    expect(reply.body).not.toHaveProperty('edit');
  });

  it('pasted lyrics answer with the edit and the count, not the project', async () => {
    const { after, reply } = await expectReloadParity(() => request(app).post(`${base()}/lyrics/import?edit=1`).send({ text: '[00:01.00]first line\n[00:03.00]second line', format: 'lrc' }), { changes: ['lyricCues'] });
    expect(reply).toMatchObject({ imported: 2, format: 'lrc' });
    expect(after.lyricCues.map((cue) => cue.text)).toEqual(['first line', 'second line']);
  });

  it('track lyrics answer with the edit, and answer edit: null when the lines are kept', async () => {
    await projects.updateProject(project.id, { trackId: 'track-example' });
    const { after, reply } = await expectReloadParity(() => request(app).post(`${base()}/lyrics/import-track?edit=1`).send({ mode: 'replace' }), { changes: ['lyricCues'] });
    expect(reply).toMatchObject({ imported: 2, skipped: null });
    expect(after.lyricCues.map((cue) => cue.text)).toEqual(['First sung line', 'Second sung line']);
    const kept = await request(app).post(`${base()}/lyrics/import-track?edit=1`).send({ mode: 'if-empty' });
    expect(kept.body).toEqual({ edit: null, imported: 0, markers: 0, skipped: 'has-lyrics' });
  });

  it('the lyric imports still answer with the project without ?edit=1', async () => {
    const pasted = await request(app).post(`${base()}/lyrics/import`).send({ text: 'one line', format: 'text' });
    expect(pasted.body).toMatchObject({ project: { id: project.id }, imported: 1 });
    const track = await request(app).post(`${base()}/lyrics/import-track`).send({ mode: 'replace' });
    expect(track.body.project).toBeUndefined();
    expect(track.status).toBe(400);
  });

  // Uniquely catches a follow-up write (naming references) that leaves the asking tab out of its broadcast and refetching.
  it('every change broadcast of a save names the tab that asked', async () => {
    const seen = [];
    const listen = (event) => { if (event.recordId === project.id) seen.push(event.origin ?? null); };
    recordEvents.on('updated', listen);
    await save({ visualSpec: { references: [{ id: 'r1', imageId: 'a.png', role: 'mood', condition: false }] } }, 'socket-example');
    await request(app).post(`${base()}/lyrics/import?edit=1`).set('X-PortOS-Origin', 'socket-example').send({ text: 'one line', format: 'text' });
    recordEvents.off('updated', listen);
    expect(seen.length).toBeGreaterThan(1);
    expect(new Set(seen)).toEqual(new Set(['socket-example']));
  });
});
