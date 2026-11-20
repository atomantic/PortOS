import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetCosWhileAwayActivity, mockSocket } = vi.hoisted(() => ({
  mockGetCosWhileAwayActivity: vi.fn(),
  mockSocket: { on: vi.fn(), off: vi.fn() },
}));

vi.mock('../services/apiAgents.js', () => ({
  getCosWhileAwayActivity: (...args) => mockGetCosWhileAwayActivity(...args),
}));

vi.mock('../services/socket', () => ({ default: mockSocket }));

import WhileAwayWidget from './WhileAwayWidget.jsx';

function CurrentPath() {
  const { pathname } = useLocation();
  return <output data-testid="current-path">{pathname}</output>;
}

const activity = {
  stats: { completed: 3, succeeded: 2, failed: 1, successRate: 67 },
  accomplishments: [
    { id: 'run/one', description: 'First run', taskType: 'task', completedRelative: '1m ago' },
    { id: 'run-two', description: 'Second run', taskType: 'task', completedRelative: '2m ago' },
  ],
  incidents: [
    { id: 'incident-three', description: 'Third run', taskType: 'task', completedRelative: '3m ago' },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCosWhileAwayActivity.mockResolvedValue(activity);
});

describe('WhileAwayWidget run links', () => {
  it('opens the exact run selected from either activity section', async () => {
    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <Routes>
          <Route path="/dashboard" element={<WhileAwayWidget />} />
          <Route path="/cos/agents/:agentId" element={<CurrentPath />} />
        </Routes>
      </MemoryRouter>,
    );

    const firstRun = await screen.findByRole('link', { name: /First run/ });
    const secondRun = screen.getByRole('link', { name: /Second run/ });
    const incidentRun = screen.getByRole('link', { name: /Third run/ });

    expect(firstRun).toHaveAttribute('href', '/cos/agents/run%2Fone');
    expect(secondRun).toHaveAttribute('href', '/cos/agents/run-two');
    expect(incidentRun).toHaveAttribute('href', '/cos/agents/incident-three');

    fireEvent.click(firstRun);
    expect(await screen.findByTestId('current-path')).toHaveTextContent('/cos/agents/run%2Fone');
  });
});

describe('WhileAwayWidget live reads', () => {
  const renderWidget = () => render(<MemoryRouter><WhileAwayWidget /></MemoryRouter>);

  it('re-reads activity when an agent run completes', async () => {
    renderWidget();
    expect(await screen.findByText('3 agent runs since', { exact: false })).toBeInTheDocument();

    mockGetCosWhileAwayActivity.mockResolvedValueOnce({ ...activity, stats: { ...activity.stats, completed: 4 } });
    const [, onCompleted] = mockSocket.on.mock.calls.find(([event]) => event === 'cos:agent:completed');
    await act(async () => { onCompleted({ id: 'run-new' }); });

    expect(await screen.findByText('4 agent runs since', { exact: false })).toBeInTheDocument();
  });

  it('shows an error with retry, not an empty card, when the read fails', async () => {
    mockGetCosWhileAwayActivity.mockRejectedValueOnce(new Error('503'));
    renderWidget();

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load recent agent activity');
    expect(screen.queryByText('No agent activity while you were away.')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('3 agent runs since', { exact: false })).toBeInTheDocument();
  });
});
