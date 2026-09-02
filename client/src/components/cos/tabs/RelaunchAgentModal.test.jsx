import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../../services/api', () => ({
  relaunchCosAgent: vi.fn(),
}));
vi.mock('../../ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

import * as api from '../../../services/api';
import toast from '../../ui/Toast';
import RelaunchAgentModal from './RelaunchAgentModal';

const PROVIDERS = [
  { id: 'claude', name: 'Claude', enabled: true, models: ['claude-opus-5', 'claude-sonnet-5'] },
  { id: 'codex', name: 'Codex', enabled: true, models: ['gpt-5'] },
];

// A run stalled on a usage limit: still `running`, pinned to the provider that
// stopped answering.
const STALLED_AGENT = {
  id: 'agent-live',
  taskId: 'task-abc',
  status: 'running',
  metadata: { taskDescription: 'Ship the thing', provider: 'claude', model: 'claude-opus-5' },
};

const renderModal = (props = {}) => render(
  <RelaunchAgentModal
    agent={STALLED_AGENT}
    providers={PROVIDERS}
    apps={[]}
    onDone={vi.fn()}
    onClose={vi.fn()}
    {...props}
  />
);

beforeEach(() => {
  vi.clearAllMocks();
  api.relaunchCosAgent.mockResolvedValue({ success: true, taskId: 'task-abc', mode: 'requeued' });
});

describe('RelaunchAgentModal', () => {
  it('submits the stalled run\'s own settings when the user changes nothing', async () => {
    const user = userEvent.setup();
    renderModal();

    await user.click(screen.getByRole('button', { name: 'Relaunch Agent' }));

    await waitFor(() => expect(api.relaunchCosAgent).toHaveBeenCalledWith(
      'agent-live',
      expect.objectContaining({ provider: 'claude', model: 'claude-opus-5' }),
      { silent: true },
    ));
  });

  it('sends the newly picked provider and drops the model pinned to the old one', async () => {
    const user = userEvent.setup();
    const onDone = vi.fn();
    const onClose = vi.fn();
    renderModal({ onDone, onClose });

    await user.selectOptions(screen.getByRole('combobox', { name: /provider/i }), 'codex');
    await user.click(screen.getByRole('button', { name: 'Relaunch Agent' }));

    await waitFor(() => expect(api.relaunchCosAgent).toHaveBeenCalled());
    const [, overrides] = api.relaunchCosAgent.mock.calls[0];
    expect(overrides.provider).toBe('codex');
    // A model from the provider the user just left would be unrunnable; blank is
    // "server default", which is what clearing it means.
    expect(overrides.model).toBeUndefined();
    expect(onDone).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  // `already-active` and `superseded` deliberately queue NOTHING server-side, so
  // a relaunch must not claim it restarted the work.
  it.each([
    ['already-active', /already queued or running/i],
    ['superseded', /later agent/i],
  ])('reports the %s outcome without claiming the task was relaunched', async (mode, pattern) => {
    const user = userEvent.setup();
    api.relaunchCosAgent.mockResolvedValue({ success: true, taskId: 'task-abc', mode });
    renderModal();

    await user.click(screen.getByRole('button', { name: 'Relaunch Agent' }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(pattern)));
    expect(toast.success).not.toHaveBeenCalledWith(expect.stringMatching(/queued again/i));
  });

  it('keeps the dialog open and surfaces the error when the relaunch fails', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    api.relaunchCosAgent.mockRejectedValue(new Error('Agent agent-live is completed, not running'));
    renderModal({ onClose });

    await user.click(screen.getByRole('button', { name: 'Relaunch Agent' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith(expect.stringMatching(/not running/i)));
    expect(onClose).not.toHaveBeenCalled();
  });
});
