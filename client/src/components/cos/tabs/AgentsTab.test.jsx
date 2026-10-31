import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { MemoryRouter, Routes, Route } from 'react-router';

const socket = vi.hoisted(() => {
  const handlers = new Map();
  return {
    on: (event, handler) => {
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(handler);
    },
    off: (event, handler) => handlers.get(event)?.delete(handler),
    emit: vi.fn(),
    receive: (event, payload) => handlers.get(event)?.forEach(handler => handler(payload)),
    listenerCount: event => handlers.get(event)?.size || 0,
  };
});
vi.mock('../../../services/socket', () => ({ default: socket }));

vi.mock('../../../services/api', () => ({
  getCosLearningDurations: vi.fn(),
  getCosAgent: vi.fn(),
  getCosCompletedAgents: vi.fn(),
  getCosPendingAgentFeedback: vi.fn(),
  hydrateCosAgentDescription: vi.fn(async (agent) => agent),
  clearCompletedCosAgents: vi.fn(),
  deleteCosAgent: vi.fn(),
  resumeCosAgent: vi.fn(),
  relaunchCosAgent: vi.fn(),
  addCosTask: vi.fn(),
}));

vi.mock('../../ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('./AgentCard', () => ({
  default: ({ agent, onFeedbackChange, onResume, onRelaunch, onDelete }) => (
    <div data-testid={`agent-${agent.id}`}>
      <span>{agent.metadata?.taskDescription}</span>
      {onDelete && <button type="button" onClick={() => onDelete(agent.id)}>Delete {agent.id}</button>}
      <input aria-label={`Card draft ${agent.id}`} defaultValue="" />
      {onResume && (
        <button type="button" onClick={() => onResume(agent)}>Resume {agent.id}</button>
      )}
      {onRelaunch && (
        <button type="button" onClick={() => onRelaunch(agent)}>Relaunch {agent.id}</button>
      )}
      {agent.feedback?.rating && <span>Feedback: {agent.feedback.rating}</span>}
      {!agent.feedback?.rating && (
        <button
          type="button"
          onClick={() => onFeedbackChange?.({
            ...agent,
            feedback: { rating: 'positive', submittedAt: '2026-07-13T12:00:00.000Z' },
          }, agent)}
        >
          Rate {agent.metadata?.taskDescription}
        </button>
      )}
    </div>
  ),
}));

// Stands in for the real dialog's submit: the payload shape it hands back is
// what AgentsTab has to route to the right endpoint.
vi.mock('./ResumeAgentModal', () => ({
  default: ({ agent, onSubmit }) => (
    <button
      type="button"
      onClick={() => onSubmit({
        description: `[Resume] ${agent.metadata?.taskDescription}`,
        context: 'previous context',
        provider: 'claude',
        model: 'claude-opus-5',
        effort: 'high',
        app: '',
        type: 'user',
      }).catch(() => {})}
    >
      Submit resume
    </button>
  ),
}));
// The dialog owns the relaunch call and its outcome message; the tab's job is to
// mount it against the right agent and refresh when it is done.
vi.mock('./RelaunchAgentModal', () => ({
  default: ({ agent, onDone }) => (
    <button type="button" onClick={() => onDone?.({ mode: 'requeued' })}>
      Relaunch dialog for {agent.id}
    </button>
  ),
}));
vi.mock('../../ui/InlineConfirmRow', () => ({
  default: ({ question, confirmText, onConfirm }) => (
    <div>
      <p>{question}</p>
      {onConfirm && <button type="button" onClick={onConfirm}>{confirmText || 'Confirm'}</button>}
    </div>
  ),
}));

import * as api from '../../../services/api';
import toast from '../../ui/Toast';
import AgentsTab from './AgentsTab';

const completedAgent = (id, description, extra = {}) => ({
  id,
  taskId: `task-${id}`,
  status: 'completed',
  completedAt: '2026-07-13T10:00:00.000Z',
  startedAt: '2026-07-13T09:00:00.000Z',
  metadata: { taskDescription: description, taskType: 'user' },
  ...extra,
});

const renderTab = (agents, onRefresh = vi.fn(), initialEntry = '/cos/agents') => render(
  <MemoryRouter initialEntries={[initialEntry]}>
    <AgentsTab
      agents={agents}
      onRefresh={onRefresh}
      liveOutputs={{}}
      providers={[]}
      apps={[]}
    />
  </MemoryRouter>
);

