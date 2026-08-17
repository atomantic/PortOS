import { describe, expect, it } from 'vitest';
import { EXTERNAL_UNTYPED_TASK_TYPE, extractCosTaskType } from './cosTaskType';

describe('extractCosTaskType', () => {
  it('keeps a scheduled analysis bucket ahead of generic words in its description', () => {
    expect(extractCosTaskType({
      description: '[Self-Improvement] security audit: fix exposed configuration',
      taskType: 'internal',
      metadata: { analysisType: 'security' }
    })).toBe('self-improve:security');
  });

  it('recognizes the archived agent analysis projection', () => {
    expect(extractCosTaskType({
      description: 'Improve the CoS task prompt',
      taskType: 'internal',
      metadata: { taskAnalysisType: 'feature-ideas' }
    })).toBe('self-improve:feature-ideas');
  });

  it('keeps user work in the user-task bucket used by learning metrics', () => {
    expect(extractCosTaskType({
      description: 'Fix the failing import',
      taskType: 'user'
    })).toBe('user-task');
  });

  // The `ux` audit (#3273) is a scheduled self-improvement type like any other:
  // TaskItem/AgentCard classify it through this resolver, which is metadata-first
  // and type-agnostic — so the new type needs no per-type heuristic, and adding
  // one could only shadow a sibling. These pin that: a `ux` task lands in its own
  // bucket even though its description is full of words the untyped classifiers
  // key on ("review", "audit"), and the sibling viewport type is unaffected.
  it('buckets scheduled ux audits and mobile-responsive runs by their own analysis type', () => {
    expect(extractCosTaskType({
      description: '[Self-Improvement] ux: review the design of each route',
      taskType: 'internal',
      metadata: { analysisType: 'ux' }
    })).toBe('self-improve:ux');

    expect(extractCosTaskType({
      description: '[Self-Improvement] mobile-responsive: check each viewport',
      taskType: 'internal',
      metadata: { analysisType: 'mobile-responsive' }
    })).toBe('self-improve:mobile-responsive');

    // Archived-agent projection of the same run.
    expect(extractCosTaskType({
      description: 'UX/design audit',
      taskType: 'internal',
      metadata: { taskAnalysisType: 'ux' }
    })).toBe('self-improve:ux');
  });

  it('supports tagged legacy tasks and safe untyped fallbacks', () => {
    expect(extractCosTaskType({ description: '[self-improvement] accessibility - fix labels' }))
      .toBe('self-improve:accessibility');
    expect(extractCosTaskType({ description: 'unclassified task' }))
      .toBe(EXTERNAL_UNTYPED_TASK_TYPE);
  });
});
// @vitest-environment node
