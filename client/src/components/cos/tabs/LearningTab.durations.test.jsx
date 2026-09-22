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

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import LearningTab from './LearningTab';

const api = vi.hoisted(() => ({
  getCosLearning: vi.fn(),
  getCosLearningPerformance: vi.fn(),
  getCosLearningSkipped: vi.fn(),
  getCosLearningDurations: vi.fn(),
  getCosLearningRouting: vi.fn(),
  getCosLearningConfidence: vi.fn(),
  getCosFeedbackStats: vi.fn(),
  getDismissedCosRecommendations: vi.fn(),
  resetCosTaskTypeLearning: vi.fn(),
}));

vi.mock('../../../services/api', () => api);
vi.mock('../../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

const row = (avgDurationMs, completed) => ({
  avgDurationMs,
  avgDurationMin: Math.round(avgDurationMs / 60000),
  p80DurationMs: avgDurationMs,
  maxDurationMs: avgDurationMs,
  completed,
  successRate: 100,
});

describe('LearningTab — duration table reserved keys', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getCosLearning.mockResolvedValue({ totals: { completed: 9, succeeded: 9, avgDurationMs: 60000 }, recommendations: [] });
    api.getCosLearningPerformance.mockResolvedValue({ topPerformers: [], needsAttention: [], skipped: [] });
    api.getCosLearningSkipped.mockResolvedValue({ skippedCount: 0, skippedTypes: [] });
    api.getCosLearningRouting.mockResolvedValue({ byModelTier: {} });
    api.getCosLearningConfidence.mockResolvedValue({
      levels: { high: [], medium: [], low: [], new: [] },
      thresholds: { highThreshold: 80, lowThreshold: 50, minSamples: 5 },
      summary: { high: 0, medium: 0, low: 0, new: 0, total: 0, requireApproval: 0 },
    });
    api.getCosFeedbackStats.mockResolvedValue({ total: 0 });
    api.getDismissedCosRecommendations.mockResolvedValue({ dismissed: [] });
    api.getCosLearningDurations.mockResolvedValue({
      'self-improve:release-check': row(120000, 6),
      'user-task': row(60000, 3),
      _overall: row(90000, 9),
      _byExecution: { 'self-improve:release-check|ollama|local-coder|low': row(480000, 4) },
      _byExecutionProviderModel: { 'self-improve:release-check|ollama|local-coder': row(480000, 4) },
    });
  });

  it('counts and lists only real task types, never a reserved aggregate', async () => {
    render(<MemoryRouter><LearningTab /></MemoryRouter>);
    await userEvent.click(await screen.findByText('Duration Estimates'));

    expect(screen.getByText('(2 task types)')).toBeInTheDocument();
    expect(screen.getByText('self-improve:release-check')).toBeInTheDocument();
    expect(screen.getByText('user-task')).toBeInTheDocument();
    for (const reserved of ['_overall', '_byExecution', '_byExecutionProviderModel']) {
      expect(screen.queryByText(reserved), `${reserved} is an aggregate, not a task type`).not.toBeInTheDocument();
    }
  });
});
