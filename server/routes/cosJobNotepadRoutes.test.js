/**
 * Job notepad routes (#17392) at the HTTP boundary with the real notepad service on the file backend.
 * Only the job lookup is mocked; cap enforcement, validation and 404s come from the real route + service.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { cleanupTempDataRoots, lazyTempDataRoot, makePathsProxy } from '../lib/mockPathsDataRoot.js';

vi.mock('../lib/fileUtils.js', async (importOriginal) => makePathsProxy(await importOriginal(), { dataRoot: () => lazyTempDataRoot('portos-job-notepad-routes-') }));
vi.mock('../services/cos/cosTaskStore.js', () => ({ addTask: vi.fn(), reviveBlockedTask: vi.fn() }));
vi.mock('../services/cos/cos.js', () => ({ forceSpawnTask: vi.fn() }));
vi.mock('../services/autonomousJobs.js', () => ({ getJob: vi.fn(async (id) => (id === 'job-1' ? { id } : null)) }));

const { default: jobRoutes } = await import('./cosJobRoutes.js');
const { clearJobNotes, resetJobNotepadStore } = await import('../services/autonomousJobs/notepad.js');
const { MAX_VALUE_BYTES } = await import('../lib/autonomousJobNotepad.js');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api/cos', jobRoutes);
app.use(errorMiddleware);

beforeEach(async () => {
  resetJobNotepadStore();
  await clearJobNotes('job-1');
});
afterAll(() => cleanupTempDataRoots());

describe('job notepad routes', () => {
  it('round-trips upsert, get, list with budget, and delete', async () => {
    const put = await request(app).put('/api/cos/jobs/job-1/notepad/last-pr').send({ value: '123' });
    expect(put.status).toBe(200);
    expect(put.body).toMatchObject({ usedBytes: 'last-pr'.length + 3, notes: [{ key: 'last-pr', value: '123' }] });
    expect(put.body.remainingBytes).toBe(put.body.maxBytes - put.body.usedBytes);

    expect((await request(app).get('/api/cos/jobs/job-1/notepad/last-pr')).body).toMatchObject({ key: 'last-pr', value: '123' });
    expect((await request(app).get('/api/cos/jobs/job-1/notepad')).body.notes).toHaveLength(1);

    const del = await request(app).delete('/api/cos/jobs/job-1/notepad/last-pr');
    expect(del.status).toBe(200);
    expect(del.body.notes).toEqual([]);
    expect((await request(app).delete('/api/cos/jobs/job-1/notepad/last-pr')).status).toBe(404);
  });

  it('clears every key', async () => {
    await request(app).put('/api/cos/jobs/job-1/notepad/a').send({ value: '1' });
    await request(app).put('/api/cos/jobs/job-1/notepad/b').send({ value: '2' });
    const res = await request(app).delete('/api/cos/jobs/job-1/notepad');
    expect(res.status).toBe(200);
    expect(res.body.notes).toEqual([]);
  });

  it('rejects bad keys, oversized values and total overflow with 400 without mutating state', async () => {
    expect((await request(app).put('/api/cos/jobs/job-1/notepad/bad%20key').send({ value: 'x' })).status).toBe(400);
    expect((await request(app).put(`/api/cos/jobs/job-1/notepad/${'k'.repeat(129)}`).send({ value: 'x' })).status).toBe(400);
    expect((await request(app).put('/api/cos/jobs/job-1/notepad/big').send({ value: 'x'.repeat(MAX_VALUE_BYTES + 1) })).status).toBe(400);
    expect((await request(app).put('/api/cos/jobs/job-1/notepad/num').send({ value: 5 })).status).toBe(400);
    for (let i = 0; i < 4; i += 1) await request(app).put(`/api/cos/jobs/job-1/notepad/k${i}`).send({ value: 'v'.repeat(MAX_VALUE_BYTES - 2) });
    const overflow = await request(app).put('/api/cos/jobs/job-1/notepad/k4').send({ value: 'x'.repeat(8) });
    expect(overflow.status).toBe(400);
    expect(overflow.body.code).toBe('VALIDATION_ERROR');
    expect((await request(app).get('/api/cos/jobs/job-1/notepad')).body.notes.map((n) => n.key)).toEqual(['k0', 'k1', 'k2', 'k3']);
  });

  it('404s for an unknown job and an absent key', async () => {
    expect((await request(app).get('/api/cos/jobs/missing/notepad')).status).toBe(404);
    expect((await request(app).put('/api/cos/jobs/missing/notepad/a').send({ value: 'x' })).status).toBe(404);
    expect((await request(app).get('/api/cos/jobs/job-1/notepad/absent')).status).toBe(404);
  });
});
