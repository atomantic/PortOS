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
  addCosTask: vi.fn(),
}));

vi.mock('../../ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('./AgentCard', () => ({
  default: ({ agent, onFeedbackChange, onResume }) => (
    <div data-testid={`agent-${agent.id}`}>
      <span>{agent.metadata?.taskDescription}</span>
      {onResume && (
        <button type="button" onClick={() => onResume(agent)}>Resume {agent.id}</button>
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