beforeEach(() => {
  vi.clearAllMocks();
  api.getCosLearningDurations.mockResolvedValue({});
  api.getCosCompletedAgents.mockResolvedValue({ items: [], total: 0, nextCursor: null });
  api.getCosPendingAgentFeedback.mockResolvedValue({ agents: [], count: null });
  api.hydrateCosAgentDescription.mockImplementation(async (agent) => agent);
});

// A relaunch is offered only on a RUNNING agent — it is the recovery for a run
// that is alive but stalled (a CLI parked on a provider usage limit), where the
// existing Pause/Kill/Resume trio either loses the worktree or parks the task.
describe('AgentsTab relaunch routing', () => {
  const runningAgent = {
    id: 'agent-live',
    taskId: 'task-abc',
    status: 'running',
    startedAt: '2026-07-13T09:00:00.000Z',
    metadata: { taskDescription: 'Stalled on a usage limit' },
  };

  it('opens the relaunch dialog on the running agent and refreshes when it finishes', async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();
    renderTab([runningAgent], onRefresh);
    await act(async () => {});

    await user.click(screen.getByRole('button', { name: 'Relaunch agent-live' }));
    await user.click(screen.getByRole('button', { name: 'Relaunch dialog for agent-live' }));

    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
    // A relaunch moves the EXISTING task, so neither resume door may fire — a
    // second task would spawn a second agent.
    expect(api.addCosTask).not.toHaveBeenCalled();
    expect(api.resumeCosAgent).not.toHaveBeenCalled();
  });

  it('offers no relaunch on a settled agent, which has no live run to move', async () => {
    renderTab([completedAgent('agent-done', 'Finished work')]);
    await act(async () => {});

    // The card renders (its Resume door is offered), so the missing Relaunch is a
    // real absence rather than a row that never mounted.
    expect(screen.getByRole('button', { name: 'Resume agent-done' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Relaunch agent-done' })).toBeNull();
  });
});

describe('AgentsTab resume routing', () => {
  const pausedAgent = {
    id: 'agent-paused',
    taskId: 'task-abc',
    status: 'paused',
    startedAt: '2026-07-13T09:00:00.000Z',
    metadata: { taskDescription: 'Half-finished work' },
  };

  it('resumes a PAUSED agent in place instead of queueing a second task', async () => {
    const user = userEvent.setup();
    api.resumeCosAgent.mockResolvedValue({ success: true, taskId: 'task-abc', mode: 'requeued' });
    renderTab([pausedAgent]);
    await act(async () => {});

    await user.click(screen.getByRole('button', { name: 'Resume agent-paused' }));
    await user.click(screen.getByRole('button', { name: 'Submit resume' }));

    await waitFor(() => expect(api.resumeCosAgent).toHaveBeenCalledWith(
      'agent-paused',
      expect.objectContaining({ provider: 'claude', model: 'claude-opus-5', effort: 'high' }),
      { silent: true },
    ));
    expect(api.addCosTask).not.toHaveBeenCalled();
  });

  // `already-active` and `superseded` create NOTHING server-side — the task is
  // already in flight, or a later pause owns it. Reporting "created a resume task"
  // there is the message that had users hunting for an agent that never spawned.
  it.each([
    ['already-active', /already queued or running/i],
    ['superseded', /later agent/i],
  ])('reports the %s outcome without claiming a task was created', async (mode, pattern) => {
    const user = userEvent.setup();
    api.resumeCosAgent.mockResolvedValue({ success: true, taskId: 'task-abc', mode });
    renderTab([pausedAgent]);
    await act(async () => {});

    await user.click(screen.getByRole('button', { name: 'Resume agent-paused' }));
    await user.click(screen.getByRole('button', { name: 'Submit resume' }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(pattern)));
    expect(toast.success).not.toHaveBeenCalledWith(expect.stringMatching(/resume task/i));
  });

  // The server force-spawns the resumed task when a slot is free, so "queued" is the
  // exception, not the rule — and a "queued" toast for a run that already started
  // reads as the Resume click not having taken.
  it('says the resumed task is running when the server started it', async () => {
    const user = userEvent.setup();
    api.resumeCosAgent.mockResolvedValue({ success: true, taskId: 'task-abc', mode: 'requeued', spawned: true });
    renderTab([pausedAgent]);
    await act(async () => {});

    await user.click(screen.getByRole('button', { name: 'Resume agent-paused' }));
    await user.click(screen.getByRole('button', { name: 'Submit resume' }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/running again/i)));
  });

  it('names why a resumed task stayed queued instead of leaving the user to hunt for it', async () => {
    const user = userEvent.setup();
    api.resumeCosAgent.mockResolvedValue({
      success: true, taskId: 'task-abc', mode: 'requeued',
      spawned: false, spawnHold: 'No available agent slots (3/3)',
    });
    renderTab([pausedAgent]);
    await act(async () => {});

    await user.click(screen.getByRole('button', { name: 'Resume agent-paused' }));
    await user.click(screen.getByRole('button', { name: 'Submit resume' }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/No available agent slots \(3\/3\)/)));
  });

  // `new-task` is the mode where the paused task was gone, so a REPLACEMENT was
  // queued — and it is force-spawned like any other. Without its own entry it fell
  // through to the generic "Created resume task", which says nothing about whether
  // the replacement actually started.
  it('says a replacement task is running when the server started that too', async () => {
    const user = userEvent.setup();
    api.resumeCosAgent.mockResolvedValue({ success: true, taskId: 'task-new', mode: 'new-task', created: true, spawned: true });
    renderTab([pausedAgent]);
    await act(async () => {});

    await user.click(screen.getByRole('button', { name: 'Resume agent-paused' }));
    await user.click(screen.getByRole('button', { name: 'Submit resume' }));

    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringMatching(/replacement task is running/i)));
  });

  // The default has to be safe by construction, not by keeping a copy of the server's
  // mode enum in sync — a future non-creating mode this build has no wording for must
  // not regress to announcing a task that was never queued.
  it('never claims a task was created for an unrecognized non-creating mode', async () => {
    const user = userEvent.setup();
    api.resumeCosAgent.mockResolvedValue({ success: true, taskId: 'task-abc', mode: 'some-future-mode', created: false });
    renderTab([pausedAgent]);
    await act(async () => {});

    await user.click(screen.getByRole('button', { name: 'Resume agent-paused' }));
    await user.click(screen.getByRole('button', { name: 'Submit resume' }));

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalledWith(expect.stringMatching(/created/i));
  });

  it('still queues a fresh task for a COMPLETED agent, which has no task to requeue', async () => {
    const user = userEvent.setup();
    api.addCosTask.mockResolvedValue({ id: 'task-new' });
    renderTab([completedAgent('done', 'Finished work')]);
    await act(async () => {});

    await user.click(screen.getByRole('button', { name: 'Resume done' }));
    await user.click(screen.getByRole('button', { name: 'Submit resume' }));

    await waitFor(() => expect(api.addCosTask).toHaveBeenCalledWith(
      expect.objectContaining({ description: '[Resume] Finished work' }),
      { silent: true },
    ));
    expect(api.resumeCosAgent).not.toHaveBeenCalled();
  });
});

