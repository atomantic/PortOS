import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';

// In-memory settings store backing the mocked service.
let store = {};

vi.mock('../services/settings.js', () => ({
  getSettings: vi.fn(async () => ({ ...store })),
  updateSettings: vi.fn(async (patch) => {
    store = { ...store, ...patch };
    return { ...store };
  }),
  // The PUT handler uses updateSettingsWith so it can re-inject persisted
  // write-only tokens omitted by the patch (see preserveWriteOnlyTokens).
  updateSettingsWith: vi.fn(async (mutate) => {
    store = await mutate({ ...store });
    return { ...store };
  }),
}));
vi.mock('../services/aiAssignments.js', () => ({
  getAiAssignments: vi.fn(async () => ({})),
  updateAiAssignment: vi.fn(async () => ({})),
}));
vi.mock('../services/mediaJobQueue/index.js', () => ({
  setCodexParallelLimit: vi.fn(),
  CODEX_PARALLEL_MIN: 1,
  CODEX_PARALLEL_MAX: 8,
  CODEX_PARALLEL_DEFAULT: 2,
}));

import settingsRoutes from './settings.js';

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/settings', settingsRoutes);
  return app;
};

describe('Settings routes — apiAccess slice', () => {
  beforeEach(() => {
    store = {};
    vi.clearAllMocks();
  });

  it('accepts a valid apiAccess patch and persists it', async () => {
    const res = await request(buildApp())
      .put('/api/settings')
      .send({ apiAccess: { voice: { exposed: true, requireAuth: false } } });
    expect(res.status).toBe(200);
    expect(res.body.apiAccess.voice.exposed).toBe(true);
  });

  it('rejects a non-boolean exposed flag', async () => {
    const res = await request(buildApp())
      .put('/api/settings')
      .send({ apiAccess: { voice: { exposed: 'yes' } } });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects unknown keys inside an apiAccess entry (strict)', async () => {
    const res = await request(buildApp())
      .put('/api/settings')
      .send({ apiAccess: { voice: { open: true } } });
    expect(res.status).toBe(400);
  });

  it('rejects an unknown API id (strict)', async () => {
    const res = await request(buildApp())
      .put('/api/settings')
      .send({ apiAccess: { elevenlabs: { exposed: true } } });
    expect(res.status).toBe(400);
  });

  it('GET returns apiAccess (not stripped like secrets)', async () => {
    store = { apiAccess: { sdapi: { exposed: true, requireAuth: false } } };
    const res = await request(buildApp()).get('/api/settings');
    expect(res.status).toBe(200);
    expect(res.body.apiAccess.sdapi.exposed).toBe(true);
  });
});

describe('Settings routes — imageGen.grok slice (#2859)', () => {
  beforeEach(() => {
    store = {};
    vi.clearAllMocks();
  });

  it('accepts a valid grok slice and persists it', async () => {
    const res = await request(buildApp())
      .put('/api/settings')
      .send({ imageGen: { grok: { enabled: true, grokPath: '/usr/local/bin/grok', aspectRatio: '16:9' } } });
    expect(res.status).toBe(200);
    expect(res.body.imageGen.grok.enabled).toBe(true);
    expect(res.body.imageGen.grok.aspectRatio).toBe('16:9');
  });

  it('accepts empty-string UI sentinels for path and ratio', async () => {
    const res = await request(buildApp())
      .put('/api/settings')
      .send({ imageGen: { grok: { enabled: false, grokPath: '', aspectRatio: '' } } });
    expect(res.status).toBe(200);
  });

  it('rejects a malformed aspect ratio (would land verbatim in the grok prompt)', async () => {
    const res = await request(buildApp())
      .put('/api/settings')
      .send({ imageGen: { grok: { aspectRatio: '16:9; rm -rf /' } } });
    expect(res.status).toBe(400);
  });

  it('rejects a non-boolean enabled gate', async () => {
    const res = await request(buildApp())
      .put('/api/settings')
      .send({ imageGen: { grok: { enabled: 'yes' } } });
    expect(res.status).toBe(400);
  });

  it('leaves an imageGen patch without a grok key unvalidated (polymorphic parent)', async () => {
    const res = await request(buildApp())
      .put('/api/settings')
      .send({ imageGen: { mode: 'local' } });
    expect(res.status).toBe(200);
  });
});
