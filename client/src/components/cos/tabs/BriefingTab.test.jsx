import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import BriefingTab from './BriefingTab';

const api = vi.hoisted(() => ({
  getCosBriefings: vi.fn(),
  getCosLatestBriefing: vi.fn(),
  triggerCosJob: vi.fn(),
}));
const toast = vi.hoisted(() => ({ error: vi.fn() }));

vi.mock('../../../services/api', () => api);
vi.mock('../../ui/Toast', () => ({ default: toast }));

const renderTab = () => render(
  <MemoryRouter>
    <BriefingTab />
  </MemoryRouter>,
);

beforeEach(() => {
  vi.clearAllMocks();
  api.getCosBriefings.mockReset().mockResolvedValue({ briefings: [] });
  api.getCosLatestBriefing.mockReset().mockResolvedValue(null);
  api.triggerCosJob.mockReset().mockResolvedValue({ started: true });
  toast.error.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
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

  it('keeps the action pending until the triggered briefing is persisted', async () => {
    vi.useFakeTimers();
    api.getCosLatestBriefing
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        date: '2026-09-11',
        content: '# Today\n## Focus\nA generated briefing',
      });
    renderTab();

    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Generate today’s briefing' }));
    await act(async () => {});
    expect(screen.getByRole('button', { name: 'Generating today’s briefing…' })).toBeDisabled();

    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(screen.getByText('Today')).toBeInTheDocument();
  });

  it('does not trigger twice while generation is pending', async () => {
    let resolveTrigger;
    api.triggerCosJob.mockReturnValue(new Promise((resolve) => { resolveTrigger = resolve; }));
    renderTab();
    await act(async () => {});
    const generate = await screen.findByRole('button', { name: 'Generate today’s briefing' });

    await act(async () => { fireEvent.click(generate); });
    await act(async () => { fireEvent.click(generate); });

    expect(api.triggerCosJob).toHaveBeenCalledTimes(1);
    resolveTrigger({ started: true });
    await act(async () => {});
  });

  it('shows a rejected trigger reason once', async () => {
    const user = userEvent.setup();
    api.triggerCosJob.mockResolvedValue({ success: false, status: 'skipped', reason: 'No provider available' });
    renderTab();

    await user.click(await screen.findByRole('button', { name: 'Generate today’s briefing' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('No provider available'));
    expect(toast.error).toHaveBeenCalledTimes(1);
  });
});
