import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';

const mock = vi.hoisted(() => ({
  getReviewQueue: vi.fn(),
  claimReviewQueueDelivery: vi.fn(),
  updateInstanceFeature: vi.fn(),
}));

vi.mock('../services/api', () => mock);
vi.mock('../services/socket', () => ({ default: { on: vi.fn(), off: vi.fn() } }));

import { toast, Toaster } from '../components/ui/Toast';
import { INSTANCE_FEATURES_CHANGED } from '../constants/events.js';
import { useEngagementReminderToast } from './useEngagementReminderToast';
import { __resetActionQueue } from './useActionQueue';

function Harness() {
  useEngagementReminderToast();
  return null;
}

describe('useEngagementReminderToast', () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.clearAllMocks();
    __resetActionQueue();
    mock.claimReviewQueueDelivery.mockResolvedValue({ claimed: true, generation: 0 });
    mock.getReviewQueue.mockResolvedValue({
      partial: false,
      items: [{
        id: 'product:daily-post',
        source: 'product',
        occurrence: '2026-08-24',
        type: 'post_engagement',
        title: 'Daily POST is waiting',
        detail: 'No POST activity today.',
        link: '/post/launcher',
        featureId: 'post',
        featureLabel: 'POST',
      }],
    });
    mock.updateInstanceFeature.mockResolvedValue({ features: [{ id: 'post', enabled: false }] });
  });

  afterEach(() => {
    act(() => toast.dismiss());
    cleanup();
  });

  it('keeps the action link and offers a per-instance disable button', async () => {
    render(<MemoryRouter><Harness /><Toaster /></MemoryRouter>);

    const link = await screen.findByRole('link', { name: 'Open action' });
    expect(link).toHaveAttribute('href', '/review/product%3Adaily-post?view=today');
    expect(screen.getByRole('button', { name: 'Disable on this instance' })).toBeInTheDocument();
  });

  it('disables the feature and closes the reminder', async () => {
    render(<MemoryRouter><Harness /><Toaster /></MemoryRouter>);
    const featureChanged = vi.fn();
    window.addEventListener(INSTANCE_FEATURES_CHANGED, featureChanged);
    fireEvent.click(await screen.findByRole('button', { name: 'Disable on this instance' }));

    await waitFor(() => expect(mock.updateInstanceFeature).toHaveBeenCalledWith('post', false, { silent: true }));
    await waitFor(() => expect(featureChanged).toHaveBeenCalledTimes(1));
    expect(featureChanged.mock.calls[0][0].detail).toEqual({ featureId: 'post', enabled: false });
    expect(screen.queryByText('Daily POST is waiting')).toBeNull();
    expect(await screen.findByText('POST disabled on this instance')).toBeInTheDocument();
    window.removeEventListener(INSTANCE_FEATURES_CHANGED, featureChanged);
  });
});
