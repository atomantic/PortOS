import { describe, it, expect } from 'vitest';
import {
  EXECUTION_FAILURE_CATEGORIES,
  EXECUTION_FAILURE_VALUES,
  UNKNOWN_EXECUTION_FAILURE,
  classifyExecutionFailure,
  formatExecutionFailure,
  formatExecutionFailures,
  summarizeExecutionFailures
} from './layeredIntelligenceExecutionFailures.js';

// A minimal failed-execution outcome record.
const failed = (failureCategory) => ({ executionOutcome: 'failure', failureCategory });

describe('execution-failure taxonomy vocabulary', () => {
  it('keeps the unknown sentinel OUT of the diagnosis vocabulary but inside the storable values', () => {
    expect(EXECUTION_FAILURE_CATEGORIES).not.toContain(UNKNOWN_EXECUTION_FAILURE);
    expect(EXECUTION_FAILURE_VALUES).toContain(UNKNOWN_EXECUTION_FAILURE);
    expect(EXECUTION_FAILURE_VALUES).toEqual([...EXECUTION_FAILURE_CATEGORIES, UNKNOWN_EXECUTION_FAILURE]);
  });

  it('carries exactly the five #2764 §1 categories', () => {
    expect(EXECUTION_FAILURE_CATEGORIES).toEqual(['planning', 'execution', 'testing', 'context', 'scope']);
  });

  it('has no duplicate tokens', () => {
    expect(new Set(EXECUTION_FAILURE_VALUES).size).toBe(EXECUTION_FAILURE_VALUES.length);
  });

  it('glosses every storable token, and passes an unglossed token through', () => {
    for (const token of EXECUTION_FAILURE_VALUES) {
      expect(formatExecutionFailure(token)).toBeTruthy();
      expect(typeof formatExecutionFailure(token)).toBe('string');
    }
    expect(formatExecutionFailure('some-future-token')).toBe('some-future-token');
  });

  it('renders a nullish (unclassified) input as empty, NOT as the unknown sentinel', () => {
    expect(formatExecutionFailure(null)).toBe('');
    expect(formatExecutionFailure(undefined)).toBe('');
    expect(formatExecutionFailure('')).toBe('');
  });
});

describe('classifyExecutionFailure', () => {
  it('returns null when the execution did not fail', () => {
    expect(classifyExecutionFailure({ success: true, errorCategory: 'test-failure' })).toBeNull();
    expect(classifyExecutionFailure({ success: null, executionOutcome: 'success' })).toBeNull();
    // Nothing at all → nothing to diagnose.
    expect(classifyExecutionFailure({})).toBeNull();
  });

  it('maps raw error categories to the taxonomy', () => {
    expect(classifyExecutionFailure({ success: false, errorCategory: 'test-failure' })).toBe('testing');
    expect(classifyExecutionFailure({ success: false, errorCategory: 'build-error' })).toBe('testing');
    expect(classifyExecutionFailure({ success: false, errorCategory: 'lint-error' })).toBe('testing');
    expect(classifyExecutionFailure({ success: false, errorCategory: 'git-conflict' })).toBe('execution');
    expect(classifyExecutionFailure({ success: false, errorCategory: 'tool-error' })).toBe('execution');
    expect(classifyExecutionFailure({ success: false, errorCategory: 'context-length' })).toBe('context');
    expect(classifyExecutionFailure({ success: false, errorCategory: 'file-not-found' })).toBe('context');
    expect(classifyExecutionFailure({ success: false, errorCategory: 'turn-limit' })).toBe('context');
    expect(classifyExecutionFailure({ success: false, errorCategory: 'task-rejected' })).toBe('scope');
    expect(classifyExecutionFailure({ success: false, errorCategory: 'content-filtered' })).toBe('scope');
    expect(classifyExecutionFailure({ success: false, errorCategory: 'no-changes' })).toBe('planning');
  });

  it('normalizes separators and case in the raw category', () => {
    expect(classifyExecutionFailure({ success: false, errorCategory: 'Test_Failure' })).toBe('testing');
    expect(classifyExecutionFailure({ success: false, errorCategory: 'GIT CONFLICT' })).toBe('execution');
  });

  it('classifies a clean-exit validation miss (no error category) as testing', () => {
    // The run exited without a recognized error but missed its declared criterion —
    // a regression the error sweep produced no category for.
    expect(classifyExecutionFailure({ success: false, errorCategory: null, validationPassed: false })).toBe('testing');
  });

  it('falls through to the unknown sentinel when a failure has no usable signal', () => {
    expect(classifyExecutionFailure({ success: false, errorCategory: null, validationPassed: null })).toBe(UNKNOWN_EXECUTION_FAILURE);
    // An environmental token that slipped past the upstream filter is not a
    // capability signal — it reads as unknown, never a fabricated taxonomy token.
    expect(classifyExecutionFailure({ success: false, errorCategory: 'rate-limit' })).toBe(UNKNOWN_EXECUTION_FAILURE);
  });

  it('re-diagnoses a persisted record from executionOutcome when no explicit success is given', () => {
    expect(classifyExecutionFailure({ executionOutcome: 'failure', errorCategory: 'test-failure' })).toBe('testing');
  });

  it('is deterministic', () => {
    const args = { success: false, errorCategory: 'git-error', validationPassed: false };
    expect(classifyExecutionFailure(args)).toBe(classifyExecutionFailure(args));
  });
});

