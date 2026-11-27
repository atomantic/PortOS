import { beforeEach, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

const api = vi.hoisted(() => ({
  getCosTodayActivity: vi.fn(),
}));
vi.mock('../../../services/apiAgents.js', () => ({
  getCosTodayActivity: api.getCosTodayActivity,
}));
vi.mock('./ProviderStatusCard', () => ({ default: () => null }));

import HealthTab from './HealthTab';

beforeEach(() => {
  vi.clearAllMocks();
  api.getCosTodayActivity.mockResolvedValue({ stats: { completed: 0 }, accomplishments: [] });
});

const renderTab = () => render(<MemoryRouter><HealthTab health={null} onCheck={vi.fn()} /></MemoryRouter>);

it('links to Learning from Health without rendering the learning dashboard', async () => {
  renderTab();

  expect(await screen.findByText(/No tasks completed today yet/)).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Learning tab' })).toHaveAttribute('href', '/cos/learning');
  expect(screen.queryByRole('button', { name: 'Backfill History' })).not.toBeInTheDocument();
});

it.each([false, true])('retries a failed activity read (has accomplishments: %s)', async (hasAccomplishments) => {
  const activity = hasAccomplishments
    ? { stats: { completed: 1 }, time: { combined: '1m' }, accomplishments: [{ description: 'Example accomplishment', duration: 60_000 }] }
    : { stats: { completed: 0 }, accomplishments: [] };
  api.getCosTodayActivity.mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce(activity);
  renderTab();

  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load activity data');
  expect(screen.queryByText('No accomplishments yet today')).not.toBeInTheDocument();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText(hasAccomplishments ? 'Example accomplishment' : 'No accomplishments yet today')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
