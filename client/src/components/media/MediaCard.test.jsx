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
});
