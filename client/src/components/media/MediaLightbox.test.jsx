import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

const imageItem = {
  kind: 'image',
  key: 'image:frame.png',
  filename: 'frame.png',
  previewUrl: '/data/images/frame.png',
  downloadUrl: '/data/images/frame.png',
  prompt: 'a cat portrait',
  createdAt: Date.now(),
};

describe('MediaLightbox video element (mobile playback)', () => {
  // jsdom doesn't implement HTMLMediaElement.play; stub it per-test so we can
  // drive the unmute-on-open effect down both the granted and blocked paths.
  let playMock;
  beforeEach(() => {
    playMock = vi.fn(() => Promise.resolve());
    HTMLMediaElement.prototype.play = playMock;
  });
  afterEach(() => {
    delete HTMLMediaElement.prototype.play;
  });

  it('renders the <video> with a poster + playsInline + muted autoplay baseline so it loads on mobile', () => {
    const { container } = render(<MediaLightbox item={videoItem} onClose={() => {}} />);
    const video = container.querySelector('video');
    expect(video).toBeTruthy();
    // src points at the full asset
    expect(video.getAttribute('src')).toBe('/data/videos/abc.mp4');
    // poster = thumbnail so a blank box never shows while the clip buffers,
    // and the frame is visible even if mobile autoplay is deferred.
    expect(video.getAttribute('poster')).toBe('/data/video-thumbnails/abc.jpg');
    // muted autoplay is the baseline that lets the clip start under the mobile
    // media-engagement policy; the effect then unmutes for sound.
    expect(video.hasAttribute('autoplay')).toBe(true);
    // playsInline keeps iOS from promoting to a native fullscreen player.
    expect(video.hasAttribute('playsinline')).toBe(true);
    expect(video.hasAttribute('loop')).toBe(true);
    expect(video.hasAttribute('controls')).toBe(true);
  });

  it('unmutes and plays for sound when the opening gesture allows audible playback', async () => {
    const { container } = render(<MediaLightbox item={videoItem} onClose={() => {}} />);
    const video = container.querySelector('video');
    await waitFor(() => expect(playMock).toHaveBeenCalled());
    // play() resolved (gesture activation present) → stays unmuted for sound.
    expect(video.muted).toBe(false);
  });

  it('falls back to muted playback when audible autoplay is blocked', async () => {
    playMock.mockImplementation(() => Promise.reject(new Error('NotAllowedError')));
    const { container } = render(<MediaLightbox item={videoItem} onClose={() => {}} />);
    const video = container.querySelector('video');
    // First (unmuted) play rejects → effect re-mutes and re-plays so the clip
    // still runs; the user can unmute via the controls.
    await waitFor(() => expect(video.muted).toBe(true));
    expect(playMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('omits poster when the video has no thumbnail rather than rendering an empty poster', () => {
    const { container } = render(
      <MediaLightbox item={{ ...videoItem, previewUrl: null }} onClose={() => {}} />
    );
    const video = container.querySelector('video');
    expect(video.hasAttribute('poster')).toBe(false);
  });
});

describe('MediaLightbox route-changing actions', () => {
  it('closes the preview before Send to Video runs so query cleanup cannot override navigation', () => {
    const calls = [];
    const onClose = vi.fn(() => calls.push('close'));
    const onSendToVideo = vi.fn(() => calls.push('send'));

    render(
      <MediaLightbox
        item={imageItem}
        onClose={onClose}
        onSendToVideo={onSendToVideo}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: /send to video/i }));

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSendToVideo).toHaveBeenCalledWith(imageItem);
    expect(calls).toEqual(['close', 'send']);
  });
});
