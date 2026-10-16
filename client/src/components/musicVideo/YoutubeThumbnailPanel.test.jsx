/**
 * YouTube thumbnail card: tapping an image makes the thumbnail from it with
 * the title, a shot's still is offered after the video's best frames, and the
 * made thumbnail can join the Test & Compare set until it holds three.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import YoutubeThumbnailPanel, { thumbnailSources } from './YoutubeThumbnailPanel.jsx';

vi.mock('../../hooks/useMusicVideoCoverLettering.js', () => ({ default: () => ({ fonts: [], styles: [], uploading: false }) }));
vi.mock('../imageGen/GalleryImagePicker', () => ({ default: () => null }));

const hook = (over = {}) => ({ composingThumbnail: false, composeThumbnail: vi.fn(), clearThumbnail: vi.fn(), addThumbnailTest: vi.fn(), removeThumbnailTest: vi.fn(), ...over });
const project = (kit = {}) => ({
  id: 'mv-1', name: 'Example Song',
  scenes: [{ sceneId: 's1', referenceImageId: 'still-1.png', sectionLabel: 'Verse 1' }],
  publishKit: { thumbnails: ['best.jpg', 'next.jpg'], thumbnail: 'best.jpg', ...kit },
});

describe('YoutubeThumbnailPanel', () => {
  it('offers the best frames first, then shot stills', () => {
    expect(thumbnailSources(project()).map((s) => s.label)).toEqual(['Video frame 1 (best)', 'Video frame 2', 'Shot 1 (Verse 1)']);
  });

  it('makes the thumbnail from a tapped shot still, with the title', () => {
    const k = hook();
    render(<YoutubeThumbnailPanel project={project()} publishKit={k} />);
    fireEvent.click(screen.getByRole('button', { name: 'Make the thumbnail from Shot 1 (Verse 1)' }));
    expect(k.composeThumbnail).toHaveBeenCalledWith(expect.objectContaining({ source: { kind: 'image', filename: 'still-1.png' }, title: 'Example Song', lettering: true }));
  });

  it('adds the made thumbnail to the A/B test until it holds three', () => {
    const k = hook();
    const made = { filename: 'yt-2.jpg', source: { kind: 'thumbnail', filename: 'best.jpg' }, title: 'Example Song', focusX: 0.5, focusY: 0.5, lettering: true };
    const { rerender } = render(<YoutubeThumbnailPanel project={project({ youtubeThumbnail: made, youtubeThumbnailTests: [{ filename: 'yt-1.jpg' }] })} publishKit={k} />);
    fireEvent.click(screen.getByRole('button', { name: /YouTube thumbnail/ })); // a made thumbnail folds the card
    fireEvent.click(screen.getByRole('button', { name: 'Add this one to the test' }));
    expect(k.addThumbnailTest).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Remove test thumbnail 1' }));
    expect(k.removeThumbnailTest).toHaveBeenCalledWith('yt-1.jpg');
    rerender(<YoutubeThumbnailPanel project={project({ youtubeThumbnail: made, youtubeThumbnailTests: [{ filename: 'a.jpg' }, { filename: 'b.jpg' }, { filename: 'c.jpg' }] })} publishKit={k} />);
    expect(screen.getByRole('button', { name: 'Add this one to the test' })).toBeDisabled();
  });
});
