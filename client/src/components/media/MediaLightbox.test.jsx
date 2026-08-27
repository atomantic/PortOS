import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import MediaLightbox from './MediaLightbox';

// The footer's AddToCollectionMenu and prompt modals pull the whole API surface
// (and useProviderModels) into the import graph. Keep the mocks inert except
// for PromptRefineModal's open state, which lets the Escape regression assert
// that it closes without pulling its provider hooks into the test.
vi.mock('./AddToCollectionMenu', () => ({ default: () => null }));
vi.mock('./PromptRefineModal', () => ({
  default: ({ open }) => open ? <div data-testid="refine-modal" /> : null,
}));
vi.mock('./PromptFromMedia', () => ({
  default: () => null,
  PromptFromMediaModal: ({ open }) => open ? <div data-testid="prompt-from-modal" /> : null,
}));

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

// The overlay portals to <body>, so it is outside render()'s container —
// query the whole document for the media element.
const videoEl = () => document.body.querySelector('video');

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
    render(<MediaLightbox item={videoItem} onClose={() => {}} />);
    const video = videoEl();
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
    render(<MediaLightbox item={videoItem} onClose={() => {}} />);
    const video = videoEl();
    await waitFor(() => expect(playMock).toHaveBeenCalled());
    // play() resolved (gesture activation present) → stays unmuted for sound.
    expect(video.muted).toBe(false);
  });

  it('falls back to muted playback when audible autoplay is blocked', async () => {
    playMock.mockImplementation(() => Promise.reject(new Error('NotAllowedError')));
    render(<MediaLightbox item={videoItem} onClose={() => {}} />);
    const video = videoEl();
    // First (unmuted) play rejects → effect re-mutes and re-plays so the clip
    // still runs; the user can unmute via the controls.
    await waitFor(() => expect(video.muted).toBe(true));
    expect(playMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('omits poster when the video has no thumbnail rather than rendering an empty poster', () => {
    render(
      <MediaLightbox item={{ ...videoItem, previewUrl: null }} onClose={() => {}} />
    );
    const video = videoEl();
    expect(video.hasAttribute('poster')).toBe(false);
  });
});

describe('MediaLightbox overlay portal', () => {
  it('portals the overlay to <body>, escaping a backdrop-filter containing-block ancestor', () => {
    // Mirror a themed gallery: the lightbox is opened from inside a
    // `.bg-port-card` tile, which gains `backdrop-filter` on "glass" themes. A
    // backdrop-filter ancestor becomes the containing block for position:fixed
    // descendants, so an inline overlay would be sized to the card instead of
    // the viewport. The portal has to move it to <body> to escape that trap.
    const { container } = render(
      <div className="bg-port-card border rounded-xl" style={{ backdropFilter: 'blur(22px)' }} data-testid="glass-card">
        <MediaLightbox item={imageItem} onClose={() => {}} />
      </div>
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('fixed inset-0');
    expect(screen.getByTestId('glass-card').contains(dialog)).toBe(false);
    expect(dialog.parentElement).toBe(document.body);
    // The component's own rendered subtree holds nothing at all.
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });
});

describe('MediaLightbox Escape cascade', () => {
  it('exits full screen without closing the lightbox', () => {
    const onClose = vi.fn();
    render(<MediaLightbox item={imageItem} onClose={onClose} />);

    fireEvent.keyDown(screen.getByRole('button', { name: 'Full screen' }), { key: 'f' });
    const exitFullScreen = screen.getByRole('button', { name: 'Exit full screen' });

    fireEvent.keyDown(exitFullScreen, { key: 'Escape' });

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Full screen' })).toBeTruthy();
  });

  it('closes the refine modal without closing the lightbox', () => {
    const onClose = vi.fn();
    render(<MediaLightbox item={imageItem} onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: 'Refine Prompt' }));
    const refineModal = screen.getByTestId('refine-modal');

    fireEvent.keyDown(refineModal, { key: 'Escape' });

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByTestId('refine-modal')).toBeNull();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('closes the prompt-from-media modal without closing the lightbox', () => {
    const onClose = vi.fn();
    render(<MediaLightbox item={imageItem} onClose={onClose} />);

    fireEvent.click(screen.getByRole('button', { name: 'Prompt from this' }));
    const promptFromModal = screen.getByTestId('prompt-from-modal');

    fireEvent.keyDown(promptFromModal, { key: 'Escape' });

    expect(onClose).not.toHaveBeenCalled();
    expect(screen.queryByTestId('prompt-from-modal')).toBeNull();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('closes the lightbox when Escape is pressed with nothing else open', () => {
    const onClose = vi.fn();
    render(<MediaLightbox item={imageItem} onClose={onClose} />);

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
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

// The conditioning promise (#4874) is provenance: a clip whose opening frame was
// GENERATED rather than reproduced has to say so where the render is inspected.
// The Image Strength number alone never carried that distinction.
describe('MediaLightbox — i2v reference provenance (#4874)', () => {
  // jsdom has no HTMLMediaElement.play; the lightbox calls it on mount for a
  // video item, so stub it here the way the playback suite above does.
  beforeEach(() => { HTMLMediaElement.prototype.play = vi.fn(() => Promise.resolve()); });
  afterEach(() => { delete HTMLMediaElement.prototype.play; });

  const videoItem = (raw) => ({
    kind: 'video',
    key: 'video:ref-1',
    id: 'ref-1',
    filename: 'ref-1.mp4',
    downloadUrl: '/data/videos/ref-1.mp4',
    prompt: 'a fox in the rain',
    modelId: 'ltx25_mlx_q8',
    numFrames: 121,
    fps: 24,
    createdAt: '2026-08-23T10:00:00.000Z',
    raw,
  });

  it('names the promise and the strength that delivered it', () => {
    render(<MediaLightbox item={videoItem({ i2vReferenceMode: 'inspire', imageStrength: 0.35 })} onClose={() => {}} />);
    expect(screen.getByText('Reference')).toBeTruthy();
    expect(screen.getByText('Inspire')).toBeTruthy();
    expect(screen.getByText('Image strength')).toBeTruthy();
  });

  it('shows no Reference row for an anchored render, so the row means something', () => {
    render(<MediaLightbox item={videoItem({})} onClose={() => {}} />);
    expect(screen.queryByText('Reference')).toBeNull();
  });
});

describe('MediaLightbox — local image execution provenance', () => {
  it('distinguishes confirmed, degraded, and unknown legacy image execution', () => {
    const { rerender } = render(<MediaLightbox item={{ ...imageItem, executionProvenance: { state: 'confirmed', effectiveDevice: 'cuda', placement: 'cuda+offload' } }} onClose={() => {}} />);
    expect(screen.getByText('Execution')).toBeTruthy();
    expect(screen.getByText('Confirmed · cuda (cuda+offload)')).toBeTruthy();

    rerender(<MediaLightbox item={{ ...imageItem, executionProvenance: { state: 'degraded', requestedDevice: 'mps' } }} onClose={() => {}} />);
    expect(screen.getByText('Degraded · CPU fallback (requested mps)')).toBeTruthy();

    rerender(<MediaLightbox item={imageItem} onClose={() => {}} />);
    expect(screen.getByText('Unknown (legacy runner)')).toBeTruthy();
  });

  it('does not mistake a malformed marker for confirmed execution', () => {
    render(<MediaLightbox item={{ ...imageItem, executionProvenance: { state: 'malformed' } }} onClose={() => {}} />);
    expect(screen.getByText('Unknown (invalid runner marker)')).toBeTruthy();
  });
});
