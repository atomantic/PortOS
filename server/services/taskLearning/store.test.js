import { describe, it, expect } from 'vitest';
import { extractTaskType, calculateDurationETA } from './store.js';

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
    // falls through to 'unknown' since nothing else matches
    expect(extractTaskType({ metadata: { reviewType: 'manual' } })).toBe('unknown');
  });

  it('classifies mission tasks by mission name', () => {
    expect(extractTaskType({ metadata: { missionName: 'cleanup' } })).toBe('mission:cleanup');
  });

  it('classifies app-improvement tasks only when both taskApp and selfImprovementType present', () => {
    expect(extractTaskType({ metadata: { taskApp: 'foo', selfImprovementType: 'perf' } })).toBe('app-improve:perf');
    // taskApp without selfImprovementType falls through
    expect(extractTaskType({ metadata: { taskApp: 'foo' } })).toBe('unknown');
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

  it('returns unknown for an empty/undefined task', () => {
    expect(extractTaskType()).toBe('unknown');
    expect(extractTaskType({})).toBe('unknown');
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
