import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../../services/api', () => ({
  listShareBuckets: vi.fn(),
  exportToShareBucket: vi.fn(),
  listShareSubscriptions: vi.fn(),
  subscribeToShareBucket: vi.fn(),
  unsubscribeFromShareBucket: vi.fn(),
}));
vi.mock('../ui/Toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

import * as api from '../../services/api';
import ShareToButton from './ShareToButton';

const BUCKET_A = { id: 'bkt-a', name: 'Bucket A', mode: 'auto-merge', path: '/exports/a' };
const BUCKET_B = { id: 'bkt-b', name: 'Bucket B', mode: 'inbox', path: '/exports/b' };

beforeEach(() => {
  vi.clearAllMocks();
  api.listShareBuckets.mockResolvedValue({ buckets: [BUCKET_A, BUCKET_B] });
  api.listShareSubscriptions.mockResolvedValue({ subscriptions: [] });
});

describe('ShareToButton', () => {
  it('is disabled when nothing is selected to share (no ids)', () => {
    render(<ShareToButton kind="series" />);
    expect(screen.getByRole('button', { name: /Share/i })).toBeDisabled();
  });

  it('opens the bucket list when clicked', async () => {
    const user = userEvent.setup();
    render(<ShareToButton kind="series" ids={['s1']} />);
    await user.click(screen.getByRole('button', { name: /Share/i }));
    await waitFor(() => expect(api.listShareBuckets).toHaveBeenCalled());
    expect(await screen.findByText('Bucket A')).toBeTruthy();
    expect(screen.getByText('Bucket B')).toBeTruthy();
  });

  it('exposes aria-expanded=false when closed and aria-expanded=true when open', async () => {
    const user = userEvent.setup();
    render(<ShareToButton kind="series" ids={['s1']} />);
    const trigger = screen.getByRole('button', { name: /Share/i });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveAttribute('aria-haspopup', 'true');
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('closes the popover and returns focus to the trigger when Escape is pressed', async () => {
    const user = userEvent.setup();
    render(<ShareToButton kind="series" ids={['s1']} />);
    const trigger = screen.getByRole('button', { name: /Share/i });
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard('{Escape}');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    // Focus returns to the trigger after Escape.
    expect(document.activeElement).toBe(trigger);
  });

  it('subscribes a series record to a bucket on click', async () => {
    api.subscribeToShareBucket.mockResolvedValue({
      subscription: { id: 'sub-s1-bkt-a', bucketId: 'bkt-a' },
    });
    const user = userEvent.setup();
    render(<ShareToButton kind="series" ids={['s1']} />);
    await user.click(screen.getByRole('button', { name: /Share/i }));
    await screen.findByText('Bucket A');
    await user.click(screen.getByText('Bucket A'));
    await waitFor(() => expect(api.subscribeToShareBucket).toHaveBeenCalledWith(
      { bucketId: 'bkt-a', recordKind: 'series', recordId: 's1' },
      { silent: true },
    ));
  });

  it('shares a media item one-shot on click', async () => {
    api.exportToShareBucket.mockResolvedValue({
      exports: [{ recordCount: 3, assetCount: 1 }],
    });
    const user = userEvent.setup();
    const items = [{ kind: 'media', ref: 'm1' }];
    render(<ShareToButton kind="media" items={items} />);
    await user.click(screen.getByRole('button', { name: /Share/i }));
    await screen.findByText('Bucket A');
    await user.click(screen.getByText('Bucket A'));
    await waitFor(() => expect(api.exportToShareBucket).toHaveBeenCalledWith(
      'bkt-a',
      { kind: 'media', items },
      { silent: true },
    ));
  });
});
