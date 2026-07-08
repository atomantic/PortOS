import { describe, it, expect, vi } from 'vitest';

// evaluator.js pulls in the whole extraction/LLM graph at module top. Stub the
// heavy siblings so this unit test can import it cheaply — it only exercises the
// pure KIND_META map + the `cuts`/`revise` SHAPERS, which depend on nothing but
// stripCodeFences (aiProvider) and CUT_TYPES (cutApplier, real).
vi.mock('../../lib/aiProvider.js', () => ({ stripCodeFences: (s) => String(s ?? '') }));
vi.mock('../../lib/stageRunner.js', () => ({ runStagedLLM: vi.fn() }));
vi.mock('../../lib/bibleExtractor.js', () => ({ extractBible: vi.fn() }));
vi.mock('../../lib/sceneExtractor.js', () => ({ extractScenes: vi.fn(), SOURCE_KIND: { PROSE: 'prose' } }));
vi.mock('../../lib/storyBible.js', () => ({ BIBLE_KIND: { CHARACTER: 'character', PLACE: 'place', OBJECT: 'object' } }));
vi.mock('./local.js', () => ({ getWorkWithBody: vi.fn(), ensureWorkMediaCollection: vi.fn() }));
vi.mock('../mediaCollections.js', () => ({ addItem: vi.fn(), ERR_DUPLICATE: 'DUP' }));
vi.mock('./characters.js', () => ({ listCharacters: vi.fn(), mergeExtractedCharacters: vi.fn() }));
vi.mock('./places.js', () => ({ listPlaces: vi.fn(), mergeExtractedPlaces: vi.fn() }));
vi.mock('./objects.js', () => ({ listObjects: vi.fn(), mergeExtractedObjects: vi.fn() }));

const { KIND_META, SHAPERS } = await import('./evaluator.js');

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
});

describe('SHAPERS.revise', () => {
  it('returns the prose body, stripping a markdown fence', () => {
    expect(SHAPERS.revise('  Just prose.  ')).toEqual({ revisedBody: 'Just prose.' });
    expect(SHAPERS.revise('```markdown\nFenced prose.\n```')).toEqual({ revisedBody: 'Fenced prose.' });
  });
});
