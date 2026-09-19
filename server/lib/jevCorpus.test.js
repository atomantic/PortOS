import { describe, expect, it } from 'vitest';
import {
  assertSplitDisjoint,
  buildCorpusExample,
  corpusExampleKey,
  corpusHash,
  dedupeCorpus,
  JEV_CORPUS_GOLD_FRACTION,
  JEV_CORPUS_MIN_GOLD,
  majorityClassAccuracy,
  splitCorpus,
  summarizeCorpusSources,
  toCorpusJsonl,
  validateCorpusRow,
} from './jevCorpus.js';

const OPTIONS = ['advances the goal', 'unrelated to the goal', 'works against the goal'];

const example = (n, { chosen = OPTIONS[0], source = 'merged-pr' } = {}) => buildCorpusExample({
  context: `Stated product goal (GOALS.md#a:${n}):\nship things\n\nProposed change (issue):\nTitle: change ${n}`,
  options: OPTIONS,
  chosen,
  source,
});

const corpusOf = (count, options = {}) => Array.from({ length: count }, (_unused, index) => example(index, options));

describe('buildCorpusExample', () => {
  it('records the label as the index of the chosen option', () => {
    expect(example(1).label).toBe(0);
    expect(example(1, { chosen: OPTIONS[2] }).label).toBe(2);
  });

  // A forge read is paginated and untidy; one unusable row must not fail a
  // build of four hundred, so this returns null rather than throwing.
  it('returns null rather than throwing on an unusable row', () => {
    expect(buildCorpusExample({ context: 'x', options: OPTIONS, chosen: 'not an option', source: 'merged-pr' })).toBeNull();
    expect(buildCorpusExample({ context: '', options: OPTIONS, chosen: OPTIONS[0], source: 'merged-pr' })).toBeNull();
    expect(buildCorpusExample({ context: 'x', options: [OPTIONS[0]], chosen: OPTIONS[0], source: 'merged-pr' })).toBeNull();
    expect(buildCorpusExample({ context: 'x', options: OPTIONS, chosen: OPTIONS[0], source: 'invented' })).toBeNull();
  });
});

describe('corpusExampleKey', () => {
  // Re-wording a hypothesis makes it a different question. Collapsing the two
  // would let a re-worded decision silently inherit the old split assignment,
  // which is how a gold row becomes a training row without anybody moving it.
  it('changes when the options change, not only when the context does', () => {
    const base = example(1);
    const reworded = { ...base, options: [...OPTIONS.slice(0, 2), 'contradicts the goal'] };
    expect(corpusExampleKey(reworded)).not.toBe(corpusExampleKey(base));
  });

  it('is stable across two constructions of the same example', () => {
    expect(corpusExampleKey(example(7))).toBe(corpusExampleKey(example(7)));
  });
});

describe('corpusHash', () => {
  it('ignores example order', () => {
    const rows = corpusOf(5);
    expect(corpusHash([...rows].reverse())).toBe(corpusHash(rows));
  });

  // A relabelled corpus is a different corpus even when it holds the same
  // questions — otherwise a head could claim provenance from a build that never
  // taught it what it learned.
  it('changes when a label changes', () => {
    const rows = corpusOf(5);
    const relabelled = [{ ...rows[0], label: 1 }, ...rows.slice(1)];
    expect(corpusHash(relabelled)).not.toBe(corpusHash(rows));
  });
});

