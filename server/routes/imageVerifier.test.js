import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { closeLoopbackServer, request, startLoopbackServer, waitForAbort } from '../lib/testHelper.js';
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
import { verifyImage } from '../services/imageVerifier.js';

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

  it('aborts verification when the client disconnects after sending the JSON body', async () => {
    const started = Promise.withResolvers();
    const canceled = Promise.withResolvers();
    verifyImage.mockImplementationOnce(async ({ signal }) => {
      started.resolve(signal);
      await waitForAbort(signal);
      canceled.resolve();
      signal.throwIfAborted();
    });
    const server = await startLoopbackServer(app);
    const client = new AbortController();
    const response = fetch(`http://127.0.0.1:${server.address().port}/api/image-verifier/verify`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ filename: 'test.png' }),
      signal: client.signal,
    }).catch((error) => error);
    try {
      const signal = await started.promise;
      expect(signal.aborted).toBe(false);
      client.abort();
      expect(await response).toMatchObject({ name: 'AbortError' });
      await canceled.promise;
      expect(signal.aborted).toBe(true);
    } finally {
      client.abort();
      await closeLoopbackServer(server);
    }
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
