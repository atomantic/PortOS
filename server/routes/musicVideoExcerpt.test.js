/**
 * Music Video draft excerpt (#8986): review-note CRUD, deletion, and clone
 * carry-over, exercised through the real router + excerptService.js +
 * excerpt.js + the real file-backed project store. The ffmpeg render itself
 * is out of scope here (mocked) — this covers what the acceptance criteria
 * actually gate on: review notes surviving a reload and a clone, and a render
 * in flight blocking deletion until it's cancelled.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { makePathsProxy, lazyTempDataRoot, cleanupTempDataRoots } from '../lib/mockPathsDataRoot.js';

const ROOT = () => lazyTempDataRoot('mv-excerpt-route-test-');
vi.mock('../lib/paths.js', async (importOriginal) => makePathsProxy(await importOriginal(), { dataRoot: ROOT }));

// The route's job here is CRUD dispatch against the persisted excerpt list;
// the ffmpeg/overlay pipeline is unit-tested in render.test.js
// (buildMusicVideoFfmpegArgs' `excerpt` option, excerptBoundaryTimes).
vi.mock('../services/musicVideo/excerptRender.js', () => ({
  startExcerptRender: vi.fn(),
  attachExcerptRenderSseClient: vi.fn(() => true),
  cancelExcerptRender: vi.fn(() => true),
}));

const { default: musicVideoRoutes } = await import('./musicVideo.js');
const { startExcerptRender } = await import('../services/musicVideo/excerptRender.js');
const projects = await import('../services/musicVideo/projects.js');

const app = express();
app.use(express.json());
app.use('/api/music-video', musicVideoRoutes);
app.use(errorMiddleware);

const base = (id) => `/api/music-video/${id}`;

beforeEach(() => {
  rmSync(join(ROOT(), 'music-video-projects.json'), { force: true });
  vi.clearAllMocks();
});
afterAll(cleanupTempDataRoots);

// Seed a project with one excerpt directly on the record — the render
// pipeline that produces this shape is exercised elsewhere.
async function projectWithExcerpt(excerptOverrides = {}) {
  const project = await projects.createProject({ name: 'Example Video' });
  const excerpt = {
    id: 'mve-1', startSec: 10, endSec: 20, status: 'complete',
    filename: 'music-video-excerpt-1.mp4', contactSheetFilename: 'music-video-excerpt-1-sheet.png',
    error: null, notes: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    ...excerptOverrides,
  };
  const updated = await projects.updateProject(project.id, { excerpts: [excerpt] });
  return { project: updated, excerptId: excerpt.id };
}

describe('draft excerpt review notes (#8986)', () => {
  it('adds, edits and removes a timecoded note, surviving a reload', async () => {
    const { project } = await projectWithExcerpt();

    const added = await request(app).post(`${base(project.id)}/excerpt/mve-1/notes`).send({ atSec: 3.5, note: 'lip-sync drifts here', verdict: 'flagged' });
    expect(added.status).toBe(201);
    const noteId = added.body.note.id;
    expect(added.body.note).toMatchObject({ atSec: 3.5, note: 'lip-sync drifts here', verdict: 'flagged' });

    // Reload from the store — not the response body — proves persistence.
    const reloaded = await projects.getProject(project.id);
    expect(reloaded.excerpts[0].notes).toEqual([added.body.note]);

    const edited = await request(app).patch(`${base(project.id)}/excerpt/mve-1/notes/${noteId}`).send({ verdict: 'approved' });
    expect(edited.status).toBe(200);
    expect(edited.body.note.verdict).toBe('approved');
    expect(edited.body.note.note).toBe('lip-sync drifts here'); // untouched fields survive a partial edit

    const removed = await request(app).delete(`${base(project.id)}/excerpt/mve-1/notes/${noteId}`);
    expect(removed.status).toBe(200);
    expect(removed.body.excerpts[0].notes).toEqual([]);
  });

  it('404s adding a note to an unknown excerpt', async () => {
    const project = await projects.createProject({ name: 'Example Video' });
    const r = await request(app).post(`${base(project.id)}/excerpt/nope/notes`).send({ atSec: 1, note: 'x' });
    expect(r.status).toBe(404);
  });

  it('422s a timecode well past the excerpt\'s own duration', async () => {
    const { project } = await projectWithExcerpt(); // 10s excerpt (startSec 10, endSec 20)
    const r = await request(app).post(`${base(project.id)}/excerpt/mve-1/notes`).send({ atSec: 30, note: 'way past the end' });
    expect(r.status).toBe(422);
  });
});

describe('draft excerpt deletion (#8986)', () => {
  it('removes a completed excerpt and its files', async () => {
    const { project } = await projectWithExcerpt();
    const r = await request(app).delete(`${base(project.id)}/excerpt/mve-1`);
    expect(r.status).toBe(200);
    expect(r.body.excerpts).toEqual([]);
  });

  it('refuses to delete the excerpt registered as the production proof (#10148)', async () => {
    const { project } = await projectWithExcerpt();
    await projects.updateProject(project.id, { productionReview: { proof: { excerptId: 'mve-1', startSec: 10, endSec: 20, basis: 'b' } } });
    const r = await request(app).delete(`${base(project.id)}/excerpt/mve-1`);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe('EXCERPT_REGISTERED_PROOF');
    expect(r.body.error || r.body.message).toMatch(/Revoke/);
    expect((await projects.getProject(project.id)).excerpts).toHaveLength(1);
  });

  it('refuses to delete an excerpt whose render is still in flight', async () => {
    const { project } = await projectWithExcerpt({ status: 'rendering', filename: null, contactSheetFilename: null });
    const r = await request(app).delete(`${base(project.id)}/excerpt/mve-1`);
    expect(r.status).toBe(409);
    const reloaded = await projects.getProject(project.id);
    expect(reloaded.excerpts).toHaveLength(1); // untouched
  });
});

describe('excerpts survive a clone (#8986 acceptance)', () => {
  it('carries excerpts and their review notes onto the cloned project', async () => {
    const { project } = await projectWithExcerpt({ notes: [{ id: 'mvn-1', atSec: 2, note: 'kept across clone', verdict: null, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }] });
    const cloned = await projects.cloneProject(project.id, {});
    expect(cloned.excerpts).toEqual(project.excerpts);
  });

  // A clone never duplicates the rendered bytes — it carries over the SAME
  // filename pointers as the source (see the previous test). Deleting one
  // project's excerpt must not unlink a file the other still references.
  it('does not delete the shared excerpt file while a clone still references it, and does once neither does', async () => {
    const { project } = await projectWithExcerpt();
    const cloned = await projects.cloneProject(project.id, {});
    const videoPath = join(ROOT(), 'videos', 'music-video-excerpt-1.mp4');
    const sheetPath = join(ROOT(), 'video-thumbnails', 'music-video-excerpt-1-sheet.png');
    mkdirSync(join(ROOT(), 'videos'), { recursive: true });
    mkdirSync(join(ROOT(), 'video-thumbnails'), { recursive: true });
    writeFileSync(videoPath, 'mp4-bytes');
    writeFileSync(sheetPath, 'png-bytes');

    const first = await request(app).delete(`${base(project.id)}/excerpt/mve-1`);
    expect(first.status).toBe(200);
    expect(existsSync(videoPath)).toBe(true); // the clone still references it
    expect(existsSync(sheetPath)).toBe(true);

    const second = await request(app).delete(`${base(cloned.id)}/excerpt/mve-1`);
    expect(second.status).toBe(200);
    expect(existsSync(videoPath)).toBe(false); // no project references it anymore
    expect(existsSync(sheetPath)).toBe(false);
  });
});

describe('social cuts (#9280)', () => {
  it('forwards a vertical, faded excerpt request and rejects an unknown aspect', async () => {
    const project = await projects.createProject({ name: 'Example Video' });
    startExcerptRender.mockResolvedValue({ jobId: 'mve-2', excerptId: 'mve-2' });
    const ok = await request(app).post(`${base(project.id)}/excerpt`).send({ startSec: 10, endSec: 25, aspect: '9:16', fade: true });
    expect(ok.status).toBe(200);
    expect(startExcerptRender).toHaveBeenCalledWith(project.id, { startSec: 10, endSec: 25, aspect: '9:16', fade: true });
    const bad = await request(app).post(`${base(project.id)}/excerpt`).send({ startSec: 10, endSec: 25, aspect: '4:3' });
    expect(bad.status).toBe(400);
  });

  it('suggests hook windows from the project\'s lyric timing', async () => {
    const created = await projects.createProject({ name: 'Example Video' });
    await projects.updateProject(created.id, {
      audioAnalysis: { durationSec: 60 },
      lyricCues: Array.from({ length: 10 }, (_, i) => ({ id: `lc-${i}`, text: `line ${i}`, startSec: i * 6, endSec: i * 6 + 5 })),
    });
    const r = await request(app).get(`${base(created.id)}/social-cuts?count=2&minSec=10&maxSec=20`);
    expect(r.status).toBe(200);
    expect(r.body.suggestions).toHaveLength(2);
    expect(r.body.suggestions[0]).toMatchObject({ startSec: expect.any(Number), endSec: expect.any(Number), reasons: expect.any(Array) });
  });
});
