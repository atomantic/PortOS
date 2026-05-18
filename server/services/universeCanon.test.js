import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory file store mirroring universeBuilder.test.js so canon mutations
// roundtrip through the same readState/writeState path the real service uses.
const fileStore = new Map();

vi.mock('../lib/fileUtils.js', () => ({
  PATHS: { data: '/mock/data' },
  ensureDir: vi.fn().mockResolvedValue(undefined),
  atomicWrite: vi.fn(async (path, data) => { fileStore.set(path, data); }),
  readJSONFile: vi.fn(async (path, fallback) => (fileStore.has(path) ? fileStore.get(path) : fallback)),
  shortId: (id, n = 8) => (id == null ? '' : String(id).slice(0, n)),
}));

let uuidCounter = 0;
vi.mock('crypto', async () => {
  const actual = await vi.importActual('crypto');
  return { ...actual, randomUUID: () => `uuid-${++uuidCounter}` };
});

// The bible extractor + staged-LLM runner + prompt-refine helpers all reach
// out to live AI providers. Stub them to return deterministic shapes so we
// can test lock semantics without spinning up a model.
const extractBibleMock = vi.fn();
vi.mock('../lib/bibleExtractor.js', () => ({
  extractBible: (...args) => extractBibleMock(...args),
}));

const runStagedLLMMock = vi.fn();
vi.mock('../lib/stageRunner.js', () => ({
  runStagedLLM: (...args) => runStagedLLMMock(...args),
}));

const runPromptRefineMock = vi.fn();
vi.mock('./pipeline/refineHelpers.js', () => ({
  runPromptRefine: (...args) => runPromptRefineMock(...args),
}));

const svc = await import('./universeBuilder.js');
const canonSvc = await import('./universeCanon.js');

const seedUniverseWithCharacters = async (characters) => {
  const w = await svc.createUniverse({
    name: 'Test Universe',
    starterPrompt: 'test seed',
    stylePrompt: 'test style',
  });
  // Bypass the route schema to plant canon entries directly via updateUniverse.
  return svc.updateUniverse(w.id, { characters });
};

beforeEach(() => {
  fileStore.clear();
  uuidCounter = 0;
  extractBibleMock.mockReset();
  runStagedLLMMock.mockReset();
  runPromptRefineMock.mockReset();
});

describe('universeCanon — setCanonEntryLock', () => {
  it('toggles locked: true on the target entry and persists', async () => {
    const w = await seedUniverseWithCharacters([
      { name: 'Alex', physicalDescription: 'jacket' },
    ]);
    const entryId = w.characters[0].id;
    const { entry } = await canonSvc.setCanonEntryLock(w.id, 'character', entryId, true);
    expect(entry.locked).toBe(true);
    // Persisted: a fresh read finds it locked.
    const reread = (await svc.listUniverses())[0];
    expect(reread.characters.find((c) => c.id === entryId).locked).toBe(true);
  });

  it('removes the locked field entirely on unlock (minimal on-disk shape)', async () => {
    const w = await seedUniverseWithCharacters([
      { name: 'Alex', physicalDescription: 'jacket', locked: true },
    ]);
    const entryId = w.characters[0].id;
    const { entry } = await canonSvc.setCanonEntryLock(w.id, 'character', entryId, false);
    expect(entry.locked).toBeUndefined();
  });

  it('rejects unknown kind with a 400-coded ServerError', async () => {
    const w = await seedUniverseWithCharacters([
      { name: 'Alex', physicalDescription: 'jacket' },
    ]);
    await expect(
      canonSvc.setCanonEntryLock(w.id, 'monster', w.characters[0].id, true),
    ).rejects.toMatchObject({ status: 400, code: 'UNIVERSE_CANON_INVALID_KIND' });
  });

  it('rejects unknown entry with a 404-coded ServerError', async () => {
    const w = await seedUniverseWithCharacters([
      { name: 'Alex', physicalDescription: 'jacket' },
    ]);
    await expect(
      canonSvc.setCanonEntryLock(w.id, 'character', 'chr-not-real', true),
    ).rejects.toMatchObject({ status: 404, code: 'UNIVERSE_CANON_NOT_FOUND' });
  });
});

