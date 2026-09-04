import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';
import { MemoryRouter } from 'react-router';

vi.mock('../../../services/api', () => ({
  getCosLearningDurations: vi.fn(),
  getCosAgentDates: vi.fn(),
  getCosAgentsByDate: vi.fn(),
  clearCompletedCosAgents: vi.fn(),
  resumeCosAgent: vi.fn(),
  relaunchCosAgent: vi.fn(),
  addCosTask: vi.fn(),
}));

vi.mock('../../ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('./AgentCard', () => ({
  default: ({ agent, onFeedbackChange, onResume, onRelaunch }) => (
    <div data-testid={`agent-${agent.id}`}>
      <span>{agent.metadata?.taskDescription}</span>
      {onResume && (
        <button type="button" onClick={() => onResume(agent)}>Resume {agent.id}</button>
      )}
      {onRelaunch && (
        <button type="button" onClick={() => onRelaunch(agent)}>Relaunch {agent.id}</button>
      )}
      {!agent.feedback?.rating && (
        <button
          type="button"
          onClick={() => onFeedbackChange?.({
            ...agent,
            feedback: { rating: 'positive', submittedAt: '2026-07-13T12:00:00.000Z' },
          })}
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
vi.mock('../../ui/InlineConfirmRow', () => ({ default: () => null }));

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
  api.getCosAgentDates.mockResolvedValue({ dates: [] });
  api.getCosAgentsByDate.mockResolvedValue([]);
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
    api.getCosAgentDates.mockResolvedValue({ dates: [{ date: '2026-07-13', count: 1 }] });
    api.getCosAgentsByDate.mockResolvedValue([
      completedAgent('archived', 'Archived task'),
    ]);

    renderTab([], onRefresh);
    await act(async () => {});
    await screen.findByText('Archived task');
    await user.click(screen.getByRole('button', { name: 'Needs feedback: 1' }));
    await user.click(screen.getByRole('button', { name: 'Rate Archived task' }));

    await waitFor(() => {
      expect(screen.queryByText('Archived task')).not.toBeInTheDocument();
      expect(screen.getByText('All loaded agent runs have feedback.')).toBeInTheDocument();
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
