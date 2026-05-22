import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import { request } from '../lib/testHelper.js';
import { errorMiddleware } from '../lib/errorHandler.js';
import { enqueueJob } from '../services/mediaJobQueue/index.js';

const fileStore = new Map();

vi.mock('../lib/fileUtils.js', () => ({
tryReadFile: vi.fn().mockResolvedValue(null),
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

// Stub the LLM promote service so route tests don't shell out to a provider.
// Default mock just echoes back a minimal canon entry shape so the route
// returns 200 and the schema/validation paths get exercised end-to-end.
const promoteVariationToCanonMock = vi.fn(async (_universeId, body = {}) => ({
  universe: { id: _universeId, characters: [], places: [], objects: [] },
  entry: { id: 'mock-entry', name: body.label },
  targetKind: body.targetKind || 'characters',
  removed: { category: body.category, label: body.label },
  runId: 'mock-run',
  llm: { provider: 'mock', model: null },
}));
vi.mock('../services/universeBuilderPromote.js', async () => {
  // Pass the real VALID_TARGET_KINDS through so the route's Zod enum
  // can't drift from the source-of-truth list (derived from BIBLE_FIELD).
  const actual = await vi.importActual('../services/universeBuilderPromote.js');
  return {
    ...actual,
    promoteVariationToCanon: (...args) => promoteVariationToCanonMock(...args),
  };
});

// Stub the auto-sort service — same shape as promote, just returns a mock
// classification batch so the route's Zod schema + error mapping are
// exercised without shelling out to a real LLM.
const autoSortOtherBucketsMock = vi.fn(async (universeId, body = {}) => ({
  universe: { id: universeId, categories: {} },
  results: [{ sourceKey: 'colonies', kind: 'places', suggestedKey: null }],
  llm: { provider: 'mock', model: body.model || null },
  runId: 'mock-autosort-run',
}));
vi.mock('../services/universeBuilderAutoSort.js', () => ({
  autoSortOtherBuckets: (...args) => autoSortOtherBucketsMock(...args),
}));

// Stub the character-expand LLM call.
const expandUniverseCharacterMock = vi.fn(async (universeId, entryId) => ({
  universe: { id: universeId, characters: [{ id: entryId, name: 'Vale', motivations: 'survive' }] },
  entry: { id: entryId, name: 'Vale', motivations: 'survive' },
  updatedFields: ['motivations'],
  rationale: 'mock rationale',
  runId: 'mock-expand-run',
  providerId: 'mock', model: 'mock',
}));
vi.mock('../services/universeCharacterExpand.js', () => ({
  expandUniverseCharacter: (...args) => expandUniverseCharacterMock(...args),
}));

// Stub the reference-sheet renderer + sibling exports — only the route
// contract is verified here; the actual prompt builder + delete plumbing are
// exercised in universeCharacterSheet.test.js / universeCharacterSheetDelete.test.js.
const renderCharacterReferenceSheetMock = vi.fn();
const deleteCharacterReferenceSheetMock = vi.fn();
const listSheetVariantsMock = vi.fn();
vi.mock('../services/universeCharacterSheet.js', () => ({
  renderCharacterReferenceSheet: (...args) => renderCharacterReferenceSheetMock(...args),
  deleteCharacterReferenceSheet: (...args) => deleteCharacterReferenceSheetMock(...args),
  listSheetVariants: (...args) => listSheetVariantsMock(...args),
}));

// Stub the LLM expander so the route test doesn't shell out to a real provider.
vi.mock('../services/universeBuilderExpand.js', () => ({
  expandWorldTemplate: vi.fn(async ({ starterPrompt }) => ({
    influences: {
      embrace: [`mocked style for ${starterPrompt}`],
      avoid: ['blurry'],
    },
    categories: {
      landscapes: { variations: [{ label: 'Mock Land', prompt: 'mocked landscape' }] },
      environments: { variations: [] },
      characters: { variations: [{ label: 'Mock Char', prompt: 'mocked character' }] },
      structures: { variations: [] },
      vehicles: { variations: [] },
    },
    compositeSheets: [
      { kind: 'reference_sheet', label: 'Mock costume sheet', prompt: 'mocked complete costume reference sheet with lineup, materials, fasteners, palette' },
      { kind: 'world_pitch_poster', label: 'Mock universe pitch poster', prompt: 'mocked universe summary concept pitch poster with hero panorama, inset cultures, palette, materials, and theme icons' },
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
// Mirrors the production helper's universeId-first resolution so repeat-
// render tests verify the new contract (same `universeId` → same collection
// id) rather than the old name-only contract.
const collectionsByUniverseId = new Map();
const upsertUniverseRec = ({ universeId, universeName }) => {
  if (collectionsByUniverseId.has(universeId)) return collectionsByUniverseId.get(universeId);
  const name = `Universe: ${universeName || ''}`.slice(0, 80);
  const rec = mockCreateRec(name);
  rec.universeId = universeId;
  collectionsByUniverseId.set(universeId, rec);
  return rec;
};
vi.mock('../services/mediaCollections.js', () => ({
  createCollection: vi.fn(async ({ name }) => mockCreateRec(name)),
  findOrCreateCollectionByName: vi.fn(async ({ name }) => {
    return collectionsByName.get(name.toLowerCase()) ?? mockCreateRec(name);
  }),
  findOrCreateUniverseCollection: vi.fn(async ({ universeId, universeName }) =>
    upsertUniverseRec({ universeId, universeName })),
  addItem: vi.fn(),
  // Universe rename → collection rename cascade calls this from updateUniverse.
  // No-op here is fine: the routes test cares about the universe PATCH itself,
  // not the bookkeeping side-effect (covered in mediaCollections.test.js).
  renameCollectionForUniverse: vi.fn(async () => null),
  // Universe delete → unlink linked collections so the orphaned bucket
  // becomes a normal user-owned collection. No-op stub mirrors the rename
  // cascade pattern above (behavior is covered in mediaCollections.test.js).
  unlinkCollectionsForUniverse: vi.fn(async () => []),
  universeCollectionNameFor: (name) => `Universe: ${name || ''}`.slice(0, 80),
  ERR_DUPLICATE: 'DUPLICATE',
  NAME_MAX_LENGTH: 80,
}));

vi.mock('../lib/mediaModels.js', () => ({
  getImageModels: () => [{ id: 'dev', label: 'mflux dev' }],
  isFlux2: () => false,
  isZImage: () => false,
  isErnie: () => false,
}));

const universeBuilderRoutes = (await import('./universeBuilder.js')).default;

const buildApp = () => {
  const app = express();
  // Mirror production's 55mb body limit (see server/index.js) so payload-size
  // tests exercise the Zod `.max()` boundary instead of bumping into the
  // 100kb default body-parser limit.
  app.use(express.json({ limit: '55mb' }));
  app.use('/api/universe-builder', universeBuilderRoutes);
  app.use(errorMiddleware);
  return app;
};

describe('universe-builder routes', () => {
  beforeEach(() => {
    fileStore.clear();
    uuidCounter = 0;
    collectionsByName.clear();
    collectionsByUniverseId.clear();
  });

  it('GET / returns []', async () => {
    const res = await request(buildApp()).get('/api/universe-builder');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('POST / creates a universe', async () => {
    const res = await request(buildApp())
      .post('/api/universe-builder')
      .send({ name: 'My Universe', starterPrompt: 'cyber forest' });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe('uuid-1');
    expect(res.body.name).toBe('My Universe');
    // Default categories populated, each tagged with its canon trunk via
    // WORLD_CATEGORY_DEFAULT_KINDS. `characters` was retired in schema v4
    // (canon owns characters now).
    expect(Object.keys(res.body.categories).sort()).toEqual(
      ['environments', 'landscapes', 'structures', 'vehicles'],
    );
    expect(res.body.categories.landscapes.kind).toBe('places');
    expect(res.body.categories.vehicles.kind).toBe('objects');
  });

  it('POST / accepts and persists a `kind` on each category', async () => {
    const res = await request(buildApp())
      .post('/api/universe-builder')
      .send({
        name: 'Kinded',
        categories: {
          factions: { kind: 'characters', variations: [{ label: 'Iron Reach', prompt: 'x' }] },
          colonies: { kind: 'places', variations: [{ label: 'Tycho', prompt: 'y' }] },
        },
      });
    expect(res.status).toBe(201);
    expect(res.body.categories.factions.kind).toBe('characters');
    expect(res.body.categories.colonies.kind).toBe('places');
  });

  it('POST / rejects an invalid `kind` enum value via Zod', async () => {
    const res = await request(buildApp())
      .post('/api/universe-builder')
      .send({
        name: 'Bad Kind',
        categories: {
          colonies: { kind: 'not-a-kind', variations: [] },
        },
      });
    expect(res.status).toBe(400);
  });

  it('POST / folds a stale `characters` bucket into canon characters[] and drops the bucket', async () => {
    const res = await request(buildApp())
      .post('/api/universe-builder')
      .send({
        name: 'Stale Client',
        categories: {
          // Mimic an outdated client still sending the retired bucket.
          characters: { variations: [{ label: 'Ash', prompt: 'young survivor' }] },
        },
      });
    expect(res.status).toBe(201);
    expect(res.body.categories.characters).toBeUndefined();
    const ash = res.body.characters.find((c) => c.name === 'Ash');
    expect(ash).toBeDefined();
    expect(ash.prompt).toBe('young survivor');
  });

  it('POST / accepts dynamic universe-building categories', async () => {
    const res = await request(buildApp())
      .post('/api/universe-builder')
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
      .post('/api/universe-builder')
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

  it('POST / accepts universe pitch poster composite prompts', async () => {
    const res = await request(buildApp())
      .post('/api/universe-builder')
      .send({
        name: 'Pitch Posters',
        compositeSheets: [
          { kind: 'world_pitch_poster', label: 'Universe summary concept pitch poster', prompt: 'Create a cinematic universe summary concept pitch poster with hero panorama, inset environments, cultures, creatures, visual language strip, color palette, materials, light atmosphere, and theme icons.' },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.compositeSheets).toHaveLength(1);
    expect(res.body.compositeSheets[0].kind).toBe('world_pitch_poster');
  });

  it('POST / rejects missing name', async () => {
    const res = await request(buildApp())
      .post('/api/universe-builder')
      .send({ starterPrompt: 'cyber forest' });
    expect(res.status).toBe(400);
  });

  // Starter-idea length: the legacy 4000-char cap was lifted in favor of a
  // 200,000-char sanity ceiling. These tests pin the new Zod boundary so a
  // future schema edit can't silently restore the old limit (or relax it
  // past the documented ceiling).
  it('POST / accepts a starterPrompt well beyond the legacy 4000-char limit', async () => {
    const longPrompt = 'a'.repeat(50_000);
    const res = await request(buildApp())
      .post('/api/universe-builder')
      .send({ name: 'Long Idea', starterPrompt: longPrompt });
    expect(res.status).toBe(201);
    expect(res.body.starterPrompt).toHaveLength(50_000);
  });

  it('POST /expand rejects a starterPrompt exceeding 200,000 chars', async () => {
    const res = await request(buildApp())
      .post('/api/universe-builder/expand')
      .send({ starterPrompt: 'x'.repeat(200_001) });
    expect(res.status).toBe(400);
  });

  it('POST /expand accepts a starterPrompt at exactly 200,000 chars', async () => {
    const res = await request(buildApp())
      .post('/api/universe-builder/expand')
      .send({ starterPrompt: 'x'.repeat(200_000) });
    expect(res.status).toBe(200);
  });

  it('PATCH /:id updates fields', async () => {
    const app = buildApp();
    const c = await request(app).post('/api/universe-builder').send({ name: 'A' });
    const res = await request(app)
      .patch(`/api/universe-builder/${c.body.id}`)
      .send({ name: 'B', influences: { embrace: ['oil painting'], avoid: [] } });
    expect(res.status).toBe(200);
    expect(res.body.name).toBe('B');
    expect(res.body.influences.embrace).toEqual(['oil painting']);
    // The v2 prose stylePrompt / negativePrompt fields no longer round-trip.
    expect(res.body.stylePrompt).toBeUndefined();
    expect(res.body.negativePrompt).toBeUndefined();
  });

  it('PATCH /:id absorbs stale prose stylePrompt/negativePrompt into influences', async () => {
    // Backward compat: a stale v2-shaped client may still PATCH the prose
    // fields. The sanitizer's v2 → v3 migration splits them into chip tokens
    // and merges into influences.embrace / influences.avoid.
    const app = buildApp();
    const c = await request(app)
      .post('/api/universe-builder')
      .send({ name: 'Legacy', influences: { embrace: ['existing'], avoid: ['existing-neg'] } });
    const res = await request(app)
      .patch(`/api/universe-builder/${c.body.id}`)
      .send({ stylePrompt: 'oil painting, gritty', negativePrompt: 'blurry' });
    expect(res.status).toBe(200);
    expect(res.body.influences.embrace).toEqual(['existing', 'oil painting', 'gritty']);
    expect(res.body.influences.avoid).toEqual(['existing-neg', 'blurry']);
  });

  it('PATCH /:id persists canon array writes (characters/settings/objects)', async () => {
    // Regression guard for the Zod-default-strips-unknown-keys bug that
    // would silently drop canon-array writes from the inline-edit UI.
    const app = buildApp();
    const c = await request(app).post('/api/universe-builder').send({ name: 'A' });
    const res = await request(app)
      .patch(`/api/universe-builder/${c.body.id}`)
      .send({
        characters: [{ name: 'Jean', physicalDescription: 'tall, dark hair' }],
        places: [{ slugline: 'INT. BAR — NIGHT', intExt: 'INT', timeOfDay: 'night' }],
        objects: [{ name: 'Gold pocket watch', description: 'tarnished brass casing' }],
      });
    expect(res.status).toBe(200);
    expect(res.body.characters).toHaveLength(1);
    expect(res.body.characters[0].name).toBe('Jean');
    expect(res.body.places).toHaveLength(1);
    expect(res.body.places[0].intExt).toBe('INT');
    expect(res.body.places[0].timeOfDay).toBe('night');
    expect(res.body.objects).toHaveLength(1);
    expect(res.body.objects[0].name).toBe('Gold pocket watch');
  });

  it('DELETE /:id removes the universe', async () => {
    const app = buildApp();
    const c = await request(app).post('/api/universe-builder').send({ name: 'A' });
    const del = await request(app).delete(`/api/universe-builder/${c.body.id}`);
    expect(del.status).toBe(200);
    const list = await request(app).get('/api/universe-builder');
    expect(list.body).toEqual([]);
  });

  it('POST /expand returns LLM expansion', async () => {
    const res = await request(buildApp())
      .post('/api/universe-builder/expand')
      .send({ starterPrompt: 'moebius scifi' });
    expect(res.status).toBe(200);
    expect(res.body.influences.embrace[0]).toContain('moebius scifi');
    expect(res.body.categories.landscapes.variations).toHaveLength(1);
    expect(res.body.compositeSheets).toHaveLength(2);
    expect(res.body.llm.provider).toBe('anthropic');
  });

  it('POST /:id/render queues image jobs and records run', async () => {
    const app = buildApp();
    const created = await request(app).post('/api/universe-builder').send({
      name: 'Render Test',
      influences: { embrace: ['style'], avoid: ['neg'] },
      categories: {
        landscapes: { variations: [{ label: 'A', prompt: 'a prompt' }, { label: 'B', prompt: 'b prompt' }] },
        // `characters` was retired as a default bucket in schema v4 (canon
        // owns characters); use a custom bucket to keep the 3-variation
        // render scenario intact.
        outfits: { variations: [{ label: 'C', prompt: 'c prompt' }] },
      },
    });
    const res = await request(app)
      .post(`/api/universe-builder/${created.body.id}/render`)
      .send({ batchPerVariation: 2, mode: 'local' });
    expect(res.status).toBe(200);
    expect(res.body.promptCount).toBe(6); // 3 variations × 2 batch
    expect(res.body.jobIds).toHaveLength(6);
    expect(res.body.collectionId).toBe('col-1');
    // Run is recorded.
    const runs = await request(app).get(`/api/universe-builder/${created.body.id}/runs`);
    expect(runs.body).toHaveLength(1);
    expect(runs.body[0].promptCount).toBe(6);
  });

  it('POST /:id/render queues custom category prompts', async () => {
    const app = buildApp();
    const created = await request(app).post('/api/universe-builder').send({
      name: 'Clothing',
      influences: { embrace: ['moebius', 'clean reference sheet'], avoid: [] },
      categories: {
        clothing_styles: { variations: [{ label: 'Gas-Giant Drifters', prompt: 'buckles, clips, pressure rings' }] },
      },
    });
    const res = await request(app)
      .post(`/api/universe-builder/${created.body.id}/render`)
      .send({ mode: 'local', selection: { clothing_styles: 'all' } });
    expect(res.status).toBe(200);
    expect(res.body.promptCount).toBe(1);
    expect(res.body.jobIds).toHaveLength(1);
  });

  it('POST /:id/render queues composite sheet prompts', async () => {
    const app = buildApp();
    const created = await request(app).post('/api/universe-builder').send({
      name: 'Composite Clothing',
      influences: { embrace: ['moebius', 'clean reference sheet'], avoid: [] },
      compositeSheets: [
        { label: 'Gas-Giant Drifters sheet', prompt: 'complete costume reference sheet, five figures, material swatches, pressure rings, palette strip' },
      ],
    });
    const res = await request(app)
      .post(`/api/universe-builder/${created.body.id}/render`)
      .send({ mode: 'local', promptMode: 'sheets' });
    expect(res.status).toBe(200);
    expect(res.body.promptCount).toBe(1);
    expect(res.body.jobIds).toHaveLength(1);
  });

  it('POST /:id/render reuses the same collection on repeat renders of the same universe', async () => {
    const app = buildApp();
    const created = await request(app).post('/api/universe-builder').send({
      name: 'Repeat Universe',
      categories: {
        landscapes: { variations: [{ label: 'A', prompt: 'a' }] },
      },
    });
    const first = await request(app)
      .post(`/api/universe-builder/${created.body.id}/render`)
      .send({ mode: 'local' });
    expect(first.status).toBe(200);
    const second = await request(app)
      .post(`/api/universe-builder/${created.body.id}/render`)
      .send({ mode: 'local' });
    expect(second.status).toBe(200);
    expect(second.body.collectionId).toBe(first.body.collectionId);
    // The auto-generated name has no date suffix — bare `Universe: <name>`.
    expect(second.body.collectionName).toBe('Universe: Repeat Universe');
    expect(second.body.collectionName).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it('POST /:id/render rejects body.collectionName with a clear error (deprecated field)', async () => {
    const app = buildApp();
    const created = await request(app).post('/api/universe-builder').send({
      name: 'Reject CollectionName Universe',
      categories: {
        landscapes: { variations: [{ label: 'A', prompt: 'a' }] },
      },
    });
    const res = await request(app)
      .post(`/api/universe-builder/${created.body.id}/render`)
      .send({ mode: 'local', collectionName: 'Shared Bucket' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/collectionName/i);
  });

  it('POST /:id/render forwards seed + LoRAs in the wire format local image gen reads', async () => {
    vi.mocked(enqueueJob).mockClear();
    const app = buildApp();
    const created = await request(app).post('/api/universe-builder').send({
      name: 'Override Universe',
      categories: {
        landscapes: { variations: [{ label: 'A', prompt: 'a' }] },
      },
    });
    const res = await request(app)
      .post(`/api/universe-builder/${created.body.id}/render`)
      .send({
        mode: 'local',
        seed: 42,
        negativePrompt: 'low quality',
        extraStyle: 'high contrast',
        loras: [
          { filename: 'foo.safetensors', name: 'Foo', scale: 0.8 },
          { filename: 'bar.safetensors', name: 'Bar', scale: 1.2 },
        ],
      });
    expect(res.status).toBe(200);
    expect(res.body.promptCount).toBe(1);
    // Verify the enqueued job carries the local-runner wire shape
    // (loraFilenames + loraScales as parallel arrays), not the UI's
    // [{filename, scale}] objects which the runner would silently ignore.
    expect(vi.mocked(enqueueJob)).toHaveBeenCalledTimes(1);
    const enqueuedParams = vi.mocked(enqueueJob).mock.calls[0][0].params;
    expect(enqueuedParams.seed).toBe(42);
    expect(enqueuedParams.loraFilenames).toEqual(['foo.safetensors', 'bar.safetensors']);
    expect(enqueuedParams.loraScales).toEqual([0.8, 1.2]);
    expect(enqueuedParams.loras).toBeUndefined();
  });

  it('POST /:id/render rejects non-numeric seed (local image gen would NaN)', async () => {
    const app = buildApp();
    const created = await request(app).post('/api/universe-builder').send({
      name: 'Bad Seed Universe',
      categories: {
        landscapes: { variations: [{ label: 'A', prompt: 'a' }] },
      },
    });
    const res = await request(app)
      .post(`/api/universe-builder/${created.body.id}/render`)
      .send({ mode: 'local', seed: 'abc123' });
    expect(res.status).toBe(400);
  });

  it('POST /:id/render rejects lora filename with path separators (basenames only)', async () => {
    const app = buildApp();
    const created = await request(app).post('/api/universe-builder').send({
      name: 'Bad LoRA Universe',
      categories: {
        landscapes: { variations: [{ label: 'A', prompt: 'a' }] },
      },
    });
    const res = await request(app)
      .post(`/api/universe-builder/${created.body.id}/render`)
      .send({
        mode: 'local',
        loras: [{ filename: '../escape.safetensors', scale: 1.0 }],
      });
    expect(res.status).toBe(400);
  });

  it('POST /:id/render rejects when no variations exist', async () => {
    const app = buildApp();
    const created = await request(app).post('/api/universe-builder').send({ name: 'Empty' });
    const res = await request(app)
      .post(`/api/universe-builder/${created.body.id}/render`)
      .send({ mode: 'local' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('WORLD_BUILDER_EMPTY');
  });

  describe('POST /:id/promote-variation', () => {
    beforeEach(() => {
      promoteVariationToCanonMock.mockClear();
    });

    it('forwards the body to the service and returns the result', async () => {
      const app = buildApp();
      const res = await request(app)
        .post('/api/universe-builder/some-id/promote-variation')
        .send({ category: 'landscapes', label: 'Salt Flats' });
      expect(res.status).toBe(200);
      expect(promoteVariationToCanonMock).toHaveBeenCalledWith('some-id', expect.objectContaining({
        category: 'landscapes',
        label: 'Salt Flats',
      }));
      expect(res.body.entry.name).toBe('Salt Flats');
    });

    it('passes through targetKind for other-kinded buckets', async () => {
      const app = buildApp();
      const res = await request(app)
        .post('/api/universe-builder/some-id/promote-variation')
        .send({ category: 'myth_archetypes', label: 'Solstice Mask', targetKind: 'objects' });
      expect(res.status).toBe(200);
      expect(promoteVariationToCanonMock).toHaveBeenCalledWith('some-id', expect.objectContaining({
        targetKind: 'objects',
      }));
    });

    it('400s on missing label (Zod schema)', async () => {
      const app = buildApp();
      const res = await request(app)
        .post('/api/universe-builder/some-id/promote-variation')
        .send({ category: 'landscapes' });
      expect(res.status).toBe(400);
      expect(promoteVariationToCanonMock).not.toHaveBeenCalled();
    });

    it('400s on invalid targetKind enum (Zod schema)', async () => {
      const app = buildApp();
      const res = await request(app)
        .post('/api/universe-builder/some-id/promote-variation')
        .send({ category: 'landscapes', label: 'A', targetKind: 'monster' });
      expect(res.status).toBe(400);
      expect(promoteVariationToCanonMock).not.toHaveBeenCalled();
    });

    it('maps service ServerError status onto the HTTP response', async () => {
      promoteVariationToCanonMock.mockRejectedValueOnce(
        Object.assign(new Error('Bucket not found'), {
          status: 404,
          code: 'UNIVERSE_PROMOTE_NO_CATEGORY',
        }),
      );
      const app = buildApp();
      const res = await request(app)
        .post('/api/universe-builder/some-id/promote-variation')
        .send({ category: 'nonexistent', label: 'A' });
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('UNIVERSE_PROMOTE_NO_CATEGORY');
    });
  });

  describe('POST /:id/auto-sort', () => {
    beforeEach(() => {
      autoSortOtherBucketsMock.mockClear();
    });

    it('forwards the body to the service and returns the result', async () => {
      const app = buildApp();
      const res = await request(app)
        .post('/api/universe-builder/some-id/auto-sort')
        .send({ providerId: 'p1', model: 'm1' });
      expect(res.status).toBe(200);
      expect(autoSortOtherBucketsMock).toHaveBeenCalledWith('some-id', expect.objectContaining({
        providerId: 'p1',
        model: 'm1',
      }));
      expect(res.body.results[0].kind).toBe('places');
      expect(res.body.runId).toBe('mock-autosort-run');
    });

    it('accepts an empty body (providerId + model are optional)', async () => {
      const app = buildApp();
      const res = await request(app)
        .post('/api/universe-builder/some-id/auto-sort')
        .send({});
      expect(res.status).toBe(200);
      expect(autoSortOtherBucketsMock).toHaveBeenCalled();
    });

    it('400s when providerId exceeds the schema cap (Zod schema)', async () => {
      const app = buildApp();
      const res = await request(app)
        .post('/api/universe-builder/some-id/auto-sort')
        .send({ providerId: 'a'.repeat(100) });
      expect(res.status).toBe(400);
      expect(autoSortOtherBucketsMock).not.toHaveBeenCalled();
    });

    it('maps service ServerError status onto the HTTP response', async () => {
      autoSortOtherBucketsMock.mockRejectedValueOnce(
        Object.assign(new Error('No provider'), {
          status: 503,
          code: 'UNIVERSE_AUTOSORT_NO_PROVIDER',
        }),
      );
      const app = buildApp();
      const res = await request(app)
        .post('/api/universe-builder/some-id/auto-sort')
        .send({});
      expect(res.status).toBe(503);
      expect(res.body.code).toBe('UNIVERSE_AUTOSORT_NO_PROVIDER');
    });
  });

  describe('POST /:id/characters/:entryId/expand', () => {
    beforeEach(() => expandUniverseCharacterMock.mockClear());

    it('200s and forwards providerId / model to the service', async () => {
      const res = await request(buildApp())
        .post('/api/universe-builder/u-1/characters/c-1/expand')
        .send({ providerId: 'anthropic', model: 'claude' });
      expect(res.status).toBe(200);
      expect(expandUniverseCharacterMock).toHaveBeenCalledWith('u-1', 'c-1', expect.objectContaining({
        providerId: 'anthropic',
        model: 'claude',
      }));
      expect(res.body.updatedFields).toEqual(['motivations']);
      expect(res.body.entry.id).toBe('c-1');
    });

    it('accepts an empty body (providerId + model are optional)', async () => {
      const res = await request(buildApp())
        .post('/api/universe-builder/u-1/characters/c-1/expand')
        .send({});
      expect(res.status).toBe(200);
      expect(expandUniverseCharacterMock).toHaveBeenCalled();
    });

    it('surfaces `locked: true` as a 200 — UI shows a Locked badge instead of a toast', async () => {
      expandUniverseCharacterMock.mockResolvedValueOnce({
        universe: { id: 'u-1', characters: [] },
        entry: { id: 'c-2', name: 'Frozen', locked: true },
        locked: true,
        updatedFields: [],
      });
      const res = await request(buildApp())
        .post('/api/universe-builder/u-1/characters/c-2/expand')
        .send({});
      expect(res.status).toBe(200);
      expect(res.body.locked).toBe(true);
      expect(res.body.updatedFields).toEqual([]);
    });

    it('maps service NOT_FOUND status onto a 404', async () => {
      expandUniverseCharacterMock.mockRejectedValueOnce(
        Object.assign(new Error('Character cx not found in universe'), {
          status: 404,
          code: 'UNIVERSE_CANON_NOT_FOUND',
        }),
      );
      const res = await request(buildApp())
        .post('/api/universe-builder/u-1/characters/cx/expand')
        .send({});
      expect(res.status).toBe(404);
      expect(res.body.code).toBe('UNIVERSE_CANON_NOT_FOUND');
    });
  });

  describe('POST /:id/characters/:entryId/render-reference-sheet', () => {
    beforeEach(() => {
      renderCharacterReferenceSheetMock.mockReset();
      renderCharacterReferenceSheetMock.mockImplementation(async (universeId, entryId, body = {}) => ({
        jobId: `job-${entryId}`,
        // generationId is now an alias for jobId per the client back-compat
        // contract — keep them identical in the mock so the test reflects prod.
        generationId: `job-${entryId}`,
        queuePosition: 1,
        destFilename: `universe-${universeId}-${entryId}-sheet-job-${entryId}.png`,
        destPath: `/data/image-refs/universe-${universeId}-${entryId}-sheet-job-${entryId}.png`,
        promptPreview: `mock prompt for ${entryId} (override:${!!body.overridePrompt})`,
      }));
    });

    it('200s with { jobId, generationId } and forwards overrides to the service', async () => {
      const res = await request(buildApp())
        .post('/api/universe-builder/u-1/characters/c-1/render-reference-sheet')
        .send({ overridePrompt: 'custom prompt', modelId: 'flux2-klein-9b' });
      expect(res.status).toBe(200);
      expect(renderCharacterReferenceSheetMock).toHaveBeenCalledWith(
        'u-1', 'c-1',
        expect.objectContaining({ overridePrompt: 'custom prompt', modelId: 'flux2-klein-9b' }),
      );
      expect(res.body.jobId).toBe('job-c-1');
      // generationId is now an alias for jobId (client back-compat).
      expect(res.body.generationId).toBe('job-c-1');
      expect(res.body.queuePosition).toBe(1);
      expect(res.body.destFilename).toContain('-sheet-');
      expect(res.body.destPath).toContain('/data/image-refs/');
    });

    it('accepts an empty body (every override is optional)', async () => {
      const res = await request(buildApp())
        .post('/api/universe-builder/u-1/characters/c-1/render-reference-sheet')
        .send({});
      expect(res.status).toBe(200);
      expect(renderCharacterReferenceSheetMock).toHaveBeenCalledWith('u-1', 'c-1', {});
    });

    it('400s when overridePrompt exceeds the 8000-char Zod cap', async () => {
      const res = await request(buildApp())
        .post('/api/universe-builder/u-1/characters/c-1/render-reference-sheet')
        .send({ overridePrompt: 'x'.repeat(8001) });
      expect(res.status).toBe(400);
      expect(renderCharacterReferenceSheetMock).not.toHaveBeenCalled();
    });

    it('maps a service "unsupported mode" error onto a 400 with the right code', async () => {
      renderCharacterReferenceSheetMock.mockRejectedValueOnce(
        Object.assign(new Error('Character reference sheet rendering needs codex or local image-gen mode'), {
          status: 400,
          code: 'UNIVERSE_CHARACTER_SHEET_UNSUPPORTED_MODE',
        }),
      );
      const res = await request(buildApp())
        .post('/api/universe-builder/u-1/characters/c-1/render-reference-sheet')
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('UNIVERSE_CHARACTER_SHEET_UNSUPPORTED_MODE');
    });
  });

  describe('POST /:id/characters/:entryId/render-reference-sheet (variant routing)', () => {
    // The route is single-entry — non-default variants are selected via the
    // body's `variant` field and forwarded to the service as a 4th arg.
    it('forwards a body-supplied variant onto the service call', async () => {
      const res = await request(buildApp())
        .post('/api/universe-builder/u-1/characters/c-1/render-reference-sheet')
        .send({ variant: 'blueprint' });
      expect(res.status).toBe(200);
      expect(renderCharacterReferenceSheetMock).toHaveBeenCalledWith(
        'u-1', 'c-1', { variant: 'blueprint' },
      );
    });

    it('rejects a variant that exceeds the 48-char Zod cap', async () => {
      const res = await request(buildApp())
        .post('/api/universe-builder/u-1/characters/c-1/render-reference-sheet')
        .send({ variant: 'x'.repeat(49) });
      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /:id/characters/:entryId/reference-sheet (variant query)', () => {
    beforeEach(() => {
      deleteCharacterReferenceSheetMock.mockReset();
      deleteCharacterReferenceSheetMock.mockResolvedValue({
        filename: 'universe-u-1-c-1-blueprint-job.png',
        fileDeleted: true,
        cleared: 1,
      });
    });

    it('forwards no variant (default) when query is empty', async () => {
      const res = await request(buildApp())
        .delete('/api/universe-builder/u-1/characters/c-1/reference-sheet');
      expect(res.status).toBe(200);
      expect(deleteCharacterReferenceSheetMock).toHaveBeenCalledWith('u-1', 'c-1', {});
    });

    it('forwards `variant` from the query string', async () => {
      const res = await request(buildApp())
        .delete('/api/universe-builder/u-1/characters/c-1/reference-sheet?variant=blueprint');
      expect(res.status).toBe(200);
      expect(deleteCharacterReferenceSheetMock).toHaveBeenCalledWith('u-1', 'c-1', { variant: 'blueprint' });
    });
  });

  describe('GET /reference-sheet-variants', () => {
    beforeEach(() => {
      listSheetVariantsMock.mockReset();
      listSheetVariantsMock.mockReturnValue([
        { id: 'standard', label: 'Illustrated', description: '...' },
        { id: 'blueprint', label: 'Blueprint', description: '...' },
      ]);
    });

    it('returns the registry catalog as { variants: [...] }', async () => {
      const res = await request(buildApp()).get('/api/universe-builder/reference-sheet-variants');
      expect(res.status).toBe(200);
      expect(res.body.variants).toHaveLength(2);
      expect(res.body.variants[0].id).toBe('standard');
      expect(res.body.variants[1].id).toBe('blueprint');
    });
  });
});
