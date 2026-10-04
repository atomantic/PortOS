import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../../hooks/useInstanceFeatures.js', () => ({
  useInstanceFeatures: () => ({ isFeatureEnabled: () => false }),
}));
vi.mock('../ui/Toast', () => ({ default: { success: vi.fn() } }));

import GsdProjectHeader from './GsdProjectHeader.jsx';

describe('GsdProjectHeader phase meters', () => {
  it('announces completed and planned phase percentages', () => {
    render(
      <GsdProjectHeader
        appId="example-app"
        project={{
          phases: [
            { totalTasks: 2, completedTasks: 2, verification: { status: 'passed' }, plans: [{}] },
            { totalTasks: 2, completedTasks: 1, verification: { status: 'pending' }, plans: [] },
          ],
        }}
        onRefresh={() => {}}
      />,
    );

    expect(screen.getByRole('progressbar', { name: 'Completed phases' })).toHaveAttribute('aria-valuenow', '50');
    expect(screen.getByRole('progressbar', { name: 'Planned phases' })).toHaveAttribute('aria-valuenow', '50');
  });
});
