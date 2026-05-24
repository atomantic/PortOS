import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { rmSync, mkdirSync } from 'fs';
import { mockNoPeerSync, mockNoPeers, mockPathsDataRoot } from '../lib/mockPathsDataRoot.js';

// Real tmpdir backing the per-record store. `mockPathsDataRoot` redirects
// PATHS.data so collectionStore lands under tempRoot/universes/. Everything
// else from fileUtils (atomicWrite, readJSONFile, ensureDir) is the real impl.
const { tempRoot, makeProxy, cleanup } = mockPathsDataRoot({
  prefix: 'portos-universe-canon-',
  extraOverrides: (root) => ({ imageRefs: `${root}/image-refs` }),
});
afterAll(cleanup);

vi.mock('../lib/fileUtils.js', async () => {
  const actual = await vi.importActual('../lib/fileUtils.js');
  return {
    ...makeProxy(actual),
    // Stub: pretend every referenced sheet file exists, so the GET-time lazy
    // `pruneStaleReferenceSheets` doesn't null out pointers between seed and
    // assertion. The purge tests below don't depend on stale-collapse behavior.
    resolveImageRef: vi.fn((filename) => (filename ? `${tempRoot}/image-refs/${filename}` : null)),
  };
});

let uuidCounter = 0;
const mockUuid = (n) => `uuid-${String(n).padStart(8, '0')}`;
vi.mock('crypto', async () => {
  const actual = await vi.importActual('crypto');
  return { ...actual, randomUUID: () => mockUuid(++uuidCounter) };
});

