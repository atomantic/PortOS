import { describe, it, expect, vi } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

// Stub the Civitai-backed services — we only verify routing + validation for
// the new /search endpoint here, not the live Civitai call.
vi.mock('../services/loras.js', () => ({
  deleteLora: vi.fn(),
  getLora: vi.fn(),
  installFromCivitai: vi.fn(),
  listLoras: vi.fn(async () => []),
  patchLoraSidecar: vi.fn(),
  resolveCivitaiKey: vi.fn(async () => null),
}));
vi.mock('../services/civitaiSuggestions.js', () => ({
  getSuggestions: vi.fn(async () => ({ curated: [], runners: {}, fetchedAt: 'now' })),
  searchLorasInFamily: vi.fn(async ({ runnerFamily, query, cursor, limit }) => ({
    runnerFamily,
    query: query || '',
    items: [{ modelId: 1, versionId: 10, name: 'Match' }],
    nextCursor: 'NEXT',
    _echo: { cursor, limit },
  })),
}));
vi.mock('../services/videoLoraSuggestions.js', () => ({
  getVideoSuggestions: vi.fn(async () => ([
    { source: 'huggingface', repo: 'fal/ltx2.3-audio-reactive-lora', name: 'LTX', runnerFamily: 'ltx-video' },
  ])),
}));
vi.mock('../services/settings.js', () => ({
  getSettings: vi.fn(async () => ({})),
  updateSettingsWith: vi.fn(async () => ({})),
}));

const { default: lorasRoutes } = await import('./loras.js');
const { searchLorasInFamily } = await import('../services/civitaiSuggestions.js');

const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/loras', lorasRoutes);
  app.use(errorMiddleware);
  return app;
};

describe('GET /api/loras/search', () => {
  it('dispatches a valid runner + keyword + cursor to the service', async () => {
    const res = await request(makeApp())
      .get('/api/loras/search?runner=z-image&query=cyberpunk&cursor=CUR&limit=20');
    expect(res.status).toBe(200);
    expect(res.body.items.length).toBe(1);
    expect(res.body.nextCursor).toBe('NEXT');
    expect(searchLorasInFamily).toHaveBeenCalledWith({
      runnerFamily: 'z-image',
      query: 'cyberpunk',
      cursor: 'CUR',
      limit: 20,
    });
  });

  it('treats a blank keyword as a top-ranking page (no query)', async () => {
    const res = await request(makeApp())
      .get('/api/loras/search?runner=mflux&query=');
    expect(res.status).toBe(200);
    expect(searchLorasInFamily).toHaveBeenCalledWith({
      runnerFamily: 'mflux',
      query: '',
      cursor: null,
      limit: 12,
    });
  });

  it('rejects an unknown runner family with 400', async () => {
    const res = await request(makeApp())
      .get('/api/loras/search?runner=sdxl');
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('VALIDATION_ERROR');
  });

  it('rejects an over-long keyword with 400', async () => {
    const res = await request(makeApp())
      .get(`/api/loras/search?runner=qwen&query=${'x'.repeat(121)}`);
    expect(res.status).toBe(400);
  });

  it('rejects an out-of-range limit (> 50) with 400', async () => {
    const res = await request(makeApp())
      .get('/api/loras/search?runner=qwen&limit=999');
    expect(res.status).toBe(400);
  });
});

describe('GET /api/loras/suggestions', () => {
  it('merges the curated video LoRAs into the Civitai suggestion payload', async () => {
    const res = await request(makeApp()).get('/api/loras/suggestions');
    expect(res.status).toBe(200);
    // Civitai shape preserved …
    expect(res.body).toHaveProperty('curated');
    expect(res.body).toHaveProperty('runners');
    // … plus the merged video section.
    expect(Array.isArray(res.body.video)).toBe(true);
    expect(res.body.video[0].runnerFamily).toBe('ltx-video');
    expect(res.body.video[0].repo).toBe('fal/ltx2.3-audio-reactive-lora');
  });
});
