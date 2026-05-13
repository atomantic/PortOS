import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';

const fileStore = new Map();

vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { data: '/mock/data' },
  ensureDir: vi.fn().mockResolvedValue(undefined),
  atomicWrite: vi.fn(async (path, data) => { fileStore.set(path, data); }),
  readJSONFile: vi.fn(async (path, fallback) => (fileStore.has(path) ? fileStore.get(path) : fallback)),
}));

let uuidCounter = 0;
vi.mock('crypto', async () => {
  const actual = await vi.importActual('crypto');
  return { ...actual, randomUUID: () => `uuid-${++uuidCounter}` };
});

// Stub the LLM expander so the route test doesn't shell out to a real provider.
vi.mock('../services/worldBuilderExpand.js', () => ({
  expandWorldTemplate: vi.fn(async ({ starterPrompt }) => ({
    stylePrompt: 'mocked style for ' + starterPrompt,
    negativePrompt: 'blurry',
    categories: {
      landscapes: { variations: [{ label: 'Mock Land', prompt: 'mocked landscape' }] },
      environments: { variations: [] },
      characters: { variations: [{ label: 'Mock Char', prompt: 'mocked character' }] },
      structures: { variations: [] },
      vehicles: { variations: [] },
    },
    compositeSheets: [
      { kind: 'reference_sheet', label: 'Mock costume sheet', prompt: 'mocked complete costume reference sheet with lineup, materials, fasteners, palette' },
      { kind: 'world_pitch_poster', label: 'Mock world pitch poster', prompt: 'mocked world summary concept pitch poster with hero panorama, inset cultures, palette, materials, and theme icons' },
    ],
    llm: { provider: 'anthropic', model: 'claude' },
  })),
}));

// Skip provisioning real settings — we only exercise CRUD + expand here.
vi.mock('../services/settings.js', () => ({
  getSettings: vi.fn(async () => ({ imageGen: { mode: 'local', local: { pythonPath: '/usr/bin/python3' } } })),
  saveSettings: vi.fn(),
}));

vi.mock('../services/mediaJobQueue/index.js', () => ({
  enqueueJob: vi.fn(({ params }) => ({ jobId: `job-${++uuidCounter}`, position: 1, status: 'queued', params })),
}));

// Tiny in-memory store so repeat-render tests can verify the new
// find-or-create semantics (existing name → same collection id).
const collectionsByName = new Map();
const mockCreateRec = (name) => {
  const id = `col-${collectionsByName.size + 1}`;
  const rec = { id, name, items: [] };
  collectionsByName.set(name.toLowerCase(), rec);
  return rec;
};
vi.mock('../services/mediaCollections.js', () => ({
  createCollection: vi.fn(async ({ name }) => mockCreateRec(name)),
  findOrCreateCollectionByName: vi.fn(async ({ name }) => {
    return collectionsByName.get(name.toLowerCase()) ?? mockCreateRec(name);
  }),
  addItem: vi.fn(),
  ERR_DUPLICATE: 'DUPLICATE',
  NAME_MAX_LENGTH: 80,
}));

vi.mock('../lib/mediaModels.js', () => ({
  getImageModels: () => [{ id: 'dev', label: 'mflux dev' }],
  isFlux2: () => false,
  isZImage: () => false,
  isErnie: () => false,
}));

const worldBuilderRoutes = (await import('./worldBuilder.js')).default;

const buildApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/world-builder', worldBuilderRoutes);
  app.use(errorMiddleware);
  return app;
};

