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

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../../services/api', () => api);
vi.mock('../../ui/Toast', () => ({ default: toast }));

const renderTab = () => render(
  <MemoryRouter>
    <LearningTab />
  </MemoryRouter>
);

describe('LearningTab — Requires Approval controls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getCosLearning.mockResolvedValue({
      totals: { completed: 60, succeeded: 5, avgDurationMs: 60000 },
      recommendations: []
    });
    api.getCosLearningPerformance.mockResolvedValue({
      topPerformers: [],
      needsAttention: [{ taskType: 'internal-task', successRate: 10, completed: 30, avgDurationMin: 5 }],
      skipped: []
    });
    api.getCosLearningSkipped.mockResolvedValue({ skippedCount: 0, skippedTypes: [] });
    api.getCosLearningDurations.mockResolvedValue({});
    api.getCosLearningRouting.mockResolvedValue({ byModelTier: {} });
    api.getCosFeedbackStats.mockResolvedValue({ total: 0 });
    api.getDismissedCosRecommendations.mockResolvedValue({ dismissed: [] });
    api.resetCosTaskTypeLearning.mockResolvedValue({ reset: true });
    api.getCosLearningConfidence.mockResolvedValue({
      levels: {
        high: [],
        medium: [],
        low: [
          { taskType: 'internal-task', successRate: 10, completed: 30, rateSource: 'windowed', windowedCompleted: 30 },
          { taskType: 'self-improve:claim-issue', successRate: 3, completed: 30, rateSource: 'windowed', windowedCompleted: 30 },
        ],
        new: []
      },
      thresholds: { highThreshold: 80, lowThreshold: 50, minSamples: 5 },
      summary: { high: 0, medium: 0, low: 2, new: 0, total: 2, requireApproval: 2 }
    });
  });

  it('renders Requires Approval table with Mark resolved on each row and link to Tasks tab', async () => {
    const user = userEvent.setup();
    renderTab();

    expect(await screen.findByText('Requires Approval (2)')).toBeInTheDocument();
    expect(screen.getAllByText('internal-task').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('self-improve:claim-issue')).toBeInTheDocument();

    const tasksLink = screen.getByRole('link', { name: 'Tasks tab' });
    expect(tasksLink).toBeInTheDocument();
    expect(tasksLink).toHaveAttribute('href', '/cos/tasks');

    const markInternalTaskBtn = screen.getByRole('button', { name: 'Mark internal-task resolved' });
    expect(markInternalTaskBtn).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark self-improve:claim-issue resolved' })).toBeInTheDocument();

    await user.click(markInternalTaskBtn);
    expect(api.resetCosTaskTypeLearning).toHaveBeenCalledWith('internal-task');
  });

  it('provides Mark all resolved button when multiple items require approval', async () => {
    const user = userEvent.setup();
    renderTab();

    const markAllButton = await screen.findByRole('button', { name: 'Mark all resolved' });
    expect(markAllButton).toBeInTheDocument();

    await user.click(markAllButton);
    expect(api.resetCosTaskTypeLearning).toHaveBeenCalledWith('internal-task');
    expect(api.resetCosTaskTypeLearning).toHaveBeenCalledWith('self-improve:claim-issue');
  });
});
