/**
 * Asset inspector (#2930 phase 2). Covers the two things the old bare lightbox
 * got wrong: it showed nothing about the asset, and it had no way to get the
 * file or its path out. Also pins the "unknown vs zero" rule — the server omits
 * image fields for unreadable/non-image files, and an omitted field must not
 * render as a blank or bogus row.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import AssetInspector from './AssetInspector.jsx';
import { hasSpritePreview } from './spriteAssets.js';

const copyToClipboard = vi.fn();
vi.mock('../../lib/clipboard.js', () => ({ copyToClipboard: (...a) => copyToClipboard(...a) }));

const deleteSpriteAsset = vi.fn();
vi.mock('../../services/apiSprites.js', () => ({ deleteSpriteAsset: (...a) => deleteSpriteAsset(...a) }));

const IMAGE = {
  path: 'reference/main.png',
  size: 2048,
  mtime: Date.now(),
  width: 48,
  height: 32,
  format: 'png',
  frameCount: 1,
};

beforeEach(() => { copyToClipboard.mockClear(); deleteSpriteAsset.mockReset(); });

describe('hasSpritePreview', () => {
  it('follows the server probe rather than the file extension', () => {
    expect(hasSpritePreview(IMAGE)).toBe(true);
    // A .png the server could not read has no dimensions — it must NOT be
    // previewed, or the grid renders a broken <img>.
    expect(hasSpritePreview({ path: 'a.png', size: 3, imageError: true })).toBe(false);
    expect(hasSpritePreview({ path: 'a.json', size: 3 })).toBe(false);
    expect(hasSpritePreview(null)).toBe(false);
  });

  it('rejects a format sharp can probe but a browser cannot paint', () => {
    // TIFF probes cleanly and yields real dimensions, so a probe-presence check
    // alone would render a broken-image icon.
    expect(hasSpritePreview({ path: 'a.tiff', width: 8, height: 8, format: 'tiff' })).toBe(false);
    expect(hasSpritePreview({ path: 'a.webp', width: 8, height: 8, format: 'webp' })).toBe(true);
  });
});

describe('AssetInspector', () => {
  it('renders the metadata the pipeline needs plus download + copy actions', async () => {
    render(<AssetInspector recordId="trail-hand" asset={IMAGE} onClose={() => {}} />);

    expect(screen.getByText('reference/main.png')).toBeInTheDocument();
    expect(screen.getByText('48 × 32')).toBeInTheDocument();
    expect(screen.getByText('png')).toBeInTheDocument();
    expect(screen.getByText('2 KB')).toBeInTheDocument();

    const download = screen.getByRole('link', { name: /download/i });
    expect(download).toHaveAttribute('href', '/data/sprites/trail-hand/reference/main.png');
    expect(download).toHaveAttribute('download', 'main.png');

    await userEvent.click(screen.getByRole('button', { name: /copy path/i }));
    expect(copyToClipboard).toHaveBeenCalledWith('reference/main.png', 'Asset path copied');
  });

  it('paints a checkerboard behind the preview so alpha is not read as black', () => {
    const { container } = render(<AssetInspector recordId="trail-hand" asset={IMAGE} onClose={() => {}} />);
    const checker = container.querySelector('[style*="linear-gradient"]');
    expect(checker).toBeTruthy();
    expect(screen.getByAltText('reference/main.png')).toHaveStyle({ imageRendering: 'pixelated' });
  });

  it('omits image rows entirely for a non-image sidecar', () => {
    render(
      <AssetInspector
        recordId="trail-hand"
        asset={{ path: 'reference/main.generation.json', size: 12, mtime: Date.now() }}
        onClose={() => {}}
      />,
    );
    expect(screen.queryByText('Dimensions')).not.toBeInTheDocument();
    expect(screen.queryByText('Format')).not.toBeInTheDocument();
    expect(screen.getByText(/no inline preview/i)).toBeInTheDocument();
  });

  it('says an image was unreadable rather than reusing the sidecar wording', () => {
    render(
      <AssetInspector
        recordId="trail-hand"
        asset={{ path: 'reference/corrupt.png', size: 12, mtime: Date.now(), imageError: true }}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText(/could not read it/i)).toBeInTheDocument();
    expect(screen.queryByText(/no inline preview/i)).not.toBeInTheDocument();
    // Still downloadable — the user may want to inspect the broken bytes.
    expect(screen.getByRole('link', { name: /download/i })).toBeInTheDocument();
  });

  it('plays a walk run source clip inline instead of forcing a download', () => {
    const { container } = render(
      <AssetInspector
        recordId="trail-hand"
        asset={{ path: 'grok/walk-east-abc/generated/source-video.mp4', size: 900, mtime: Date.now() }}
        onClose={() => {}}
      />,
    );
    const video = container.querySelector('video');
    expect(video).toHaveAttribute('src', '/data/sprites/trail-hand/grok/walk-east-abc/generated/source-video.mp4');
    expect(video).toHaveAttribute('controls');
  });

  it('offers Open alongside Download, since download= forces a save', () => {
    render(
      <AssetInspector
        recordId="trail-hand"
        asset={{ path: 'reference/main.generation.json', size: 12, mtime: Date.now() }}
        onClose={() => {}}
      />,
    );
    const open = screen.getByRole('link', { name: /^open$/i });
    expect(open).toHaveAttribute('target', '_blank');
    expect(open).not.toHaveAttribute('download');
  });

  it('renders nothing when no asset is selected', () => {
    const { container } = render(<AssetInspector recordId="trail-hand" asset={null} onClose={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('offers no Delete action unless an onDeleted handler is wired', () => {
    render(<AssetInspector recordId="trail-hand" asset={IMAGE} onClose={() => {}} />);
    expect(screen.queryByRole('button', { name: /^delete$/i })).not.toBeInTheDocument();
  });

  it('deletes through a two-button confirm, then refreshes and closes', async () => {
    deleteSpriteAsset.mockResolvedValue({ deleted: true, removed: 'reference/main.png' });
    const onClose = vi.fn();
    const onDeleted = vi.fn();
    render(<AssetInspector recordId="trail-hand" asset={IMAGE} onClose={onClose} onDeleted={onDeleted} />);

    // Arming reveals a discoverable Cancel/Delete pair (no window.confirm, no
    // two-click-arm on the same button).
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    expect(screen.getByRole('button', { name: /^cancel$/i })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }));

    expect(deleteSpriteAsset).toHaveBeenCalledWith('trail-hand', 'reference/main.png', { silent: true });
    expect(onDeleted).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows the server refusal inline and keeps the asset (no close)', async () => {
    deleteSpriteAsset.mockRejectedValue(Object.assign(new Error('This is the current runtime atlas'), { status: 409 }));
    const onClose = vi.fn();
    const onDeleted = vi.fn();
    render(<AssetInspector recordId="trail-hand" asset={IMAGE} onClose={onClose} onDeleted={onDeleted} />);

    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }));
    await userEvent.click(screen.getByRole('button', { name: /^delete$/i }));

    expect(await screen.findByText(/current runtime atlas/i)).toBeInTheDocument();
    expect(onDeleted).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