describe('AgentsTab feedback review queue', () => {
  it('applies notification feedback to live, archived and selected cards without reloading history', async () => {
    const live = completedAgent('live', 'Recent task');
    const archived = completedAgent('archived', 'Archived task');
    api.getCosCompletedAgents.mockResolvedValue({ items: [archived], total: 1, nextCursor: null });
    api.getCosAgent.mockResolvedValue(archived);
    api.getCosPendingAgentFeedback.mockResolvedValue({ count: 2 });
    const onRefresh = vi.fn();
    const view = render(
      <MemoryRouter initialEntries={['/cos/agents/archived']}>
        <Routes><Route path="/cos/agents/:agentId" element={
          <AgentsTab agents={[live]} onRefresh={onRefresh} liveOutputs={{}} providers={[]} apps={[]} />
        } /></Routes>
      </MemoryRouter>,
    );
    await waitFor(() => expect(screen.getAllByRole('button', { name: 'Rate Archived task' })).toHaveLength(2));
    const pageReads = api.getCosCompletedAgents.mock.calls.length;
    api.getCosPendingAgentFeedback.mockResolvedValue({ count: 1 });
    await act(async () => socket.receive('cos:agent:feedback', {
      agentId: 'archived', feedback: { rating: 'positive', comment: null, submittedAt: '2026-07-13T12:00:00.000Z' },
    }));
    expect(screen.getAllByText('Feedback: positive')).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Rate Archived task' })).not.toBeInTheDocument();
    await screen.findByRole('button', { name: 'Needs feedback: 1' });

    api.getCosPendingAgentFeedback.mockResolvedValue({ count: 0 });
    await act(async () => socket.receive('cos:agent:feedback', {
      agentId: 'live', feedback: { rating: 'negative', comment: null, submittedAt: '2026-07-13T12:01:00.000Z' },
    }));
    expect(screen.getByText('Feedback: negative')).toBeInTheDocument();
    await screen.findByRole('button', { name: 'Needs feedback: 0' });
    expect(api.getCosCompletedAgents).toHaveBeenCalledTimes(pageReads);
    expect(onRefresh).not.toHaveBeenCalled();
    view.unmount();
    expect(socket.listenerCount('cos:agent:feedback')).toBe(0);
  });

  it('removes externally rated runs from the feedback filter and reconciles repeated ratings without double-counting', async () => {
    const archived = completedAgent('archived', 'Archived task');
    api.getCosCompletedAgents.mockResolvedValue({ items: [archived], total: 1, nextCursor: null });
    api.getCosPendingAgentFeedback.mockResolvedValue({ count: 2 });
    renderTab([], vi.fn(), '/cos/agents?feedback=needs-feedback');
    await screen.findByText('Archived task');
    await screen.findByRole('button', { name: 'Needs feedback: 2' });
    api.getCosPendingAgentFeedback.mockResolvedValue({ count: 1 });
    const event = { agentId: 'archived', feedback: { rating: 'positive' } };
    await act(async () => socket.receive('cos:agent:feedback', event));
    expect(screen.queryByText('Archived task')).not.toBeInTheDocument();
    await screen.findByRole('button', { name: 'Needs feedback: 1' });
    await act(async () => socket.receive('cos:agent:feedback', event));
    await screen.findByRole('button', { name: 'Needs feedback: 1' });
  });

  it('renders an older durable pending run and uses its server count', async () => {
    const archived = completedAgent('agent-archived', 'An older pending run');
    api.getCosPendingAgentFeedback.mockResolvedValue({ agents: [archived], count: 1 });

    api.getCosCompletedAgents.mockResolvedValue({ items: [archived], total: 1, nextCursor: null });
    renderTab([], vi.fn(), '/cos/agents?feedback=needs-feedback');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Needs feedback: 1' })).toBeInTheDocument());
    expect(screen.getByText('An older pending run')).toBeInTheDocument();
  });

  it('does not hide a live completion that arrives after the index snapshot', async () => {
    api.getCosPendingAgentFeedback.mockResolvedValue({ agents: [], count: 0 });
    renderTab([completedAgent('just-finished', 'A just-finished run')]);

    await waitFor(() => expect(screen.getByRole('button', { name: 'Needs feedback: 1' })).toBeInTheDocument());
  });

  it('filters loaded completed agents to unrated non-system runs', async () => {
    const user = userEvent.setup();
    renderTab([
      completedAgent('unrated', 'Unrated task'),
      completedAgent('rated', 'Rated task', { feedback: { rating: 'positive' } }),
      completedAgent('system', 'System task', { taskId: 'sys-health-check' }),
    ]);
    await act(async () => {});

    const needsFeedback = screen.getByRole('button', { name: 'Needs feedback: 1' });
    await user.click(needsFeedback);

    expect(screen.getByText('Unrated task')).toBeInTheDocument();
    expect(screen.queryByText('Rated task')).not.toBeInTheDocument();
    expect(screen.queryByText('System task')).not.toBeInTheDocument();
    expect(needsFeedback).toHaveAttribute('aria-pressed', 'true');
  });

  it('excludes scheduled/autopilot runs (taskType internal) from the feedback queue', async () => {
    renderTab([
      completedAgent('unrated', 'Unrated task'),
      completedAgent('scheduled', 'Scheduled task', { metadata: { taskDescription: 'Scheduled task', taskType: 'internal' } }),
    ]);
    await act(async () => {});

    expect(screen.getByRole('button', { name: 'Needs feedback: 1' })).toBeInTheDocument();
  });

  it('opens the feedback queue directly from the URL', async () => {
    renderTab([
      completedAgent('unrated', 'Unrated task'),
      completedAgent('rated', 'Rated task', { feedback: { rating: 'positive' } }),
    ], vi.fn(), '/cos/agents?feedback=needs-feedback');
    await act(async () => {});

    expect(screen.getByText('Unrated task')).toBeInTheDocument();
    expect(screen.queryByText('Rated task')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Needs feedback: 1' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('removes an archived run from the queue immediately after feedback', async () => {
    const user = userEvent.setup();
    const onRefresh = vi.fn();
    api.getCosCompletedAgents.mockResolvedValue({ items: [completedAgent('archived', 'Archived task')], total: 1, nextCursor: null });

    renderTab([], onRefresh);
    await act(async () => {});
    await screen.findByText('Archived task');
    await user.click(screen.getByRole('button', { name: 'Needs feedback: 1' }));
    await user.click(screen.getByRole('button', { name: 'Rate Archived task' }));

    await waitFor(() => {
      expect(screen.queryByText('Archived task')).not.toBeInTheDocument();
      expect(screen.getByText('All loaded agent runs have feedback.')).toBeInTheDocument();
    });
    expect(onRefresh).not.toHaveBeenCalled();
  });
});

it('opens an agent deep link even after it has left the recent agent list', async () => {
  api.getCosAgent.mockResolvedValue({ id: 'archived-example', status: 'completed', metadata: { taskDescription: 'Example maintenance audit' } });
  render(<MemoryRouter initialEntries={['/cos/agents/archived-example']}><Routes>
    <Route path="/cos/:tab/:agentId" element={<AgentsTab agents={[]} onRefresh={vi.fn()} liveOutputs={{}} providers={[]} apps={[]} />} />
  </Routes></MemoryRouter>);
  expect(await screen.findByTestId('agent-archived-example')).toBeInTheDocument();
  expect(api.getCosAgent).toHaveBeenCalledWith('archived-example', { silent: true });
});

it('keeps a retry on an agent deep link whose read failed, and reports a 404 as not found', async () => {
  const user = userEvent.setup();
  api.getCosAgent.mockRejectedValueOnce(Object.assign(new Error('Server unavailable'), { status: 503 }))
    .mockResolvedValueOnce({ id: 'archived-example', status: 'completed', metadata: { taskDescription: 'Example maintenance audit' } });
  const { unmount } = render(<MemoryRouter initialEntries={['/cos/agents/archived-example']}><Routes>
    <Route path="/cos/:tab/:agentId" element={<AgentsTab agents={[]} onRefresh={vi.fn()} liveOutputs={{}} providers={[]} apps={[]} />} />
  </Routes></MemoryRouter>);
  expect(await screen.findByText(/Could not load this agent — Server unavailable/)).toBeInTheDocument();
  expect(screen.queryByText('Agent not found or unavailable.')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByTestId('agent-archived-example')).toBeInTheDocument();
  unmount();

  api.getCosAgent.mockRejectedValueOnce(Object.assign(new Error('Agent not found'), { status: 404 }));
  render(<MemoryRouter initialEntries={['/cos/agents/missing-example']}><Routes>
    <Route path="/cos/:tab/:agentId" element={<AgentsTab agents={[]} onRefresh={vi.fn()} liveOutputs={{}} providers={[]} apps={[]} />} />
  </Routes></MemoryRouter>);
  expect(await screen.findByText('Agent not found or unavailable.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
});

describe('AgentsTab bounded archive loading', () => {
  it('loads a bounded first page and preserves rows and cursor after a failed next page', async () => {
    const user = userEvent.setup();
    api.getCosCompletedAgents.mockResolvedValueOnce({ items: [completedAgent('archived', 'Archived task')], total: 2, nextCursor: 'next' })
      .mockRejectedValueOnce(new Error('Temporary failure'))
      .mockResolvedValueOnce({ items: [completedAgent('older', 'Older task')], total: 2, nextCursor: null });
    renderTab([]);
    await screen.findByText('Archived task');
    expect(api.getCosCompletedAgents).toHaveBeenCalledWith(expect.objectContaining({ limit: 25, cursor: null }));
    await user.click(screen.getByRole('button', { name: 'Load older agents' }));
    await screen.findByRole('alert');
    expect(screen.getByText('Archived task')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Retry loading' }));
    await screen.findByText('Older task');
    expect(api.getCosCompletedAgents.mock.calls.slice(1).map(([args]) => args.cursor)).toEqual(['next', 'next']);
    expect(screen.getByText('All results loaded')).toBeInTheDocument();
  });
});

// Resume and Relaunch build a NEW task prompt out of the description, so a copy
// the listing clipped would silently ship a truncated task.
describe('AgentsTab hydrates a clipped description before reusing it', () => {
  const clipped = {
    id: 'agent-paused',
    taskId: 'task-abc',
    status: 'paused',
    startedAt: '2026-07-13T09:00:00.000Z',
    metadata: { taskDescription: 'Half-finished', taskDescriptionTruncated: true },
  };

  it('hands the resume dialog the full description, not the listing preview', async () => {
    const user = userEvent.setup();
    api.hydrateCosAgentDescription.mockResolvedValue({
      ...clipped,
      metadata: { ...clipped.metadata, taskDescription: 'Half-finished work, in full', taskDescriptionTruncated: false },
    });
    api.resumeCosAgent.mockResolvedValue({ success: true, taskId: 'task-abc', mode: 'requeued' });

    renderTab([clipped]);
    await act(async () => {});
    await user.click(screen.getByRole('button', { name: 'Resume agent-paused' }));
    await user.click(await screen.findByRole('button', { name: 'Submit resume' }));

    await waitFor(() => expect(api.resumeCosAgent).toHaveBeenCalled());
    expect(api.hydrateCosAgentDescription).toHaveBeenCalledWith(clipped);
    expect(api.resumeCosAgent.mock.calls[0][1].description).toBe('[Resume] Half-finished work, in full');
  });
});


it('makes the clear scope explicit when the feedback filter hides completed records', async () => {
  api.getCosCompletedAgents.mockResolvedValue({ items: [completedAgent('filtered', 'Pending feedback')], total: 1, nextCursor: null });
  renderTab([], vi.fn(), '/cos/agents?feedback=needs-feedback');
  await screen.findByText('Pending feedback');
  await userEvent.click(screen.getByRole('button', { name: 'Clear all completed agents' }));
  expect(screen.getByText(/including records outside the current filter and unloaded pages/)).toBeInTheDocument();
  expect(screen.queryByText(/removes 1 agent record/)).not.toBeInTheDocument();
});

it('explains retained active cleanup owners when clearing completed agents', async () => {
  const user = userEvent.setup();
  api.getCosCompletedAgents.mockResolvedValue({ items: [completedAgent('done', 'Completed work')], total: 2, nextCursor: null });
  api.clearCompletedCosAgents.mockResolvedValue({ cleared: 1, retained: 1 });
  const onRefresh = vi.fn();
  renderTab([], onRefresh);
  await screen.findByText('Completed work');
  await user.click(screen.getByRole('button', { name: 'Clear all completed agents' }));
  await user.click(screen.getByRole('button', { name: 'Clear all' }));
  expect(toast.success).toHaveBeenCalledWith('Cleared 1 completed agent (1 active cleanup owner retained)');
  expect(onRefresh).toHaveBeenCalled();
});


const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

describe('AgentsTab confirmed deletion', () => {
  it('retains other card instances, search, filter and loaded pages without a list reload', async () => {
    const user = userEvent.setup();
    const first = completedAgent('first', 'Shared first');
    const second = completedAgent('second', 'Shared second');
    const older = completedAgent('older', 'Shared older');
    api.getCosCompletedAgents
      .mockResolvedValueOnce({ items: [first, second], total: 4, nextCursor: 'second-cursor' })
      .mockResolvedValueOnce({ items: [older], total: 4, nextCursor: 'older-cursor' })
      .mockResolvedValueOnce({ items: [second], total: 3, nextCursor: 'second-cursor' })
      .mockResolvedValueOnce({ items: [completedAgent('oldest', 'Shared oldest')], total: 3, nextCursor: null });
    const deletion = deferred();
    api.deleteCosAgent.mockReturnValue(deletion.promise);
    const onRefresh = vi.fn();
    renderTab([], onRefresh, '/cos/agents?feedback=needs-feedback');
    await screen.findByTestId('agent-second');
    await user.click(screen.getByRole('button', { name: 'Load older agents' }));
    const olderCard = await screen.findByTestId('agent-older');
    const secondCard = screen.getByTestId('agent-second');
    const grid = olderCard.parentElement;
    grid.scrollTop = 240;
    await user.type(screen.getByRole('textbox', { name: 'Card draft second' }), 'Keep local state');
    await user.type(screen.getByRole('textbox', { name: 'Search completed agents' }), 'Shared');
    await user.click(screen.getByRole('button', { name: 'Delete first' }));
    expect(screen.getByTestId('agent-first')).toBeInTheDocument();
    await act(async () => deletion.resolve({ success: true, agentId: 'first' }));
    expect(screen.queryByTestId('agent-first')).toBeNull();
    expect(screen.getByTestId('agent-second')).toBe(secondCard);
    expect(screen.getByTestId('agent-older')).toBe(olderCard);
    expect(screen.getByRole('textbox', { name: 'Card draft second' })).toHaveValue('Keep local state');
    expect(screen.getByRole('textbox', { name: 'Search completed agents' })).toHaveValue('Shared');
    expect(screen.getByRole('button', { name: /Needs feedback:/ })).toHaveAttribute('aria-pressed', 'true');
    expect(grid.scrollTop).toBe(240);
    expect(screen.getByText('(3 total)')).toBeInTheDocument();
    expect(api.getCosCompletedAgents).toHaveBeenCalledTimes(3);
    expect(onRefresh).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Load older agents' }));
    expect(api.getCosCompletedAgents).toHaveBeenLastCalledWith(expect.objectContaining({ cursor: 'older-cursor', feedback: true }));
  });

  it('removes only each confirmed ID when deletes settle out of order and parent props stay stale', async () => {
    const user = userEvent.setup();
    const first = completedAgent('first', 'First');
    const second = completedAgent('second', 'Second');
    const survivor = completedAgent('survivor', 'Survivor');
    api.getCosCompletedAgents.mockResolvedValue({ items: [first, second, survivor], total: 3, nextCursor: null });
    const firstDelete = deferred();
    const secondDelete = deferred();
    api.deleteCosAgent.mockImplementation(id => id === 'first' ? firstDelete.promise : secondDelete.promise);
    renderTab([first, second]);
    const survivorCard = await screen.findByTestId('agent-survivor');
    await user.click(screen.getByRole('button', { name: 'Delete first' }));
    await user.click(screen.getByRole('button', { name: 'Delete second' }));
    api.getCosCompletedAgents.mockResolvedValue({ items: [first, survivor], total: 2, nextCursor: null });
    await act(async () => secondDelete.resolve({ success: true, agentId: 'second' }));
    expect(screen.queryByTestId('agent-second')).toBeNull();
    expect(screen.getByTestId('agent-first')).toBeInTheDocument();
    expect(screen.getByText('(2 total)')).toBeInTheDocument();
    api.getCosCompletedAgents.mockResolvedValue({ items: [survivor], total: 1, nextCursor: null });
    await act(async () => {
      socket.receive('cos:agent:feedback', { agentId: 'second', feedback: { rating: 'positive' } });
      firstDelete.resolve({ success: true, agentId: 'first' });
    });
    expect(screen.queryByTestId('agent-first')).toBeNull();
    expect(screen.queryByTestId('agent-second')).toBeNull();
    expect(screen.getByTestId('agent-survivor')).toBe(survivorCard);
    expect(screen.getByText('(1 total)')).toBeInTheDocument();
  });

  it('keeps every card and local state when deletion fails', async () => {
    const user = userEvent.setup();
    api.getCosCompletedAgents.mockResolvedValue({ items: [completedAgent('first', 'First')], total: 1, nextCursor: null });
    api.deleteCosAgent.mockRejectedValue(new Error('Could not remove agent'));
    const onRefresh = vi.fn();
    renderTab([], onRefresh);
    const card = await screen.findByTestId('agent-first');
    await user.type(screen.getByRole('textbox', { name: 'Card draft first' }), 'Keep me');
    await user.click(screen.getByRole('button', { name: 'Delete first' }));
    expect(toast.error).toHaveBeenCalledWith('Could not remove agent');
    expect(screen.getByTestId('agent-first')).toBe(card);
    expect(screen.getByRole('textbox', { name: 'Card draft first' })).toHaveValue('Keep me');
    expect(screen.getByText('(1 total)')).toBeInTheDocument();
    expect(api.getCosCompletedAgents).toHaveBeenCalledTimes(1);
    expect(onRefresh).not.toHaveBeenCalled();
  });
});


describe('AgentsTab deletion reconciliation races', () => {
  it('uses the server count when a completion refresh observes deletion before DELETE returns', async () => {
    const user = userEvent.setup();
    const removed = completedAgent('removed', 'Removed');
    const kept = completedAgent('kept', 'Kept');
    const deletion = deferred();
    api.deleteCosAgent.mockReturnValue(deletion.promise);
    api.getCosCompletedAgents.mockResolvedValueOnce({ items: [removed, kept], total: 2, nextCursor: null })
      .mockResolvedValue({ items: [kept], total: 1, nextCursor: null });
    const tab = revision => <MemoryRouter><AgentsTab agents={[]} onRefresh={vi.fn()} liveOutputs={{}}
      providers={[]} apps={[]} completedRevision={revision} /></MemoryRouter>;
    const view = render(tab(0));
    const keptCard = await screen.findByTestId('agent-kept');
    await user.click(screen.getByRole('button', { name: 'Delete removed' }));
    view.rerender(tab(1));
    await waitFor(() => expect(screen.getByText('(1 total)')).toBeInTheDocument());
    // The additive refresh retains loaded rows; the DELETE hasn't acknowledged yet.
    expect(screen.getByTestId('agent-removed')).toBeInTheDocument();
    await act(async () => deletion.resolve({ success: true, agentId: 'removed' }));
    expect(screen.queryByTestId('agent-removed')).toBeNull();
    expect(screen.getByText('(1 total)')).toBeInTheDocument();
    expect(screen.getByTestId('agent-kept')).toBe(keptCard);
  });

  it('reconciles counts when deleting a selected record outside loaded history', async () => {
    const user = userEvent.setup();
    const selected = completedAgent('selected', 'Selected');
    const kept = completedAgent('kept', 'Kept');
    api.getCosAgent.mockResolvedValue(selected);
    api.getCosCompletedAgents.mockResolvedValueOnce({ items: [kept], total: 2, nextCursor: 'kept' })
      .mockResolvedValue({ items: [kept], total: 1, nextCursor: null });
    api.deleteCosAgent.mockResolvedValue({ success: true, agentId: 'selected' });
    render(<MemoryRouter initialEntries={['/cos/agents/selected']}><Routes>
      <Route path="/cos/agents/:agentId" element={<AgentsTab agents={[]} onRefresh={vi.fn()}
        liveOutputs={{}} providers={[]} apps={[]} />} />
    </Routes></MemoryRouter>);
    await screen.findByTestId('agent-selected');
    const keptCard = await screen.findByTestId('agent-kept');
    await user.click(screen.getByRole('button', { name: 'Delete selected' }));
    expect(screen.queryByTestId('agent-selected')).toBeNull();
    expect(screen.getByText('(1 total)')).toBeInTheDocument();
    expect(screen.getByTestId('agent-kept')).toBe(keptCard);
  });

  it('does not restore a deleted card when its focused detail read resolves late', async () => {
    const user = userEvent.setup();
    const selected = completedAgent('selected', 'Selected');
    const focus = deferred();
    api.getCosAgent.mockReturnValue(focus.promise);
    api.getCosCompletedAgents.mockResolvedValueOnce({ items: [selected], total: 1, nextCursor: null })
      .mockResolvedValue({ items: [], total: 0, nextCursor: null });
    api.deleteCosAgent.mockResolvedValue({ success: true, agentId: 'selected' });
    render(<MemoryRouter initialEntries={['/cos/agents/selected']}><Routes>
      <Route path="/cos/agents/:agentId" element={<AgentsTab agents={[]} onRefresh={vi.fn()}
        liveOutputs={{}} providers={[]} apps={[]} />} />
    </Routes></MemoryRouter>);
    await screen.findByTestId('agent-selected');
    await user.click(screen.getByRole('button', { name: 'Delete selected' }));
    await act(async () => focus.resolve(selected));
    expect(screen.queryByTestId('agent-selected')).toBeNull();
    expect(screen.getByText('Agent not found or unavailable.')).toBeInTheDocument();
  });
});
