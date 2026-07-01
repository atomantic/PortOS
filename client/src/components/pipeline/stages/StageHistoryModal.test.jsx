import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../../services/api', () => ({
  PIPELINE_STAGE_LABELS: { idea: 'Idea', prose: 'Prose' },
  restorePipelineStageVersion: vi.fn(),
}));

vi.mock('../../ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

import StageHistoryModal from './StageHistoryModal';
import { restorePipelineStageVersion } from '../../../services/api';
import toast from '../../ui/Toast';

const makeEntry = (runId, output, daysAgo = 1) => ({
  runId,
  output,
  input: '',
  createdAt: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
});

describe('StageHistoryModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows an empty state when runHistory is empty', () => {
    render(
      <StageHistoryModal
        open
        onClose={() => {}}
        issueId="iss-1"
        stageId="idea"
        currentOutput="current"
        currentRunId="run-cur"
        runHistory={[]}
      />,
    );
    expect(screen.getByText(/No prior versions yet/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Restore this version/i })).not.toBeInTheDocument();
  });

  it('defaults to the newest snapshot and renders its diff against current', () => {
    const history = [
      makeEntry('run-3', 'newest beats', 1),
      makeEntry('run-2', 'middle beats', 2),
      makeEntry('run-1', 'oldest beats', 3),
    ];
    const { container } = render(
      <StageHistoryModal
        open
        onClose={() => {}}
        issueId="iss-1"
        stageId="idea"
        currentOutput="current beats"
        currentRunId="run-cur"
        runHistory={history}
      />,
    );
    // List shows all three runIds.
    expect(screen.getByText('run run-3').textContent).toContain('run-3');
    expect(screen.getByText('run run-2').textContent).toContain('run-2');
    expect(screen.getByText('run run-1').textContent).toContain('run-1');
    // Header echoes the current runId.
    expect(screen.getByText(/run run-cur/)).toBeInTheDocument();
    // The diff is rendered (some red/green spans must exist since "newest" → "current").
    expect(container.querySelector('.text-port-error')).toBeInTheDocument();
    expect(container.querySelector('.text-port-success')).toBeInTheDocument();
  });

  it('switches the diff when a different version is selected', async () => {
    const user = userEvent.setup();
    render(
      <StageHistoryModal
        open
        onClose={() => {}}
        issueId="iss-1"
        stageId="idea"
        currentOutput="current"
        currentRunId="run-cur"
        runHistory={[
          makeEntry('run-2', 'second version', 1),
          makeEntry('run-1', 'first version', 2),
        ]}
      />,
    );
    // Clicking the older entry re-anchors the diff.
    await user.click(screen.getByRole('button', { name: /run-1/ }));
    // Active selection adds the accent border class — assert via DOM.
    const oldButton = screen.getByRole('button', { name: /run-1/ });
    expect(oldButton.className).toContain('border-port-accent');
  });

  it('disables Restore and shows the warning banner when restoreBlockedReason is set', () => {
    render(
      <StageHistoryModal
        open
        onClose={() => {}}
        issueId="iss-1"
        stageId="idea"
        currentOutput="current"
        currentRunId="run-cur"
        runHistory={[makeEntry('run-1', 'first', 1)]}
        restoreBlockedReason="Save or discard your unsaved edits before restoring."
      />,
    );
    const restoreBtn = screen.getByRole('button', { name: /Restore this version/i });
    expect(restoreBtn).toBeDisabled();
    expect(screen.getByText(/Save or discard your unsaved edits/i)).toBeInTheDocument();
  });

  it('calls restorePipelineStageVersion and fires onRestored on success', async () => {
    restorePipelineStageVersion.mockResolvedValue({
      stage: { lastRunId: 'run-2', output: 'second version', runHistory: [] },
      issue: { id: 'iss-1', stages: {} },
    });
    const onRestored = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(
      <StageHistoryModal
        open
        onClose={onClose}
        issueId="iss-1"
        stageId="idea"
        currentOutput="current"
        currentRunId="run-cur"
        runHistory={[
          makeEntry('run-2', 'second version', 1),
          makeEntry('run-1', 'first version', 2),
        ]}
        onRestored={onRestored}
      />,
    );
    await user.click(screen.getByRole('button', { name: /Restore this version/i }));
    expect(restorePipelineStageVersion).toHaveBeenCalledWith('iss-1', 'idea', 'run-2', { silent: true });
    expect(onRestored).toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
