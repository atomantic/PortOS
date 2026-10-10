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
  thumbnailUrl: '/data/image-thumbnails/late.webp',
  downloadUrl: '/data/images/late.png',
  prompt: 'late synced image',
};

beforeEach(() => {
  socketHandlers.clear();
});

describe('MediaCard', () => {
  it('skips repeated renders when its item and action props are unchanged', () => {
    let promptReads = 0;
    const stableItem = {
      ...imageItem,
      get prompt() {
        promptReads += 1;
        return imageItem.prompt;
      },
    };
    const onPreview = vi.fn();
    const { rerender } = render(
      <MediaCard
        item={stableItem}
        onPreview={onPreview}
        showCollectionMenu={false}
        showMoodBoardMenu={false}
      />
    );

    expect(promptReads).toBe(1);
    rerender(
      <MediaCard
        item={stableItem}
        onPreview={onPreview}
        showCollectionMenu={false}
        showMoodBoardMenu={false}
      />
    );
    expect(promptReads).toBe(1);

    rerender(
      <MediaCard
        item={stableItem}
        onPreview={onPreview}
        selected
        showCollectionMenu={false}
        showMoodBoardMenu={false}
      />
    );
    expect(promptReads).toBe(2);
  });

  it('uses MediaImage for grid thumbnails so peer-synced assets show and recover from the syncing placeholder', () => {
    render(<MediaCard item={imageItem} showCollectionMenu={false} />);

    expect(screen.getByAltText('late synced image')).toHaveAttribute('src', '/data/image-thumbnails/late.webp');
    fireEvent.error(screen.getByAltText('late synced image'));
    expect(screen.getByAltText('late synced image')).toHaveAttribute('src', '/data/images/late.png');
    fireEvent.error(screen.getByAltText('late synced image'));
    expect(screen.getByText(/Syncing/i)).toBeInTheDocument();

    act(() => {
      emitAssetArrived({ filename: 'late.png', kind: 'image', peerId: 'peer-a' });
    });

    expect(screen.queryByText(/Syncing/i)).not.toBeInTheDocument();
    expect(screen.getByAltText('late synced image').getAttribute('src')).toMatch(
      /^\/data\/image-thumbnails\/late\.webp\?_t=/
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

  it('offers Remix for videos when the handler is provided', () => {
    const onRemix = vi.fn();
    const videoItem = { ...imageItem, kind: 'video', key: 'video:clip-1', id: 'clip-1', filename: 'clip.mp4' };
    render(
      <MediaCard
        item={videoItem}
        onRemix={onRemix}
        showCollectionMenu={false}
        showMoodBoardMenu={false}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /Remix/i }));
    expect(onRemix).toHaveBeenCalledWith(videoItem);
  });

  it('omits Remix when no handler is provided — including for videos', () => {
    render(
      <MediaCard
        item={{ ...imageItem, kind: 'video' }}
        showCollectionMenu={false}
        showMoodBoardMenu={false}
      />
    );
    expect(screen.queryByRole('button', { name: /Remix/i })).toBeNull();
  });

  it('gives creative actions equal labeled cells, apart from the file toolbar', () => {
    render(
      <MediaCard
        item={imageItem}
        onRemix={vi.fn()}
        onSendToImage={vi.fn()}
        onSendToVideo={vi.fn()}
        onSendTo3d={vi.fn()}
        onDelete={vi.fn()}
        onToggleHidden={vi.fn()}
      />
    );

    const remix = screen.getByRole('button', { name: 'Remix' });
    const i2i = screen.getByRole('button', { name: 'Send to image-to-image' });
    const video = screen.getByRole('button', { name: 'Send to Video' });
    const to3d = screen.getByRole('button', { name: 'Send to 3D' });
    const remove = screen.getByTitle('Delete');

    expect(i2i).toHaveTextContent('i2i');
    expect(video).toHaveTextContent('Video');
    expect(to3d).toHaveTextContent('3D');

    const create = screen.getByRole('group', { name: 'Create from this render' });
    expect(create).toHaveClass('grid-cols-2');
    expect(create).toContainElement(remix);
    expect(create).toContainElement(to3d);
    expect(create).not.toContainElement(remove);
    for (const button of [remix, i2i, video, to3d]) {
      expect(button.className).not.toMatch(/\bflex-1\b/);
      expect(button).toHaveClass('w-full');
    }

    const files = screen.getByRole('group', { name: 'File actions' });
    expect(files).toContainElement(remove);
    expect(files).toHaveClass('grid-cols-3', '@min-[11rem]:grid-cols-5');
    expect(files).not.toContainElement(remix);
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

// Render duration (#5878) — the card is where a user compares "which of these
// backends is actually fast". The chip must be humanized, not raw ms, and must
// disappear entirely for a record that was never timed rather than rendering a
// placeholder or a misleading "0s".
describe('MediaCard render-time chip', () => {
  it('humanizes renderMs', () => {
    render(<MediaCard item={{ ...imageItem, renderMs: 92_000 }} />);
    expect(screen.getByText('1m 32s')).toBeInTheDocument();
    expect(screen.queryByText('92000')).not.toBeInTheDocument();
  });

  it('renders no chip when the record carries no render time', () => {
    const { container } = render(<MediaCard item={{ ...imageItem, renderMs: null }} />);
    expect(container.querySelector('[title^="Render time"]')).toBeNull();
  });
});
