import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockGetCosWhileAwayActivity, mockSocket } = vi.hoisted(() => ({
  mockGetCosWhileAwayActivity: vi.fn(),
  mockSocket: { on: vi.fn(), off: vi.fn() },
}));

vi.mock('../services/api', () => ({
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
