import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import CodeReviewersTab from './CodeReviewersTab';
import * as api from '../../services/api';

vi.mock('../../services/api', () => ({
  getCodeReviewDefaults: vi.fn(),
  updateSettings: vi.fn(),
}));

vi.mock('../../hooks/useReviewerModelOptions', () => ({
  default: () => ({ ctxById: {} }),
}));

vi.mock('../ui/Toast', () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

describe('CodeReviewersTab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders loading state initially and populates panel when fetch succeeds', async () => {
    api.getCodeReviewDefaults.mockResolvedValue({
      reviewers: ['codex'],
      usernames: [],
      optionalReviewers: [],
      reviewerMaxRounds: {},
      stopMode: 'consensus',
      reviewerApplies: false,
    });

    render(<CodeReviewersTab />);

    expect(screen.getByText('Loading defaults…')).toBeInTheDocument();

    expect(await screen.findByText('Save defaults')).toBeInTheDocument();
    expect(screen.queryByText('Failed to load code review defaults.')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save defaults' })).not.toBeDisabled();
    expect(api.getCodeReviewDefaults).toHaveBeenCalledWith({ silent: true });
  });

  it('renders error banner with Retry button and disables Save button when fetch rejects', async () => {
    api.getCodeReviewDefaults.mockRejectedValue(new Error('Network error'));

    render(<CodeReviewersTab />);

    expect(await screen.findByText('Failed to load code review defaults.')).toBeInTheDocument();
    const retryBtn = screen.getByRole('button', { name: 'Retry' });
    expect(retryBtn).toBeInTheDocument();

    const saveBtn = screen.getByRole('button', { name: 'Save defaults' });
    expect(saveBtn).toBeDisabled();
  });

  it('re-fetches defaults when Retry button is clicked and enables Save button on success', async () => {
    api.getCodeReviewDefaults
      .mockRejectedValueOnce(new Error('Network error'))
      .mockResolvedValueOnce({
        reviewers: ['codex'],
        usernames: [],
        optionalReviewers: [],
        reviewerMaxRounds: {},
        stopMode: 'consensus',
        reviewerApplies: false,
      });

    render(<CodeReviewersTab />);

    expect(await screen.findByText('Failed to load code review defaults.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save defaults' })).toBeDisabled();

    const retryBtn = screen.getByRole('button', { name: 'Retry' });
    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(screen.queryByText('Failed to load code review defaults.')).not.toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: 'Save defaults' })).not.toBeDisabled();
    expect(api.getCodeReviewDefaults).toHaveBeenCalledTimes(2);
  });

  it('handles save when Save defaults button is clicked', async () => {
    api.getCodeReviewDefaults.mockResolvedValue({
      reviewers: ['codex'],
      usernames: [],
      optionalReviewers: [],
      reviewerMaxRounds: {},
      stopMode: 'consensus',
      reviewerApplies: false,
    });
    api.updateSettings.mockResolvedValue({ success: true });

    render(<CodeReviewersTab />);

    const saveBtn = await screen.findByRole('button', { name: 'Save defaults' });
    fireEvent.click(saveBtn);

    await waitFor(() => {
      expect(api.updateSettings).toHaveBeenCalled();
    });
  });

  // The goal-fidelity gate (#5994) — the second review, which asks whether a
  // finished run delivered the objective rather than whether the code is good.
  it('round-trips the goal-fidelity gate, and defaults an absent block to on', async () => {
    api.getCodeReviewDefaults.mockResolvedValue({
      reviewers: ['ollama'],
      usernames: [],
      optionalReviewers: [],
      reviewerMaxRounds: {},
      stopMode: 'all',
      reviewerApplies: false,
    });
    api.updateSettings.mockResolvedValue({});

    render(<CodeReviewersTab />);
    const checkbox = await screen.findByLabelText(/Check finished runs against the task objective/);
    // An install that has never saved the block must read as ON — persisting a
    // stored `false` here would silently switch off a gate nobody turned off.
    expect(checkbox).toBeChecked();

    fireEvent.change(screen.getByLabelText('Local model runtime'), { target: { value: 'lmstudio' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save defaults' }));

    await waitFor(() => expect(api.updateSettings).toHaveBeenCalled());
    const [payload] = api.updateSettings.mock.calls[0];
    expect(payload.codeReview.goalFidelity).toEqual({ enabled: true, backend: 'lmstudio' });
  });

  it('sends an explicit off switch, and drops the unset pins rather than persisting empty ones', async () => {
    api.getCodeReviewDefaults.mockResolvedValue({
      reviewers: ['ollama'],
      usernames: [],
      optionalReviewers: [],
      reviewerMaxRounds: {},
      stopMode: 'all',
      reviewerApplies: false,
      goalFidelity: { enabled: true, backend: null, model: null, effort: null },
    });
    api.updateSettings.mockResolvedValue({});

    render(<CodeReviewersTab />);
    fireEvent.click(await screen.findByLabelText(/Check finished runs against the task objective/));
    fireEvent.click(screen.getByRole('button', { name: 'Save defaults' }));

    await waitFor(() => expect(api.updateSettings).toHaveBeenCalled());
    expect(api.updateSettings.mock.calls[0][0].codeReview.goalFidelity).toEqual({ enabled: false });
  });
});
