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

  const twoChip = [
    { id: 'l1', url: 'https://a.com', title: 'Alpha', bucketId: 'b1', bucketOrder: 0 },
    { id: 'l2', url: 'https://b.com', title: 'Beta', bucketId: 'b1', bucketOrder: 1 }
  ];

  it('routes a positioned chip drop to onMoveLinkToIndex with the dragged link + chip index', () => {
    const onMoveLinkToIndex = vi.fn();
    render(
      <BucketBoard
        links={twoChip}
        buckets={buckets}
        setBuckets={vi.fn()}
        onAssignLink={vi.fn()}
        onAddLinkToBucket={vi.fn()}
        onBucketDeleted={vi.fn()}
        onMoveLinkToIndex={onMoveLinkToIndex}
      />
    );
    // Drag Alpha (l1) onto Beta (index 1). jsdom reports a zero-size rect, so
    // the before/after midpoint resolves to "before" → index 1. (The exact
    // before/after split is geometry the helper test covers.)
    const dataTransfer = { getData: () => 'l1', types: ['text/x-brain-link'] };
    fireEvent.drop(screen.getByText('Beta'), { dataTransfer });
    expect(onMoveLinkToIndex).toHaveBeenCalledWith(twoChip[0], 'b1', 1);
  });

  it('keeps the armed marker through a bubbled dragleave and routes a gap drop to it', () => {
    const onMoveLinkToIndex = vi.fn();
    const { container } = render(
      <BucketBoard
        links={twoChip}
        buckets={buckets}
        setBuckets={vi.fn()}
        onAssignLink={vi.fn()}
        onAddLinkToBucket={vi.fn()}
        onBucketDeleted={vi.fn()}
        onMoveLinkToIndex={onMoveLinkToIndex}
      />
    );
    const linkDt = { getData: () => 'l1', types: ['text/x-brain-link'] };
    const card = container.querySelector('.flex.flex-col.bg-port-card'); // b1's card root
    const chipRow = container.querySelector('.flex.flex-wrap'); // b1's chip row
    // Hovering Beta (index 1) arms the marker at index 1.
    fireEvent.dragOver(screen.getByText('Beta'), { dataTransfer: linkDt });
    // A bubbled dragleave reaching the card (the chip→gap crossing fires one)
    // must NOT clear the armed marker — the regression was the card-level
    // onDragLeave wiping dropIndex unconditionally. (relatedTarget can't be
    // simulated in jsdom, but the card's leave no longer reads the event, so
    // this exercises the exact handler that held the bug.)
    fireEvent.dragLeave(card);
    // Releasing in the gap (the chip row, not a chip) bubbles to the card's
    // drop handler, which must honor the still-armed marker rather than append.
    fireEvent.drop(chipRow, { dataTransfer: linkDt });
    expect(onMoveLinkToIndex).toHaveBeenCalledWith(twoChip[0], 'b1', 1);
  });

  it('ignores a chip-level drop that carries no link payload (e.g. a bucket reorder)', () => {
    const onMoveLinkToIndex = vi.fn();
    render(
      <BucketBoard
        links={twoChip}
        buckets={buckets}
        setBuckets={vi.fn()}
        onAssignLink={vi.fn()}
        onAddLinkToBucket={vi.fn()}
        onBucketDeleted={vi.fn()}
        onMoveLinkToIndex={onMoveLinkToIndex}
      />
    );
    const dataTransfer = { getData: () => '', types: ['text/x-brain-bucket'] };
    fireEvent.drop(screen.getByText('Alpha'), { dataTransfer });
    expect(onMoveLinkToIndex).not.toHaveBeenCalled();
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

    await waitFor(() => expect(api.createBrainBucket).toHaveBeenCalledWith({ name: 'Reading' }, { silent: true }));
    expect(setBuckets).toHaveBeenCalled();
  });
});