// Stub instances.js so createUniverse's fire-and-forget autoSubscribeRecordToAllPeers
// doesn't fan the fixture out to real peers (getPeers reads the live registry via a
// dataPath closure to the real PATHS once the post-return microtask runs outside this
// file's fileUtils mock window). Mirrors importer.test.js / promoteToPipeline.test.js.
vi.mock('./instances.js', () => mockNoPeers());
vi.mock('./sharing/peerSync.js', () => mockNoPeerSync());

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
  rmSync(tempRoot, { recursive: true, force: true });
  mkdirSync(tempRoot, { recursive: true });
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

  it('persists explicit locked: false on unlock so the bit survives round-trips', async () => {
    // After PR #N the universe-builder canon contract is "locked by default":
    // a missing `locked` field reads as locked. Unlock therefore MUST persist
    // explicit `false` rather than collapsing to absent — otherwise the next
    // read of the same record would re-lock it.
    const w = await seedUniverseWithCharacters([
      { name: 'Alex', physicalDescription: 'jacket', locked: true },
    ]);
    const entryId = w.characters[0].id;
    const { entry } = await canonSvc.setCanonEntryLock(w.id, 'character', entryId, false);
    expect(entry.locked).toBe(false);
    const reread = (await svc.listUniverses())[0];
    expect(reread.characters.find((c) => c.id === entryId).locked).toBe(false);
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

describe('universeCanon — setCanonKindLockAll', () => {
  it('locks every entry of the kind, counts only entries whose state changed', async () => {
    // Two already-locked + one explicitly-unlocked: only the unlocked entry
    // should count toward `changed`. Pins the "no-op on already-target"
    // contract that the toast relies on for "Locked N characters".
    const w = await seedUniverseWithCharacters([
      { name: 'Alex', physicalDescription: 'a', locked: true },
      { name: 'Beth', physicalDescription: 'b', locked: true },
      { name: 'Cara', physicalDescription: 'c', locked: false },
    ]);
    const result = await canonSvc.setCanonKindLockAll(w.id, 'character', true);
    expect(result.changed).toBe(1);
    expect(result.total).toBe(3);
    expect(result.locked).toBe(true);
    // Persisted: every entry comes back `locked: true` on the next read.
    const reread = (await svc.listUniverses())[0];
    expect(reread.characters.every((c) => c.locked === true)).toBe(true);
  });

  it('unlock-all writes explicit locked:false so the bit survives the lock-by-default sanitizer', async () => {
    const w = await seedUniverseWithCharacters([
      { name: 'Alex', physicalDescription: 'a', locked: true },
      { name: 'Beth', physicalDescription: 'b', locked: true },
    ]);
    const result = await canonSvc.setCanonKindLockAll(w.id, 'character', false);
    expect(result.changed).toBe(2);
    const reread = (await svc.listUniverses())[0];
    expect(reread.characters.every((c) => c.locked === false)).toBe(true);
  });

  it('short-circuits a write when nothing changes', async () => {
    const w = await seedUniverseWithCharacters([
      { name: 'Alex', physicalDescription: 'a', locked: true },
    ]);
    const result = await canonSvc.setCanonKindLockAll(w.id, 'character', true);
    expect(result.changed).toBe(0);
    expect(result.total).toBe(1);
  });

  it('rejects unknown kind with a 400-coded ServerError', async () => {
    const w = await seedUniverseWithCharacters([]);
    await expect(
      canonSvc.setCanonKindLockAll(w.id, 'monster', true),
    ).rejects.toMatchObject({ status: 400, code: 'UNIVERSE_CANON_INVALID_KIND' });
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
    // Universe canon is locked-by-default — seed entries with explicit
    // `locked: false` to put them in the unlocked state the refine guard
    // requires.
    const w = await seedUniverseWithCharacters([
      { name: 'Alex', physicalDescription: 'jacket', locked: false },
      { name: 'Beth', physicalDescription: 'coat', locked: false },
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
    // Beth is explicitly unlocked so the cast isn't all-locked (the guard
    // before the LLM call) while Alex stays protected at apply time.
    const w = await seedUniverseWithCharacters([
      { name: 'Alex', physicalDescription: 'jacket', locked: true },
      { name: 'Beth', physicalDescription: 'coat', locked: false },
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

  it('without an explicit autoLock=false, new entries lock by default', async () => {
    // The universe-builder default is "lock new canon on insert" so users
    // don't have to chase batch extracts with a Lock All click; only an
    // explicit `autoLock: false` opts out.
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
    expect(inserted.locked).toBe(true);
    expect(inserted.source).toBe('series-extract'); // default new vocab
  });

  it('autoLock=false opts out so the entry lands unlocked', async () => {
    const w = await seedUniverseWithCharacters([]);
    extractBibleMock.mockImplementation(async ({ kind }) => ({
      extracted: kind === 'character' ? [{ name: 'Optout' }] : [],
      runId: 'r', providerId: 'p', model: 'm',
    }));
    const result = await canonSvc.extractCanonFromProse(w.id, {
      corpus: 'some prose',
      kinds: ['character'],
      autoLock: false,
    });
    const inserted = result.universe.characters.find((c) => c.name === 'Optout');
    expect(inserted.locked).not.toBe(true);
  });
});

describe('universeCanon — purgeReferenceSheetFromAllUniverses', () => {
  it('nulls referenceSheetImageRef on every matching character across every universe', async () => {
    const w1 = await seedUniverseWithCharacters([
      { name: 'Alex', physicalDescription: 'a', referenceSheetImageRef: 'sheet-A.png' },
      { name: 'Beth', physicalDescription: 'b', referenceSheetImageRef: 'sheet-B.png' },
    ]);
    const w2Initial = await svc.createUniverse({ name: 'Universe Two', starterPrompt: 'x', stylePrompt: 'y' });
    const w2 = await svc.updateUniverse(w2Initial.id, {
      characters: [{ name: 'Cara', physicalDescription: 'c', referenceSheetImageRef: 'sheet-A.png' }],
    });

    const result = await canonSvc.purgeReferenceSheetFromAllUniverses('sheet-A.png');
    expect(result.cleared).toBe(2);

    const reread = await svc.listUniverses();
    const reread1 = reread.find((u) => u.id === w1.id);
    const reread2 = reread.find((u) => u.id === w2.id);
    expect(reread1.characters.find((c) => c.name === 'Alex').referenceSheetImageRef).toBeNull();
    // Untouched: Beth's sheet name doesn't match the purge target.
    expect(reread1.characters.find((c) => c.name === 'Beth').referenceSheetImageRef).toBe('sheet-B.png');
    expect(reread2.characters.find((c) => c.name === 'Cara').referenceSheetImageRef).toBeNull();
  });

  it('returns cleared:0 and skips writes when no character matches', async () => {
    await seedUniverseWithCharacters([
      { name: 'Alex', physicalDescription: 'a', referenceSheetImageRef: 'sheet-A.png' },
    ]);
    const result = await canonSvc.purgeReferenceSheetFromAllUniverses('sheet-missing.png');
    expect(result.cleared).toBe(0);
  });

  it('returns cleared:0 when filename is empty / non-string (defensive guard)', async () => {
    await seedUniverseWithCharacters([
      { name: 'Alex', physicalDescription: 'a', referenceSheetImageRef: 'sheet-A.png' },
    ]);
    expect(await canonSvc.purgeReferenceSheetFromAllUniverses('')).toEqual({ cleared: 0 });
    expect(await canonSvc.purgeReferenceSheetFromAllUniverses(null)).toEqual({ cleared: 0 });
    expect(await canonSvc.purgeReferenceSheetFromAllUniverses(undefined)).toEqual({ cleared: 0 });
  });

  it('also clears matching variant keys inside referenceSheets map (blueprint, etc.)', async () => {
    // Mixed-shape fixture: Alex has the filename in the map slot, Beth has
    // the same filename in the legacy field — purge must clear both in one
    // call, regardless of which storage shape a given character used.
    const w1 = await seedUniverseWithCharacters([
      { name: 'Alex', physicalDescription: 'a', referenceSheets: { blueprint: 'shared.png' } },
      { name: 'Beth', physicalDescription: 'b', referenceSheetImageRef: 'shared.png' },
      { name: 'Cara', physicalDescription: 'c', referenceSheets: { blueprint: 'other.png', noir: 'shared.png' } },
    ]);
    const result = await canonSvc.purgeReferenceSheetFromAllUniverses('shared.png');
    expect(result.cleared).toBe(3);

    const reread = await svc.getUniverse(w1.id);
    const alex = reread.characters.find((c) => c.name === 'Alex');
    const beth = reread.characters.find((c) => c.name === 'Beth');
    const cara = reread.characters.find((c) => c.name === 'Cara');
    expect(alex.referenceSheets).toEqual({});
    expect(beth.referenceSheetImageRef).toBeNull();
    // Cara only loses the 'noir' key; 'blueprint' (pointing at a different
    // file) survives the purge.
    expect(cara.referenceSheets).toEqual({ blueprint: 'other.png' });
  });
});

describe('universeCanon — purgeImageRefFromAllUniverses', () => {
  it('strips a filename from every imageRefs[] across canon kinds', async () => {
    const w = await seedUniverseWithCharacters([
      { name: 'Alex', physicalDescription: 'a', imageRefs: ['shared.png', 'other.png'] },
      { name: 'Beth', physicalDescription: 'b', imageRefs: ['shared.png'] },
    ]);
    const result = await canonSvc.purgeImageRefFromAllUniverses('shared.png');
    expect(result.removed).toBe(2);
    const reread = (await svc.listUniverses()).find((u) => u.id === w.id);
    expect(reread.characters.find((c) => c.name === 'Alex').imageRefs).toEqual(['other.png']);
    expect(reread.characters.find((c) => c.name === 'Beth').imageRefs).toEqual([]);
  });

  it('returns removed:0 when nothing matches or input is invalid', async () => {
    await seedUniverseWithCharacters([
      { name: 'Alex', physicalDescription: 'a', imageRefs: ['only.png'] },
    ]);
    expect(await canonSvc.purgeImageRefFromAllUniverses('nope.png')).toEqual({ removed: 0 });
    expect(await canonSvc.purgeImageRefFromAllUniverses('')).toEqual({ removed: 0 });
    expect(await canonSvc.purgeImageRefFromAllUniverses(null)).toEqual({ removed: 0 });
  });
});
