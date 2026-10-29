import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor, act, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../../../hooks/useAssignableInstances', () => ({ default: () => ({ instances: [{ instanceId: 'self', isSelf: true }], isFederated: false }) }));
const api = vi.hoisted(() => ({
  getCosTasks: vi.fn(),
  getCosLearningDurations: vi.fn(),
  recheckCosAgentCleanup: vi.fn(),
  updateCosTask: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), info: vi.fn(), error: vi.fn() }));

vi.mock('../../../services/api', () => api);
vi.mock('../../ui/Toast', () => ({ default: toast }));
// TaskAddForm pulls in provider/model plumbing not under test — stub it out.
vi.mock('./AgentCard', () => ({ default: ({ agent, liveOutput }) => <div>Active agent {agent.id}{liveOutput?.map((entry, i) => <p key={i}>{entry.line}</p>)}</div> }));
vi.mock('../TaskAddForm', () => ({ default: () => null }));

const TasksTab = (await import('./TasksTab')).default;

const emptyTasks = { user: { tasks: [] }, cos: { tasks: [] } };
const renderTab = (props = {}, route = '/cos/tasks') => render(
  <MemoryRouter initialEntries={[route]}>
    <TasksTab tasks={emptyTasks} onRefresh={vi.fn()} providers={[]} apps={[]} {...props} />
  </MemoryRouter>,
);

beforeEach(() => {
  vi.clearAllMocks();
  api.getCosLearningDurations.mockResolvedValue(null);
});

it('opens and focuses the task identified by the queue deep link', async () => {
  const task = { id: 'task-example', description: 'Review an example task', status: 'completed', metadata: {} };
  renderTab({ tasks: { user: { tasks: [task] }, cos: { tasks: [] } } }, '/cos/tasks?task=task-example&source=user');

  await waitFor(() => expect(document.getElementById('cos-task-user-task-example')).not.toBeNull());
  const row = document.getElementById('cos-task-user-task-example');
  expect(row).toHaveAttribute('aria-current', 'true');
  expect(row).toHaveFocus();
});

