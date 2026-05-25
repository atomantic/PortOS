import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import MediaLightbox from './MediaLightbox';

// The footer's AddToCollectionMenu and the (closed) PromptRefineModal pull the
// whole API surface (and useProviderModels) into the import graph. Neither is
// under test here, so stub them to inert nodes — that keeps the test focused
// on MediaLightbox's own <video> markup and off the network.
vi.mock('./AddToCollectionMenu', () => ({ default: () => null }));
vi.mock('./PromptRefineModal', () => ({ default: () => null }));

const videoItem = {
  kind: 'video',
  key: 'video:abc',
  id: 'abc',
  filename: 'abc.mp4',
  previewUrl: '/data/video-thumbnails/abc.jpg',
  downloadUrl: '/data/videos/abc.mp4',
  prompt: 'a cat',
  createdAt: Date.now(),
};

describe('MediaLightbox video element (mobile playback)', () => {
  it('renders the <video> with a poster + muted + playsInline so it loads/autoplays on mobile', () => {
    const { container } = render(<MediaLightbox item={videoItem} onClose={() => {}} />);
    const video = container.querySelector('video');
    expect(video).toBeTruthy();
    // src points at the full asset
    expect(video.getAttribute('src')).toBe('/data/videos/abc.mp4');
    // poster = thumbnail so a blank box never shows while the clip buffers,
    // and the frame is visible even if mobile autoplay is deferred.
    expect(video.getAttribute('poster')).toBe('/data/video-thumbnails/abc.jpg');
    // muted is required for autoplay under mobile media-engagement policy.
    expect(video.muted).toBe(true);
    // playsInline keeps iOS from promoting to a native fullscreen player.
    expect(video.hasAttribute('playsinline')).toBe(true);
    expect(video.hasAttribute('loop')).toBe(true);
    expect(video.hasAttribute('controls')).toBe(true);
  });

  it('omits poster when the video has no thumbnail rather than rendering an empty poster', () => {
    const { container } = render(
      <MediaLightbox item={{ ...videoItem, previewUrl: null }} onClose={() => {}} />
    );
    const video = container.querySelector('video');
    expect(video.hasAttribute('poster')).toBe(false);
  });
});
