import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import MediaCard from './MediaCard';
import { normalizeImage, normalizeVideo } from './normalize';

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

  it('previews a hosted video when its poster is unavailable and retries after the video arrives', () => {
    const item = normalizeVideo({ id: 'clip', filename: 'clip.mp4', thumbnail: 'custom-poster.jpg', prompt: 'remote clip' });
    const { container } = render(<MediaCard item={item} showCollectionMenu={false} />);

    fireEvent.error(screen.getByAltText('remote clip'));
    const video = container.querySelector('video');
    expect(video).toHaveAttribute('src', '/data/videos/clip.mp4#t=0.001');
    expect(video).toHaveAttribute('preload', 'metadata');
    expect(screen.queryByText(/Syncing/i)).not.toBeInTheDocument();

    fireEvent.error(video);
    expect(screen.getByText(/Syncing/i)).toBeInTheDocument();
    act(() => emitAssetArrived({ filename: 'clip.mp4', kind: 'video' }));
    expect(screen.getByAltText('remote clip')).toHaveAttribute('src', '/data/video-thumbnails/custom-poster.jpg?_t=1');
    fireEvent.error(screen.getByAltText('remote clip'));
    expect(container.querySelector('video')).toHaveAttribute('src', '/data/videos/clip.mp4?_t=1#t=0.001');
  });

  it('previews a video without a poster', () => {
    const item = normalizeVideo({ id: 'clip', filename: 'clip.mp4', prompt: 'remote clip' });
    const { container } = render(<MediaCard item={item} showCollectionMenu={false} />);
    expect(container.querySelector('video')).toHaveAttribute('src', '/data/videos/clip.mp4#t=0.001');
  });

  it('does not request a video for a legacy history row with no filename', () => {
    const item = normalizeVideo({ id: 'legacy', prompt: 'legacy clip' });
    const { container } = render(<MediaCard item={item} showCollectionMenu={false} />);
    expect(container.querySelector('video')).toBeNull();
    expect(screen.queryByText(/Syncing/i)).not.toBeInTheDocument();
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

  it('lists where a used file is used and deletes it only through Delete anyway', () => {
    const onDelete = vi.fn();
    const usages = [
      { source: 'music-video', label: 'Music video', id: 'mv-1', title: 'Example Song', role: 'Shot 4', href: '/music-video/mv-1/scene/s-4' },
      { source: 'catalog', label: 'Casting', id: 'cat-chr-1', title: 'Alice', role: 'Sheet', href: '/casting/cat-chr-1/sheets' },
    ];
    render(<MemoryRouter><MediaCard item={imageItem} onDelete={onDelete} usages={usages} showCollectionMenu={false} showMoodBoardMenu={false} /></MemoryRouter>);

    fireEvent.click(screen.getByRole('button', { name: /Used ×2/ }));
    expect(screen.getByRole('link', { name: 'Music video · Example Song · Shot 4' })).toHaveAttribute('href', '/music-video/mv-1/scene/s-4');

    fireEvent.click(screen.getByTitle('Delete'));
    expect(screen.getByText(/Used in 2 places/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete anyway' }));
    expect(onDelete).toHaveBeenCalledWith(imageItem, { force: true });
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

describe('shared media-card file size', () => {
  it.each(['image', 'video'])('shows the actual %s file size beside the geometry chips', kind => {
    const normalize = kind === 'image' ? normalizeImage : normalizeVideo;
    render(<MediaCard item={normalize({ ...imageItem, id: 'example-clip', width: 640, height: 480, fps: kind === 'video' ? 24 : undefined, fileSizeBytes: 1572864 })} />);
    expect(screen.getByTitle('Original file size')).toHaveTextContent('1.5 MB');
    expect(screen.getByText('640×480').parentElement).toContainElement(screen.getByTitle('Original file size'));
  });
  it('omits unknown sizes while retaining a measured zero', () => {
    const { rerender } = render(<MediaCard item={imageItem} />);
    expect(screen.queryByTitle('Original file size')).not.toBeInTheDocument();
    rerender(<MediaCard item={{ ...imageItem, fileSizeBytes: 0 }} />);
    expect(screen.getByTitle('Original file size')).toHaveTextContent('0 B');
  });

  // Uniquely catches a pending row that still offers Delete (a second command)
  // or hides where its delete is waiting. Each card is queried in its own container.
  it('shows where a pending delete waits and offers cancel instead of delete', () => {
    const pendingVideo = normalizeVideo({ id: 'v-pending', filename: 'v-pending.mp4', prompt: 'pending clip',
      pendingDelete: { peerId: 'rec-peer', queuedAt: '2026-01-01T00:00:00.000Z' } });
    const plainVideo = normalizeVideo({ id: 'v-plain', filename: 'v-plain.mp4', prompt: 'plain clip' });
    const onDelete = vi.fn();
    const onCancelPendingDelete = vi.fn();
    const props = { onDelete, onCancelPendingDelete, showCollectionMenu: false, showMoodBoardMenu: false };
    const pendingCard = within(render(<MediaCard item={pendingVideo} pendingPeerName="Example Peer" {...props} />).container);
    const plainCard = within(render(<MediaCard item={plainVideo} {...props} />).container);

    expect(pendingCard.getByRole('status')).toHaveTextContent('Delete pending on Example Peer');
    expect(pendingCard.queryByRole('button', { name: 'Delete' })).toBeNull();
    fireEvent.click(pendingCard.getByRole('button', { name: 'Cancel pending delete' }));
    expect(onCancelPendingDelete).toHaveBeenCalledWith(pendingVideo);

    expect(plainCard.queryByRole('status')).toBeNull();
    expect(plainCard.queryByRole('button', { name: 'Cancel pending delete' })).toBeNull();
    expect(plainCard.getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    expect(onDelete).not.toHaveBeenCalled();
  });
});
