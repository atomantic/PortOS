import { describe, it, expect, vi, } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/imageVerifier.js', () => ({
  verifyImage: vi.fn(async (params) => ({
    verdict: 'pass',
    summary: 'Passed all checks',
    defects: [],
    profileId: params.profileId || 'strict_anatomy',
  })),
  overrideVerification: vi.fn(async (params) => ({
    verdict: params.verdict,
    overridden: true,
    overrideNotes: params.notes,
  })),
}));

import imageVerifierRoutes from './imageVerifier.js';

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/image-verifier', imageVerifierRoutes);
  app.use(errorMiddleware);
  return app;
};

describe('imageVerifier routes', () => {
  const app = buildApp();

  it('POST /api/image-verifier/verify triggers verification', async () => {
    const res = await request(app)
      .post('/api/image-verifier/verify')
      .send({ filename: 'test.png', profileId: 'strict_anatomy' });
    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe('pass');
  });

  it.each([
    ['get', '/settings'], ['put', '/settings'], ['get', '/profiles'], ['post', '/profiles'],
    ['get', '/profiles/strict_anatomy'], ['delete', '/profiles/custom_test'], ['get', '/models'],
  ])('no longer serves %s %s', async (method, path) => {
    expect((await request(app)[method](`/api/image-verifier${path}`)).status).toBe(404);
  });

  it('POST /api/image-verifier/verify triggers verification with reviewerModel', async () => {
    const res = await request(app)
      .post('/api/image-verifier/verify')
      .send({ filename: 'test.png', profileId: 'strict_anatomy', reviewerModel: 'gemini-4-argon' });
    expect(res.status).toBe(200);
    expect(res.body.verdict).toBe('pass');
  });

  it('POST /api/image-verifier/override records operator override', async () => {
    const res = await request(app)
      .post('/api/image-verifier/override')
      .send({ filename: 'test.png', verdict: 'pass', notes: 'Manual operator signoff' });
    expect(res.status).toBe(200);
    expect(res.body.overridden).toBe(true);
    expect(res.body.verdict).toBe('pass');
  });
});
