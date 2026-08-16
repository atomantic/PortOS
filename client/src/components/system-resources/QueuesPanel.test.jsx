import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const api = vi.hoisted(() => ({
  getCosTasks: vi.fn(),
  forceSpawnTask: vi.fn(),
}));

vi.mock('../../services/api.js', () => api);
vi.mock('../media/MediaJobsQueue.jsx', () => ({
  default: () => <div>Media queue</div>,
}));

const QueuesPanel = (await import('./QueuesPanel.jsx')).default;

const renderPanel = () => render(
  <MemoryRouter>
    <QueuesPanel />
  </MemoryRouter>,
);

describe('QueuesPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders an unknown state instead of a false empty queue after a failed probe', async () => {
    api.getCosTasks.mockRejectedValue(new Error('offline'));

    renderPanel();

    expect(await screen.findByText('Agent queue status is unavailable.')).toBeInTheDocument();
    expect(screen.queryByText('No pending agent tasks.')).not.toBeInTheDocument();
    expect(screen.getAllByText('—')).toHaveLength(4);
  });

  it('gives repeated task actions unique names and task-specific deep links', async () => {
    api.getCosTasks.mockResolvedValue({
      user: { tasks: [{ id: 'user/42', description: 'Run an example task', status: 'pending' }] },
      cos: { tasks: [{ id: 'review-7', description: 'Review an example task', status: 'pending', approvalRequired: true }] },
    });

    renderPanel();

    expect(await screen.findByRole('button', { name: 'Run task user/42 now' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Review task review-7' })).toHaveAttribute(
      'href',
      '/cos/tasks?task=review-7&source=internal',
    );
  });
});
