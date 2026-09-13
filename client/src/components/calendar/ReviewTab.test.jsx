import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../services/api', () => ({
  getDailyReview: vi.fn(() => Promise.resolve({
    events: [],
    progressEntries: [],
    summary: { totalEvents: 0, confirmed: 0, skipped: 0, unreviewed: 0 },
  })),
}));

import * as api from '../../services/api';
import ReviewTab from './ReviewTab';

describe('ReviewTab', () => {
  // Restore the ambient zone rather than pinning UTC: vitest reuses a worker
  // across files, so clobbering TZ here would follow the next suite in.
  const ambientTZ = process.env.TZ;
  afterEach(() => {
    vi.useRealTimers();
    if (ambientTZ === undefined) delete process.env.TZ;
    else process.env.TZ = ambientTZ;
  });

  it('defaults to the local calendar date', async () => {
    vi.setSystemTime(new Date(2026, 0, 1, 20));

    render(<MemoryRouter><ReviewTab /></MemoryRouter>);

    await waitFor(() => expect(api.getDailyReview).toHaveBeenCalledWith('2026-01-01'));
    expect(screen.getByLabelText('Review date').value).toBe('2026-01-01');
    expect(screen.queryByRole('button', { name: 'Today' })).toBeNull();
  });

  it('navigates by local calendar day in positive UTC offsets', async () => {
    process.env.TZ = 'Pacific/Kiritimati';
    vi.setSystemTime(new Date(2026, 0, 1, 20));

    render(<MemoryRouter><ReviewTab /></MemoryRouter>);
    await waitFor(() => expect(api.getDailyReview).toHaveBeenCalledWith('2026-01-01'));

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    await waitFor(() => expect(api.getDailyReview).toHaveBeenCalledWith('2026-01-02'));
    expect(screen.getByLabelText('Review date').value).toBe('2026-01-02');
  });

  it('shows a connect-calendar empty state with 0 accounts instead of a generic no-events message', async () => {
    vi.setSystemTime(new Date(2026, 0, 1, 20));

    render(<MemoryRouter><ReviewTab accounts={[]} /></MemoryRouter>);
    await waitFor(() => expect(api.getDailyReview).toHaveBeenCalled());

    expect(screen.getByText('No calendar connected')).toBeTruthy();
    const link = screen.getByRole('link', { name: 'Add a calendar account' });
    expect(link.getAttribute('href')).toBe('/calendar/config');
    expect(screen.queryByText('No events for this date')).toBeNull();
  });

  it('shows the plain no-events message when accounts exist but nothing happened that day', async () => {
    vi.setSystemTime(new Date(2026, 0, 1, 20));

    render(<MemoryRouter><ReviewTab accounts={[{ id: 'acct-1', name: 'Personal' }]} /></MemoryRouter>);
    await waitFor(() => expect(api.getDailyReview).toHaveBeenCalled());

    expect(screen.getByText('No events for this date')).toBeTruthy();
    expect(screen.queryByText('No calendar connected')).toBeNull();
    expect(screen.queryByText('Sync your calendar to see events here')).toBeNull();
  });
});
