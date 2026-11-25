import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('react-router', () => ({ useNavigate: () => vi.fn() }));
vi.mock('../../hooks/useInstanceFeatures.js', () => ({
  useInstanceFeatures: () => ({ isFeatureEnabled: () => false }),
}));
vi.mock('../ui/Toast');
vi.mock('../../services/apiAgents.js', () => ({ addCosTask: vi.fn() }));

import GsdProjectHeader from './GsdProjectHeader.jsx';
import toast from '../ui/Toast';
import { addCosTask } from '../../services/apiAgents.js';

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

describe('GsdProjectHeader new milestone', () => {
  const completeProject = { phases: [{ totalTasks: 1, completedTasks: 1, verification: { status: 'passed' }, plans: [{}] }] };
  const renderComplete = () => render(<GsdProjectHeader appId="example-app" project={completeProject} onRefresh={() => {}} />);

  it('does not announce success when the task request fails', async () => {
    vi.clearAllMocks();
    addCosTask.mockRejectedValue(new Error('boom'));
    renderComplete();
    await userEvent.click(screen.getByRole('button', { name: /New Milestone/ }));
    await waitFor(() => expect(addCosTask).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('announces success once when the task is created', async () => {
    vi.clearAllMocks();
    addCosTask.mockResolvedValue({ id: 't1' });
    renderComplete();
    await userEvent.click(screen.getByRole('button', { name: /New Milestone/ }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledTimes(1));
  });
});