describe('summarizeExecutionFailures', () => {
  it('counts only failed-execution records, commonest first', () => {
    const { entries, total, diagnosed } = summarizeExecutionFailures([
      failed('testing'),
      failed('testing'),
      failed('execution'),
      { executionOutcome: 'success', failureCategory: null }, // ignored
      { executionOutcome: null, failureCategory: null }        // never executed, ignored
    ]);
    expect(entries).toEqual([{ category: 'testing', count: 2 }, { category: 'execution', count: 1 }]);
    expect(total).toBe(3);
    expect(diagnosed).toBe(3);
  });

  it('breaks count ties by taxonomy order for stable output', () => {
    const { entries } = summarizeExecutionFailures([failed('scope'), failed('planning')]);
    // planning precedes scope in EXECUTION_FAILURE_CATEGORIES → planning first on a tie.
    expect(entries.map(e => e.category)).toEqual(['planning', 'scope']);
  });

  it('separates the unknown sentinel from unclassified records', () => {
    const { entries, unknown, unclassified, diagnosed, total } = summarizeExecutionFailures([
      failed('execution'),
      failed(UNKNOWN_EXECUTION_FAILURE),
      failed(null),                 // never classified (pre-field / no signal path)
      failed('bogus-future-token')  // unrecognized → unclassified, not a finding
    ]);
    expect(entries).toEqual([{ category: 'execution', count: 1 }]);
    expect(unknown).toBe(1);
    expect(unclassified).toBe(2);
    expect(diagnosed).toBe(1);
    expect(total).toBe(4);
  });

  it('reports zero across the board for an empty / all-success history', () => {
    expect(summarizeExecutionFailures([]).total).toBe(0);
    expect(summarizeExecutionFailures([{ executionOutcome: 'success', failureCategory: null }]).total).toBe(0);
    expect(summarizeExecutionFailures('not-an-array').total).toBe(0);
  });
});

describe('formatExecutionFailures', () => {
  it('returns empty ONLY when nothing has failed', () => {
    expect(formatExecutionFailures([])).toBe('');
    expect(formatExecutionFailures([{ executionOutcome: 'success' }])).toBe('');
  });

  it('lists the commonest diagnoses, glossed', () => {
    const line = formatExecutionFailures([failed('testing'), failed('testing'), failed('execution')]);
    expect(line).toContain('(2)');
    expect(line).toContain('regression');
  });

  it('names every non-zero gap rather than falling silent', () => {
    const line = formatExecutionFailures([failed(UNKNOWN_EXECUTION_FAILURE), failed(null)]);
    expect(line).toContain('1 of 2 failed with no recognized cause');
    expect(line).toContain('1 of 2 not yet classified');
  });

  it('respects the limit on listed diagnoses', () => {
    const line = formatExecutionFailures(
      [failed('planning'), failed('execution'), failed('testing'), failed('context')],
      2
    );
    // Four distinct single-count categories; only two are listed.
    expect(line.split(';').length).toBe(2);
  });
});
