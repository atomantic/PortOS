/**
 * Cover art panel: any image in history (or an upload) can be the cover, and a
 * cover finished elsewhere is used as it is, with no second title set on it.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import CoverArtPanel, { coverArtSources } from './CoverArtPanel.jsx';

// Lettering data (fonts, artist styles) loads from the server; this suite is about the cover's source and lettering switch.
vi.mock('../../hooks/useMusicVideoCoverLettering.js', () => ({ default: () => ({ fonts: [], styles: [], uploading: false }) }));
vi.mock('../imageGen/GalleryImagePicker', () => ({
  default: ({ open, onSelect, allowUpload }) => (open ? (
    <button type="button" data-upload={String(allowUpload)} onClick={() => onSelect({ filename: 'history-example.png' })}>Pick history-example</button>
  ) : null),
}));

const kit = (over = {}) => ({ composeCover: vi.fn(), designCover: vi.fn(), generateCover: vi.fn(), composing: false, designing: false, requestingImage: false, ...over });
const project = (coverArt = {}) => ({ id: 'mv-1', name: 'Example Song', publishKit: { thumbnails: ['t1.jpg'], coverArt } });

describe('CoverArtPanel', () => {
  it('makes the cover from an image picked in history, with upload offered in the same picker', () => {
    const publishKit = kit();
    render(<CoverArtPanel project={project()} publishKit={publishKit} />);
    fireEvent.click(screen.getByRole('button', { name: /Choose from image history or upload/ }));
    const pick = screen.getByRole('button', { name: 'Pick history-example' });
    expect(pick).toHaveAttribute('data-upload', 'true');
    fireEvent.click(pick);
    expect(publishKit.composeCover).toHaveBeenCalledWith(expect.objectContaining({ source: { kind: 'image', filename: 'history-example.png' }, title: 'Example Song', lettering: true }));
  });

  it('uses a finished cover bare: no title or artist fields, and no title needed', () => {
    const publishKit = kit();
    render(<CoverArtPanel project={project({ source: { kind: 'image', filename: 'finished.png' } })} publishKit={publishKit} />);
    fireEvent.change(screen.getByLabelText('Title on the cover'), { target: { value: '' } });
    fireEvent.click(screen.getByLabelText(/Set the title and artist on the image/));
    expect(screen.queryByLabelText('Title on the cover')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Apply to the cover' }));
    expect(publishKit.composeCover).toHaveBeenCalledWith(expect.objectContaining({ lettering: false }));
  });

  it('turns the switch back on when a restyle or a new photo re-letters the cover on the server', () => {
    const publishKit = kit();
    const { rerender } = render(<CoverArtPanel project={project({ source: { kind: 'image', filename: 'finished.png' }, lettering: false })} publishKit={publishKit} />);
    expect(screen.getByLabelText(/Set the title and artist on the image/)).not.toBeChecked();
    rerender(<CoverArtPanel project={project({ source: { kind: 'image', filename: 'finished.png' }, lettering: true })} publishKit={publishKit} />);
    expect(screen.getByLabelText(/Set the title and artist on the image/)).toBeChecked();
    fireEvent.click(screen.getByRole('button', { name: 'Apply to the cover' }));
    expect(publishKit.composeCover).toHaveBeenCalledWith(expect.objectContaining({ lettering: true }));
  });

  it('keeps an image picked from history among the sources, marked as the current one', () => {
    const sources = coverArtSources(project({ source: { kind: 'image', filename: 'history-example.png' } }));
    expect(sources[0]).toMatchObject({ kind: 'image', filename: 'history-example.png', label: 'Current cover image' });
  });
});
