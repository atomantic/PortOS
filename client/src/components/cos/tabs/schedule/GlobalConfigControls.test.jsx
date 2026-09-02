import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';

// The two hooks are the component's only API callers — stub them so the test
// exercises the config controls, not the network.
vi.mock('../../../../hooks/useCodeReviewDefaults', () => ({
  useCodeReviewDefaults: () => ({
    reviewers: ['copilot'],
    usernames: [],
    optionalReviewers: [],
    reviewerMaxRounds: {},
    stopMode: 'clean',
    reviewerApplies: false,
  }),
}));
vi.mock('../../../../hooks/useReviewerModelOptions', () => ({
  default: () => ({ optionsByReviewer: {}, freeText: {}, unavailable: {}, loaded: true }),
}));
vi.mock('../../ReviewerPicker', () => ({
  default: () => <div data-testid="reviewer-picker" />,
}));

import GlobalConfigControls from './GlobalConfigControls';

const BASE_CONFIG = {
  type: 'daily',
  enabled: true,
  providerId: null,
  model: null,
  effort: null,
  prompt: 'do the thing',
  status: {},
};

function renderControls({ taskMetadata, onUpdate = vi.fn(), taskType = 'feature-ideas', config: extraConfig = {}, setUpdating = () => {} } = {}) {
  render(
    <GlobalConfigControls
      taskType={taskType}
      config={{ ...BASE_CONFIG, taskMetadata, ...extraConfig }}
      onUpdate={onUpdate}
      onTrigger={() => {}}
      onReset={() => {}}
      providers={[]}
      apps={[]}
      updating={false}
      setUpdating={setUpdating}
      allTaskTypes={['feature-ideas']}
    />
  );
  return onUpdate;
}

