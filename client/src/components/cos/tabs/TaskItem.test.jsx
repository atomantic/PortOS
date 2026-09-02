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
  it('uses the scheduled task learning bucket for its ETA instead of generic task text', () => {
    const scheduled = {
      ...task,
      id: 'sys-security',
      description: '[Self-Improvement] security audit: fix exposed configuration',
      taskType: 'internal',
      metadata: { analysisType: 'security' },
    };
    const durations = {
      'self-improve:security': {
        avgDurationMin: 2,
        p80DurationMs: 120000,
        completed: 5,
        successRate: 100,
      },
    };

    render(<TaskItem task={scheduled} isSystem onRefresh={vi.fn()} providers={providers} durations={durations} />);

    expect(screen.getByTitle('Based on 5 completed self-improve:security tasks')).toBeInTheDocument();
    expect(screen.getByText('~2m')).toBeInTheDocument();
  });

  it('uses its queue source for an untyped raw task ETA', () => {
    const rawUserTask = {
      ...task,
      id: 'user-fix',
      description: 'Fix the queued task display',
    };
    const durations = {
      'user-task': { avgDurationMin: 3, p80DurationMs: 180000, completed: 4, successRate: 100 },
      'auto-fix': { avgDurationMin: 1, p80DurationMs: 60000, completed: 9, successRate: 100 },
    };

    render(<TaskItem task={rawUserTask} onRefresh={vi.fn()} providers={providers} durations={durations} />);

    expect(screen.getByTitle('Based on 4 completed user-task tasks')).toBeInTheDocument();
    expect(screen.getByText('~3m')).toBeInTheDocument();
  });

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

  it('shows and persists the selected thinking effort for an effort-capable provider', async () => {
    const effortTask = {
      ...task,
      metadata: { ...task.metadata, effort: 'medium' },
    };
    render(<TaskItem task={effortTask} isSystem onRefresh={vi.fn()} providers={providers} />);

    expect(screen.getByText('medium effort')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Edit task' }));

    const effortSelect = screen.getByRole('combobox', { name: 'Thinking effort' });
    expect(effortSelect).toHaveValue('medium');
    fireEvent.change(effortSelect, { target: { value: 'xhigh' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.updateCosTask).toHaveBeenCalledWith(
      'sys-model-edit',
      expect.objectContaining({
        provider: 'codex-tui',
        model: 'gpt-5.6-terra',
        effort: 'xhigh',
        type: 'internal',
      }),
      { silent: true },
    ));
  });

  it('clears the model and effort when the provider changes', async () => {
    const effortTask = {
      ...task,
      metadata: { ...task.metadata, effort: 'high' },
    };
    render(<TaskItem task={effortTask} isSystem onRefresh={vi.fn()} providers={providers} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit task' }));
    fireEvent.change(screen.getByRole('combobox', { name: 'Provider' }), { target: { value: '' } });
    expect(screen.queryByRole('combobox', { name: 'Thinking effort' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.updateCosTask).toHaveBeenCalledWith(
      'sys-model-edit',
      expect.objectContaining({ provider: '', model: '', effort: '', type: 'internal' }),
      { silent: true },
    ));
  });

  it('preserves effort encoded in a legacy Antigravity model pin', async () => {
    const legacyTask = {
      ...task,
      metadata: {
        provider: 'antigravity-tui',
        model: 'gemini-3.6-flash-high',
      },
    };
    const antigravityProviders = [{
      id: 'antigravity-tui',
      name: 'Antigravity TUI',
      enabled: true,
      models: ['gemini-3.6-flash-low', 'gemini-3.6-flash-medium', 'gemini-3.6-flash-high'],
    }];
    render(<TaskItem task={legacyTask} isSystem onRefresh={vi.fn()} providers={antigravityProviders} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit task' }));
    expect(screen.getByRole('combobox', { name: 'Model' })).toHaveValue('gemini-3.6-flash');
    expect(screen.getByRole('combobox', { name: 'Thinking effort' })).toHaveValue('high');

    // Normalizing the two controls is not itself an edit, so Cancel stays
    // immediate instead of asking the user to discard a change they never made.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('group', { name: 'Confirm discard task edits' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Edit task' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.updateCosTask).toHaveBeenCalledWith(
      'sys-model-edit',
      expect.objectContaining({
        provider: 'antigravity-tui',
        model: 'gemini-3.6-flash',
        effort: 'high',
        type: 'internal',
      }),
      { silent: true },
    ));
  });

  it('updates an approval-gated system task in the internal queue when changing status', async () => {
    render(<TaskItem task={{ ...task, approvalRequired: true }} isSystem onRefresh={vi.fn()} providers={providers} />);

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

describe('TaskItem unblock action', () => {
  const blocked = {
    id: 'sys-blocked-3',
    description: 'Blocked task',
    status: 'blocked',
    metadata: { blockedReason: 'Max total spawns exceeded' },
  };
  const unblockButton = () =>
    screen.getByRole('button', { name: `Unblock task ${blocked.id} and move it to pending` });

  it('moves a blocked task to pending from the card itself', async () => {
    const onRefresh = vi.fn();
    render(<TaskItem task={blocked} isSystem onRefresh={onRefresh} providers={providers} />);

    fireEvent.click(unblockButton());

    await waitFor(() => expect(api.updateCosTask).toHaveBeenCalledWith(
      'sys-blocked-3',
      { status: 'pending', type: 'internal' },
      { silent: true }
    ));
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
    expect(toast.success).toHaveBeenCalledWith('Task unblocked and moved to pending');
  });

  it('is offered only on blocked tasks, and never alongside Mark as blocked', () => {
    const { unmount } = render(<TaskItem task={blocked} isSystem onRefresh={vi.fn()} providers={providers} />);
    expect(screen.queryByRole('button', { name: 'Mark task as blocked' })).not.toBeInTheDocument();
    unmount();

    render(<TaskItem task={task} isSystem onRefresh={vi.fn()} providers={providers} />);
    expect(screen.queryByRole('button', { name: /^Unblock task/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark task as blocked' })).toBeInTheDocument();
  });

  it('re-enables the button when the update fails so the user can retry', async () => {
    api.updateCosTask.mockRejectedValue(new Error('network down'));
    render(<TaskItem task={blocked} isSystem onRefresh={vi.fn()} providers={providers} />);

    fireEvent.click(unblockButton());

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('network down'));
    expect(unblockButton()).not.toBeDisabled();
  });
});

describe('TaskItem block modal state (#4038)', () => {
  const openBlockModal = () =>
    fireEvent.click(screen.getByRole('button', { name: 'Mark task as blocked' }));
  const reasonField = () =>
    screen.getByPlaceholderText('e.g., Waiting for API access, Needs design review...');

  // Belt-and-braces: today the sole opener re-seeds the field from the task, so a
  // retained reason is not reachable through the UI and this passes without the
  // cancel-side clear. It pins the contract for a future second opener that skips
  // the seed — which is exactly how the leak would become user-visible.
  it('drops a typed reason when the modal is canceled', () => {
    render(<TaskItem task={task} isSystem onRefresh={vi.fn()} providers={providers} />);

    openBlockModal();
    fireEvent.change(reasonField(), { target: { value: 'Waiting on design review' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    openBlockModal();
    expect(reasonField()).toHaveValue('');
  });

  it('seeds the field from an auto-written blockedReason, not just a user-set blocker', () => {
    // The badge already falls back to blockedReason; the edit field must match, or
    // re-blocking a server-auto-blocked task silently clears the recorded reason.
    const autoBlocked = { ...task, id: 'sys-auto-block', metadata: { blockedReason: 'Max total spawns exceeded' } };
    render(<TaskItem task={autoBlocked} isSystem onRefresh={vi.fn()} providers={providers} />);

    openBlockModal();
    expect(reasonField()).toHaveValue('Max total spawns exceeded');
  });

  it('keeps the modal and the typed reason open when the update fails', async () => {
    api.updateCosTask.mockRejectedValue(new Error('network down'));
    render(<TaskItem task={task} isSystem onRefresh={vi.fn()} providers={providers} />);

    openBlockModal();
    fireEvent.change(reasonField(), { target: { value: 'Waiting on design review' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mark Blocked' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('network down'));
    expect(reasonField()).toHaveValue('Waiting on design review');
  });

  it('closes and clears once the block succeeds', async () => {
    render(<TaskItem task={task} isSystem onRefresh={vi.fn()} providers={providers} />);

    openBlockModal();
    fireEvent.change(reasonField(), { target: { value: 'Waiting on design review' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mark Blocked' }));

    await waitFor(() => expect(api.updateCosTask).toHaveBeenCalledWith(
      'sys-model-edit',
      { status: 'blocked', type: 'internal', blockedReason: 'Waiting on design review' },
      { silent: true },
    ));
    await waitFor(() => expect(screen.queryByText('Mark Task as Blocked')).not.toBeInTheDocument());

    openBlockModal();
    expect(reasonField()).toHaveValue('');
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

    const context = document.getElementById('task-context-sys-sys-long-context');
    expect(context).toHaveClass('line-clamp-2');

    fireEvent.click(toggleFor('task-context-sys-sys-long-context'));
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

    expect(document.getElementById('task-blocker-sys-sys-long-block')).toHaveClass('line-clamp-2');
    expect(toggleFor('task-blocker-sys-sys-long-block')).toBeInTheDocument();
  });

  it('omits the toggle when the context fits within the clamp', () => {
    const withContext = { ...task, id: 'sys-short-context', metadata: { context: 'short note' } };
    render(<TaskItem task={withContext} isSystem onRefresh={vi.fn()} providers={providers} />);

    expect(screen.queryByRole('button', { name: /Show more/ })).not.toBeInTheDocument();
  });

  it('renders an approval-gated system task once with an inline approval action', async () => {
    forceOverflow();
    const gated = {
      ...task,
      id: 'sys-gated',
      approvalRequired: true,
      metadata: { context: longPrompt },
    };
    api.approveCosTask.mockResolvedValue({ ...gated, approvalRequired: false });
    const onRefresh = vi.fn();
    const { container } = render(
      <TaskItem task={gated} isSystem onRefresh={onRefresh} providers={providers} />);

    expect(container.querySelectorAll('[id^="task-context-"]')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Approve task sys-gated' }));
    await waitFor(() => expect(api.approveCosTask).toHaveBeenCalledWith('sys-gated', { silent: true }));
    expect(onRefresh).toHaveBeenCalled();
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

// #4153 — the agent-facing payload moved to `metadata.prompt`; `metadata.context`
// is now the one-line human note. A task written before the split has no
// `prompt` at all, so the field must not appear (and must not be PATCHed) then.
describe('TaskItem prompt field (#4153)', () => {
  const split = {
    ...task,
    id: 'sys-split',
    metadata: { prompt: 'the agent body\nsecond line', context: 'a short note' },
  };

  it('renders the prompt and the note as separate blocks', () => {
    render(<TaskItem task={split} isSystem onRefresh={vi.fn()} providers={providers} />);
    expect(screen.getByText(/the agent body/)).toBeInTheDocument();
    expect(screen.getByText('a short note')).toBeInTheDocument();
  });

  it('offers a Prompt textarea in edit mode and PATCHes the edit', async () => {
    const onRefresh = vi.fn();
    render(<TaskItem task={split} isSystem onRefresh={onRefresh} providers={providers} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit task' }));
    const promptField = screen.getByPlaceholderText('Prompt');
    expect(promptField.tagName).toBe('TEXTAREA');
    expect(promptField).toHaveValue('the agent body\nsecond line');

    fireEvent.change(promptField, { target: { value: 'rewritten body' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.updateCosTask).toHaveBeenCalledWith(
      'sys-split',
      expect.objectContaining({ prompt: 'rewritten body', context: 'a short note' }),
      { silent: true }
    ));
  });

  it('shows the confirm row when only the prompt field changed', () => {
    render(<TaskItem task={split} isSystem onRefresh={vi.fn()} providers={providers} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit task' }));
    fireEvent.change(screen.getByPlaceholderText('Prompt'), { target: { value: 'edited' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('group', { name: 'Confirm discard task edits' })).toBeInTheDocument();
  });

  // Writing `prompt: ''` onto every legacy task the user edits would create an
  // empty key the markdown store then serializes — absent must stay absent.
  it('omits the Prompt field, and the prompt key, for a legacy context-only task', async () => {
    const legacy = { ...task, id: 'sys-legacy', metadata: { context: 'legacy body' } };
    render(<TaskItem task={legacy} isSystem onRefresh={vi.fn()} providers={providers} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit task' }));
    expect(screen.queryByPlaceholderText('Prompt')).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Context'), { target: { value: 'edited note' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.updateCosTask).toHaveBeenCalled());
    const [, payload] = api.updateCosTask.mock.calls.at(-1);
    expect(payload).not.toHaveProperty('prompt');
    expect(payload.context).toBe('edited note');
  });

  it('refreshes the prompt draft when a mounted legacy task gains split metadata', async () => {
    const legacy = { ...task, id: 'sys-refresh', metadata: { context: 'legacy body' } };
    const splitTask = {
      ...legacy,
      metadata: { prompt: 'the refreshed body\nsecond line', context: 'a short note' },
    };
    const { rerender } = render(<TaskItem task={legacy} isSystem onRefresh={vi.fn()} providers={providers} />);
    rerender(<TaskItem task={splitTask} isSystem onRefresh={vi.fn()} providers={providers} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit task' }));
    await waitFor(() => expect(screen.getByPlaceholderText('Prompt')).toHaveValue('the refreshed body\nsecond line'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.updateCosTask).toHaveBeenCalledWith(
      'sys-refresh',
      expect.objectContaining({ prompt: 'the refreshed body\nsecond line', context: 'a short note' }),
      { silent: true }
    ));
  });
});

describe('TaskItem security scan report', () => {
  it('shows the bounded per-PR report without treating it as a blocker-only message', () => {
    const reportTask = {
      ...task,
      id: 'sys-pr-reviewer-findings',
      metadata: {
        pipeline: {
          securityScan: {
            status: 'findings',
            reports: [{
              number: 42,
              url: 'https://github.com/example/repo/pull/42',
              passed: false,
              findings: 'blocking — package.json:12: The diff attempts to direct the downstream reviewer to run an installer.',
              modelResponse: '{"safe":false,"findings":[{"severity":"blocking"}]}',
            }],
          },
        },
      },
    };

    render(<TaskItem task={reportTask} isSystem onRefresh={vi.fn()} providers={providers} />);

    expect(screen.getByRole('region', { name: 'Security scan report' })).toBeInTheDocument();
    expect(screen.getByText('Security scan findings')).toBeInTheDocument();
    expect(screen.getByText(/The diff attempts to direct the downstream reviewer/)).toBeInTheDocument();
    expect(screen.queryByText('Model response (untrusted)')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open PR' })).toHaveAttribute('href', 'https://github.com/example/repo/pull/42');
  });

  it('does not render a report panel for a clean scan', () => {
    const cleanTask = {
      ...task,
      id: 'sys-pr-reviewer-clean',
      metadata: { pipeline: { securityScan: { status: 'passed', reports: [{ number: 42, passed: true, findings: 'No findings.' }] } } },
    };

    render(<TaskItem task={cleanTask} isSystem onRefresh={vi.fn()} providers={providers} />);

    expect(screen.queryByRole('region', { name: 'Security scan report' })).not.toBeInTheDocument();
  });
});

describe('TaskItem cancel-edit confirmation (#4037)', () => {
  it('discards immediately when Cancel is clicked with no unsaved changes', () => {
    render(<TaskItem task={task} isSystem onRefresh={vi.fn()} providers={providers} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit task' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    // Back to the read-only view — no confirm row, no edit fields.
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'Confirm discard task edits' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit task' })).toBeInTheDocument();
  });

  it('shows an inline confirm row instead of discarding when there are unsaved changes', () => {
    render(<TaskItem task={task} isSystem onRefresh={vi.fn()} providers={providers} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit task' }));
    fireEvent.change(screen.getByDisplayValue(task.description), { target: { value: 'Edited description' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    // Still editing — the draft field keeps the typed value, and a confirm row
    // replaced the Save/Cancel pair instead of silently discarding it.
    expect(screen.getByDisplayValue('Edited description')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Confirm discard task edits' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('shows the confirm row when only the context field changed', () => {
    // Pins hasUnsavedEdits' context branch specifically — a regression narrowing
    // the comparison to description alone would still pass every other test in
    // this block since they all edit description.
    render(<TaskItem task={task} isSystem onRefresh={vi.fn()} providers={providers} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit task' }));
    fireEvent.change(screen.getByPlaceholderText('Context'), { target: { value: 'New context note' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.getByRole('group', { name: 'Confirm discard task edits' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('shows the confirm row when only the model select changed', () => {
    // Pins hasUnsavedEdits' model branch in isolation (provider left untouched).
    render(<TaskItem task={task} isSystem onRefresh={vi.fn()} providers={providers} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit task' }));
    const [, modelSelect] = screen.getAllByRole('combobox');
    fireEvent.change(modelSelect, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.getByRole('group', { name: 'Confirm discard task edits' })).toBeInTheDocument();
  });

  it('shows the confirm row when only the provider select changed', () => {
    // Pins hasUnsavedEdits' provider branch.
    render(<TaskItem task={task} isSystem onRefresh={vi.fn()} providers={providers} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit task' }));
    const [providerSelect] = screen.getAllByRole('combobox');
    fireEvent.change(providerSelect, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.getByRole('group', { name: 'Confirm discard task edits' })).toBeInTheDocument();
  });

  it('discards the draft on a second click confirming the discard', () => {
    render(<TaskItem task={task} isSystem onRefresh={vi.fn()} providers={providers} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit task' }));
    fireEvent.change(screen.getByDisplayValue(task.description), { target: { value: 'Edited description' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

    expect(screen.queryByDisplayValue('Edited description')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit task' })).toBeInTheDocument();
  });

  it('reverts the draft, not just hides it, so reopening Edit does not resurrect the discarded text', () => {
    render(<TaskItem task={task} isSystem onRefresh={vi.fn()} providers={providers} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit task' }));
    fireEvent.change(screen.getByDisplayValue(task.description), { target: { value: 'Edited description' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));

    fireEvent.click(screen.getByRole('button', { name: 'Edit task' }));
    expect(screen.getByDisplayValue(task.description)).toBeInTheDocument();
    expect(screen.queryByDisplayValue('Edited description')).not.toBeInTheDocument();
  });

  it('returns to the edit fields when the discard confirm is itself canceled', () => {
    render(<TaskItem task={task} isSystem onRefresh={vi.fn()} providers={providers} />);

    fireEvent.click(screen.getByRole('button', { name: 'Edit task' }));
    fireEvent.change(screen.getByDisplayValue(task.description), { target: { value: 'Edited description' } });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.getByDisplayValue('Edited description')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
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

describe('TaskItem investigation approval hint (#3714)', () => {
  const held = {
    ...task,
    id: 'sys-inv-held',
    description: '[Auto] Investigate agent failure [startup-failure:user:none]: Agent exited during startup',
    approvalRequired: true,
    metadata: { isInvestigation: true, approvalReason: 'investigation-loop:repeat-fingerprint' },
  };

  it('names the loop signal on the APPROVE button so the hold is explainable in place', () => {
    render(<TaskItem task={held} isSystem onRefresh={vi.fn()} providers={providers} />);
    const approve = screen.getByRole('button', { name: /^Approve task sys-inv-held — / });
    expect(approve).toHaveAttribute('title', expect.stringContaining('last 24 hours'));
  });

  it('leaves the plain approve label on an approval-required task that is not a failure loop', () => {
    const plain = { ...held, id: 'sys-approve-plain', metadata: {} };
    render(<TaskItem task={plain} isSystem onRefresh={vi.fn()} providers={providers} />);
    const approve = screen.getByRole('button', { name: 'Approve task sys-approve-plain' });
    expect(approve).not.toHaveAttribute('title');
  });

  it('names the schedule Require approval toggle on the APPROVE button', () => {
    const gated = {
      ...held,
      id: 'sys-require-approval',
      metadata: { requireApproval: true, approvalReason: 'config:requireApproval' },
    };
    render(<TaskItem task={gated} isSystem onRefresh={vi.fn()} providers={providers} />);
    const approve = screen.getByRole('button', { name: /^Approve task sys-require-approval — / });
    expect(approve).toHaveAttribute('title', expect.stringContaining('Require approval'));
  });
});

// #4520: a task can be pinned to one federated instance. The row shows where it
// will run; the editor changes it — but only on an install that actually has
// more than one instance to choose between.
describe('TaskItem federated instance pin (#4520)', () => {
  const SELF = 'self-instance-id';
  const PEER = 'peer-instance-id';
  const instances = [
    { instanceId: SELF, name: 'workstation', isSelf: true },
    { instanceId: PEER, name: 'render-box', isSelf: false },
  ];
  const pinned = { ...task, metadata: { ...task.metadata, targetInstanceId: PEER } };

  it('badges the pinned instance by name', () => {
    render(<TaskItem task={pinned} providers={providers} instances={instances} onRefresh={vi.fn()} />);
    expect(screen.getByText('render-box')).toBeTruthy();
  });

  it('badges a pin whose instance has left the registry, rather than hiding it', () => {
    // The task nothing will ever run is exactly the one that must stay visible.
    const orphaned = { ...task, metadata: { ...task.metadata, targetInstanceId: 'ghost-instance-id' } };
    render(<TaskItem task={orphaned} providers={providers} instances={instances} onRefresh={vi.fn()} />);
    expect(screen.getByText('unknown instance')).toBeTruthy();
  });

  it('shows no badge for an unpinned task', () => {
    render(<TaskItem task={task} providers={providers} instances={instances} onRefresh={vi.fn()} />);
    expect(screen.queryByText('render-box')).toBeNull();
  });

  it('saves a re-pin from the editor', async () => {
    render(<TaskItem task={task} providers={providers} instances={instances} onRefresh={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("Edit task"));
    fireEvent.change(screen.getByLabelText('Run on'), { target: { value: PEER } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(api.updateCosTask).toHaveBeenCalled());
    expect(api.updateCosTask.mock.calls[0][1].targetInstanceId).toBe(PEER);
  });

  it('sends null when the editor selects "Any instance" — the explicit unpin', async () => {
    render(<TaskItem task={pinned} providers={providers} instances={instances} onRefresh={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("Edit task"));
    fireEvent.change(screen.getByLabelText('Run on'), { target: { value: '' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(api.updateCosTask).toHaveBeenCalled());
    expect(api.updateCosTask.mock.calls[0][1].targetInstanceId).toBeNull();
  });

  it('hides the picker AND withholds the field for an UNPINNED task on a single-instance install', async () => {
    // Otherwise an edit made here would silently unpin a task another machine
    // pinned — the field would ride along as `null` on every save.
    render(<TaskItem task={task} providers={providers} instances={[{ instanceId: SELF, name: 'workstation', isSelf: true }]} onRefresh={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("Edit task"));
    expect(screen.queryByLabelText('Run on')).toBeNull();
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(api.updateCosTask).toHaveBeenCalled());
    expect('targetInstanceId' in api.updateCosTask.mock.calls[0][1]).toBe(false);
  });

  it('still offers the picker for an ALREADY-pinned task after the last peer is removed', async () => {
    // Hiding it there would leave the pin permanently unclearable and the task
    // unrunnable on every instance.
    render(<TaskItem task={pinned} providers={providers} instances={[{ instanceId: SELF, name: 'workstation', isSelf: true }]} onRefresh={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("Edit task"));
    fireEvent.change(screen.getByLabelText('Run on'), { target: { value: '' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(api.updateCosTask).toHaveBeenCalled());
    expect(api.updateCosTask.mock.calls[0][1].targetInstanceId).toBeNull();
  });

  it('hides the picker until the registry read lands, so an edit mid-load cannot unpin', async () => {
    render(<TaskItem task={pinned} providers={providers} onRefresh={vi.fn()} />);
    fireEvent.click(screen.getByLabelText("Edit task"));
    expect(screen.queryByLabelText('Run on')).toBeNull();
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(api.updateCosTask).toHaveBeenCalled());
    expect('targetInstanceId' in api.updateCosTask.mock.calls[0][1]).toBe(false);
  });
});

// A row must not claim a pin points at an "unknown instance" merely because the
// registry read hasn't landed yet — `null` is not-fetched, `[]` is fetched-empty.
describe('TaskItem instance registry — not-fetched vs fetched-empty (#4520)', () => {
  const pinned = { ...task, metadata: { ...task.metadata, targetInstanceId: 'peer-instance-id' } };

  it('renders no pin badge while the registry is still loading', () => {
    render(<TaskItem task={pinned} providers={providers} onRefresh={vi.fn()} />);
    expect(screen.queryByText('unknown instance')).toBeNull();
  });

  it('renders the orphaned-pin badge once the registry is known to be empty', () => {
    render(<TaskItem task={pinned} providers={providers} instances={[]} onRefresh={vi.fn()} />);
    expect(screen.getByText('unknown instance')).toBeTruthy();
  });
});

// An orphaned pin must stay editable: without its own <option> the select falls
// back to showing "Any instance" while still submitting the dead id, and the
// server rejects every save with no visible cause.
describe('TaskItem editing a pin whose instance has left the registry (#4520)', () => {
  const instances = [
    { instanceId: 'self-instance-id', name: 'workstation', isSelf: true },
    { instanceId: 'peer-instance-id', name: 'render-box', isSelf: false },
  ];
  const orphaned = { ...task, metadata: { ...task.metadata, targetInstanceId: 'ghost-instance-id' } };

  it('shows the dead pin as the selected option rather than a misleading "Any instance"', () => {
    render(<TaskItem task={orphaned} providers={providers} instances={instances} onRefresh={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('Edit task'));
    expect(screen.getByLabelText('Run on').value).toBe('ghost-instance-id');
  });

  it('lets the user move the task to a live instance', async () => {
    render(<TaskItem task={orphaned} providers={providers} instances={instances} onRefresh={vi.fn()} />);
    fireEvent.click(screen.getByLabelText('Edit task'));
    fireEvent.change(screen.getByLabelText('Run on'), { target: { value: 'peer-instance-id' } });
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(api.updateCosTask).toHaveBeenCalled());
    expect(api.updateCosTask.mock.calls[0][1].targetInstanceId).toBe('peer-instance-id');
  });
});
