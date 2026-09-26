import { MemoryRouter } from 'react-router';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// UpcomingTasksWidget's own logic is what response to a good/failed/absent
// fetch should render — the subscription/retry mechanics belong to useSocketResource
// and are covered by its own test suite. Mocking the hook lets these tests
// pin the widget's render contract directly against each { data, loading,
// error } combination without fake timers or interval plumbing.
const { mockUseSocketResource, mockGetCosUpcomingTasks } = vi.hoisted(() => ({
  mockUseSocketResource: vi.fn(),
  mockGetCosUpcomingTasks: vi.fn(),
}));

vi.mock('../hooks/useSocketResource', () => ({
  useSocketResource: (...args) => mockUseSocketResource(...args),
}));

vi.mock('../services/api', () => ({
  getCosUpcomingTasks: (...args) => mockGetCosUpcomingTasks(...args),
}));

import UpcomingTasksWidget from './UpcomingTasksWidget.jsx';

const renderWidget = () => render(
  <MemoryRouter>
    <UpcomingTasksWidget />
  </MemoryRouter>,
);

const readyTask = {
  taskType: 'security',
  status: 'ready',
  description: 'Security audit',
  intervalType: 'cron',
  runCount: 2,
  lastRunFormatted: '2h ago',
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('UpcomingTasksWidget', () => {
  it('renders nothing during the initial load', () => {
    mockUseSocketResource.mockReturnValue({ data: null, loading: true, error: null });
    const { container } = renderWidget();
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when there is genuinely no upcoming work and no error', () => {
    mockUseSocketResource.mockReturnValue({ data: [], loading: false, error: null });
    const { container } = renderWidget();
    expect(container).toBeEmptyDOMElement();
  });

  it('shows an unavailable state instead of silently hiding when the first-ever fetch fails (#7527)', () => {
    mockUseSocketResource.mockReturnValue({ data: null, loading: false, error: new Error('boom') });
    renderWidget();
    expect(screen.getByText('Schedule unavailable — retrying…')).toBeInTheDocument();
  });

  it('renders ready and scheduled tasks on a healthy load', () => {
    mockUseSocketResource.mockReturnValue({
      data: [
        readyTask,
        {
          taskType: 'documentation',
          status: 'scheduled',
          description: 'Docs sweep',
          intervalType: 'cron',
          eligibleInFormatted: '3h',
          successRate: null,
        },
      ],
      loading: false,
      error: null,
    });
    renderWidget();
    expect(screen.getByText('1 ready now')).toBeInTheDocument();
    expect(screen.getByText('Security audit')).toBeInTheDocument();
    expect(screen.getByText('Docs sweep')).toBeInTheDocument();
  });

  it('keeps showing the last good schedule and flags it stale when a later fetch fails (#7527)', () => {
    mockUseSocketResource.mockReturnValue({
      data: [readyTask],
      loading: false,
      error: new Error('boom'),
    });
    renderWidget();
    expect(screen.getByText('Security audit')).toBeInTheDocument();
    expect(screen.getByText('Showing last known schedule — live data unavailable')).toBeInTheDocument();
  });
});