describe('world-builder routes', () => {
  beforeEach(() => {
    fileStore.clear();
    uuidCounter = 0;
    collectionsByName.clear();
  });

  it('GET / returns []', async () => {
    const res = await request(buildApp()).get('/api/world-builder');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('POST / creates a world', async () => {
    const res = await request(buildApp())
      .post('/api/world-builder')
      .send({ name: 'My World', starterPrompt: 'cyber forest' });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe('uuid-1');
    expect(res.body.name).toBe('My World');
    // All five categories populated even when not supplied.
    expect(Object.keys(res.body.categories).sort()).toEqual(
      ['characters', 'environments', 'landscapes', 'structures', 'vehicles'],
    );
  });

  it('POST / accepts dynamic world-building categories', async () => {
    const res = await request(buildApp())
      .post('/api/world-builder')
      .send({
        name: 'Colonies',
        categories: {
          colonies: { variations: [{ label: 'Canopy Symbiotes', prompt: 'leaf fiber outfit reference sheet' }] },
          raider_clans: { variations: [{ label: 'Wake Jackals', prompt: 'simple scavenger pirate kit' }] },
        },
      });
    expect(res.status).toBe(201);
    expect(res.body.categories.colonies.variations).toHaveLength(1);
    expect(res.body.categories.raider_clans.variations[0].label).toBe('Wake Jackals');
  });

  it('POST / accepts composite sheet prompts', async () => {
    const res = await request(buildApp())
      .post('/api/world-builder')
      .send({
        name: 'Sheets',
        compositeSheets: [
          { label: 'Gas-Giant Drifters sheet', prompt: 'Create a clean illustrated costume reference sheet with five figures, material swatches, fasteners, accessories, and palette strip.' },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.compositeSheets).toHaveLength(1);
    expect(res.body.compositeSheets[0].kind).toBe('reference_sheet');
    expect(res.body.compositeSheets[0].label).toBe('Gas-Giant Drifters sheet');
  });

  it('POST / accepts world pitch poster composite prompts', async () => {
    const res = await request(buildApp())
      .post('/api/world-builder')
      .send({
        name: 'Pitch Posters',
        compositeSheets: [
          { kind: 'world_pitch_poster', label: 'World summary concept pitch poster', prompt: 'Create a cinematic world summary concept pitch poster with hero panorama, inset environments, cultures, creatures, visual language strip, color palette, materials, light atmosphere, and theme icons.' },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.compositeSheets).toHaveLength(1);
    expect(res.body.compositeSheets[0].kind).toBe('world_pitch_poster');
  });

  it('POST / rejects missing name', async () => {
    const res = await request(buildApp())
      .post('/api/world-builder')
      .send({ starterPrompt: 'cyber forest' });
    expect(res.status).toBe(400);
  });

  it('PATCH /:id updates fields', async () => {
    const app = buildApp();
    const c = await request(app).post('/api/world-builder').send({ name: 'A' });
    const res = await request(app)
      .patch(`/api/world-builder/${c.body.id}`)
      .send({ name: 'B', stylePrompt: 'oil painting' });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('B');
    expect(res.body.stylePrompt).toBe('oil painting');
  });

  it('DELETE /:id removes the world', async () => {
    const app = buildApp();
    const c = await request(app).post('/api/world-builder').send({ name: 'A' });
    const del = await request(app).delete(`/api/world-builder/${c.body.id}`);
    expect(del.status).toBe(200);
    const list = await request(app).get('/api/world-builder');
    expect(list.body).toEqual([]);
  });

  it('POST /expand returns LLM expansion', async () => {
    const res = await request(buildApp())
      .post('/api/world-builder/expand')
      .send({ starterPrompt: 'moebius scifi' });
    expect(res.status).toBe(200);
    expect(res.body.stylePrompt).toContain('moebius scifi');
    expect(res.body.categories.landscapes.variations).toHaveLength(1);
    expect(res.body.compositeSheets).toHaveLength(2);
    expect(res.body.llm.provider).toBe('anthropic');
  });

  it('POST /:id/render queues image jobs and records run', async () => {
    const app = buildApp();
    const created = await request(app).post('/api/world-builder').send({
      name: 'Render Test',
      stylePrompt: 'style',
      negativePrompt: 'neg',
      categories: {
        landscapes: { variations: [{ label: 'A', prompt: 'a prompt' }, { label: 'B', prompt: 'b prompt' }] },
        characters: { variations: [{ label: 'C', prompt: 'c prompt' }] },
      },
    });
    const res = await request(app)
      .post(`/api/world-builder/${created.body.id}/render`)
      .send({ batchPerVariation: 2, mode: 'local' });
    expect(res.status).toBe(200);
    expect(res.body.promptCount).toBe(6); // 3 variations × 2 batch
    expect(res.body.jobIds).toHaveLength(6);
    expect(res.body.collectionId).toBe('col-1');
    // Run is recorded.
    const runs = await request(app).get(`/api/world-builder/${created.body.id}/runs`);
    expect(runs.body).toHaveLength(1);
    expect(runs.body[0].promptCount).toBe(6);
  });

  it('POST /:id/render queues custom category prompts', async () => {
    const app = buildApp();
    const created = await request(app).post('/api/world-builder').send({
      name: 'Clothing',
      stylePrompt: 'moebius, clean reference sheet',
      categories: {
        clothing_styles: { variations: [{ label: 'Gas-Giant Drifters', prompt: 'buckles, clips, pressure rings' }] },
      },
    });
    const res = await request(app)
      .post(`/api/world-builder/${created.body.id}/render`)
      .send({ mode: 'local', selection: { clothing_styles: 'all' } });
    expect(res.status).toBe(200);
    expect(res.body.promptCount).toBe(1);
    expect(res.body.jobIds).toHaveLength(1);
  });

  it('POST /:id/render queues composite sheet prompts', async () => {
    const app = buildApp();
    const created = await request(app).post('/api/world-builder').send({
      name: 'Composite Clothing',
      stylePrompt: 'moebius, clean reference sheet',
      compositeSheets: [
        { label: 'Gas-Giant Drifters sheet', prompt: 'complete costume reference sheet, five figures, material swatches, pressure rings, palette strip' },
      ],
    });
    const res = await request(app)
      .post(`/api/world-builder/${created.body.id}/render`)
      .send({ mode: 'local', promptMode: 'sheets' });
    expect(res.status).toBe(200);
    expect(res.body.promptCount).toBe(1);
    expect(res.body.jobIds).toHaveLength(1);
  });

  it('POST /:id/render reuses the same collection on repeat renders of the same world', async () => {
    const app = buildApp();
    const created = await request(app).post('/api/world-builder').send({
      name: 'Repeat World',
      categories: {
        landscapes: { variations: [{ label: 'A', prompt: 'a' }] },
      },
    });
    const first = await request(app)
      .post(`/api/world-builder/${created.body.id}/render`)
      .send({ mode: 'local' });
    expect(first.status).toBe(200);
    const second = await request(app)
      .post(`/api/world-builder/${created.body.id}/render`)
      .send({ mode: 'local' });
    expect(second.status).toBe(200);
    expect(second.body.collectionId).toBe(first.body.collectionId);
    // The auto-generated name has no date suffix — bare `World: <name>`.
    expect(second.body.collectionName).toBe('World: Repeat World');
    expect(second.body.collectionName).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('POST /:id/render reuses an existing collection when collectionName matches', async () => {
    const app = buildApp();
    const created = await request(app).post('/api/world-builder').send({
      name: 'Custom Bucket World',
      categories: {
        landscapes: { variations: [{ label: 'A', prompt: 'a' }] },
      },
    });
    const first = await request(app)
      .post(`/api/world-builder/${created.body.id}/render`)
      .send({ mode: 'local', collectionName: 'Shared Bucket' });
    const second = await request(app)
      .post(`/api/world-builder/${created.body.id}/render`)
      .send({ mode: 'local', collectionName: '  shared bucket  ' });
    expect(second.body.collectionId).toBe(first.body.collectionId);
  });

  it('POST /:id/render rejects when no variations exist', async () => {
    const app = buildApp();
    const created = await request(app).post('/api/world-builder').send({ name: 'Empty' });
    const res = await request(app)
      .post(`/api/world-builder/${created.body.id}/render`)
      .send({ mode: 'local' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('WORLD_BUILDER_EMPTY');
  });
});