describe('universeCanon — refineUniverseCharacter respects locks', () => {
  it('refuses with 409 when the target character is locked', async () => {
    const w = await seedUniverseWithCharacters([
      { name: 'Alex', physicalDescription: 'jacket', locked: true },
    ]);
    await expect(
      canonSvc.refineUniverseCharacter(w.id, w.characters[0].id),
    ).rejects.toMatchObject({ status: 409, code: 'UNIVERSE_CANON_LOCKED' });
    // No LLM call was made — the guard fires before runPromptRefine.
    expect(runPromptRefineMock).not.toHaveBeenCalled();
  });

  it('proceeds when the character is unlocked', async () => {
    const w = await seedUniverseWithCharacters([
      { name: 'Alex', physicalDescription: 'jacket' },
      { name: 'Beth', physicalDescription: 'coat' },
    ]);
    runPromptRefineMock.mockResolvedValue({
      refined: 'fresh description', changes: [], rationale: 'distinct from Beth',
      runId: 'run-1', providerId: 'test', model: 'test',
    });
    const result = await canonSvc.refineUniverseCharacter(w.id, w.characters[0].id);
    expect(runPromptRefineMock).toHaveBeenCalledTimes(1);
    expect(result.entry.physicalDescription).toBe('fresh description');
  });
});

describe('universeCanon — differentiateUniverseCast respects locks', () => {
  it('skips locked entries at apply time even though the LLM saw them', async () => {
    const w = await seedUniverseWithCharacters([
      { name: 'Alex', physicalDescription: 'jacket', locked: true },
      { name: 'Beth', physicalDescription: 'coat' },
    ]);
    const [alex, beth] = w.characters;
    runStagedLLMMock.mockResolvedValue({
      content: {
        characters: [
          { id: alex.id, physicalDescription: 'rewritten alex (should be ignored)' },
          { id: beth.id, physicalDescription: 'rewritten beth' },
        ],
        rationale: 'differentiated',
      },
      runId: 'run-2', providerId: 'test', model: 'test',
    });
    const result = await canonSvc.differentiateUniverseCast(w.id);
    expect(result.touched).toBe(1);
    expect(result.skippedLocked).toBe(1);
    const refreshed = (await svc.listUniverses())[0];
    expect(refreshed.characters.find((c) => c.id === alex.id).physicalDescription).toBe('jacket');
    expect(refreshed.characters.find((c) => c.id === beth.id).physicalDescription).toBe('rewritten beth');
  });

  it('rejects when every character is locked', async () => {
    const w = await seedUniverseWithCharacters([
      { name: 'Alex', physicalDescription: 'a', locked: true },
      { name: 'Beth', physicalDescription: 'b', locked: true },
    ]);
    await expect(
      canonSvc.differentiateUniverseCast(w.id),
    ).rejects.toMatchObject({ status: 400, code: 'UNIVERSE_CANON_ALL_LOCKED' });
    expect(runStagedLLMMock).not.toHaveBeenCalled();
  });
});

describe('universeCanon — extractCanonFromProse passes autoLock + sourceSeriesId through', () => {
  it('autoLock=true makes newly-inserted entries locked + stamps sourceSeriesId', async () => {
    const w = await seedUniverseWithCharacters([]);
    extractBibleMock.mockImplementation(async ({ kind }) => ({
      extracted: kind === 'character' ? [{ name: 'NewbyChar' }] : [],
      runId: 'r', providerId: 'p', model: 'm',
    }));
    const result = await canonSvc.extractCanonFromProse(w.id, {
      corpus: 'some prose',
      kinds: ['character'],
      source: 'series-extract',
      autoLock: true,
      sourceSeriesId: 'ser-active',
    });
    const inserted = result.universe.characters.find((c) => c.name === 'NewbyChar');
    expect(inserted.locked).toBe(true);
    expect(inserted.source).toBe('series-extract');
    expect(inserted.sourceSeriesId).toBe('ser-active');
  });

  it('without autoLock, new entries are unlocked (universe-side direct extraction)', async () => {
    const w = await seedUniverseWithCharacters([]);
    extractBibleMock.mockImplementation(async ({ kind }) => ({
      extracted: kind === 'character' ? [{ name: 'Newby' }] : [],
      runId: 'r', providerId: 'p', model: 'm',
    }));
    const result = await canonSvc.extractCanonFromProse(w.id, {
      corpus: 'some prose',
      kinds: ['character'],
    });
    const inserted = result.universe.characters.find((c) => c.name === 'Newby');
    expect(inserted.locked).toBeUndefined();
    expect(inserted.source).toBe('series-extract'); // default new vocab
  });
});
