import { describe, it, expect } from 'vitest';
import {
  extractTaskType,
  calculateDurationETA,
  classifyUntypedTask,
  isSandboxedTaskType,
  EXTERNAL_UNTYPED_TASK_TYPE
} from './store.js';

// These two helpers are the pure foundation every other taskLearning submodule
// builds on (duration math + task-type classification). They take no I/O, so we
// exercise every branch arm directly without mocking the persistence layer.

describe('store.extractTaskType', () => {
  it('prefers metadata.analysisType (self-improve) over everything else', () => {
    expect(extractTaskType({ metadata: { analysisType: 'ui-bugs' } })).toBe('self-improve:ui-bugs');
  });

  it('accepts the forwarded taskAnalysisType alias', () => {
    expect(extractTaskType({ metadata: { taskAnalysisType: 'console' } })).toBe('self-improve:console');
  });

  it('maps an idle reviewType to idle-review', () => {
    expect(extractTaskType({ metadata: { reviewType: 'idle' } })).toBe('idle-review');
    expect(extractTaskType({ metadata: { taskReviewType: 'idle' } })).toBe('idle-review');
  });

  it('does not treat a non-idle reviewType as idle-review', () => {
    // falls through to the sandboxed fallback since nothing else matches (#2333)
    expect(extractTaskType({ metadata: { reviewType: 'manual' } })).toBe(EXTERNAL_UNTYPED_TASK_TYPE);
  });

  it('classifies mission tasks by mission name', () => {
    expect(extractTaskType({ metadata: { missionName: 'cleanup' } })).toBe('mission:cleanup');
  });

  it('classifies app-improvement tasks only when both taskApp and selfImprovementType present', () => {
    expect(extractTaskType({ metadata: { taskApp: 'foo', selfImprovementType: 'perf' } })).toBe('app-improve:perf');
    // taskApp with a selfImprovementType but no taskApp-pairing is caught by the
    // classifier as a self-improve domain (#2333)
    expect(extractTaskType({ metadata: { selfImprovementType: 'perf' } })).toBe('self-improve:perf');
  });

  it('parses a [self-improvement] description tag with a type token', () => {
    expect(extractTaskType({ description: '[self-improvement] accessibility - fix labels' }))
      .toBe('self-improve:accessibility');
  });

  it('falls back to self-improve:general when the tag has no type token', () => {
    expect(extractTaskType({ description: '[self-improvement] !!!' })).toBe('self-improve:general');
  });

  it('matches description tags case-insensitively', () => {
    expect(extractTaskType({ description: '[IDLE REVIEW] poke around' })).toBe('idle-review');
  });

  it('recognizes the auto-fix description variants', () => {
    expect(extractTaskType({ description: '[auto-fix] retry' })).toBe('auto-fix');
    expect(extractTaskType({ description: '[auto] investigate the crash' })).toBe('auto-fix');
  });

  it('recognizes both app-improvement spellings in the description', () => {
    expect(extractTaskType({ description: '[app-improvement] thing' })).toBe('app-improvement');
    expect(extractTaskType({ description: '[app improvement] thing' })).toBe('app-improvement');
  });

  it('classifies user and internal tasks by taskType when no pattern matches', () => {
    expect(extractTaskType({ taskType: 'user', description: 'do a thing' })).toBe('user-task');
    expect(extractTaskType({ taskType: 'internal', description: 'do a thing' })).toBe('internal-task');
  });

  it('returns the sandboxed fallback (never the old unknown) for an empty/undefined task', () => {
    expect(extractTaskType()).toBe(EXTERNAL_UNTYPED_TASK_TYPE);
    expect(extractTaskType({})).toBe(EXTERNAL_UNTYPED_TASK_TYPE);
    // regression guard: the blind 'unknown' sink is gone
    expect(extractTaskType({})).not.toBe('unknown');
  });
});

