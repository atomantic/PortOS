import { beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
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
  backfillCosLearning: vi.fn(),
}));

vi.mock('../../../services/api', () => api);
vi.mock('../../ui/Toast', () => ({ default: { success: vi.fn(), error: vi.fn() } }));

const renderTab = () => render(<MemoryRouter><LearningTab /></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  api.getCosLearning.mockResolvedValue({ totals: { completed: 12, succeeded: 10, failed: 2, successRate: 83 }, recommendations: [] });
  api.getCosLearningPerformance.mockResolvedValue({ topPerformers: [], needsAttention: [] });
  api.getCosLearningSkipped.mockResolvedValue({ skippedCount: 0, skippedTypes: [] });
  api.getCosLearningDurations.mockResolvedValue({});
  api.getCosLearningRouting.mockResolvedValue({ matrix: [] });
  api.getCosLearningConfidence.mockResolvedValue({});
  api.getCosFeedbackStats.mockResolvedValue({ total: 0 });
  api.getDismissedCosRecommendations.mockResolvedValue({ dismissed: [] });
});

describe('LearningTab failed reads', () => {
  // A failed summary read used to say "No learning data available yet" and offer
  // Backfill History, as if the install had never recorded a completed task.
  it('shows a failed summary read with Retry, not the empty state and Backfill', async () => {
    api.getCosLearning.mockRejectedValueOnce(new Error('Synthetic learning failure'));
    renderTab();

    expect(await screen.findByText('Could not load learning analytics')).toBeInTheDocument();
    expect(screen.queryByText('No learning data available yet.')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Backfill History/ })).not.toBeInTheDocument();
    expect(api.getCosLearning).toHaveBeenCalledWith({ silent: true });

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Tasks Analyzed')).toBeInTheDocument();
    expect(screen.queryByText('Could not load learning analytics')).not.toBeInTheDocument();
  });

  it('names a failed section read instead of showing its counts as zero', async () => {
    api.getCosLearningSkipped.mockRejectedValueOnce(new Error('Synthetic skipped failure'));
    renderTab();

    expect(await screen.findByText(/Could not load some learning sections \(skipped tasks\)/)).toBeInTheDocument();
    expect(screen.getByText('not loaded')).toBeInTheDocument();
    expect(screen.queryByText('due to low success')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Tasks Analyzed')).toBeInTheDocument();
    expect(screen.queryByText(/Could not load some learning sections/)).not.toBeInTheDocument();
  });

  // StrictMode mounts twice, so two batches overlap; the older one failing after
  // the newer one succeeded must not replace the loaded view with an error.
  it('ignores an older batch that fails after a newer one loaded', async () => {
    let failFirst;
    api.getCosLearning
      .mockImplementationOnce(() => new Promise((_, reject) => { failFirst = reject; }))
      .mockResolvedValueOnce({ totals: { completed: 12, succeeded: 10, failed: 2, successRate: 83 }, recommendations: [] });
    render(<StrictMode><MemoryRouter><LearningTab /></MemoryRouter></StrictMode>);

    expect(await screen.findByText('Tasks Analyzed')).toBeInTheDocument();
    await act(async () => failFirst(new Error('Synthetic stale failure')));
    expect(screen.getByText('Tasks Analyzed')).toBeInTheDocument();
    expect(screen.queryByText('Could not load learning analytics')).not.toBeInTheDocument();
  });
});