describe('splitCorpus', () => {
  it('is deterministic across repeated builds', () => {
    const rows = corpusOf(200);
    const first = splitCorpus(rows);
    const second = splitCorpus([...rows].reverse());
    expect(new Set(second.gold.map(corpusExampleKey))).toEqual(new Set(first.gold.map(corpusExampleKey)));
  });

  it('holds out roughly the requested fraction', () => {
    const { train, gold } = splitCorpus(corpusOf(600));
    expect(train.length + gold.length).toBe(600);
    expect(Math.abs(gold.length / 600 - JEV_CORPUS_GOLD_FRACTION)).toBeLessThan(0.08);
  });

  // A repository re-states a goal across PRD.md and GOALS.md often enough that
  // the retriever pairs one change with two identical clauses. Left in, the
  // same question lands in both splits by definition of the hash — the
  // contamination arriving through the front door.
  it('drops a duplicated question before it can land in both splits', () => {
    const rows = corpusOf(4);
    const { train, gold } = splitCorpus([...rows, ...rows]);
    expect(train.length + gold.length).toBe(4);
  });
});

describe('dedupeCorpus', () => {
  it('keeps the first label when a question appears twice with different labels', () => {
    const first = example(1);
    const disagreeing = { ...first, label: 2 };
    expect(dedupeCorpus([first, disagreeing])).toEqual([first]);
  });
});

describe('assertSplitDisjoint — the refusal', () => {
  it('accepts a clean split', () => {
    const { train, gold } = splitCorpus(corpusOf(300));
    expect(assertSplitDisjoint({ train, gold }).ok).toBe(true);
  });

  // THE acceptance criterion. A gold set sharing rows with the training split
  // reports a score that is partly memorization, and that score is the only
  // evidence the adoption gate reads.
  it('refuses a split whose gold set overlaps the training split', () => {
    const { train, gold } = splitCorpus(corpusOf(300));
    const contaminated = [...gold, train[0]];
    expect(assertSplitDisjoint({ train, gold: contaminated }))
      .toEqual({ ok: false, code: 'jev-corpus-split-overlap', overlap: 1 });
  });

  it('refuses a gold set too small to separate three numbers', () => {
    const rows = corpusOf(200);
    const { train } = splitCorpus(rows);
    const tiny = splitCorpus(corpusOf(6)).gold;
    expect(tiny.length).toBeLessThan(JEV_CORPUS_MIN_GOLD);
    expect(assertSplitDisjoint({ train, gold: tiny }).code).toBe('jev-corpus-gold-too-small');
  });

  it('refuses a split with no training rows at all', () => {
    const { gold } = splitCorpus(corpusOf(300));
    expect(assertSplitDisjoint({ train: [], gold }).code).toBe('jev-corpus-split-invalid');
  });

  it('refuses a malformed split rather than reading it as empty', () => {
    expect(assertSplitDisjoint({}).code).toBe('jev-corpus-split-invalid');
  });
});

describe('majorityClassAccuracy', () => {
  it('is the share of the most common label', () => {
    const rows = [...corpusOf(3), ...corpusOf(1, { chosen: OPTIONS[1] })];
    expect(majorityClassAccuracy(rows)).toBeCloseTo(0.75, 5);
  });

  // `null`, never 0: an install with no gold rows has no baseline, and 0 would
  // read as "a constant prediction gets everything wrong" — which would make
  // any head look adoptable.
  it('reports null rather than zero on an empty gold set', () => {
    expect(majorityClassAccuracy([])).toBeNull();
  });
});

describe('serialization', () => {
  it('round-trips through JSONL', () => {
    const rows = corpusOf(3);
    const parsed = toCorpusJsonl(rows).split('\n').map((line) => validateCorpusRow(JSON.parse(line)));
    expect(parsed).toEqual(rows);
  });

  it('rejects a row whose label points past its options', () => {
    expect(validateCorpusRow({ context: 'x', options: OPTIONS, label: 9, source: 'merged-pr' })).toBeNull();
  });
});

describe('summarizeCorpusSources', () => {
  it('counts every known source, including the ones with no rows', () => {
    const rows = [...corpusOf(2), ...corpusOf(1, { source: 'parked-issue', chosen: OPTIONS[1] })];
    expect(summarizeCorpusSources(rows)).toEqual({
      'merged-pr': 2,
      'closed-unmerged-pr': 0,
      'closed-not-planned-issue': 0,
      'parked-issue': 1,
    });
  });
});
