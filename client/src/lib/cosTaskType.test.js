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

  it('supports tagged legacy tasks and safe untyped fallbacks', () => {
    expect(extractCosTaskType({ description: '[self-improvement] accessibility - fix labels' }))
      .toBe('self-improve:accessibility');
    expect(extractCosTaskType({ description: 'unclassified task' }))
      .toBe(EXTERNAL_UNTYPED_TASK_TYPE);
  });
});
