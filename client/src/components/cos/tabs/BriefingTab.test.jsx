import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import BriefingTab from './BriefingTab';

const api = vi.hoisted(() => ({
  getCosBriefings: vi.fn(),
  getCosLatestBriefing: vi.fn(),
  triggerCosJob: vi.fn(),
}));

vi.mock('../../../services/api', () => api);

const renderTab = () => render(
  <MemoryRouter>
    <BriefingTab />
  </MemoryRouter>,
);

beforeEach(() => {
  vi.clearAllMocks();
  api.getCosBriefings.mockResolvedValue({ briefings: [] });
  api.getCosLatestBriefing.mockResolvedValue(null);
  api.triggerCosJob.mockResolvedValue({ started: true });
});

describe('BriefingTab empty state', () => {
  it('offers generation and the Daily Briefing job settings link', async () => {
    const user = userEvent.setup();
    renderTab();

    const generate = await screen.findByRole('button', { name: 'Generate today’s briefing' });
    expect(screen.getByText('No briefing yet')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Daily Briefing job' })).toHaveAttribute('href', '/cos/jobs');

    await user.click(generate);

    await waitFor(() => expect(api.triggerCosJob).toHaveBeenCalledWith(
      'job-daily-briefing',
      { silent: true },
    ));
    await waitFor(() => expect(api.getCosLatestBriefing).toHaveBeenCalledTimes(2));
  });
});
