import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

vi.mock('../services/imageVerifier.js', () => ({
  getVerifierSettings: vi.fn(async () => ({
    enabledForGeneration: true,
    enabledForImport: false,
    defaultProfileId: 'strict_anatomy',
    maxRerolls: 2,
    customProfiles: [],
  })),
  updateVerifierSettings: vi.fn(async (updates) => ({
    enabledForGeneration: updates.enabledForGeneration ?? true,
    enabledForImport: updates.enabledForImport ?? false,
    defaultProfileId: updates.defaultProfileId ?? 'strict_anatomy',
    maxRerolls: updates.maxRerolls ?? 2,
    customProfiles: [],
  })),
  getVerificationProfiles: vi.fn(async () => ({
    strict_anatomy: { id: 'strict_anatomy', name: 'Strict Anatomy' },
  })),
  getVerificationProfile: vi.fn(async (id) => ({
    id,
    name: 'Strict Anatomy',
  })),
  saveCustomProfile: vi.fn(async (profile) => profile),
  deleteCustomProfile: vi.fn(async (id) => ({ deleted: true, id })),
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

  it('GET /api/image-verifier/settings returns settings', async () => {
    const res = await request(app).get('/api/image-verifier/settings');
    expect(res.status).toBe(200);
    expect(res.body.enabledForGeneration).toBe(true);
    expect(res.body.defaultProfileId).toBe('strict_anatomy');
  });

  it('PUT /api/image-verifier/settings updates settings', async () => {
    const res = await request(app)
      .put('/api/image-verifier/settings')
      .send({ enabledForImport: true, maxRerolls: 3 });
    expect(res.status).toBe(200);
    expect(res.body.enabledForImport).toBe(true);
    expect(res.body.maxRerolls).toBe(3);
  });

  it('GET /api/image-verifier/profiles returns profile map', async () => {
    const res = await request(app).get('/api/image-verifier/profiles');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('strict_anatomy');
  });

  it('POST /api/image-verifier/profiles creates a custom profile', async () => {
    const profile = {
      id: 'custom_test',
      name: 'Custom Test',
      dimensions: {
        hands_and_fingers: { enabled: true, severity: 'critical' },
      },
    };
    const res = await request(app)
      .post('/api/image-verifier/profiles')
      .send(profile);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe('custom_test');
  });

  it('DELETE /api/image-verifier/profiles/:id deletes custom profile', async () => {
    const res = await request(app).delete('/api/image-verifier/profiles/custom_test');
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
  });

  it('POST /api/image-verifier/verify triggers verification', async () => {
    const res = await request(app)
      .post('/api/image-verifier/verify')
      .send({ filename: 'test.png', profileId: 'strict_anatomy' });
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
