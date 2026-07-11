import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

import TwinEvaluationSuitePanel from './TwinEvaluationSuitePanel';

// #2385 — a suite load FAILURE (server/network) must render a distinct
// load-error state with Retry, never collapse into the genuinely-empty
// "No suite" copy. These tests cover both the failure and empty responses.

const StubIcon = (props) => <svg data-testid="stub-icon" {...props} />;

const makeSuite = (overrides = {}) => ({
  HeaderIcon: StubIcon,
  title: 'Values-Alignment Tests',
  description: 'desc',
  runLabel: 'Run Dilemmas',
  loadingText: 'Loading values suite',
  itemLabel: 'Dilemma',
  emptyState: <span>No values-alignment suite found.</span>,
  scoreLabel: 'Alignment Score',
  countField: 'aligned',
  historyTitle: 'Recent Values Runs',
  statusMap: {},
  passResult: 'aligned',
  failResult: 'misaligned',
  getTests: vi.fn().mockResolvedValue([]),
  getHistory: vi.fn().mockResolvedValue([]),
  runTests: vi.fn(),
  successToast: 'done',
  ...overrides,
});

const renderPanel = (suite) =>
  render(
    <TwinEvaluationSuitePanel
      suite={suite}
      renderDetail={() => null}
      selectedProviders={[{ providerId: 'p1', model: 'm1' }]}
    />
  );

describe('TwinEvaluationSuitePanel load states', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders a distinct load-error state with Retry when the suite load fails', async () => {
    const getTests = vi.fn().mockRejectedValue(new Error('boom'));
    renderPanel(makeSuite({ getTests }));

    await waitFor(() =>
      expect(screen.getByText(/could not load the suite/i)).toBeInTheDocument()
    );
    // The empty-suite copy must NOT appear — failure and empty are distinct.
    expect(screen.queryByText(/no values-alignment suite found/i)).not.toBeInTheDocument();

    const retry = screen.getByRole('button', { name: /retry/i });
    getTests.mockResolvedValueOnce([]);
    await userEvent.click(retry);

    await waitFor(() =>
      expect(screen.queryByText(/could not load the suite/i)).not.toBeInTheDocument()
    );
    // Recovered into the (genuinely) empty state, not the error state.
    expect(screen.getByText(/no values-alignment suite found/i)).toBeInTheDocument();
    expect(getTests).toHaveBeenCalledTimes(2);
  });

  it('renders the empty-suite copy (not the error state) for a successful empty response', async () => {
    renderPanel(makeSuite({ getTests: vi.fn().mockResolvedValue([]) }));

    await waitFor(() =>
      expect(screen.getByText(/no values-alignment suite found/i)).toBeInTheDocument()
    );
    expect(screen.queryByText(/could not load the suite/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument();
  });
});
