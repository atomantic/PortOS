import { render, screen, waitFor } from '@testing-library/react';
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
  afterEach(() => {
    vi.useRealTimers();
  });

  it('defaults to the local calendar date', async () => {
    vi.setSystemTime(new Date(2026, 0, 1, 20));

    render(<ReviewTab />);

    await waitFor(() => expect(api.getDailyReview).toHaveBeenCalledWith('2026-01-01'));
    expect(screen.getByLabelText('Review date').value).toBe('2026-01-01');
    expect(screen.queryByRole('button', { name: 'Today' })).toBeNull();
  });
});
