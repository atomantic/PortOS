import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { typeSettled } from '../../../test/settledInput';

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

afterEach(() => {
  vi.useRealTimers();
});

describe('AgentCard feedback', () => {
  it('uses the archived scheduled type for a running agent ETA', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T10:00:00.000Z'));
    const runningAgent = {
      ...agent,
      status: 'running',
      startedAt: '2026-07-13T09:59:00.000Z',
      completedAt: null,
      metadata: {
        taskDescription: 'Fix the security configuration',
        taskType: 'internal',
        taskAnalysisType: 'security',
      },
    };
    const durations = {
      'self-improve:security': { avgDurationMs: 600000, p80DurationMs: 600000, completed: 5 },
      _overall: { avgDurationMs: 1000, p80DurationMs: 1000, completed: 20 },
    };

    render(
      <MemoryRouter>
        <AgentCard agent={runningAgent} durations={durations} />
      </MemoryRouter>
    );

    expect(screen.getByText('10% complete')).toBeInTheDocument();
  });

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
    await typeSettled(user, screen.getByPlaceholderText('What made this work well or poorly?'), updatedAgent.feedback.comment);
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
    await typeSettled(user, screen.getByPlaceholderText('What made this work well or poorly?'), detailedAgent.feedback.comment);
    await user.click(screen.getByRole('button', { name: 'Save detail' }));

    expect(api.submitCosAgentFeedback).toHaveBeenCalledWith(
      agent.id,
      { rating: 'positive', comment: detailedAgent.feedback.comment },
      { silent: true }
    );
  });
});

describe('AgentCard transcript truncation (#3498)', () => {
  it('says the transcript was clipped when the server returns a capped tail', async () => {
    const user = userEvent.setup();
    api.getCosAgent.mockResolvedValue({
      ...agent,
      output: [{ line: 'last line', timestamp: agent.completedAt }],
      outputTruncated: true,
      outputTotalBytes: 12 * 1024 * 1024,
    });

    render(
      <MemoryRouter>
        <AgentCard agent={agent} completed />
      </MemoryRouter>
    );

    await user.click(screen.getByRole('button', { name: 'Show' }));

    expect(await screen.findByText(/Showing the last 1 line —/)).toBeInTheDocument();
    expect(screen.getByText(/12 MB/)).toBeInTheDocument();
  });

  it('still reports the clip when the tail window yielded no renderable lines', async () => {
    const user = userEvent.setup();
    api.getCosAgent.mockResolvedValue({
      ...agent,
      output: [],
      outputTruncated: true,
      outputTotalBytes: 8 * 1024 * 1024,
    });

    render(
      <MemoryRouter>
        <AgentCard agent={agent} completed />
      </MemoryRouter>
    );

    await user.click(screen.getByRole('button', { name: 'Show' }));

    // "No output captured" would call a multi-MB log empty.
    expect(await screen.findByText(/no readable lines/)).toBeInTheDocument();
    expect(screen.queryByText('No output captured')).not.toBeInTheDocument();
  });

  it('stays quiet when the whole transcript fit under the cap', async () => {
    const user = userEvent.setup();
    api.getCosAgent.mockResolvedValue({
      ...agent,
      output: [{ line: 'only line', timestamp: agent.completedAt }],
      outputTruncated: false,
      outputTotalBytes: 10,
    });

    render(
      <MemoryRouter>
        <AgentCard agent={agent} completed />
      </MemoryRouter>
    );

    await user.click(screen.getByRole('button', { name: 'Show' }));

    await waitFor(() => expect(api.getCosAgent).toHaveBeenCalledWith(agent.id));
    expect(screen.queryByText(/Showing the last/)).not.toBeInTheDocument();
  });
});