const prSelect = () => screen.queryByLabelText('After opening PR');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('GlobalConfigControls — After opening PR', () => {
  it('hides the selector when the task does not open a PR', () => {
    renderControls({ taskMetadata: { useWorktree: true, openPR: false } });
    expect(prSelect()).not.toBeInTheDocument();
  });

  it('defaults an unpinned task to the app-default option', () => {
    renderControls({ taskMetadata: { useWorktree: true, openPR: true } });
    expect(prSelect()).toHaveValue('');
    expect(screen.getByTestId('reviewer-picker')).toBeInTheDocument();
  });

  it('shows a legacy reviewLoop task the policy it actually runs under', () => {
    renderControls({ taskMetadata: { useWorktree: true, openPR: true, reviewLoop: true } });
    expect(prSelect()).toHaveValue('review-then-merge');
  });

  // Keeps unrelated keys, and drops the legacy reviewLoop bit so it can't
  // outvote the pin the user just made.
  it('persists the picked policy into taskMetadata', () => {
    const onUpdate = renderControls({ taskMetadata: { useWorktree: true, openPR: true, simplify: true, reviewLoop: true } });
    fireEvent.change(prSelect(), { target: { value: 'merge-on-green' } });
    expect(onUpdate).toHaveBeenCalledWith('feature-ideas', {
      taskMetadata: { useWorktree: true, openPR: true, simplify: true, prCompletion: 'merge-on-green' },
    });
  });

  it('clears the pin (back to the app default) when App default is picked', () => {
    const onUpdate = renderControls({ taskMetadata: { useWorktree: true, openPR: true, prCompletion: 'leave-open' } });
    expect(prSelect()).toHaveValue('leave-open');
    fireEvent.change(prSelect(), { target: { value: '' } });
    expect(onUpdate).toHaveBeenCalledWith('feature-ideas', {
      taskMetadata: { useWorktree: true, openPR: true },
    });
  });

  it.each(['merge-on-green', 'leave-open'])('hides the reviewer picker for %s', (prCompletion) => {
    renderControls({ taskMetadata: { useWorktree: true, openPR: true, prCompletion } });
    expect(screen.queryByTestId('reviewer-picker')).not.toBeInTheDocument();
  });

  it('keeps the reviewer picker for review-then-merge', () => {
    renderControls({ taskMetadata: { useWorktree: true, openPR: true, prCompletion: 'review-then-merge' } });
    expect(screen.getByTestId('reviewer-picker')).toBeInTheDocument();
  });

  it('keeps the reviewer picker for a legacy reviewLoop task that opens no PR', () => {
    renderControls({ taskMetadata: { useWorktree: true, openPR: false, reviewLoop: true } });
    expect(screen.getByTestId('reviewer-picker')).toBeInTheDocument();
  });

  it('resets the task review override while preserving unrelated task metadata', () => {
    const onUpdate = renderControls({
      taskMetadata: {
        useWorktree: true,
        openPR: true,
        prCompletion: 'review-then-merge',
        reviewers: ['codex'],
        usernames: ['example-reviewer'],
        optionalReviewers: ['codex'],
        reviewerMaxRounds: { codex: 2 },
        reviewerModels: { codex: 'example-model' },
        reviewerEfforts: { codex: 'high' },
        reviewStopMode: 'first-blocking',
        reviewerApplies: true,
      },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Use system Code Review Defaults' }));

    expect(onUpdate).toHaveBeenCalledWith('feature-ideas', {
      taskMetadata: {
        useWorktree: true,
        openPR: true,
        prCompletion: 'review-then-merge',
      },
    });
  });
});

describe('GlobalConfigControls — branch-reconcile batch size', () => {
  it('shows the safe default and persists a selected branch batch', () => {
    const onUpdate = renderControls({ taskType: 'branch-reconcile', taskMetadata: { cleanupMerged: true } });
    const select = screen.getByLabelText('Branches per agent');
    expect(select).toHaveValue('3');
    fireEvent.change(select, { target: { value: '5' } });
    expect(onUpdate).toHaveBeenCalledWith('branch-reconcile', {
      taskMetadata: { cleanupMerged: true, branchesPerAgent: 5 }
    });
  });
});

describe('GlobalConfigControls — issue exclude labels', () => {
  it('is hidden for a task type without the issue author filter', () => {
    renderControls({ taskType: 'feature-ideas' });
    expect(screen.queryByLabelText('Leave issues with these labels for humans')).toBeNull();
  });

  it('seeds the input from the configured labels and commits a parsed list on blur', () => {
    const onUpdate = renderControls({
      taskType: 'claim-issue',
      taskMetadata: { issueAuthorFilter: 'self', issueExcludeLabels: ['good first issue'] },
      onUpdate: vi.fn().mockResolvedValue(undefined),
    });
    const input = screen.getByLabelText('Leave issues with these labels for humans');
    expect(input).toHaveValue('good first issue');

    fireEvent.change(input, { target: { value: 'good first issue, help wanted' } });
    fireEvent.blur(input);

    expect(onUpdate).toHaveBeenCalledWith('claim-issue', {
      taskMetadata: { issueAuthorFilter: 'self', issueExcludeLabels: ['good first issue', 'help wanted'] }
    });
  });

  it('commits an empty array when the input is cleared', () => {
    const onUpdate = renderControls({
      taskType: 'claim-work',
      taskMetadata: { issueExcludeLabels: ['good first issue'] },
      onUpdate: vi.fn().mockResolvedValue(undefined),
    });
    const input = screen.getByLabelText('Leave issues with these labels for humans');

    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);

    expect(onUpdate).toHaveBeenCalledWith('claim-work', {
      taskMetadata: { issueExcludeLabels: [] }
    });
  });

  it('gates RunTaskButton on the in-flight save (setUpdating around the commit)', async () => {
    let resolveUpdate;
    const onUpdate = vi.fn(() => new Promise((resolve) => { resolveUpdate = resolve; }));
    const setUpdating = vi.fn();
    renderControls({
      taskType: 'claim-issue',
      taskMetadata: { issueExcludeLabels: [] },
      onUpdate,
      setUpdating,
    });
    const input = screen.getByLabelText('Leave issues with these labels for humans');

    fireEvent.change(input, { target: { value: 'good first issue' } });
    fireEvent.blur(input);

    // setUpdating(true) must fire BEFORE the PATCH resolves, not after — a
    // caller that gates RunTaskButton on it needs the disable to take effect
    // while onUpdate is still in flight.
    expect(setUpdating).toHaveBeenCalledWith(true);
    expect(setUpdating).not.toHaveBeenCalledWith(false);

    await act(async () => { resolveUpdate(); await Promise.resolve(); });
    expect(setUpdating).toHaveBeenLastCalledWith(false);
  });
});

describe('GlobalConfigControls — require approval', () => {
  it('toggles requireApproval on the task metadata', () => {
    const onUpdate = renderControls({ taskType: 'release-check', taskMetadata: { useWorktree: false, openPR: false } });
    fireEvent.click(screen.getByRole('button', { name: /Require approval/i }));
    expect(onUpdate).toHaveBeenCalledWith('release-check', {
      taskMetadata: { useWorktree: false, openPR: false, requireApproval: true },
    });
  });

  it('turns requireApproval off when it is already on', () => {
    const onUpdate = renderControls({
      taskType: 'release-check',
      taskMetadata: { requireApproval: true },
    });
    fireEvent.click(screen.getByRole('button', { name: /Require approval/i }));
    expect(onUpdate).toHaveBeenCalledWith('release-check', {
      taskMetadata: { requireApproval: false },
    });
  });
});

describe('GlobalConfigControls — file issues only', () => {
  it('is hidden for non-audit tasks', () => {
    renderControls();
    expect(screen.queryByRole('button', { name: /File issues only/i })).not.toBeInTheDocument();
  });

  it('toggles fileIssues and forces the no-code posture on', () => {
    const onUpdate = renderControls({
      taskType: 'security',
      taskMetadata: { useWorktree: true, openPR: true, simplify: true, fileIssues: false },
      config: { fileIssuesCapable: true, defaultFileIssues: false },
    });
    fireEvent.click(screen.getByRole('button', { name: /File issues only/i }));
    expect(onUpdate).toHaveBeenCalledWith('security', {
      taskMetadata: { useWorktree: false, openPR: false, simplify: false, fileIssues: true },
    });
  });

  it('restores required worktree isolation when module-hygiene switches to do-work mode', () => {
    const onUpdate = renderControls({
      taskType: 'module-hygiene',
      taskMetadata: { useWorktree: false, openPR: false, simplify: false, fileIssues: true },
      config: { fileIssuesCapable: true, defaultFileIssues: true, doWorkRequiresWorktree: true },
    });
    fireEvent.click(screen.getByRole('button', { name: /File issues only/i }));
    expect(onUpdate).toHaveBeenCalledWith('module-hygiene', {
      taskMetadata: { useWorktree: true, openPR: false, simplify: false, fileIssues: false },
    });
  });
});
