import { describe, it, expect } from 'vitest';
import {
  normalizeToken,
  formatTaxonomyToken,
  tallyTaxonomy,
  renderTallyLine,
  createTaxonomyTally
} from './taxonomyTally.js';

// A tiny fixture taxonomy exercising the engine directly (independent of the two LI
// consumers, whose own suites pin the domain-facing contracts).
const VOCAB = ['alpha', 'beta', 'gamma'];
const SENTINEL = 'unknown-x';
const LABELS = { alpha: 'the alpha cause', beta: 'the beta cause', gamma: 'the gamma cause', [SENTINEL]: 'no known cause' };
const gloss = (t) => formatTaxonomyToken(t, LABELS);
const config = {
  predicate: (r) => r.kind === 'counted',
  select: (r) => r.token,
  field: 'token',
  vocabulary: VOCAB,
  sentinel: SENTINEL,
  glossFn: gloss,
  gapWording: {
    unknown: (n, total) => `${n} of ${total} with no known cause`,
    unclassified: (n, total) => `${n} of ${total} not yet classified`
  }
};
const rec = (token) => ({ kind: 'counted', token });

describe('normalizeToken', () => {
  it('lowercases and collapses separators', () => {
    expect(normalizeToken('Not_Planned')).toBe('not-planned');
    expect(normalizeToken('Test Failure')).toBe('test-failure');
    expect(normalizeToken('  git---conflict  ')).toBe('git-conflict');
  });

  it('returns empty string for a non-string', () => {
    expect(normalizeToken(null)).toBe('');
    expect(normalizeToken(undefined)).toBe('');
    expect(normalizeToken(42)).toBe('');
  });
});

describe('formatTaxonomyToken', () => {
  it('glosses a known token and passes an unglossed token through', () => {
    expect(formatTaxonomyToken('alpha', LABELS)).toBe('the alpha cause');
    expect(formatTaxonomyToken('future-token', LABELS)).toBe('future-token');
  });

  it('renders a nullish input as empty, never a sentinel', () => {
    expect(formatTaxonomyToken(null, LABELS)).toBe('');
    expect(formatTaxonomyToken(undefined, LABELS)).toBe('');
    expect(formatTaxonomyToken('', LABELS)).toBe('');
  });
});

describe('tallyTaxonomy', () => {
  it('counts only population records, commonest first, and keys entries by field', () => {
    const { entries, diagnosed, total } = tallyTaxonomy(
      [rec('beta'), rec('beta'), rec('alpha'), { kind: 'ignored', token: 'beta' }],
      config
    );
    expect(entries).toEqual([{ token: 'beta', count: 2 }, { token: 'alpha', count: 1 }]);
    expect(diagnosed).toBe(2 + 1);
    expect(total).toBe(3);
  });

  it('breaks count ties by vocabulary order, independent of record order', () => {
    const forward = tallyTaxonomy([rec('gamma'), rec('alpha')], config);
    const reverse = tallyTaxonomy([rec('alpha'), rec('gamma')], config);
    expect(forward.entries.map((e) => e.token)).toEqual(['alpha', 'gamma']);
    expect(forward.entries).toEqual(reverse.entries);
  });

  it('separates the sentinel (unknown) from absent/unrecognized (unclassified)', () => {
    const { entries, unknown, unclassified, diagnosed, total } = tallyTaxonomy(
      [rec('alpha'), rec(SENTINEL), rec(null), rec('not-in-vocab')],
      config
    );
    expect(entries).toEqual([{ token: 'alpha', count: 1 }]);
    expect(unknown).toBe(1);
    expect(unclassified).toBe(2);
    expect(diagnosed).toBe(1);
    expect(total).toBe(4);
  });

  it('tolerates junk input and nullish records', () => {
    expect(tallyTaxonomy(null, config).total).toBe(0);
    expect(tallyTaxonomy([null, undefined, 'x'], config).total).toBe(0);
  });
});

describe('renderTallyLine', () => {
  it('returns empty ONLY when the population is empty', () => {
    expect(renderTallyLine(tallyTaxonomy([], config), config)).toBe('');
  });

  it('lists glossed diagnoses with counts, then names every non-zero gap', () => {
    const summary = tallyTaxonomy([rec('alpha'), rec('alpha'), rec(SENTINEL), rec(null)], config);
    const line = renderTallyLine(summary, config);
    expect(line).toBe('the alpha cause (2) — 1 of 4 with no known cause — 1 of 4 not yet classified');
  });

  it('caps listed diagnoses at the limit but still counts the gap over everything', () => {
    const summary = tallyTaxonomy([rec('alpha'), rec('beta'), rec('gamma'), rec(SENTINEL)], config);
    const line = renderTallyLine(summary, { ...config, limit: 2 });
    expect(line.split(' — ')[0].split(';').length).toBe(2);
    expect(line).toContain('1 of 4 with no known cause');
  });

  it('never falls silent on an all-undiagnosed population', () => {
    const summary = tallyTaxonomy([rec(null), rec(null)], config);
    expect(renderTallyLine(summary, config)).toBe('2 of 2 not yet classified');
  });
});

describe('createTaxonomyTally', () => {
  it('binds a config into a { summarize, format } pair', () => {
    const { summarize, format } = createTaxonomyTally(config);
    expect(summarize([rec('beta'), rec('beta')]).entries).toEqual([{ token: 'beta', count: 2 }]);
    expect(format([rec('alpha')])).toBe('the alpha cause (1)');
    expect(format([])).toBe('');
  });

  it('threads the limit through format', () => {
    const { format } = createTaxonomyTally(config);
    const line = format([rec('alpha'), rec('beta'), rec('gamma')], 1);
    expect(line.split(';').length).toBe(1);
  });
});
