import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware, ServerError } from '../lib/errorHandler.js';

// Stub the registry + install service — this suite verifies routing +
// validation + status-code mapping for the #2124 add/manage endpoints, not the
// live HuggingFace fetch or on-disk registry write.
vi.mock('../lib/mediaModels.js', () => ({
  loadMediaModels: vi.fn(() => ({
    video: {
      macos: [
        { id: 'ltx23_distilled_q4', name: 'LTX-2.3 Q4', repo: 'notapalindrome/ltx23-mlx-av-q4', runtime: 'mlx_video', steps: 25, guidance: 3 },
        { id: 'hf-mine', name: 'Mine', repo: 'me/mine', runtime: 'ltx2', steps: 8, guidance: 3, source: 'user' },
      ],
      windows: [],
    },
    image: [
      { id: 'dev', name: 'Flux 1 Dev', runner: 'mflux', steps: 20, guidance: 3.5 },
    ],
  })),
  isUserModelEntry: (e) => e?.source === 'user',
  patchUserModelEntry: vi.fn((id, patch) => ({ id, ...patch, source: 'user' })),
  removeUserModelEntry: vi.fn((id) => ({ ok: true, id })),
}));

vi.mock('../lib/huggingfaceModel.js', () => ({
  ADDABLE_VIDEO_RUNTIMES: ['mlx_video', 'ltx2'],
  ADDABLE_IMAGE_RUNNERS: ['mflux', 'flux2', 'z-image', 'ernie', 'hidream', 'qwen'],
  searchHuggingfaceModels: vi.fn(async (query) => [{ id: `org/${query}`, likes: 1, downloads: 2, pipeline_tag: 'text-to-image' }]),
}));

vi.mock('../services/mediaModelInstall.js', () => ({
  addModelFromHuggingface: vi.fn(async (input) => ({
    entry: { id: 'hf-new', name: 'New', repo: 'org/new', runtime: 'mlx_video', source: 'user' },
    kind: 'video',
  })),
}));

// Avoid touching the real HF cache dir in GET / (not under test here).
vi.mock('../lib/fileUtils.js', async (orig) => {
  const actual = await orig();
  return { ...actual };
});

const { default: routes } = await import('./imageVideoModels.js');
const { addModelFromHuggingface } = await import('../services/mediaModelInstall.js');
const { patchUserModelEntry, removeUserModelEntry } = await import('../lib/mediaModels.js');

const makeApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/image-video/models', routes);
  app.use(errorMiddleware);
  return app;
};

beforeEach(() => { vi.clearAllMocks(); });

describe('GET /registry', () => {
  it('flattens video + image entries with a builtIn flag', async () => {
    const res = await request(makeApp()).get('/api/image-video/models/registry');
    expect(res.status).toBe(200);
    expect(res.body.video).toHaveLength(2);
    expect(res.body.image).toHaveLength(1);
    const builtIn = res.body.video.find((m) => m.id === 'ltx23_distilled_q4');
    const user = res.body.video.find((m) => m.id === 'hf-mine');
    expect(builtIn.builtIn).toBe(true);
    expect(user.builtIn).toBe(false);
  });
});

describe('GET /search', () => {
  it('returns mapped HF search rows', async () => {
    const res = await request(makeApp()).get('/api/image-video/models/search?query=ltx&pipeline=text-to-video');
    expect(res.status).toBe(200);
    expect(res.body.items[0].id).toBe('org/ltx');
  });
});

describe('POST /install/huggingface', () => {
  it('adds a model and returns 201 with the entry', async () => {
    const res = await request(makeApp())
      .post('/api/image-video/models/install/huggingface')
      .send({ url: 'org/new' });
    expect(res.status).toBe(201);
    expect(res.body.entry.id).toBe('hf-new');
    expect(addModelFromHuggingface).toHaveBeenCalledWith(expect.objectContaining({ url: 'org/new' }));
  });

  it('rejects a missing url with 400', async () => {
    const res = await request(makeApp())
      .post('/api/image-video/models/install/huggingface')
      .send({});
    expect(res.status).toBe(400);
  });

  it('rejects an out-of-enum runner override', async () => {
    const res = await request(makeApp())
      .post('/api/image-video/models/install/huggingface')
      .send({ url: 'org/x', runner: 'not-a-runner' });
    expect(res.status).toBe(400);
  });

  it('surfaces a typed classifier refusal (e.g. GGUF-only) with its status', async () => {
    addModelFromHuggingface.mockRejectedValueOnce(
      new ServerError('ships only GGUF', { status: 422, code: 'HF_UNSUPPORTED_FORMAT' }),
    );
    const res = await request(makeApp())
      .post('/api/image-video/models/install/huggingface')
      .send({ url: 'unsloth/LTX-2.3-GGUF' });
    expect(res.status).toBe(422);
    expect(res.body.code).toBe('HF_UNSUPPORTED_FORMAT');
  });
});

describe('PATCH /custom/:id', () => {
  it('patches a user model', async () => {
    const res = await request(makeApp())
      .patch('/api/image-video/models/custom/hf-mine')
      .send({ name: 'Renamed', steps: 10 });
    expect(res.status).toBe(200);
    expect(patchUserModelEntry).toHaveBeenCalledWith('hf-mine', expect.objectContaining({ name: 'Renamed', steps: 10 }));
  });
});

describe('DELETE /custom/:id', () => {
  it('removes a user model', async () => {
    const res = await request(makeApp()).delete('/api/image-video/models/custom/hf-mine');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, id: 'hf-mine' });
    expect(removeUserModelEntry).toHaveBeenCalledWith('hf-mine');
  });
});
