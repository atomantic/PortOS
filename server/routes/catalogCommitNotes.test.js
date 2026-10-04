/**
 * `POST /api/catalog/scraps/:id/commit` stamps the Brain notes a scrap was built
 * from as consumed in the SAME request (#9943), including when the request is a
 * replay of an already-committed operation key.
 *
 * Why the request, not a follow-up client call: the client used to mark the notes
 * after the commit response arrived, so a reload in between left them re-sendable
 * and a second ingest of the same notes duplicated the ingredients. The commit
 * receipt/idempotency half of this contract is covered against a real database in
 * catalog.test.js; this file needs none — the catalog DB layer and the brain store
 * are doubled so the only thing under test is the route's sequencing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const SCRAP = { id: 'scrap-example', rawText: 'Example source text.' };
const NOTE_A = '3f1c0c52-8d5e-4b8e-9d3c-111111111111';
const NOTE_B = '3f1c0c52-8d5e-4b8e-9d3c-222222222222';
const KEY = '9b2f6d1a-4c1e-4f0a-8c55-aaaaaaaaaaaa';
const CREATED = [{ id: 'ing-1', name: 'Example idea' }];

const { getScrap, getScrapCommitReceipt, commitScrap, markInboxSentToCatalog, embedBatch } = vi.hoisted(() => ({
  getScrap: vi.fn(),
  getScrapCommitReceipt: vi.fn(),
  commitScrap: vi.fn(),
  markInboxSentToCatalog: vi.fn(),
  embedBatch: vi.fn(),
}));

vi.mock('../services/catalogDB.js', async (importOriginal) => ({
  ...(await importOriginal()),
  getScrap, getScrapCommitReceipt, commitScrap,
}));
vi.mock('../services/embeddings.js', () => ({
  embedBatch,
  ingredientEmbedSeed: vi.fn((draft) => draft),
  embedIngredient: vi.fn(async () => ({})),
}));
vi.mock('../services/brain.js', () => ({ markInboxSentToCatalog }));

const router = (await import('./catalog.js')).default;
const app = express();
app.use(express.json());
app.use('/api/catalog', router);
app.use(errorMiddleware);

const accepted = [{ type: 'idea', name: 'Example idea' }];
const commit = (body) => request(app).post(`/api/catalog/scraps/${SCRAP.id}/commit`).send({ accepted, ...body });

beforeEach(() => {
  vi.clearAllMocks();
  getScrap.mockResolvedValue(SCRAP);
  getScrapCommitReceipt.mockResolvedValue(null);
  commitScrap.mockResolvedValue(CREATED);
  embedBatch.mockResolvedValue([{ embedding: null, model: null }]);
  markInboxSentToCatalog.mockResolvedValue([]);
});

describe('POST /api/catalog/scraps/:id/commit — source notes', () => {
  it('stamps the source notes consumed after the commit lands', async () => {
    const res = await commit({ operationKey: KEY, creativeNoteIds: [NOTE_A, NOTE_B] });

    expect(res.status).toBe(201);
    expect(res.body.ingredients).toEqual(CREATED);
    expect(markInboxSentToCatalog).toHaveBeenCalledWith([NOTE_A, NOTE_B]);
    expect(commitScrap.mock.invocationCallOrder[0]).toBeLessThan(markInboxSentToCatalog.mock.invocationCallOrder[0]);
    // The ids are bookkeeping about the source, not part of what is committed.
    expect(commitScrap.mock.calls[0][0]).not.toHaveProperty('creativeNoteIds');
  });

  it('still stamps them when the key replays an earlier commit, creating nothing new', async () => {
    getScrapCommitReceipt.mockResolvedValue(CREATED);

    const res = await commit({ operationKey: KEY, creativeNoteIds: [NOTE_A] });

    expect(res.status).toBe(201);
    expect(res.body.ingredients).toEqual(CREATED);
    expect(commitScrap).not.toHaveBeenCalled();
    expect(embedBatch).not.toHaveBeenCalled();
    expect(markInboxSentToCatalog).toHaveBeenCalledWith([NOTE_A]);
  });

  it('leaves the notes alone when the commit fails, so the retry can still consume them', async () => {
    commitScrap.mockRejectedValue(new Error('simulated commit failure'));

    const res = await commit({ operationKey: KEY, creativeNoteIds: [NOTE_A] });

    expect(res.status).toBe(500);
    expect(markInboxSentToCatalog).not.toHaveBeenCalled();
  });

  it('fails the request when the stamp fails, and the same-key retry replays and stamps again', async () => {
    markInboxSentToCatalog.mockRejectedValueOnce(new Error('simulated brain store failure'));
    const failed = await commit({ operationKey: KEY, creativeNoteIds: [NOTE_A] });
    expect(failed.status).toBe(500);

    getScrapCommitReceipt.mockResolvedValue(CREATED);
    const retried = await commit({ operationKey: KEY, creativeNoteIds: [NOTE_A] });

    expect(retried.status).toBe(201);
    expect(commitScrap).toHaveBeenCalledTimes(1);
    expect(markInboxSentToCatalog).toHaveBeenCalledTimes(2);
  });

  it('does not touch the Brain store for a commit with no source notes', async () => {
    const res = await commit({ operationKey: KEY });

    expect(res.status).toBe(201);
    expect(markInboxSentToCatalog).not.toHaveBeenCalled();
  });

  it('rejects malformed note ids before anything is committed', async () => {
    const res = await commit({ creativeNoteIds: ['not-a-guid'] });

    expect(res.status).toBe(400);
    expect(commitScrap).not.toHaveBeenCalled();
    expect(markInboxSentToCatalog).not.toHaveBeenCalled();
  });
});
