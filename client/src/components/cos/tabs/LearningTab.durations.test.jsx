/**
 * Reserved-key handling in the duration table (#8001).
 *
 * `/api/cos/learning/durations` keeps real task types top-level and rides its
 * non-task-type aggregates on `_`-prefixed keys. The table used to skip only the
 * literal `_overall` and count rows as `Object.keys(durations).length - 1`, so the
 * execution-scoped maps added for this issue would have rendered as bogus
 * "task type" rows (with an empty duration, since they hold no `avgDurationMs`)
 * and inflated the count beside the heading.
 */

import { describe, expect, it } from 'vitest';
import { taskTypeDurationRows } from './LearningTab';

const row = (avgDurationMs, completed) => ({
  avgDurationMs,
  avgDurationMin: Math.round(avgDurationMs / 60000),
  p80DurationMs: avgDurationMs,
  maxDurationMs: avgDurationMs,
  completed,
  successRate: 100,
});

describe('taskTypeDurationRows', () => {
  it('keeps only real task types, slowest first, whatever reserved keys ride along', () => {
    const rows = taskTypeDurationRows({
      'user-task': row(60000, 3),
      'self-improve:release-check': row(120000, 6),
      _overall: row(90000, 9),
      _byExecution: { 'self-improve:release-check|ollama|local-coder|low': row(480000, 4) },
      _byExecutionProviderModel: { 'self-improve:release-check|ollama|local-coder': row(480000, 4) },
    });

    // Both the table and the "(N task types)" count read this list, so its length
    // is the count — no reserved key can inflate it and none renders a blank row.
    expect(rows.map(([taskType]) => taskType)).toEqual(['self-improve:release-check', 'user-task']);
  });

  it('answers an empty list before any history has loaded', () => {
    expect(taskTypeDurationRows(null)).toEqual([]);
    expect(taskTypeDurationRows({})).toEqual([]);
  });
});
