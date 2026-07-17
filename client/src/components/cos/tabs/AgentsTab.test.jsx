import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { act } from 'react';

vi.mock('../../../services/api', () => ({
  getCosLearningDurations: vi.fn(),
  getCosAgentDates: vi.fn(),
  getCosAgentsByDate: vi.fn(),
  clearCompletedCosAgents: vi.fn(),
}));

vi.mock('../../ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('./AgentCard', () => ({
  default: ({ agent, onFeedbackChange }) => (
    <div data-testid={`agent-${agent.id}`}>
      <span>{agent.metadata?.taskDescription}</span>
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

vi.mock('./ResumeAgentModal', () => ({ default: () => null }));
vi.mock('../../ui/InlineConfirmRow', () => ({ default: () => null }));

import * as api from '../../../services/api';
import AgentsTab from './AgentsTab';

const completedAgent = (id, description, extra = {}) => ({
  id,
  taskId: `task-${id}`,
  status: 'completed',
  completedAt: '2026-07-13T10:00:00.000Z',
  startedAt: '2026-07-13T09:00:00.000Z',
  metadata: { taskDescription: description },
  ...extra,
});

const renderTab = (agents, onRefresh = vi.fn()) => render(
  <AgentsTab
    agents={agents}
    onRefresh={onRefresh}
    liveOutputs={{}}
    providers={[]}
    apps={[]}
  />
);

beforeEach(() => {
  vi.clearAllMocks();
  api.getCosLearningDurations.mockResolvedValue({});
  api.getCosAgentDates.mockResolvedValue({ dates: [] });
  api.getCosAgentsByDate.mockResolvedValue([]);
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