// The server registers an agent as `running` BEFORE it flips the agent's task
// off `pending`, so between those two writes a task legitimately reads as
// pending on one list and running on the other. The tab must settle that from
// the agent list rather than rendering the task in both sections at once.
describe('TasksTab spawning window', () => {
  const pendingTask = (id, extra = {}) => ({ id, description: `Task ${id}`, status: 'pending', metadata: {}, ...extra });
  // `startedAt` is how the settlement tells a live spawn from a zombie record —
  // registerAgent always stamps it. See server/lib/cosSpawnWindow.js.
  const liveAgent = (id, taskId, ageMs = 0) => ({ id, status: 'running', taskId, startedAt: new Date(Date.now() - ageMs).toISOString() });

  it('shows idle cleanup as pending for both queues', async () => {
    const heldTask = id => ({ id, description: `Finalize ${id}`, status: 'in_progress',
      metadata: { deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: `agent-${id}` } });
    renderTab({
      tasks: { user: { tasks: [heldTask('task-example')] }, cos: { tasks: [heldTask('sys-rl-example')] } },
      agents: [{ id: 'agent-sys-rl-example', taskId: 'sys-rl-example', status: 'completed' }],
    });

    expect(await screen.findByText('Finalize task-example')).toBeInTheDocument();
    expect(screen.getByText('Finalize sys-rl-example')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /finalizing delivery/i })).toBeNull();
    expect(screen.getAllByText('Pending (1)')).toHaveLength(2);
    expect(screen.queryByText(/^Active \(/)).toBeNull();
    expect(screen.getAllByRole('button', { name: /Status: cleanup pending/ })).toHaveLength(2);

  });

  it('moves cleanup to Active only while its owner has live delivery activity', async () => {
    const task = { id: 'sys-cleanup', description: 'Finish cleanup', status: 'in_progress',
      metadata: { deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: 'agent-owner' } };
    const owner = { id: 'agent-owner', taskId: task.id, status: 'completed' };
    const view = activity => <MemoryRouter><TasksTab tasks={{ user: { tasks: [] }, cos: { tasks: [task] } }}
      agents={[{ ...owner, deliveryActivity: activity }]} onRefresh={vi.fn()} providers={[]} apps={[]} /></MemoryRouter>;
    const { rerender } = render(view(null));
    expect(await screen.findByText('Pending (1)')).toBeInTheDocument();
    rerender(view({ label: 'Checking repository preservation' }));
    expect(await screen.findByText('Active (1)')).toBeInTheDocument();
    rerender(view(null));
    expect(await screen.findByText('Pending (1)')).toBeInTheDocument();
  });

  it.each(['user', 'internal'])('preserves an unsaved %s task edit through cleanup activity changes', async source => {
    const task = { id: 'held-draft', description: 'Original description', status: 'in_progress',
      metadata: { deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: 'agent-owner' } };
    const owner = { id: 'agent-owner', taskId: task.id, status: 'completed' };
    const view = activity => <MemoryRouter><TasksTab tasks={{ user: { tasks: source === 'user' ? [task] : [] },
      cos: { tasks: source === 'internal' ? [task] : [] } }} agents={[{ ...owner, deliveryActivity: activity }]}
      onRefresh={vi.fn()} providers={[]} apps={[]} /></MemoryRouter>;
    const { rerender } = render(view(null));
    fireEvent.click(await screen.findByRole('button', { name: 'Edit task' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Task description' }), { target: { value: 'My unfinished edit' } });
    rerender(view({ label: 'Checking cleanup' }));
    expect(await screen.findByText('Active (1)')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Task description' })).toHaveValue('My unfinished edit');
    rerender(view(null));
    expect(await screen.findByText('Pending (1)')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Task description' })).toHaveValue('My unfinished edit');
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('group', { name: 'Confirm discard task edits' })).toBeInTheDocument();
  });

  it('preserves a task block dialog while cleanup moves between sections', async () => {
    const task = { id: 'held-modal', description: 'Finish delivery', status: 'in_progress',
      metadata: { deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: 'agent-owner' } };
    const owner = { id: 'agent-owner', taskId: task.id, status: 'completed' };
    const view = activity => <MemoryRouter><TasksTab tasks={{ user: { tasks: [] }, cos: { tasks: [task] } }}
      agents={[{ ...owner, deliveryActivity: activity }]} onRefresh={vi.fn()} providers={[]} apps={[]} /></MemoryRouter>;
    const { rerender } = render(view(null));
    fireEvent.click(await screen.findByRole('button', { name: 'Mark task as blocked' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Reason this task is blocked' }), { target: { value: 'Need a review' } });
    rerender(view({ label: 'Checking cleanup' }));
    expect(await screen.findByText('Active (1)')).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Reason this task is blocked' })).toHaveValue('Need a review');
  });

  it('keeps only queued user tasks sortable when cleanup is pending', async () => {
    const queued = { id: 'queued', description: 'Queued task', status: 'pending', metadata: {} };
    const held = { id: 'held', description: 'Held cleanup', status: 'in_progress',
      metadata: { deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: 'agent-owner' } };
    renderTab({ tasks: { user: { tasks: [queued, held] }, cos: { tasks: [] } },
      agents: [{ id: 'agent-owner', taskId: held.id, status: 'completed' }] });
    const queuedRow = await screen.findByText('Queued task');
    const heldRow = screen.getByText('Held cleanup');
    expect(within(queuedRow.closest('[data-task-group]')).getByRole('button', { name: 'Drag to reorder' })).toBeInTheDocument();
    expect(within(heldRow.closest('[data-task-group]')).queryByRole('button', { name: 'Drag to reorder' })).toBeNull();
  });

  it('shows exact retry-cleanup activity but ignores an unattributed boolean hold', async () => {
    const held = { id: 'retry-held', description: 'Retry cleanup', status: 'in_progress', metadata: { retryPendingCleanup: 'agent-owner' } };
    const owner = { id: 'agent-owner', taskId: held.id, status: 'completed', deliveryActivity: { label: 'Saving retry checkout' } };
    const view = (task, agent) => <MemoryRouter><TasksTab tasks={{ user: { tasks: [] }, cos: { tasks: [task] } }}
      agents={[agent]} onRefresh={vi.fn()} providers={[]} apps={[]} /></MemoryRouter>;
    const { rerender } = render(view(held, owner));
    expect(await screen.findByText('Active (1)')).toBeInTheDocument();
    expect(screen.getByText('Saving retry checkout')).toBeInTheDocument();
    rerender(view({ ...held, metadata: { retryPendingCleanup: 'true' } }, { ...owner, id: 'true' }));
    expect(await screen.findByText('Pending (1)')).toBeInTheDocument();
    expect(screen.queryByText('Active (1)')).toBeNull();
  });

  it('prefers the active retry owner when delivery and retry holds name different owners', async () => {
    const task = { id: 'two-owners', description: 'Delivery and retry cleanup', status: 'in_progress',
      metadata: { deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: 'agent-delivery', retryPendingCleanup: 'agent-retry' } };
    renderTab({ tasks: { user: { tasks: [] }, cos: { tasks: [task] } }, agents: [
      { id: 'agent-delivery', taskId: task.id, status: 'completed' },
      { id: 'agent-retry', taskId: task.id, status: 'completed', deliveryActivity: { label: 'Saving the retry checkout' } },
    ] });
    expect(await screen.findByText('Active (1)')).toBeInTheDocument();
    expect(screen.getByText('Saving the retry checkout')).toBeInTheDocument();
  });

  it.each([
    ['loading', false, null, {}, /Agent status is loading/],
    ['failed', true, 'unavailable', {}, /Agent status could not be loaded/],
    ['peer owner', true, null, { claimedBy: 'peer' }, /different instance claimed this task/],
  ])('keeps %s activity explicitly unconfirmed', async (_label, agentsLoaded, agentsError, metadata, reason) => {
    const task = { id: 'unknown', description: 'Activity needs confirmation', status: 'in_progress', metadata };
    renderTab({ tasks: { user: { tasks: [] }, cos: { tasks: [task] } }, agentsLoaded, agentsError });
    expect(await screen.findByText('Activity unconfirmed (1)')).toBeInTheDocument();
    expect(screen.getByText(reason)).toBeInTheDocument();
    expect(screen.queryByText('Pending (1)')).toBeNull();
  });

  it('does not show a stale running agent or reset action after the agent read fails', async () => {
    const task = { id: 'stale', description: 'Stale task', status: 'in_progress', metadata: {} };
    renderTab({ tasks: { user: { tasks: [] }, cos: { tasks: [task] } }, agentsLoaded: true, agentsError: 'unavailable',
      agents: [liveAgent('agent-old', task.id)] });
    expect(await screen.findByText('Activity unconfirmed (1)')).toBeInTheDocument();
    expect(screen.queryByText('Active agent agent-old')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Reset spawn budget and run' })).toBeNull();
    expect(screen.getByRole('button', { name: /Status: activity unconfirmed/ })).toBeDisabled();
  });

  it('still recognizes a locally idle preflight while the agent list is loading', async () => {
    const task = { id: 'preflight-demand-1', description: 'Queued preparation', status: 'in_progress', preflightActive: false,
      metadata: { machineLocal: 'true', preflight: { requestId: 'demand-1', phase: 'queued', steps: [{ key: 'prepare', label: 'Preparing', status: 'pending' }] } } };
    renderTab({ tasks: { user: { tasks: [] }, cos: { tasks: [task] } }, agentsLoaded: false });
    expect(await screen.findByText('Pending (1)')).toBeInTheDocument();
    expect(screen.queryByText('Activity unconfirmed (1)')).toBeNull();
  });

  it('uses live preflight activity instead of a persisted preparing phase', async () => {
    const task = { id: 'preflight-demand-1', description: 'Preparing a task', status: 'in_progress',
      metadata: { machineLocal: true, preflight: { requestId: 'demand-1', phase: 'preparing', steps: [{ key: 'prepare', label: 'Preparing', status: 'active' }] } } };
    const view = active => <MemoryRouter><TasksTab tasks={{ user: { tasks: [] }, cos: { tasks: [{ ...task, preflightActive: active }] } }}
      onRefresh={vi.fn()} providers={[]} apps={[]} /></MemoryRouter>;
    const { rerender } = render(view(false));
    expect(await screen.findByText('Pending (1)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reset spawn budget and run' })).toBeNull();
    rerender(view(true));
    expect(await screen.findByText('Active (1)')).toBeInTheDocument();
    expect(screen.getByText('running now — no agent has started yet')).toBeInTheDocument();
  });

  it('keeps a legacy shared preflight unconfirmed without local activity evidence', async () => {
    const task = { id: 'preflight-legacy', description: 'Shared preparation', status: 'in_progress', preflightActive: false,
      metadata: { preflight: { requestId: 'legacy', phase: 'preparing', steps: [{ key: 'prepare', label: 'Preparing', status: 'active' }] } } };
    renderTab({ tasks: { user: { tasks: [] }, cos: { tasks: [task] } }, agentsLoaded: true });
    expect(await screen.findByText('Activity unconfirmed (1)')).toBeInTheDocument();
    expect(screen.getByText(/shared pre-agent card may be running/)).toBeInTheDocument();
    expect(screen.getByText('activity unconfirmed')).toBeInTheDocument();
    expect(screen.queryByText('waiting for preparation')).toBeNull();
  });

  it('keeps an actual running agent active even if an old cleanup marker remains', async () => {
    renderTab({
      tasks: { user: { tasks: [] }, cos: { tasks: [{ ...pendingTask('sys-running'), status: 'in_progress',
        metadata: { deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: 'agent-older' } }] } },
      agents: [liveAgent('agent-current', 'sys-running')],
    });

    expect(await screen.findByText('Active (1)')).toBeInTheDocument();
    expect(screen.getByText('Active agent agent-current')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: /finalizing delivery/ })).toBeNull();
  });

  it('shows the exact cleanup failure and owner in normal task groups and animates only live work', async () => {
    const task = { id: 'task-held', description: 'Deliver example change', status: 'in_progress',
      metadata: { deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: 'agent-owner' } };
    const owner = { id: 'agent-owner', taskId: task.id, status: 'completed', metadata: {
      repoStateVerification: { checkedAt: '2026-01-01T12:00:00Z', reasons: ['cleanup-already-warned'] },
      cleanupOutcome: { status: 'blocked', reason: 'preservation-unverified', taskId: 'task-recovery' },
    }, result: { taskOutcome: { reason: 'The archive still needs verification.' } } };
    const view = activity => <MemoryRouter><TasksTab tasks={{ user: { tasks: [task] }, cos: { tasks: [] } }}
      agents={[{ ...owner, deliveryActivity: activity }, { id: 'agent-other', taskId: task.id, status: 'completed' }]}
      onRefresh={vi.fn()} providers={[]} apps={[]} /></MemoryRouter>;
    const { rerender } = render(view(null));
    expect(await screen.findByText('Deliver example change')).toBeInTheDocument();
    expect(screen.queryByText(/recovery sweep|recovery schedule/i)).toBeNull();
    expect(screen.getByText(/Execution ended; delivery or cleanup still needs repair/)).toBeInTheDocument();
    expect(screen.getByText('Last check: preservation unverified.')).toBeInTheDocument();
    expect(screen.getByText(/Last checked:/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /View recovery task/ })).toHaveAttribute('href', '/cos/tasks?task=task-recovery');
    expect(screen.getByRole('link', { name: /View agent report/ })).toHaveAttribute('href', '/cos/agents/agent-owner');
    expect(screen.getByLabelText('Delivery activity').querySelector('.animate-spin')).toBeNull();
    rerender(view({ label: 'Checking repository preservation' }));
    expect(screen.getByText('Checking repository preservation')).toBeInTheDocument();
    expect(screen.getByLabelText('Delivery activity').querySelector('.animate-spin')).not.toBeNull();
    rerender(view(null));
    expect(screen.getByText(/Execution ended; delivery or cleanup still needs repair/)).toBeInTheDocument();
    expect(screen.getByLabelText('Delivery activity').querySelector('.animate-spin')).toBeNull();
  });

  it('rechecks only the selected cleanup owner and reports a remaining hold', async () => {
    api.recheckCosAgentCleanup.mockResolvedValue({ ok: true, verified: false, reasons: ['release-sync-local-review-unretained'] });
    const task = { id: 'sys-held', description: 'Finish delivery', status: 'in_progress',
      metadata: { deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: 'agent-owner' } };
    renderTab({ tasks: { user: { tasks: [] }, cos: { tasks: [task] } },
      agents: [{ id: 'agent-owner', taskId: task.id, status: 'completed', result: { cleanupPending: true } }] });
    fireEvent.click(await screen.findByRole('button', { name: 'Retry cleanup' }));
    await waitFor(() => expect(api.recheckCosAgentCleanup).toHaveBeenCalledWith('agent-owner', task.id, { silent: true }));
    expect(await screen.findByText(/Cleanup still needs attention: Waiting for release review evidence/)).toBeInTheDocument();
    expect(toast.info).toHaveBeenCalledWith(expect.stringContaining('sys-held: Cleanup still needs attention'));
  });

  it('announces cleanup results even if activity moves the row between sections', async () => {
    let resolveCheck;
    api.recheckCosAgentCleanup.mockImplementation(() => new Promise(resolve => { resolveCheck = resolve; }));
    const task = { id: 'sys-held', description: 'Finish delivery', status: 'in_progress',
      metadata: { deliveryRecovery: 'cleanup', deliveryRecoveryAgentId: 'agent-owner' } };
    const owner = { id: 'agent-owner', taskId: task.id, status: 'completed', result: { cleanupPending: true } };
    const view = activity => <MemoryRouter><TasksTab tasks={{ user: { tasks: [] }, cos: { tasks: [task] } }}
      agents={[{ ...owner, deliveryActivity: activity }]} onRefresh={vi.fn()} providers={[]} apps={[]} /></MemoryRouter>;
    const { rerender } = render(view(null));
    fireEvent.click(await screen.findByRole('button', { name: 'Retry cleanup' }));
    rerender(view({ label: 'Checking cleanup' }));
    expect(await screen.findByText('Active (1)')).toBeInTheDocument();
    await act(async () => resolveCheck({ ok: true, verified: false, reasons: ['cleanup-review-required'] }));
    expect(toast.info).toHaveBeenCalledWith(expect.stringContaining('retained checkout needs a preservation review'));
  });

  it('moves a pending task with a live agent out of Pending and into Active', async () => {
    renderTab({
      tasks: { user: { tasks: [pendingTask('task-spawning'), pendingTask('task-waiting')] }, cos: { tasks: [] } },
      agents: [liveAgent('agent-1', 'task-spawning')],
      liveOutputs: { 'agent-1': [{ line: 'Implementing the change' }] },
    });

    await waitFor(() => expect(screen.getByText(/^Pending \(/)).toBeInTheDocument());
    expect(screen.getByText('Pending (1)')).toBeInTheDocument();
    expect(screen.getByText('Active (1)')).toBeInTheDocument();
    expect(screen.getByText(/Active agent agent-1/)).toBeInTheDocument();
    expect(screen.getByText('Implementing the change')).toBeInTheDocument();
  });

  it('leaves a pending system task pending when its agent has already completed', async () => {
    renderTab({
      tasks: { user: { tasks: [] }, cos: { tasks: [pendingTask('cos-task-1')] } },
      agents: [{ id: 'agent-1', status: 'completed', taskId: 'cos-task-1' }],
    });

    await waitFor(() => expect(screen.getByText('Pending (1)')).toBeInTheDocument());
    expect(screen.queryByText(/^Active \(/)).not.toBeInTheDocument();
  });

  it('hands the task back to Pending once its holder is too old to be mid-spawn', async () => {
    // Past SPAWN_CLAIM_GRACE_MS a `running` agent on a `pending` task is a zombie,
    // not a spawn in flight — and `forceSpawnTask` supersedes it on the same
    // bound. Keeping it under Active would hide the stuck task in a section whose
    // rows are presented as work already underway.
    renderTab({
      tasks: { user: { tasks: [pendingTask('task-stuck')] }, cos: { tasks: [] } },
      agents: [liveAgent('agent-1', 'task-stuck', 10 * 60 * 1000)],
    });

    await waitFor(() => expect(screen.getByText('Pending (1)')).toBeInTheDocument());
    expect(screen.queryByText(/^Active \(/)).not.toBeInTheDocument();
  });

  it('keeps Process now reachable for a task whose agent record is stuck running', async () => {
    renderTab({
      tasks: { user: { tasks: [pendingTask('task-spawning')] }, cos: { tasks: [] } },
      agents: [liveAgent('agent-1', 'task-spawning')],
    });

    await waitFor(() => expect(screen.getByText('Active (1)')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Task details and actions'));
    // An agent stuck at `running` (the zombie state cleanupZombieAgents clears)
    // would otherwise leave the row with no way to re-dispatch it. Duplicate
    // dispatch is refused server-side by forceSpawnTask, not by hiding this.
    expect(screen.getByRole('button', { name: /Process task now/i })).toBeInTheDocument();
  });

  it('still offers Process now for a genuinely queued task', async () => {
    renderTab({
      tasks: { user: { tasks: [pendingTask('task-waiting')] }, cos: { tasks: [] } },
      agents: [],
    });

    await waitFor(() => expect(screen.getByText('Pending (1)')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /Process task now/i })).toBeInTheDocument();
  });
});

it('focuses a deep link when its task arrives, then preserves user focus on refresh', async () => {
  const task = { id: 'task-example', description: 'Review an example task', status: 'completed', metadata: {} };
  const view = (tasks) => <MemoryRouter initialEntries={['/cos/tasks?task=task-example&source=user']}>
    <input aria-label="Draft" />
    <TasksTab tasks={tasks} onRefresh={vi.fn()} providers={[]} apps={[]} />
  </MemoryRouter>;
  const { rerender } = render(view(emptyTasks));
  rerender(view({ user: { tasks: [task] }, cos: { tasks: [] } }));
  await waitFor(() => expect(document.getElementById('cos-task-user-task-example')).toHaveFocus());
  const draft = screen.getByRole('textbox', { name: 'Draft' });
  draft.focus();
  const row = document.getElementById('cos-task-user-task-example');
  const scroll = vi.spyOn(row, 'scrollIntoView');
  rerender(view({ user: { tasks: [{ ...task }] }, cos: { tasks: [] } }));
  await waitFor(() => expect(draft).toHaveFocus());
  expect(scroll).not.toHaveBeenCalled();
});


it('refreshes expanded history on completed changes without fetching it for queue heartbeats', async () => {
  const completed = id => ({ id, description: `Completed ${id}`, status: 'completed', metadata: {} });
  api.getCosTasks.mockResolvedValueOnce({ items: [completed('old')], total: 1, nextCursor: null })
    .mockResolvedValueOnce({ items: [completed('new'), completed('old')], total: 2, nextCursor: null })
    .mockResolvedValueOnce({ items: [completed('replacement')], total: 1, nextCursor: null });
  const view = (count, revision = 0) => <MemoryRouter><TasksTab tasks={{ user: { tasks: [], completedCount: count }, cos: { tasks: [], completedCount: 0 } }} completedRevision={revision} onRefresh={vi.fn()} providers={[]} apps={[]} /></MemoryRouter>;
  const { rerender } = render(view(1));
  expect(api.getCosTasks).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Completed (1)' }));
  await screen.findByText('Completed old');
  rerender(view(1));
  expect(api.getCosTasks).toHaveBeenCalledTimes(1);
  rerender(view(2));
  await screen.findByText('Completed new');
  rerender(view(1, 1));
  await screen.findByText('Completed replacement');
  expect(screen.queryByText('Completed old')).not.toBeInTheDocument();
  expect(api.getCosTasks).toHaveBeenCalledTimes(3);
});

it('displays loading spinners while tasks are loading instead of empty messages', async () => {
  renderTab({ tasks: { user: null, cos: null } });
  await act(async () => {});

  expect(screen.queryByText('No user tasks. Add one above or edit TASKS.md directly.')).not.toBeInTheDocument();
  expect(screen.queryByText('No system tasks.')).not.toBeInTheDocument();
  expect(screen.queryByText(/0 pending · 0 active · 0 blocked/)).not.toBeInTheDocument();

  expect(screen.getAllByLabelText('Loading task queue…').length).toBeGreaterThanOrEqual(1);
  expect(screen.getByLabelText('Loading system tasks…')).toBeInTheDocument();
});
