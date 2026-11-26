import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import LearningTab from './LearningTab';

const api = vi.hoisted(() => ({
  getCosLearningDashboard: vi.fn(),
  getReviewerVerdictStats: vi.fn(),
  resetCosTaskTypeLearning: vi.fn(),
}));

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('../../../services/apiAgents.js', () => ({
  getCosLearningDashboard: api.getCosLearningDashboard,
  resetCosTaskTypeLearning: api.resetCosTaskTypeLearning,
}));
vi.mock('../../../services/apiCodeReview.js', () => ({ getReviewerVerdictStats: api.getReviewerVerdictStats }));
vi.mock('../../ui/Toast', () => ({ default: toast }));

const dashboard = {};

const renderTab = () => render(
  <MemoryRouter>
    <LearningTab />
  </MemoryRouter>
);

describe('LearningTab — Requires Approval controls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    dashboard.learning = {
      totals: { completed: 60, succeeded: 5, avgDurationMs: 60000 },
      recommendations: []
    };
    dashboard.performance = {
      topPerformers: [],
      needsAttention: [{ taskType: 'internal-task', successRate: 10, completed: 30, avgDurationMin: 5 }],
      skipped: []
    };
    dashboard.skipped = { skippedCount: 0, skippedTypes: [] };
    dashboard.durations = {};
    dashboard.routing = { byModelTier: {} };
    dashboard.feedback = { total: 0 };
    dashboard.dismissed = [];
    dashboard.reviewerVerdicts = { runs: 0, reports: 0, byReviewer: [], bySize: [] };
    api.resetCosTaskTypeLearning.mockResolvedValue({ reset: true });
    dashboard.confidence = {
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
    };
    api.getCosLearningDashboard.mockImplementation(async () => ({ ...dashboard }));
    api.getReviewerVerdictStats.mockImplementation(async () => dashboard.reviewerVerdicts);
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
    expect(api.getCosLearningDashboard).toHaveBeenCalledTimes(2);
    expect(api.getReviewerVerdictStats).not.toHaveBeenCalled();
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
