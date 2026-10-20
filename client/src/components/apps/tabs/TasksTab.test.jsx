import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

vi.mock('../../../services/api', () => ({
  getAppAgents: vi.fn(),
  getProviders: vi.fn(),
  getApps: vi.fn(),
}));

vi.mock('../../cos/TaskAddForm', () => ({ default: () => <div data-testid="task-add-form" /> }));
vi.mock('../../BrailleSpinner', () => ({ default: () => <div>Loading agent history</div> }));

import * as api from '../../../services/api';
import TasksTab from './TasksTab';

const AGENT = {
  id: 'agent-1',
  status: 'completed',
  startedAt: '2026-09-10T16:00:00.000Z',
  completedAt: '2026-09-10T16:00:15.000Z',
  metadata: {
    taskType: 'internal',
    taskDescription: 'A long task description that used to force the table past its container and clip Duration and When.',
  },
};

function renderTab() {
  return render(
    <MemoryRouter>
      <TasksTab appId="app-1" />
    </MemoryRouter>,
  );
}

describe('TasksTab layout', () => {
  beforeEach(() => {
    api.getAppAgents.mockResolvedValue({
      agents: [AGENT],
      summary: { total: 1, running: 0, succeeded: 1 },
    });
    api.getProviders.mockResolvedValue({ providers: [] });
    api.getApps.mockResolvedValue([]);
  });

  it('lets the recent-task table use the full desktop width instead of clipping Duration and When', async () => {
    const { container } = renderTab();

    await waitFor(() => {
      expect(screen.getByRole('columnheader', { name: 'Duration' })).toBeInTheDocument();
    });

    expect(screen.getByRole('columnheader', { name: 'When' })).toBeInTheDocument();
    expect(container.querySelector('.max-w-5xl')).toBeNull();

    const table = screen.getByRole('table');
    expect(table).toHaveClass('w-full', 'table-fixed');
    expect(table.parentElement).toHaveClass('overflow-x-auto');
  });
});

describe('TasksTab read failure', () => {
  beforeEach(() => {
    api.getProviders.mockResolvedValue({ providers: [] });
    api.getApps.mockResolvedValue([]);
  });

  it('shows an error row with Retry instead of zero stats and the empty copy, then recovers', async () => {
    api.getAppAgents.mockRejectedValueOnce(new Error('boom'));
    renderTab();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not load agent history');
    expect(screen.queryByText('Success Rate')).toBeNull();
    expect(screen.queryByText(/No agent tasks found/)).toBeNull();

    api.getAppAgents.mockResolvedValue({ agents: [AGENT], summary: { total: 1 } });
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await screen.findByRole('table');
    expect(screen.getByText('Success Rate')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('renders the real-empty copy when the read succeeds with no agents', async () => {
    api.getAppAgents.mockResolvedValue({ agents: [], summary: {} });
    renderTab();
    expect(await screen.findByText(/No agent tasks found/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
