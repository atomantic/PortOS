import { beforeEach, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const api = vi.hoisted(() => ({
  getCosLearning: vi.fn(),
  getCosTodayActivity: vi.fn(),
  backfillCosLearning: vi.fn(),
}));
vi.mock('../../../services/apiAgents.js', () => ({
  getCosLearning: api.getCosLearning,
  getCosTodayActivity: api.getCosTodayActivity,
  backfillCosLearning: api.backfillCosLearning,
}));
vi.mock('./ProviderStatusCard', () => ({ default: () => null }));

import HealthTab from './HealthTab';

beforeEach(() => {
  vi.clearAllMocks();
  api.getCosTodayActivity.mockResolvedValue({ stats: { completed: 0 }, accomplishments: [] });
  api.getCosLearning.mockResolvedValue(null);
});

// A failed learning read used to read "No learning data available yet" — the
// same copy as a fresh install, and it hid the Backfill History action.
it('shows a retryable error when the learning read fails', async () => {
  const user = userEvent.setup();
  api.getCosLearning.mockRejectedValueOnce(new Error('Server unavailable'))
    .mockResolvedValueOnce({ totals: { completed: 12, successRate: 75, avgDurationMin: 4, failed: 3 }, insights: {} });
  render(<HealthTab health={null} onCheck={vi.fn()} />);

  expect(await screen.findByText(/Could not load learning data — Server unavailable/)).toBeInTheDocument();
  expect(screen.queryByText('No learning data available yet')).not.toBeInTheDocument();
  expect(api.getCosLearning).toHaveBeenCalledWith({ silent: true });

  await user.click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText('Tasks Tracked')).toBeInTheDocument();
  expect(screen.getByText('75%')).toBeInTheDocument();
});

it('keeps a newer learning read when an older one fails last', async () => {
  const user = userEvent.setup();
  let rejectFirst;
  api.getCosLearning.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectFirst = reject; }))
    .mockResolvedValueOnce({ totals: { completed: 5, successRate: 60, avgDurationMin: 2, failed: 2 }, insights: {} });
  render(<HealthTab health={null} onCheck={vi.fn()} />);
  await user.click(screen.getByRole('button', { name: 'Refresh' }));
  expect(await screen.findByText('60%')).toBeInTheDocument();
  await act(async () => rejectFirst(new Error('Late failure')));
  expect(screen.getByText('60%')).toBeInTheDocument();
  expect(screen.queryByText(/Could not load learning data/)).not.toBeInTheDocument();
});

it.each([false, true])('retries a failed activity read (has accomplishments: %s)', async (hasAccomplishments) => {
  const activity = hasAccomplishments
    ? { stats: { completed: 1 }, time: { combined: '1m' }, accomplishments: [{ description: 'Example accomplishment', duration: 60_000 }] }
    : { stats: { completed: 0 }, accomplishments: [] };
  api.getCosTodayActivity.mockRejectedValueOnce(new Error('Offline')).mockResolvedValueOnce(activity);
  render(<HealthTab health={null} onCheck={vi.fn()} />);

  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load activity data');
  expect(screen.queryByText('No accomplishments yet today')).not.toBeInTheDocument();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Retry' }));
  expect(await screen.findByText(hasAccomplishments ? 'Example accomplishment' : 'No accomplishments yet today')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});
