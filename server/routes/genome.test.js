import { beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/genome.js', () => ({
  deleteGenome: vi.fn(async () => undefined),
}));

vi.mock('../services/clinvar.js', () => ({
  deleteClinvar: vi.fn(async () => undefined),
}));

vi.mock('../services/epigenetic.js', () => ({
  logEntry: vi.fn(async () => ({
    id: 'log-1',
    date: '2026-09-11',
    amount: 5,
    unit: 'mg',
    notes: '',
    loggedAt: '2026-09-11T12:00:00.000Z',
  })),
}));

const { deleteGenome } = await import('../services/genome.js');
const { deleteClinvar } = await import('../services/clinvar.js');
const { logEntry } = await import('../services/epigenetic.js');
const { default: genomeRoutes } = await import('./genome.js');

const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/meatspace/genome', genomeRoutes);
  app.use(errorMiddleware);
  return app;
};

describe('genome deletion routes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('deletes both the uploaded genome and ClinVar data before returning 204', async () => {
    const response = await request(makeApp()).delete('/api/meatspace/genome');

    expect(response.status).toBe(204);
    expect(response.text).toBe('');
    expect(deleteGenome).toHaveBeenCalledOnce();
    expect(deleteClinvar).toHaveBeenCalledOnce();
    expect(deleteGenome.mock.invocationCallOrder[0]).toBeLessThan(deleteClinvar.mock.invocationCallOrder[0]);
  });

  it('deletes only ClinVar data from the scoped endpoint', async () => {
    const response = await request(makeApp()).delete('/api/meatspace/genome/clinvar');

    expect(response.status).toBe(204);
    expect(response.text).toBe('');
    expect(deleteClinvar).toHaveBeenCalledOnce();
    expect(deleteGenome).not.toHaveBeenCalled();
  });
});

describe('POST /api/meatspace/genome/epigenetic/:id/log', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('validates and forwards a log entry to the requested intervention', async () => {
    const response = await request(makeApp())
      .post('/api/meatspace/genome/epigenetic/vitamin-d/log')
      .send({ amount: 5, date: '2026-09-11', notes: 'with breakfast' });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({ id: 'log-1', amount: 5, date: '2026-09-11' });
    expect(logEntry).toHaveBeenCalledWith('vitamin-d', {
      amount: 5,
      date: '2026-09-11',
      notes: 'with breakfast',
    });
  });

  it('returns the route error contract when the intervention is missing', async () => {
    logEntry.mockResolvedValueOnce({ error: 'Intervention not found' });

    const response = await request(makeApp())
      .post('/api/meatspace/genome/epigenetic/missing/log')
      .send({ amount: 1 });

    expect(response.status).toBe(404);
    expect(response.body).toMatchObject({
      error: 'Intervention not found',
      code: 'INTERVENTION_NOT_FOUND',
    });
  });
});
