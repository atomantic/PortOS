import { describe, it, expect, vi, beforeEach } from 'vitest';

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

const svc = await import('./worldBuilder.js');

const seedWorld = async (overrides = {}) => svc.createWorld({
  name: 'Moebius SciFi',
  starterPrompt: 'moebius and scavengers reign meets prophet',
  stylePrompt: 'moebius linework, scavengers reign palette',
  negativePrompt: 'blurry, lowres',
  categories: {
    landscapes: { variations: [
      { label: 'Crystal Canyon', prompt: 'crystalline canyon, alien sun' },
      { label: 'Sand Sea', prompt: 'endless sand sea, dunes' },
    ] },
    characters: { variations: [
      { label: 'Scavenger', prompt: 'lone scavenger figure, weathered cloak' },
    ] },
  },
  ...overrides,
});

describe('worldBuilder service', () => {
  beforeEach(() => {
    fileStore.clear();
    uuidCounter = 0;
  });

  it('listWorlds returns [] for fresh state', async () => {
    expect(await svc.listWorlds()).toEqual([]);
  });

  it('createWorld persists with sanitized categories', async () => {
    const w = await seedWorld();
    expect(w.id).toBe('uuid-1');
    expect(w.name).toBe('Moebius SciFi');
    // All five categories materialized even when only two were provided.
    for (const c of svc.WORLD_CATEGORIES) {
      expect(w.categories[c]).toBeDefined();
      expect(Array.isArray(w.categories[c].variations)).toBe(true);
    }
    expect(w.categories.landscapes.variations).toHaveLength(2);
    expect(w.categories.characters.variations).toHaveLength(1);
    expect(w.categories.environments.variations).toHaveLength(0);
  });

  it('createWorld rejects empty name', async () => {
    await expect(svc.createWorld({ name: '' })).rejects.toThrow(/name is required/);
  });

  it('updateWorld merges partial patches', async () => {
    const w = await seedWorld();
    const patched = await svc.updateWorld(w.id, { name: 'Renamed', stylePrompt: 'new style' });
    expect(patched.name).toBe('Renamed');
    expect(patched.stylePrompt).toBe('new style');
    // Untouched fields preserved.
    expect(patched.starterPrompt).toBe(w.starterPrompt);
    expect(patched.categories.landscapes.variations).toHaveLength(2);
  });

  it('updateWorld throws NOT_FOUND for unknown id', async () => {
    await expect(svc.updateWorld('no-such', { name: 'X' })).rejects.toMatchObject({ code: svc.ERR_NOT_FOUND });
  });

  it('deleteWorld removes the world and its runs', async () => {
    const w = await seedWorld();
    await svc.recordRun({
      id: 'run-1', worldId: w.id, collectionId: 'col-1', jobIds: ['j1'], promptCount: 3,
    });
    expect((await svc.listRuns(w.id))).toHaveLength(1);
    await svc.deleteWorld(w.id);
    expect(await svc.listWorlds()).toEqual([]);
    expect(await svc.listRuns(w.id)).toEqual([]);
  });

  describe('compilePrompts', () => {
    it('returns one prompt per variation across selected categories with style prefix', async () => {
      const w = await seedWorld();
      const compiled = svc.compilePrompts(w);
      // 2 landscapes + 1 character = 3 (other categories empty)
      expect(compiled).toHaveLength(3);
      expect(compiled[0].prompt).toBe('moebius linework, scavengers reign palette, crystalline canyon, alien sun');
      expect(compiled[0].category).toBe('landscapes');
      expect(compiled[0].label).toBe('Crystal Canyon');
      expect(compiled[0].negativePrompt).toBe('blurry, lowres');
    });

    it('respects batchPerVariation', async () => {
      const w = await seedWorld();
      const compiled = svc.compilePrompts(w, { batchPerVariation: 3 });
      expect(compiled).toHaveLength(9); // 3 variations × 3 batch
      expect(compiled.filter((c) => c.label === 'Crystal Canyon')).toHaveLength(3);
    });

    it('selection: array filters by label (case-insensitive)', async () => {
      const w = await seedWorld();
      const compiled = svc.compilePrompts(w, {
        selection: { landscapes: ['crystal canyon'], characters: 'all' },
      });
      // 1 landscape (filtered) + 1 character (all) = 2
      expect(compiled).toHaveLength(2);
      expect(compiled.map((c) => c.label).sort()).toEqual(['Crystal Canyon', 'Scavenger']);
    });

    it('selection: missing key skips category', async () => {
      const w = await seedWorld();
      const compiled = svc.compilePrompts(w, { selection: { landscapes: 'all' } });
      expect(compiled).toHaveLength(2);
      expect(compiled.every((c) => c.category === 'landscapes')).toBe(true);
    });

    it('clamps batchPerVariation to 1..20', async () => {
      const w = await seedWorld();
      // 0 → 1
      expect(svc.compilePrompts(w, { batchPerVariation: 0 })).toHaveLength(3);
      // 100 → 20
      const big = svc.compilePrompts(w, { batchPerVariation: 100 });
      expect(big).toHaveLength(60); // 3 × 20
    });
  });

  describe('sanitizers', () => {
    it('drops malformed variations on read', async () => {
      // Manually plant invalid state — sanitizeTemplate strips it on read.
      fileStore.set('/mock/data/world-builder.json', {
        worlds: [{
          id: 'w1',
          name: 'X',
          starterPrompt: '',
          stylePrompt: '',
          negativePrompt: '',
          categories: {
            landscapes: { variations: [
              { label: 'Good', prompt: 'good prompt' },
              { label: '', prompt: 'no label' },
              { label: 'No prompt', prompt: '' },
              null,
            ] },
          },
          createdAt: '2024-01-01T00:00:00Z',
        }],
        runs: [],
      });
      const list = await svc.listWorlds();
      expect(list[0].categories.landscapes.variations).toHaveLength(1);
      expect(list[0].categories.landscapes.variations[0].label).toBe('Good');
    });
  });
});
