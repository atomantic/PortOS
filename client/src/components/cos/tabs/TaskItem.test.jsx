import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const api = vi.hoisted(() => ({
  updateCosTask: vi.fn(),
  deleteCosTask: vi.fn(),
  approveCosTask: vi.fn(),
  forceSpawnTask: vi.fn(),
  resolveCosTaskChallenge: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

vi.mock('../../../services/api', () => api);
vi.mock('../../ui/Toast', () => ({ default: toast }));

const TaskItem = (await import('./TaskItem')).default;

const task = {
  id: 'sys-model-edit',
  description: 'Reference repo review',
  status: 'pending',
  metadata: { provider: 'codex-tui', model: 'gpt-5.6-terra' },
};
const providers = [{ id: 'codex-tui', name: 'Codex TUI', enabled: true, models: ['gpt-5.6-terra'] }];

beforeEach(() => {
  vi.clearAllMocks();
  api.updateCosTask.mockResolvedValue({ ...task });
});

describe('TaskItem task source', () => {
  it('updates a system task in the internal queue when saving its model', async () => {
    render(<TaskItem task={task} isSystem onRefresh={vi.fn()} providers={providers} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit task' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.updateCosTask).toHaveBeenCalledWith(
      'sys-model-edit',
      expect.objectContaining({
        provider: 'codex-tui',
        model: 'gpt-5.6-terra',
        type: 'internal',
      }),
      { silent: true },
    ));
  });

  it('updates an approval-gated task in the internal queue when changing status', async () => {
    render(<TaskItem task={task} awaitingApproval onRefresh={vi.fn()} providers={providers} />);

    fireEvent.click(screen.getByRole('button', { name: /Status: pending/i }));

    await waitFor(() => expect(api.updateCosTask).toHaveBeenCalledWith(
      'sys-model-edit',
      { status: 'completed', type: 'internal' },
      { silent: true },
    ));
  });
});

describe('TaskItem blocked reason', () => {
  it('renders blockedReason when a blocked task has no user-set blocker', () => {
    // Every server-side auto-block (max-spawns, retries, provider-config, …) writes
    // metadata.blockedReason, never `blocker`, so the display must fall back to it.
    const blocked = {
      id: 'sys-blocked',
      description: 'Blocked task',
      status: 'blocked',
      metadata: { blockedReason: 'Provider "ollama" is an HTTP API provider with no file-writing harness' },
    };
    render(<TaskItem task={blocked} isSystem onRefresh={vi.fn()} providers={providers} />);
    expect(screen.getByText(/no file-writing harness/)).toBeInTheDocument();
  });

  it('prefers the user-set blocker over blockedReason', () => {
    const blocked = {
      id: 'sys-blocked-2',
      description: 'Blocked task',
      status: 'blocked',
      metadata: { blocker: 'Paused by user', blockedReason: 'Max total spawns exceeded' },
    };
    render(<TaskItem task={blocked} isSystem onRefresh={vi.fn()} providers={providers} />);
    expect(screen.getByText('Paused by user')).toBeInTheDocument();
    expect(screen.queryByText(/Max total spawns/)).not.toBeInTheDocument();
  });
});

describe('TaskItem long-text clamping', () => {
  // The context often holds a task's entire prompt (orchestrator tasks put the
  // whole thing there). Rendering it unclamped turned the pending list into a
  // wall of text the user had to scroll past to reach the rest of the queue.
  const longPrompt = 'You are the Creative Director. '.repeat(200);

  // jsdom reports 0 for both scrollHeight and clientHeight, so nothing ever
  // measures as overflowing without this. Restored in afterEach rather than at
  // the end of the test body, so a failed assertion can't leak it into the next.
  const forceOverflow = () =>
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(500);
  afterEach(() => vi.restoreAllMocks());

  const toggleFor = (id) => screen.getAllByRole('button', { name: /Show more/ })
    .find(b => b.getAttribute('aria-controls') === id);

  it('clamps the context and offers an expand toggle when it overflows', () => {
    forceOverflow();
    const withContext = { ...task, id: 'sys-long-context', metadata: { context: longPrompt } };
    render(<TaskItem task={withContext} isSystem onRefresh={vi.fn()} providers={providers} />);

    const context = document.getElementById('task-context-sys-long-context');
    expect(context).toHaveClass('line-clamp-2');

    fireEvent.click(toggleFor('task-context-sys-long-context'));
    expect(context).not.toHaveClass('line-clamp-2');
  });

  it('clamps a long auto-written blockedReason', () => {
    forceOverflow();
    const blocked = {
      ...task,
      id: 'sys-long-block',
      status: 'blocked',
      metadata: { blockedReason: 'stderr dump '.repeat(200) },
    };
    render(<TaskItem task={blocked} isSystem onRefresh={vi.fn()} providers={providers} />);

    expect(document.getElementById('task-blocker-sys-long-block')).toHaveClass('line-clamp-2');
    expect(toggleFor('task-blocker-sys-long-block')).toBeInTheDocument();
  });

  it('omits the toggle when the context fits within the clamp', () => {
    const withContext = { ...task, id: 'sys-short-context', metadata: { context: 'short note' } };
    render(<TaskItem task={withContext} isSystem onRefresh={vi.fn()} providers={providers} />);

    expect(screen.queryByRole('button', { name: /Show more/ })).not.toBeInTheDocument();
  });

  it('edits the context in a multi-line textarea, not a single-line input', () => {
    const withContext = { ...task, id: 'sys-edit-context', metadata: { context: longPrompt } };
    render(<TaskItem task={withContext} isSystem onRefresh={vi.fn()} providers={providers} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit task' }));
    const contextField = screen.getByPlaceholderText('Context');
    expect(contextField.tagName).toBe('TEXTAREA');
    expect(contextField).toHaveValue(longPrompt);
  });
});

describe('TaskItem challenge resolve controls (#2471)', () => {
  const challenged = {
    id: 'sys-challenged',
    description: 'Disputed work',
    status: 'challenged',
    metadata: { challenge: { reason: 'reviewer misread the diff', reviewer: 'ollama' } },
  };

  it('upholds a parked challenge via the inline control', async () => {
    api.resolveCosTaskChallenge.mockResolvedValue({ status: 'pending' });
    const onRefresh = vi.fn();
    render(<TaskItem task={challenged} isSystem onRefresh={onRefresh} providers={providers} />);

    fireEvent.click(screen.getByRole('button', { name: 'Uphold' }));

    await waitFor(() => expect(api.resolveCosTaskChallenge).toHaveBeenCalledWith(
      'sys-challenged',
      { outcome: 'upheld', resolvedBy: 'user' },
      { silent: true },
    ));
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
  });

  it('escalates a parked challenge via the inline control', async () => {
    api.resolveCosTaskChallenge.mockResolvedValue({ status: 'blocked' });
    render(<TaskItem task={challenged} isSystem onRefresh={vi.fn()} providers={providers} />);

    fireEvent.click(screen.getByRole('button', { name: 'Escalate' }));

    await waitFor(() => expect(api.resolveCosTaskChallenge).toHaveBeenCalledWith(
      'sys-challenged',
      { outcome: 'escalated', resolvedBy: 'user' },
      { silent: true },
    ));
  });

  it('hides the resolve controls once the challenge is already settled', () => {
    const settled = {
      ...challenged,
      id: 'sys-challenged-done',
      metadata: { ...challenged.metadata, challengeResolution: { outcome: 'upheld' } },
    };
    render(<TaskItem task={settled} isSystem onRefresh={vi.fn()} providers={providers} />);
    expect(screen.queryByRole('button', { name: 'Uphold' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Escalate' })).not.toBeInTheDocument();
  });
});
