import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const claimMergeAdmission = vi.hoisted(() => vi.fn(async ({ outcome }) => ({ admitted: false, released: true, outcome })));
vi.mock('../services/cos.js', () => ({}));
vi.mock('../services/agentOrchestrator.js', () => ({}));
vi.mock('../services/cosMergeAdmission.js', async (importOriginal) => ({
  MERGE_ADMISSION_OUTCOMES: (await importOriginal()).MERGE_ADMISSION_OUTCOMES,
  claimMergeAdmission,
}));

import routes from './cosAgentRoutes.js';
import { MERGE_ADMISSION_OUTCOMES } from '../services/cosMergeAdmission.js';

const app = express();
app.use(express.json());
app.use('/api/cos', routes);
app.use(errorMiddleware);
const token = '00000000-0000-4000-8000-000000000000';
const releaseWith = (outcome) => request(app).post('/api/cos/merge-admission')
  .send({ agentId: 'parent-example', action: 'release', token, outcome });

describe('POST /api/cos/merge-admission outcomes', () => {
  it('accepts every service outcome, including resync, and rejects any other', async () => {
    expect(MERGE_ADMISSION_OUTCOMES).toEqual(['merged', 'leave-open', 'resync']);
    for (const outcome of MERGE_ADMISSION_OUTCOMES) {
      const res = await releaseWith(outcome);
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ released: true, outcome });
    }
    claimMergeAdmission.mockClear();
    expect((await releaseWith('abandoned')).status).toBe(400);
    expect(claimMergeAdmission).not.toHaveBeenCalled();
  });
});
