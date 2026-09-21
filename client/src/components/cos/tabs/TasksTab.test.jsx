import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

// Regression coverage for #2519 — the "Run Now" evaluate button must only toast
// success after the request resolves.
vi.mock('../../../hooks/useAssignableInstances', () => ({ default: () => ({ instances: [], isFederated: false }) }));
const api = vi.hoisted(() => ({
  forceCosEvaluate: vi.fn(),
  getCosLearningDurations: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));

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

describe('TasksTab Run Now', () => {
  it('does not toast success when the evaluate request fails', async () => {
    api.forceCosEvaluate.mockRejectedValue(new Error('offline'));
    renderTab();

    fireEvent.click(screen.getByRole('button', { name: /Run tasks now/i }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('offline'));
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('toasts success only after the evaluate request resolves', async () => {
    api.forceCosEvaluate.mockResolvedValue({ success: true });
    renderTab();

    fireEvent.click(screen.getByRole('button', { name: /Run tasks now/i }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('Evaluation triggered'));
    expect(toast.error).not.toHaveBeenCalled();
    // Must pass { silent: true } so the custom catch is the only error toast.
    expect(api.forceCosEvaluate).toHaveBeenCalledWith({ silent: true });
  });

  it('opens and focuses the task identified by the queue deep link', async () => {
    const task = { id: 'task-example', description: 'Review an example task', status: 'completed', metadata: {} };
    renderTab({ tasks: { user: { tasks: [task] }, cos: { tasks: [] } } }, '/cos/tasks?task=task-example&source=user');

    await waitFor(() => expect(document.getElementById('cos-task-user-task-example')).not.toBeNull());
    const row = document.getElementById('cos-task-user-task-example');
    expect(row).toHaveAttribute('aria-current', 'true');
    expect(row).toHaveFocus();
  });
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
