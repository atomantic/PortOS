import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// The SSE stream itself is covered by useInstallStream's own suite; this file
// pins the failure-footer contract every installer surface shares (#5981).
vi.mock('../../hooks/useInstallStream', () => ({
  useInstallStream: vi.fn(),
}));
vi.mock('../../services/api', () => ({
  addCosTask: vi.fn(),
}));
vi.mock('../ui/Toast', () => ({
  default: Object.assign(vi.fn(), {
    success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn(),
  }),
}));

import { useInstallStream } from '../../hooks/useInstallStream';
import { addCosTask } from '../../services/api';
import toast from '../ui/Toast';
import RuntimeInstallModal from './RuntimeInstallModal';

const streamState = (overrides = {}) => ({
  logs: [],
  currentStage: null,
  done: false,
  error: null,
  streamStarted: true,
  logsEndRef: { current: null },
  close: vi.fn(),
  ...overrides,
});

const renderFailed = ({ onClose = vi.fn(), ...overrides } = {}) => {
  useInstallStream.mockReturnValue(streamState({
    error: 'setup.sh exited 1',
    currentStage: 'clone',
    logs: [{ kind: 'log', text: 'cloning repo' }, { kind: 'error', text: 'fatal: could not build' }],
    ...overrides,
  }));
  render(<RuntimeInstallModal open runtime="trellis2" label="TRELLIS.2" onClose={onClose} />);
  return onClose;
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('RuntimeInstallModal failure footer', () => {
  it('offers no investigation action while the install is still running', () => {
    useInstallStream.mockReturnValue(streamState());
    render(<RuntimeInstallModal open runtime="trellis2" label="TRELLIS.2" onClose={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /queue agent to investigate/i })).toBeNull();
  });

  it('queues a CoS task carrying the failing stage, error and log tail, targeting PortOS itself', async () => {
    addCosTask.mockResolvedValue({ id: 'task-1' });
    renderFailed();

    fireEvent.click(screen.getByRole('button', { name: /queue agent to investigate/i }));

    await waitFor(() => expect(addCosTask).toHaveBeenCalledTimes(1));
    const [task, options] = addCosTask.mock.calls[0];
    expect(task.description).toBe('Fix TRELLIS.2 installer failure at the clone stage');
    expect(task.prompt).toContain('Failing stage: clone');
    expect(task.prompt).toContain('setup.sh exited 1');
    expect(task.prompt).toContain('fatal: could not build');
    // No `app` — the installer code lives in PortOS, which is the server default.
    expect(task.app).toBeUndefined();
    expect(task).toMatchObject({ useWorktree: true, openPR: true });
    // useAsyncAction owns the failure toast, so the request must not toast too.
    expect(options).toMatchObject({ silent: true });

    // Queued state: labelled and disabled so a second click can't double-queue.
    const queued = await screen.findByRole('button', { name: /agent queued/i });
    expect(queued.disabled).toBe(true);
    expect(toast.success).toHaveBeenCalled();
  });

  it('toasts and stays clickable when queueing fails', async () => {
    addCosTask.mockRejectedValue(new Error('CoS queue unavailable'));
    renderFailed();

    fireEvent.click(screen.getByRole('button', { name: /queue agent to investigate/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('CoS queue unavailable'));
    const button = screen.getByRole('button', { name: /queue agent to investigate/i });
    expect(button.disabled).toBe(false);
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('reads a duplicate-task 409 as an existing task, not as a failure or a fresh queue', async () => {
    // The store returns 409 for an existing PENDING **or BLOCKED** task, so the
    // button must not claim an agent is on it — it surfaces the server's wording.
    const duplicate = Object.assign(new Error('A task with this description is already blocked'), {
      code: 'DUPLICATE_TASK',
      status: 409,
    });
    addCosTask.mockRejectedValue(duplicate);
    renderFailed();

    fireEvent.click(screen.getByRole('button', { name: /queue agent to investigate/i }));

    const existing = await screen.findByRole('button', { name: /task already exists/i });
    expect(existing.disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /agent queued/i })).toBeNull();
    expect(toast).toHaveBeenCalledWith('A task with this description is already blocked', { icon: '🤖' });
    expect(toast.error).not.toHaveBeenCalled();
  });

  it('keeps Close working alongside the new action', () => {
    const onClose = renderFailed();
    expect(screen.getByRole('button', { name: /queue agent to investigate/i })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^close$/i }));
    // A failed install is not "running", so Close dismisses without the
    // cancel-confirmation prompt.
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
