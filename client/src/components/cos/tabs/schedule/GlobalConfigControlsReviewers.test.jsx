import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Same hook stubs as GlobalConfigControls.test.jsx, but ReviewerPicker is REAL
// here — these tests prove the picker + controls emit only what changed (#6208).
vi.mock('../../../../hooks/useCodeReviewDefaults', () => ({
  useCodeReviewDefaults: () => ({
    reviewers: ['codex', 'antigravity'],
    usernames: [],
    optionalReviewers: [],
    reviewerMaxRounds: {},
    stopMode: 'all',
    reviewerApplies: false,
  }),
}));
vi.mock('../../../../hooks/useReviewerModelOptions', () => ({
  default: () => ({ optionsByReviewer: {}, freeText: {}, unavailable: {}, loaded: true }),
}));

import GlobalConfigControls from './GlobalConfigControls';

const BASE_CONFIG = {
  type: 'cron',
  cronExpression: '0 7 * * *',
  enabled: true,
  providerId: null,
  model: null,
  effort: null,
  prompt: 'do the thing',
  status: {},
};

function renderControls({ taskMetadata, onUpdate = vi.fn(async () => {}), taskType = 'claim-work' } = {}) {
  render(
    <GlobalConfigControls
      taskType={taskType}
      config={{ ...BASE_CONFIG, taskMetadata }}
      onUpdate={onUpdate}
      onTrigger={() => {}}
      providers={[]}
      apps={[]}
      updating={false}
      setUpdating={() => {}}
      allTaskTypes={['claim-work']}
    />
  );
  return onUpdate;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('GlobalConfigControls — reviewer override emits only what changed (#6208)', () => {
  it('changing only the stop-mode on a task with no reviewer override persists reviewStopMode and nothing else', async () => {
    const onUpdate = renderControls({
      taskMetadata: { useWorktree: false, openPR: false, claimFlow: true },
    });
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText('Stop mode:'), 'on-clean');
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith('claim-work', {
      taskMetadata: { useWorktree: false, openPR: false, claimFlow: true, reviewStopMode: 'on-clean' },
    });
  });

  it('removing one reviewer from a seeded list persists reviewers and nothing else', async () => {
    const onUpdate = renderControls({
      taskMetadata: { useWorktree: false, openPR: false, claimFlow: true },
    });
    const user = userEvent.setup();
    await user.click(screen.getByLabelText('Remove Codex'));
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith('claim-work', {
      taskMetadata: { useWorktree: false, openPR: false, claimFlow: true, reviewers: ['antigravity'] },
    });
  });

  it('reverting a pin to the default deletes the key instead of persisting the snapshot', async () => {
    // Task carries a stale full-snapshot override; removing the extra reviewer
    // back to the seeded list must drop the reviewers key, not rewrite it.
    const onUpdate = renderControls({
      taskMetadata: {
        useWorktree: false,
        openPR: false,
        claimFlow: true,
        reviewers: ['codex', 'antigravity', 'copilot'],
      },
    });
    const user = userEvent.setup();
    await user.click(screen.getByLabelText('Remove Copilot'));
    expect(onUpdate).toHaveBeenCalledTimes(1);
    expect(onUpdate).toHaveBeenCalledWith('claim-work', {
      taskMetadata: { useWorktree: false, openPR: false, claimFlow: true },
    });
  });

  it('the reset button still clears a stop-mode-only override', () => {
    const onUpdate = renderControls({
      taskMetadata: { useWorktree: false, openPR: false, claimFlow: true, reviewStopMode: 'on-clean' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Use system Code Review Defaults' }));
    expect(onUpdate).toHaveBeenCalledWith('claim-work', {
      taskMetadata: { useWorktree: false, openPR: false, claimFlow: true },
    });
  });
});
