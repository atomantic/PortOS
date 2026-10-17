import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const api = vi.hoisted(() => ({ getFeeds: vi.fn(), getFeedItems: vi.fn() }));
vi.mock('../../../services/api', () => api);
vi.mock('../../ui/Toast', () => ({ default: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }) }));

import FeedsTab from './FeedsTab';

describe('FeedsTab loading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getFeedItems.mockResolvedValue([]);
  });

  it('shows a retryable failure instead of the first-run prompt, while retaining empty success', async () => {
    api.getFeeds.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([]);
    render(<FeedsTab />);

    expect(await screen.findByText('Could not load feeds.')).toBeInTheDocument();
    expect(screen.queryByText('No feeds subscribed yet.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('No feeds subscribed yet.')).toBeInTheDocument();
  });

  it('treats a falsy rejection as a failed primary load', async () => {
    api.getFeeds.mockRejectedValueOnce(undefined);
    render(<FeedsTab />);

    expect(await screen.findByText('Could not load feeds.')).toBeInTheDocument();
    expect(screen.queryByText('No feeds subscribed yet.')).not.toBeInTheDocument();
  });
});
