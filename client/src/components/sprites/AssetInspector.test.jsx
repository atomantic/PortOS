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

const IMAGE = {
  path: 'reference/main.png',
  size: 2048,
  mtime: Date.now(),
  width: 48,
  height: 32,
  format: 'png',
  frameCount: 1,
};

beforeEach(() => copyToClipboard.mockClear());

describe('hasSpritePreview', () => {
  it('follows the server probe rather than the file extension', () => {
    expect(hasSpritePreview(IMAGE)).toBe(true);
    // A .png the server could not read has no dimensions — it must NOT be
    // previewed, or the grid renders a broken <img>.
    expect(hasSpritePreview({ path: 'a.png', size: 3, imageError: true })).toBe(false);
    expect(hasSpritePreview({ path: 'a.json', size: 3 })).toBe(false);
    expect(hasSpritePreview(null)).toBe(false);
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

  it('renders nothing when no asset is selected', () => {
    const { container } = render(<AssetInspector recordId="trail-hand" asset={null} onClose={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});
