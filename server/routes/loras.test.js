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
  installFromHuggingface: vi.fn(async (_input, { onProgress } = {}) => {
    onProgress?.({ received: 4, total: 8 });
    onProgress?.({ received: 8, total: 8 });
    return { filename: 'lora-x-hf.safetensors', name: 'X', runnerFamily: 'ltx-video' };
  }),
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
const { installFromHuggingface, listLoras } = await import('../services/loras.js');

// Parse an SSE response body into an array of decoded frame objects.
const parseSseFrames = (text) => text
  .split('\n\n')
  .filter((b) => b.startsWith('data: '))
  .map((b) => JSON.parse(b.slice('data: '.length)));

const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/loras', lorasRoutes);
  app.use(errorMiddleware);
  return app;
};

describe('GET /api/loras', () => {
  it('returns the full LoRA array by default', async () => {
    listLoras.mockResolvedValueOnce([{ filename: 'a.safetensors' }]);
    const res = await request(makeApp()).get('/api/loras');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(1);
  });

  it('returns a bounded envelope when pagination is requested', async () => {
    listLoras.mockResolvedValueOnce(
      Array.from({ length: 5 }, (_, i) => ({ filename: `l${i}.safetensors` }))
    );
    const res = await request(makeApp()).get('/api/loras?limit=2&offset=1');
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
    expect(res.body.items[0].filename).toBe('l1.safetensors');
    expect(res.body.total).toBe(5);
    expect(res.body.limit).toBe(2);
    expect(res.body.offset).toBe(1);
  });
});

describe('POST /api/loras/install/huggingface/stream', () => {
  it('streams byte-progress frames then a complete frame carrying the sidecar', async () => {
    const res = await request(makeApp())
      .post('/api/loras/install/huggingface/stream')
      .send({ url: 'fal/ltx2.3-audio-reactive-lora' });
    expect(res.status).toBe(200);
    const frames = parseSseFrames(res.text);
    // The service double emitted 4/8 then 8/8 → progress 0.5 then 1.
    expect(frames.filter((f) => f.type === 'progress').map((f) => f.progress)).toEqual([0.5, 1]);
    const complete = frames.find((f) => f.type === 'complete');
    expect(complete?.sidecar?.runnerFamily).toBe('ltx-video');
    // The body carries through to the service, with an AbortSignal + progress cb.
    expect(installFromHuggingface).toHaveBeenCalledWith(
      expect.objectContaining({ url: 'fal/ltx2.3-audio-reactive-lora' }),
      expect.objectContaining({ onProgress: expect.any(Function), signal: expect.any(Object) }),
    );
  });

  it('forwards an install failure as an SSE error frame (not a thrown 500)', async () => {
    installFromHuggingface.mockRejectedValueOnce(
      Object.assign(new Error('could not classify'), { code: 'HF_UNKNOWN_FAMILY' }),
    );
    const res = await request(makeApp())
      .post('/api/loras/install/huggingface/stream')
      .send({ url: 'someone/mystery' });
    expect(res.status).toBe(200); // headers already flushed — error is a frame, not a status
    const err = parseSseFrames(res.text).find((f) => f.type === 'error');
    expect(err.code).toBe('HF_UNKNOWN_FAMILY');
    expect(err.message).toBe('could not classify');
  });

  it('rejects an invalid family override before opening the stream', async () => {
    const res = await request(makeApp())
      .post('/api/loras/install/huggingface/stream')
      .send({ url: 'x/y', family: 'bogus' });
    expect(res.status).toBe(400);
  });
});

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
