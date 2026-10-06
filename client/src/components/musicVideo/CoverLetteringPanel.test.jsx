/**
 * The cover Lettering controls (#10345): a control changes the live preview
 * with no request, "Set the lettering" sends the whole design to be saved,
 * a saved artist style applies in one click, and an uploaded font joins the
 * Typeface choices.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';

const lettering = {
  fonts: [{ id: 'example-font', family: 'Example Font', ext: 'ttf', width: 0.5, addedAt: '2026-01-01T00:00:00.000Z' }],
  styles: [{ key: 'example artist', name: 'Example Artist', design: { layout: 'center', typeface: 'serif', titleStyle: 'outline' }, updatedAt: '2026-01-01T00:00:00.000Z' }],
  uploading: false,
  uploadFont: vi.fn(async () => null),
  removeFont: vi.fn(async () => true),
  saveStyle: vi.fn(async () => null),
  removeStyle: vi.fn(async () => true),
};
vi.mock('../imageGen/GalleryImagePicker', () => ({ default: () => null }));
vi.mock('../../hooks/useMusicVideoCoverLettering.js', () => ({ default: () => lettering }));

import CoverArtPanel from './CoverArtPanel.jsx';

const project = {
  id: 'mv-example',
  name: 'Example Song',
  publishKit: {
    thumbnails: ['frame-1.jpg'],
    coverArt: {
      title: 'Example Song', tag: 'Example Artist', focusX: 0.5, filename: 'cover-example.jpg',
      source: { kind: 'thumbnail', filename: 'frame-1.jpg' },
      design: { layout: 'bottom-left', typeface: 'sans', weight: 'bold', titleStyle: 'fill' },
    },
  },
};
const kit = (over = {}) => ({
  composing: false, designing: false, requestingImage: false, savingLettering: false,
  composeCover: vi.fn(async () => null), designCover: vi.fn(async () => null), generateCover: vi.fn(async () => null),
  saveCoverDesign: vi.fn(async () => null), ...over,
});
const preview = () => screen.getByRole('img', { name: /Lettering preview/ });

beforeEach(() => vi.clearAllMocks());

describe('CoverLetteringPanel (inside CoverArtPanel)', () => {
  it('previews a control change at once, and saves the whole design only when asked', () => {
    const k = kit();
    render(<CoverArtPanel project={project} publishKit={k} />);
    expect(preview().innerHTML).not.toContain('stroke=');
    expect(screen.getByRole('button', { name: /Set the lettering/ })).toBeDisabled();

    fireEvent.change(screen.getByLabelText('Title treatment'), { target: { value: 'outline' } });
    fireEvent.change(screen.getByLabelText('Title color'), { target: { value: '#ff8800' } });
    // The preview is laid out by the server's own code, so it shows the change with no request.
    expect(preview().innerHTML).toContain('fill="none" stroke="#ff8800"');
    expect(k.saveCoverDesign).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: /Set the lettering/ }));
    expect(k.saveCoverDesign).toHaveBeenCalledWith(expect.objectContaining({ layout: 'bottom-left', typeface: 'sans', titleStyle: 'outline', titleColor: '#ff8800' }));

    // Undo returns the controls (and the preview) to the saved design.
    fireEvent.click(screen.getByRole('button', { name: /Undo changes/ }));
    expect(screen.getByLabelText('Title treatment')).toHaveValue('fill');
    expect(preview().innerHTML).not.toContain('stroke=');
  });

  it("offers the artist's uploaded font as a typeface and applies a saved artist style in one click", () => {
    const k = kit();
    render(<CoverArtPanel project={project} publishKit={k} />);
    const typeface = screen.getByLabelText('Typeface');
    expect(within(typeface).getByRole('option', { name: 'Example Font' })).toHaveValue('font:example-font');
    fireEvent.change(typeface, { target: { value: 'font:example-font' } });
    expect(preview().innerHTML).toContain("font-family=\"'Example Font',sans-serif\"");

    // The saved style for the cover's artist is chosen already; one click puts it on this song.
    expect(screen.getByLabelText('Saved styles')).toHaveValue('example artist');
    fireEvent.click(screen.getByRole('button', { name: 'Apply artist style' }));
    expect(k.saveCoverDesign).toHaveBeenCalledWith(expect.objectContaining({ layout: 'center', typeface: 'serif', titleStyle: 'outline' }));

    fireEvent.click(screen.getByRole('button', { name: /Save as artist style/ }));
    expect(lettering.saveStyle).toHaveBeenCalledWith({ name: 'Example Artist', design: expect.objectContaining({ typeface: 'font:example-font' }) });
  });
});
