import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Mirrors GET /calendar/review/:date: one bounded page plus full-day metadata.
const reviewPage = (events, { total = events.length, offset = 0, nextOffset = null, unreviewed = total } = {}) => ({
  events, total, offset, nextOffset, hasMore: nextOffset !== null,
  confirmations: {},
  progressEntries: [],
  summary: { totalEvents: total, confirmed: 0, skipped: 0, unreviewed },
});
const dayEvents = (from, to) => Array.from({ length: to - from }, (_, i) => ({
  id: `event-${from + i}`, title: `Event ${from + i}`, startTime: '2026-01-01T09:00:00',
}));

vi.mock('../../services/api', () => ({
  getDailyReview: vi.fn(() => Promise.resolve(reviewPage([]))),
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

    await waitFor(() => expect(api.getDailyReview).toHaveBeenCalledWith('2026-01-01', expect.objectContaining({ limit: 200, offset: 0 }), expect.anything()));
    expect(screen.getByLabelText('Review date').value).toBe('2026-01-01');
    expect(screen.queryByRole('button', { name: 'Today' })).toBeNull();
  });

  it('navigates by local calendar day in positive UTC offsets', async () => {
    process.env.TZ = 'Pacific/Kiritimati';
    vi.setSystemTime(new Date(2026, 0, 1, 20));

    render(<MemoryRouter><ReviewTab /></MemoryRouter>);
    await waitFor(() => expect(api.getDailyReview).toHaveBeenCalledWith('2026-01-01', expect.objectContaining({ limit: 200, offset: 0 }), expect.anything()));

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));

    await waitFor(() => expect(api.getDailyReview).toHaveBeenCalledWith('2026-01-02', expect.objectContaining({ limit: 200, offset: 0 }), expect.anything()));
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

  describe('paged days', () => {
    it('loads the 201st event, keeping the full-day counts visible', async () => {
      vi.setSystemTime(new Date(2026, 0, 1, 20));
      api.getDailyReview
        .mockResolvedValueOnce(reviewPage(dayEvents(0, 200), { total: 201, nextOffset: 200 }))
        .mockResolvedValueOnce(reviewPage(dayEvents(200, 201), { total: 201, offset: 200 }));

      render(<MemoryRouter><ReviewTab accounts={[{ id: 'acct-1' }]} /></MemoryRouter>);

      expect(await screen.findByText('Event 200')).toBeTruthy();
      expect(api.getDailyReview).toHaveBeenLastCalledWith('2026-01-01', { limit: 200, offset: 200 }, expect.anything());
      expect(screen.getByText('201 events')).toBeTruthy();
      expect(screen.getByText('201 to review')).toBeTruthy();
      expect(screen.getAllByLabelText('Confirm - it happened')).toHaveLength(201);
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('keeps loaded rows when a later page fails and resumes from the same cursor on Retry', async () => {
      vi.setSystemTime(new Date(2026, 0, 1, 20));
      api.getDailyReview
        .mockResolvedValueOnce(reviewPage(dayEvents(0, 200), { total: 201, nextOffset: 200 }))
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValueOnce(reviewPage(dayEvents(200, 201), { total: 201, offset: 200 }));

      render(<MemoryRouter><ReviewTab accounts={[{ id: 'acct-1' }]} /></MemoryRouter>);

      const alert = await screen.findByRole('alert');
      expect(alert.textContent).toContain('Showing 200 of 201 events');
      expect(screen.getAllByLabelText('Confirm - it happened')).toHaveLength(200);
      expect(screen.getByText('201 to review')).toBeTruthy();

      fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

      expect(await screen.findByText('Event 200')).toBeTruthy();
      expect(api.getDailyReview).toHaveBeenLastCalledWith('2026-01-01', { limit: 200, offset: 200 }, expect.anything());
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('never shows an obsolete day when its response resolves after a date change', async () => {
      vi.setSystemTime(new Date(2026, 0, 1, 20));
      let resolveFirst;
      api.getDailyReview
        .mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve; }))
        .mockResolvedValueOnce(reviewPage([{ id: 'new-day', title: 'New day event', startTime: '2026-01-02T09:00:00' }]));

      render(<MemoryRouter><ReviewTab accounts={[{ id: 'acct-1' }]} /></MemoryRouter>);
      await waitFor(() => expect(api.getDailyReview).toHaveBeenCalledTimes(1));
      fireEvent.click(screen.getByRole('button', { name: 'Next' }));
      expect(await screen.findByText('New day event')).toBeTruthy();

      resolveFirst(reviewPage([{ id: 'old-day', title: 'Old day event', startTime: '2026-01-01T09:00:00' }]));
      await Promise.resolve();
      await Promise.resolve();

      expect(screen.queryByText('Old day event')).toBeNull();
      expect(screen.getByText('New day event')).toBeTruthy();
    });
  });
});
