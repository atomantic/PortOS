import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('../../../services/api', () => ({
  createBrainBucket: vi.fn(),
  updateBrainBucket: vi.fn(),
  deleteBrainBucket: vi.fn(),
  reorderBrainBuckets: vi.fn()
}));
vi.mock('../../ui/Toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));

import * as api from '../../../services/api';
import BucketBoard from './BucketBoard';

const buckets = [
  { id: 'b1', name: 'Bookmarks', color: 'purple', icon: '', order: 0 },
  { id: 'b2', name: 'Tools', color: 'accent', icon: '', order: 1 }
];
const links = [
  { id: 'l1', url: 'https://news.example.com', title: 'News', bucketId: 'b1', bucketOrder: 0 },
  { id: 'l2', url: 'https://example.org', title: 'Ungrouped Link', bucketId: null }
];

beforeEach(() => {
  vi.clearAllMocks();
});

describe('BucketBoard', () => {
  it('renders each bucket and its chips, but not links from other buckets', () => {
    render(
      <BucketBoard
        links={links}
        buckets={buckets}
        setBuckets={vi.fn()}
        onAssignLink={vi.fn()}
        onAddLinkToBucket={vi.fn()}
        onBucketDeleted={vi.fn()}
      />
    );
    expect(screen.getByText('Bookmarks')).toBeTruthy();
    expect(screen.getByText('Tools')).toBeTruthy();
    expect(screen.getByText('News')).toBeTruthy();
    // The ungrouped link is never shown on the board.
    expect(screen.queryByText('Ungrouped Link')).toBeNull();
  });

  it('creates a new bucket through the inline form', async () => {
    api.createBrainBucket.mockResolvedValue({ id: 'b3', name: 'Reading', color: 'accent', order: 2 });
    const setBuckets = vi.fn();
    render(
      <BucketBoard
        links={links}
        buckets={buckets}
        setBuckets={setBuckets}
        onAssignLink={vi.fn()}
        onAddLinkToBucket={vi.fn()}
        onBucketDeleted={vi.fn()}
      />
    );
    fireEvent.click(screen.getByText('New bucket'));
    fireEvent.change(screen.getByLabelText('New bucket name'), { target: { value: 'Reading' } });
    fireEvent.click(screen.getByText('Create'));

    await waitFor(() => expect(api.createBrainBucket).toHaveBeenCalledWith({ name: 'Reading' }));
    expect(setBuckets).toHaveBeenCalled();
  });
});
