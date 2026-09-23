import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import BucketCard from './BucketCard';

const bucket = { id: 'b1', name: 'Bookmarks', color: 'purple', icon: '', order: 0 };
const links = [{ id: 'l1', url: 'https://example.com', title: 'Example', bucketId: 'b1', bucketOrder: 0 }];

const renderCard = (props = {}) => render(
  <BucketCard
    bucket={bucket}
    bucketIndex={0}
    links={links}
    onUpdate={vi.fn()}
    onDelete={vi.fn()}
    onAddLink={vi.fn()}
    onRemoveLink={vi.fn()}
    {...props}
  />
);

// A tap target smaller than ~44px is unreliable on a phone, and here Edit sits
// directly beside the destructive Delete — a mis-tap opens a delete confirm.
const expectTouchTarget = (el) => {
  expect(el.className).toContain('min-h-[44px]');
  expect(el.className).toContain('min-w-[44px]');
  expect(el.className).toContain('items-center');
  expect(el.className).toContain('justify-center');
};

describe('BucketCard', () => {
  it('gives the header edit and delete actions 44px touch targets', () => {
    renderCard();
    expectTouchTarget(screen.getByLabelText('Edit bucket'));
    expectTouchTarget(screen.getByLabelText('Delete bucket'));
  });

  it('gives the add-link submit a 44px touch target', () => {
    renderCard();
    expectTouchTarget(screen.getByLabelText('Add link to bucket'));
  });

  it('opens the inline edit form from the edit action', () => {
    renderCard();
    fireEvent.click(screen.getByLabelText('Edit bucket'));
    expect(screen.getByLabelText('Bucket name').value).toBe('Bookmarks');
  });

  it('asks for confirmation before deleting instead of deleting on the first tap', () => {
    const onDelete = vi.fn();
    renderCard({ onDelete });
    fireEvent.click(screen.getByLabelText('Delete bucket'));
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByText(/Delete bucket\?/)).toBeTruthy();
  });

  // #8120: native drag-and-drop had no keyboard path. dnd-kit's `useDraggable`
  // attributes make a button a focusable, announced drag handle, so asserting
  // the handle carries a real accessible name is the reachable proxy for
  // "a keyboard user can find and pick this up" in a jsdom render.
  it('names the bucket reorder handle for the bucket it moves', () => {
    renderCard();
    expect(screen.getByLabelText('Reorder bucket Bookmarks')).toBeTruthy();
  });

  it('names each chip\'s drag handle for the link it moves', () => {
    renderCard();
    expect(screen.getByLabelText('Drag Example')).toBeTruthy();
  });

  it('renders no native draggable attribute anywhere in the card', () => {
    const { container } = renderCard();
    expect(container.querySelector('[draggable="true"]')).toBeNull();
  });
});
