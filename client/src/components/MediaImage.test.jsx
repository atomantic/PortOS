import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

// Mock the socket module so we can drive `peerSync:asset-arrived` events
// without a real Socket.IO connection.
const socketHandlers = new Map();
vi.mock('../services/socket', () => ({
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

import MediaImage from './MediaImage';

function emitAssetArrived(payload) {
  for (const fn of socketHandlers.get('peerSync:asset-arrived') ?? []) fn(payload);
}

beforeEach(() => {
  socketHandlers.clear();
});

describe('MediaImage', () => {
  it('renders the underlying <img> with the original src by default', () => {
    render(<MediaImage src="/data/images/foo.png" alt="character" />);
    const img = screen.getByAltText('character');
    expect(img.tagName).toBe('IMG');
    expect(img.getAttribute('src')).toBe('/data/images/foo.png');
  });

  it('shows the "Syncing" placeholder after an onError fires (asset 404s before pull lands)', () => {
    render(<MediaImage src="/data/images/missing.png" alt="ghost" />);
    fireEvent.error(screen.getByAltText('ghost'));
    expect(screen.getByText(/Syncing/i)).toBeTruthy();
  });

  it('swaps back to the image when the peerSync:asset-arrived event matches the filename', () => {
    render(<MediaImage src="/data/images/late.png" alt="late" />);
    fireEvent.error(screen.getByAltText('late'));
    expect(screen.getByText(/Syncing/i)).toBeTruthy();
    act(() => {
      emitAssetArrived({ filename: 'late.png', kind: 'image', peerId: 'peer-a' });
    });
    // Placeholder gone, image is back (with a cache-buster nonce).
    expect(screen.queryByText(/Syncing/i)).toBeNull();
    const img = screen.getByAltText('late');
    expect(img.getAttribute('src')).toMatch(/^\/data\/images\/late\.png\?_t=/);
  });

  it('ignores arrival events for a different filename (no spurious reset)', () => {
    render(<MediaImage src="/data/images/foo.png" alt="foo" />);
    fireEvent.error(screen.getByAltText('foo'));
    expect(screen.getByText(/Syncing/i)).toBeTruthy();
    act(() => {
      emitAssetArrived({ filename: 'bar.png', kind: 'image', peerId: 'peer-a' });
    });
    // Still syncing — different filename means our asset is still missing.
    expect(screen.getByText(/Syncing/i)).toBeTruthy();
  });

  it('resets the error state when src changes (new record may reference an asset we have)', () => {
    const { rerender } = render(<MediaImage src="/data/images/a.png" alt="a" />);
    fireEvent.error(screen.getByAltText('a'));
    expect(screen.getByText(/Syncing/i)).toBeTruthy();
    rerender(<MediaImage src="/data/images/b.png" alt="a" />);
    expect(screen.queryByText(/Syncing/i)).toBeNull();
  });

  it('forwards onError to the caller in addition to setting errored state', () => {
    const onError = vi.fn();
    render(<MediaImage src="/data/images/x.png" alt="x" onError={onError} />);
    fireEvent.error(screen.getByAltText('x'));
    expect(onError).toHaveBeenCalled();
    // Placeholder visible regardless.
    expect(screen.getByText(/Syncing/i)).toBeTruthy();
  });
});