describe('store.classifyUntypedTask (issue #2333)', () => {
  it('infers a self-improve domain from a bare selfImprovementType hint', () => {
    expect(classifyUntypedTask({ metadata: { selfImprovementType: 'Perf Tuning' } }))
      .toBe('self-improve:perf-tuning');
  });

  it('maps an allow-listed explicit task.taskType the primary extractor did not special-case', () => {
    // Previously these all collapsed to 'unknown'
    expect(classifyUntypedTask({ taskType: 'scheduled' })).toBe('scheduled-task');
    expect(classifyUntypedTask({ taskType: 'architect' })).toBe('architect-task');
    // an already-namespaced type keeps its colon rather than getting a -task suffix
    expect(classifyUntypedTask({ taskType: 'self-improve:ui' })).toBe('self-improve:ui');
  });

  it('does not spawn a non-sandboxed bucket for an unexpected/high-cardinality taskType', () => {
    // Not allow-listed and not namespaced → falls through to the sandboxed fallback
    // rather than a routing-influencing `whatever-task` bucket.
    expect(classifyUntypedTask({ taskType: 'whatever-9f3a2b' })).toBe(EXTERNAL_UNTYPED_TASK_TYPE);
  });

  it('is round-trip stable: re-classifying the sandboxed fallback preserves the sandboxed bucket', () => {
    // Feeding external/untyped back through must NOT slug the `/` into a
    // non-sandboxed `external-untyped-task`.
    const rt = classifyUntypedTask({ taskType: EXTERNAL_UNTYPED_TASK_TYPE });
    expect(rt).toBe(EXTERNAL_UNTYPED_TASK_TYPE);
    expect(isSandboxedTaskType(rt)).toBe(true);
  });

  it('classifies free-form descriptions by keyword when no type token is present', () => {
    expect(classifyUntypedTask({ description: 'Investigate the crash in the pipeline' })).toBe('auto-fix');
    expect(classifyUntypedTask({ description: 'Refactor and clean up the store module' })).toBe('self-improve:general');
    expect(classifyUntypedTask({ description: 'Audit the routing accuracy code' })).toBe('idle-review');
    expect(classifyUntypedTask({ description: 'Add unit test coverage for the parser' })).toBe('test-task');
  });

  it('reads a description from metadata.taskDescription when top-level description is absent', () => {
    expect(classifyUntypedTask({ metadata: { taskDescription: 'fix the broken build' } })).toBe('auto-fix');
  });

  it('does not false-positive on a substring of a trigger word', () => {
    // "testing" / "fixture" must not trip the \b-anchored keyword rules
    expect(classifyUntypedTask({ description: 'contesting the fixtures inventory' }))
      .toBe(EXTERNAL_UNTYPED_TASK_TYPE);
  });

  it('falls back to external/untyped (a sandboxed type) when nothing matches', () => {
    const t = classifyUntypedTask({ description: 'ship the quarterly widgets' });
    expect(t).toBe(EXTERNAL_UNTYPED_TASK_TYPE);
    expect(isSandboxedTaskType(t)).toBe(true);
    expect(classifyUntypedTask(null)).toBe(EXTERNAL_UNTYPED_TASK_TYPE);
    expect(classifyUntypedTask('nope')).toBe(EXTERNAL_UNTYPED_TASK_TYPE);
  });

  it('is idempotent: same input always yields the same output', () => {
    const inputs = [
      { description: 'Investigate the crash' },
      { taskType: 'scheduled' },
      { metadata: { selfImprovementType: 'perf' } },
      {}
    ];
    for (const input of inputs) {
      const first = classifyUntypedTask(input);
      expect(classifyUntypedTask(input)).toBe(first);
      // re-classifying its own output-shaped task is stable (no drift)
      expect(classifyUntypedTask({ taskType: first })).toBe(classifyUntypedTask({ taskType: first }));
    }
  });

  it('only marks the fallback bucket as sandboxed', () => {
    expect(isSandboxedTaskType(EXTERNAL_UNTYPED_TASK_TYPE)).toBe(true);
    expect(isSandboxedTaskType('auto-fix')).toBe(false);
    expect(isSandboxedTaskType('unknown')).toBe(false);
  });
});

describe('store.calculateDurationETA', () => {
  it('uses success-only stats when successDurationMs is present', () => {
    const out = calculateDurationETA({
      successDurationMs: 600000, succeeded: 6, successMaxDurationMs: 200000,
      totalDurationMs: 9999999, completed: 99,
    });
    expect(out.avgDurationMs).toBe(100000); // 600000 / 6
    expect(out.maxDurationMs).toBe(200000);
    // p80 = round(min(avg*3, avg + 0.6*(max-avg))) = round(min(300000, 160000)) = 160000
    expect(out.p80DurationMs).toBe(160000);
  });

  it('falls back to total stats when there is no success data', () => {
    const out = calculateDurationETA({
      successDurationMs: 0, succeeded: 0,
      totalDurationMs: 400000, completed: 4,
    });
    expect(out.avgDurationMs).toBe(100000); // 400000 / 4
    // no success data → max defaults to avg, so p80 collapses to avg
    expect(out.maxDurationMs).toBe(100000);
    expect(out.p80DurationMs).toBe(100000);
  });

  it('returns all-zero stats when the count base is zero or missing', () => {
    expect(calculateDurationETA({ totalDurationMs: 100, completed: 0 }))
      .toEqual({ avgDurationMs: 0, maxDurationMs: 0, p80DurationMs: 0 });
    expect(calculateDurationETA({}))
      .toEqual({ avgDurationMs: 0, maxDurationMs: 0, p80DurationMs: 0 });
  });

  it('clamps p80 to at most avg*3 when the spread is very wide', () => {
    const out = calculateDurationETA({
      successDurationMs: 100000, succeeded: 1, successMaxDurationMs: 10000000,
    });
    expect(out.avgDurationMs).toBe(100000);
    // avg + 0.6*(max-avg) would be huge; the avg*3 cap wins → 300000
    expect(out.p80DurationMs).toBe(300000);
  });
});
