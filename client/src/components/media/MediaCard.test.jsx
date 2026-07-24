import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import MediaCard from './MediaCard';

const socketHandlers = new Map();
vi.mock('../../services/socket', () => ({
  default: {
    on: vi.fn((event, fn) => {
      if (!socketHandlers.has(event)) socketHandlers.set(event, new Set());
      socketHandlers.get(event).add(fn);
    }),
    off: vi.fn((event, fn) => {
      socketHandlers.get(event)?.delete(fn);
    }),
  },
}));

function emitAssetArrived(payload) {
  for (const fn of socketHandlers.get('peerSync:asset-arrived') ?? []) fn(payload);
}

const imageItem = {
  kind: 'image',
  key: 'image:late.png',
  filename: 'late.png',
  previewUrl: '/data/images/late.png',
  downloadUrl: '/data/images/late.png',
  prompt: 'late synced image',
};

beforeEach(() => {
  socketHandlers.clear();
});

describe('MediaCard', () => {
  it('uses MediaImage for grid thumbnails so peer-synced assets show and recover from the syncing placeholder', () => {
    render(<MediaCard item={imageItem} showCollectionMenu={false} />);

    fireEvent.error(screen.getByAltText('late synced image'));
    expect(screen.getByText(/Syncing/i)).toBeInTheDocument();

    act(() => {
      emitAssetArrived({ filename: 'late.png', kind: 'image', peerId: 'peer-a' });
    });

    expect(screen.queryByText(/Syncing/i)).not.toBeInTheDocument();
    expect(screen.getByAltText('late synced image').getAttribute('src')).toMatch(
      /^\/data\/images\/late\.png\?_t=/
    );
  });

  it('arms an inline confirm row before deleting instead of deleting on first click', () => {
    const onDelete = vi.fn();
    render(<MediaCard item={imageItem} onDelete={onDelete} showCollectionMenu={false} showMoodBoardMenu={false} />);

    // First click on the trash button arms confirmation — it must NOT delete yet.
    fireEvent.click(screen.getByTitle('Delete'));
    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.getByText('Delete this image?')).toBeInTheDocument();

    // Confirming fires the delete with the item.
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onDelete).toHaveBeenCalledWith(imageItem);
  });

  it('lets the user cancel the delete confirmation without deleting', () => {
    const onDelete = vi.fn();
    render(<MediaCard item={imageItem} onDelete={onDelete} showCollectionMenu={false} showMoodBoardMenu={false} />);

    fireEvent.click(screen.getByTitle('Delete'));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(onDelete).not.toHaveBeenCalled();
    expect(screen.queryByText('Delete this image?')).not.toBeInTheDocument();
    // Action row is restored, so the trash button is available again.
    expect(screen.getByTitle('Delete')).toBeInTheDocument();
  });

  it('offers the image-to-Three.js handoff only when its handler is provided', () => {
    const onSendTo3d = vi.fn();
    const { rerender } = render(
      <MediaCard
        item={imageItem}
        onSendTo3d={onSendTo3d}
        showCollectionMenu={false}
        showMoodBoardMenu={false}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Send to 3D' }));
    expect(onSendTo3d).toHaveBeenCalledWith(imageItem);

    rerender(
      <MediaCard
        item={{ ...imageItem, kind: 'video' }}
        onSendTo3d={onSendTo3d}
        showCollectionMenu={false}
        showMoodBoardMenu={false}
      />
    );
    expect(screen.queryByRole('button', { name: 'Send to 3D' })).toBeNull();
  });
});
