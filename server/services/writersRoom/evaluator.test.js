import { describe, it, expect, vi } from 'vitest';

// evaluator.js pulls in the whole extraction/LLM graph at module top. Stub the
// heavy siblings so this unit test can import it cheaply — it only exercises the
// pure KIND_META map + the `cuts`/`revise` SHAPERS, which depend on nothing but
// stripCodeFences (aiProvider) and CUT_TYPES (cutApplier, real).
vi.mock('../aiProvider.js', () => ({ stripCodeFences: (s) => String(s ?? '') }));
vi.mock('../stageRunner.js', () => ({ runStagedLLM: vi.fn() }));
vi.mock('../bibleExtractor.js', () => ({ extractBible: vi.fn() }));
vi.mock('../sceneExtractor.js', () => ({ extractScenes: vi.fn(), SOURCE_KIND: { PROSE: 'prose' } }));
vi.mock('../../lib/storyBible.js', () => ({ BIBLE_KIND: { CHARACTER: 'character', PLACE: 'place', OBJECT: 'object' } }));
vi.mock('./local.js', () => ({ getWorkWithBody: vi.fn(), ensureWorkMediaCollection: vi.fn() }));
vi.mock('../mediaCollections.js', () => ({ addItem: vi.fn(), ERR_DUPLICATE: 'DUP' }));
vi.mock('./characters.js', () => ({ listCharacters: vi.fn(), mergeExtractedCharacters: vi.fn() }));
vi.mock('./places.js', () => ({ listPlaces: vi.fn(), mergeExtractedPlaces: vi.fn() }));
vi.mock('./objects.js', () => ({ listObjects: vi.fn(), mergeExtractedObjects: vi.fn() }));

// In-memory analysis store with an async gap between load and save, so an unserialized
// read-modify-write cycle would lose one of two concurrent attaches.
const store = new Map();
vi.mock('./analysisSnapshots.js', async (importActual) => ({
  ...(await importActual()),
  loadAnalysis: async (w, id) => {
    const v = store.get(`${w}:${id}`);
    await new Promise((r) => setTimeout(r, 5));
    return v ? structuredClone(v) : null;
  },
  saveAnalysis: async (w, snap) => {
    await new Promise((r) => setTimeout(r, 5));
    store.set(`${w}:${snap.id}`, structuredClone(snap));
  },
}));

const { KIND_META, SHAPERS, attachSceneImage } = await import('./evaluator.js');

describe('attachSceneImage', () => {
  it('keeps both links when two scenes attach concurrently', async () => {
    store.set('wr-work-1:script', { id: 'script', sceneImages: {} });
    await Promise.all([
      attachSceneImage('wr-work-1', 'script', { sceneId: 's1', filename: 'a.png' }),
      attachSceneImage('wr-work-1', 'script', { sceneId: 's2', filename: 'b.png' }),
    ]);
    const saved = store.get('wr-work-1:script');
    expect(Object.keys(saved.sceneImages).sort()).toEqual(['s1', 's2']);
  });
});

describe('KIND_META', () => {
  it('registers the cuts + revise Polish pass kinds with stage + returnsJson', () => {
    expect(KIND_META.cuts).toEqual({ stage: 'writers-room-cuts', returnsJson: true });
    expect(KIND_META.revise).toEqual({ stage: 'writers-room-revise', returnsJson: false });
  });

  it('still carries the standalone analysis kinds', () => {
    for (const k of ['evaluate', 'format', 'script', 'characters', 'places', 'objects']) {
      expect(KIND_META[k]).toHaveProperty('stage');
      expect(typeof KIND_META[k].returnsJson).toBe('boolean');
    }
  });
});

describe('SHAPERS.cuts', () => {
  it('shapes typed cut findings and drops ones without an anchor quote or valid type', () => {
    const raw = JSON.stringify({
      fat_percentage: 9,
      tightest_passage: 'the best line',
      loosest_passage: 'the worst line',
      one_sentence_verdict: 'A touch loose.',
      findings: [
        { severity: 'high', anchorQuote: 'a redundant restatement here', cutType: 'REDUNDANT', problem: 'dup' },
        { anchorQuote: '', cutType: 'FAT' },            // no anchor → dropped
        { anchorQuote: 'unknown type quote', cutType: 'NONSENSE' }, // bad type → dropped
      ],
    });
    const shaped = SHAPERS.cuts(raw);
    expect(shaped.fatPercentage).toBe(9);
    expect(shaped.tightestPassage).toBe('the best line');
    expect(shaped.findings).toHaveLength(1);
    expect(shaped.findings[0]).toMatchObject({ anchorQuote: 'a redundant restatement here', cutType: 'REDUNDANT' });
  });

  it('tolerates a missing findings array', () => {
    const shaped = SHAPERS.cuts(JSON.stringify({ fat_percentage: 0 }));
    expect(shaped.findings).toEqual([]);
    expect(shaped.fatPercentage).toBe(0);
  });

  it('accepts the parsed object returned by a returnsJson staged pass', () => {
    const shaped = SHAPERS.cuts({ fat_percentage: 4, findings: [] });
    expect(shaped).toMatchObject({ fatPercentage: 4, findings: [] });
  });
});

describe('SHAPERS.revise', () => {
  it('returns the prose body, stripping a markdown fence', () => {
    expect(SHAPERS.revise('  Just prose.  ')).toEqual({ revisedBody: 'Just prose.' });
    expect(SHAPERS.revise('```markdown\nFenced prose.\n```')).toEqual({ revisedBody: 'Fenced prose.' });
  });
});
