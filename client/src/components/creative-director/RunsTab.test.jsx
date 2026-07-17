/**
 * RunsTab — surfaces a failed run's failureReason so a failed run always says
 * WHY (issue #2705). Recovery + orphan-settle write `failureReason` (not `error`),
 * and the tab previously rendered only `error`, so those runs showed blank.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

import RunsTab from './RunsTab.jsx';

const renderTab = (project) =>
  render(
    <MemoryRouter>
      <RunsTab project={project} />
    </MemoryRouter>,
  );

describe('RunsTab — run failure reasons', () => {
  it('renders a failed run\'s failureReason', () => {
    renderTab({
      runs: [
        {
          runId: 'r1', kind: 'plan', status: 'failed',
          startedAt: '2026-07-16T23:52:34.206Z',
          failureReason: 'interrupted by restart',
        },
      ],
    });
    expect(screen.getByText('interrupted by restart')).toBeInTheDocument();
  });

  it('surfaces the orphan-settle reason (the case that used to render blank)', () => {
    renderTab({
      runs: [
        {
          runId: 'r2', kind: 'plan', status: 'failed',
          startedAt: '2026-07-16T23:59:30.600Z',
          failureReason: 'agent process terminated unexpectedly (orphaned)',
        },
      ],
    });
    expect(screen.getByText(/orphaned/)).toBeInTheDocument();
  });

  it('does not duplicate the message when error and failureReason are identical', () => {
    renderTab({
      runs: [
        {
          runId: 'r3', kind: 'treatment', status: 'failed',
          startedAt: '2026-07-16T23:59:30.600Z',
          error: 'same message', failureReason: 'same message',
        },
      ],
    });
    expect(screen.getAllByText('same message')).toHaveLength(1);
  });

  it('shows an empty-state message when there are no runs', () => {
    renderTab({ runs: [] });
    expect(screen.getByText(/No runs yet/)).toBeInTheDocument();
  });
});
