import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

vi.mock('../../../services/api', () => ({
  submitCosAgentFeedback: vi.fn(),
  getCosAgent: vi.fn(),
  getCosAgentPrompt: vi.fn(),
}));

vi.mock('../../ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

import * as api from '../../../services/api';
import AgentCard from './AgentCard';

const agent = {
  id: 'agent-example',
  taskId: 'task-example',
  status: 'completed',
  startedAt: '2026-07-13T09:00:00.000Z',
  completedAt: '2026-07-13T10:00:00.000Z',
  metadata: { taskDescription: 'Example task' },
  result: { success: true, duration: 3600000 },
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AgentCard feedback', () => {
  it('returns the updated agent to its parent after a successful rating', async () => {
    const user = userEvent.setup();
    const updatedAgent = {
      ...agent,
      feedback: { rating: 'positive', submittedAt: '2026-07-13T12:00:00.000Z' },
    };
    const onFeedbackChange = vi.fn();
    api.submitCosAgentFeedback.mockResolvedValue({ success: true, agent: updatedAgent });

    render(
      <MemoryRouter>
        <AgentCard agent={agent} completed onFeedbackChange={onFeedbackChange} />
      </MemoryRouter>
    );

    await user.click(screen.getByRole('button', { name: 'Mark as helpful' }));

    expect(api.submitCosAgentFeedback).toHaveBeenCalledWith(
      agent.id,
      { rating: 'positive', comment: undefined },
      { silent: true }
    );
    await waitFor(() => expect(onFeedbackChange).toHaveBeenCalledWith(updatedAgent));
  });

  it('records a negative rating with the detail needed to improve future work', async () => {
    const user = userEvent.setup();
    const updatedAgent = {
      ...agent,
      feedback: {
        rating: 'negative',
        comment: 'The implementation did not include tests.',
        submittedAt: '2026-07-13T12:00:00.000Z'
      }
    };
    api.submitCosAgentFeedback.mockResolvedValue({ success: true, agent: updatedAgent });

    render(
      <MemoryRouter>
        <AgentCard agent={agent} completed />
      </MemoryRouter>
    );

    await user.click(screen.getByRole('button', { name: 'Add feedback comment' }));
    await user.type(screen.getByPlaceholderText('What made this work well or poorly?'), updatedAgent.feedback.comment);
    await user.click(screen.getByRole('button', { name: 'Needs work' }));

    expect(api.submitCosAgentFeedback).toHaveBeenCalledWith(
      agent.id,
      { rating: 'negative', comment: updatedAgent.feedback.comment },
      { silent: true }
    );
  });

  it('lets a quick rating receive a follow-up detail', async () => {
    const user = userEvent.setup();
    const ratedAgent = {
      ...agent,
      feedback: { rating: 'positive', submittedAt: '2026-07-13T12:00:00.000Z' }
    };
    const detailedAgent = {
      ...ratedAgent,
      feedback: { ...ratedAgent.feedback, comment: 'The focused test coverage was useful.' }
    };
    api.submitCosAgentFeedback.mockResolvedValue({ success: true, agent: detailedAgent });

    render(
      <MemoryRouter>
        <AgentCard agent={ratedAgent} completed />
      </MemoryRouter>
    );

    await user.click(screen.getByRole('button', { name: 'Add feedback detail' }));
    await user.type(screen.getByPlaceholderText('What made this work well or poorly?'), detailedAgent.feedback.comment);
    await user.click(screen.getByRole('button', { name: 'Save detail' }));

    expect(api.submitCosAgentFeedback).toHaveBeenCalledWith(
      agent.id,
      { rating: 'positive', comment: detailedAgent.feedback.comment },
      { silent: true }
    );
  });
});
