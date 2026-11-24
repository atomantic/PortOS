import { randomUUID } from 'node:crypto';
import express from 'express';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { checkHealth, close, ensureSchema, query } from '../lib/db.js';
import { requireDbOrSkip } from '../lib/dbTestGate.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { captureMusicVideoEvidence } from '../lib/musicVideo/musicVideoDependencies.js';
import { mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';
import { request } from '../lib/testHelper.js';

const { makeProxy, cleanup } = mockPathsDataRoot({ prefix: 'portos-music-video-completion-' });
vi.mock('../lib/fileUtils.js', async (importOriginal) => makeProxy(await importOriginal()));
vi.mock('../lib/pgFileFacade.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, createRecordStoreBackendSelector: (options) => actual.createRecordStoreBackendSelector(
    options.label === 'Music Video' ? { ...options, isTestMode: () => false } : options,
  ) };
});

const hydration = vi.hoisted(() => []);
vi.mock('../lib/db.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, query: async (sql, params) => {
    if (sql.startsWith('SELECT id, data FROM music_video_projects')) hydration.push(params?.[0]);
    return actual.query(sql, params);
  } };
});

const health = await checkHealth();
const runDb = requireDbOrSkip('routes/musicVideo.db.test', health.connected, health.error);
if (runDb) await ensureSchema();
const { persist } = await import('../services/musicVideo/projectsDB.js');
const { default: musicVideoRouter } = await import('./musicVideo.js');

const app = express();
app.use(express.json());
app.use('/api/music-video', musicVideoRouter);
app.use(errorMiddleware);

const ids = [];
let search;
async function seed(day, fields) {
  const id = `mv-${randomUUID()}`;
  const createdAt = `2026-01-${day}T00:00:00.000Z`;
  ids.push(id);
  await persist(query, { id, name: search, status: 'draft', scenes: [], createdAt, updatedAt: createdAt, ...fields });
  return id;
}

const mark = async (id, state, status = 200) => {
  const result = await request(app).put(`/api/music-video/${id}/completion`).send({ state });
  expect(result.status).toBe(status);
  return result.body;
};

async function page(statusFilter, cursor = '') {
  const query = new URLSearchParams({ summary: '1', q: search.toUpperCase(), statusFilter, limit: '1', cursor });
  const response = await request(app).get(`/api/music-video?${query}`);
  expect(response.status).toBe(200);
  return response.body;
}

afterAll(async () => {
  try {
    await close();
  } finally {
    await cleanup();
  }
});

describe.skipIf(!runDb)('PostgreSQL Music Video completion summaries', () => {
  beforeEach(() => {
    search = `Completion ${randomUUID()}`;
  });
  afterEach(async () => {
    if (!ids.length) return;
    await query('DELETE FROM music_video_projects WHERE id = ANY($1)', [ids]);
    ids.length = 0;
  });

  it('applies manual marks before searching and paginating, then falls back to automatic status on clear', async () => {
    const reopened = await seed('05', { status: 'complete', renderHistoryId: 'render-reopened' });
    const completed = await seed('04', { renderHistoryId: 'render-manual' });
    const noFinal = await seed('03', { completion: { state: 'complete', markedAt: '2026-01-03' } });
    const automatic = await seed('02', { status: 'complete', renderHistoryId: 'render-auto' });
    await seed('06', { name: 'Different title', status: 'complete', renderHistoryId: 'render-unmatched' });

    await mark(reopened, 'in-progress');
    await mark(completed, 'complete');
    expect(await mark(noFinal, 'complete', 409)).toMatchObject({ code: 'MUSIC_VIDEO_NO_FINAL_RENDER' });

    hydration.length = 0;
    expect(await page('in-progress')).toMatchObject({ items: [{ id: reopened, isCompleted: false }], total: 2, offset: 0, nextCursor: '1' });
    expect(await page('in-progress', '1')).toMatchObject({ items: [{ id: noFinal, isCompleted: false }], total: 2, offset: 1, nextCursor: null });
    expect(await page('completed')).toMatchObject({ items: [{ id: completed, isCompleted: true }], total: 2, offset: 0, nextCursor: '1' });
    expect(await page('completed', '1')).toMatchObject({ items: [{ id: automatic, isCompleted: true }], total: 2, offset: 1, nextCursor: null });
    expect(await page('completed', '2')).toMatchObject({ items: [], total: 2, offset: 2, nextCursor: null });
    expect(hydration).toEqual([[reopened], [noFinal], [completed], [automatic]]);

    await mark(reopened, 'auto');
    await mark(completed, 'auto');
    expect(await page('in-progress')).toMatchObject({ items: [{ id: completed, isCompleted: false }], total: 2, nextCursor: '1' });
    expect(await page('completed')).toMatchObject({ items: [{ id: reopened, isCompleted: true }], total: 2, nextCursor: '1' });
  });

  it('keeps stale automatic renders in progress when the director clears a complete mark', async () => {
    const stale = await seed('07', {
      status: 'complete',
      renderHistoryId: 'render-stale',
      uploadedAudioFilename: 'replacement.mp3',
      renderDependencies: captureMusicVideoEvidence({ uploadedAudioFilename: 'original.mp3' }),
    });

    expect(await page('in-progress')).toMatchObject({ items: [{ id: stale, isCompleted: false }] });
    await mark(stale, 'complete');
    expect(await page('completed')).toMatchObject({ items: [{ id: stale, isCompleted: true }] });
    await mark(stale, 'auto');
    expect(await page('in-progress')).toMatchObject({ items: [{ id: stale, isCompleted: false }] });
  });
});
