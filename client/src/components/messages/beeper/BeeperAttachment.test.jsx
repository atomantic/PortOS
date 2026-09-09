import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

/**
 * The lazily-mirrored image attachment (#37, real-browser pass): while bytes
 * are in flight the `<img>` used to collapse to a 2x2px box (`complete: false`)
 * for the whole fetch — up to the 60s server timeout — before the onError path
 * ever rendered the reference row. This locks the reserved-space skeleton that
 * fills that gap, plus the load and error outcomes either side of it.
 */

const api = vi.hoisted(() => ({
  beeperAttachmentUrl: vi.fn((messageId, idx) => `/api/beeper/attachments/${messageId}/${idx}`),
  fetchBeeperAttachment: vi.fn(),
  setBeeperAttachmentKeep: vi.fn(),
}));
vi.mock('../../../services/api', () => api);

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
vi.mock('../../ui/Toast', () => ({ default: toast }));

import BeeperAttachment, { reservedBoxStyle } from './BeeperAttachment';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const baseAttachment = {
  messageId: 'msg-1',
  idx: 0,
  mimeType: 'image/png',
  fileName: 'photo.png',
  byteLength: 204800,
  overCap: false,
  unavailable: false,
  stored: true,
};

describe('BeeperAttachment — image load lifecycle', () => {
  it('reserves space with a neutral skeleton while the mirror fetch is in flight, sized from width/height', () => {
    render(<BeeperAttachment attachment={{ ...baseAttachment, width: 800, height: 600 }} />);

    const skeleton = screen.getByTestId('attachment-skeleton');
    expect(skeleton).toBeTruthy();

    const img = screen.getByRole('img', { name: 'photo.png' });
    // Native width/height attributes reserve the real aspect ratio before load.
    expect(img).toHaveAttribute('width', '800');
    expect(img).toHaveAttribute('height', '600');
    // Hidden (opacity-0) until it loads, but still mounted so the fetch fires.
    expect(img.className).toContain('opacity-0');
  });

  it('falls back to a fixed neutral box when no width/height is known', () => {
    render(<BeeperAttachment attachment={{ ...baseAttachment, width: null, height: null }} />);

    expect(screen.getByTestId('attachment-skeleton')).toBeTruthy();
    const img = screen.getByRole('img', { name: 'photo.png' });
    expect(img).not.toHaveAttribute('width');
    expect(img).not.toHaveAttribute('height');
  });

  // The real-browser follow-up to the test above: the width/height attributes
  // alone reserve nothing, because the image carries `w-auto` and preflight's
  // `height: auto`, and an explicit CSS width beats a presentational attribute
  // — so an unloaded image is 0x0 and the absolute skeleton has nothing to
  // fill. jsdom cannot measure layout, so what is asserted here is that the
  // wrapper declares the box: an aspect-ratio and a width capped by the
  // `max-h-64` the image is bound to.
  it('reserves the box on the wrapper with an explicit aspect-ratio when dimensions are known', () => {
    render(<BeeperAttachment attachment={{ ...baseAttachment, width: 800, height: 600 }} />);

    const wrapper = screen.getByTestId('attachment-skeleton').parentElement;
    const style = wrapper.getAttribute('style') || '';
    expect(style).toContain('aspect-ratio: 800 / 600');
    expect(style).toContain('max-width: 100%');
  });

  // The width cap is asserted on the pure helper rather than the rendered
  // style attribute: happy-dom drops any declaration whose value is a `min()`,
  // so `width` never reaches the DOM here even though a real browser applies
  // it. Trading the `min()` for something the test environment serializes
  // would change real behaviour to suit the test, so the function is the seam.
  it('caps the reserved width at the natural width and the max-h-64 bound', () => {
    expect(reservedBoxStyle({ width: 800, height: 600 }, false)).toEqual({
      aspectRatio: '800 / 600',
      // 16rem * (800/600) = the width a 4:3 image takes once max-h-64 binds.
      width: 'min(800px, calc(16rem * 1.3333))',
      maxWidth: '100%',
    });
  });

  it('reserves the fixed neutral box from the helper when dimensions are unknown', () => {
    expect(reservedBoxStyle({ width: null, height: null }, false)).toEqual({ width: '8rem', height: '8rem' });
    // Once loaded there is nothing left to reserve — the image is its own box.
    expect(reservedBoxStyle({ width: null, height: null }, true)).toBeUndefined();
  });

  it('keeps the fixed neutral box, and no aspect-ratio, when dimensions are unknown', () => {
    render(<BeeperAttachment attachment={{ ...baseAttachment, width: null, height: null }} />);

    const style = screen.getByTestId('attachment-skeleton').parentElement.getAttribute('style') || '';
    expect(style).not.toContain('aspect-ratio');
    expect(style).toContain('8rem');
  });

  it('hugs the image with a w-fit wrapper rather than stretching to the bubble width', () => {
    render(<BeeperAttachment attachment={{ ...baseAttachment, width: 800, height: 600 }} />);

    const skeleton = screen.getByTestId('attachment-skeleton');
    const wrapper = skeleton.parentElement;
    expect(wrapper.className).toContain('w-fit');
  });

  it('keeps the loaded image visible when the attachment object is replaced but the image identity is unchanged', () => {
    // A thread refetch or the keep toggle's applyAttachmentUpdate hands down a
    // new-but-equal attachment object for the same messageId/idx. The `<img>`
    // keeps its key and `src`, so React reuses the same DOM node and no
    // second `load` event fires — the load state must survive the swap.
    const { rerender } = render(<BeeperAttachment attachment={{ ...baseAttachment, width: 800, height: 600 }} />);

    const img = screen.getByRole('img', { name: 'photo.png' });
    fireEvent.load(img);
    expect(img.className).toContain('opacity-100');

    rerender(<BeeperAttachment attachment={{ ...baseAttachment, width: 800, height: 600, keep: true }} />);

    const after = screen.getByRole('img', { name: 'photo.png' });
    expect(after).toBe(img);
    expect(screen.queryByTestId('attachment-skeleton')).toBeNull();
    expect(after.className).toContain('opacity-100');
  });

  it('swaps the skeleton for the image once it loads', () => {
    render(<BeeperAttachment attachment={{ ...baseAttachment, width: 800, height: 600 }} />);

    const img = screen.getByRole('img', { name: 'photo.png' });
    fireEvent.load(img);

    expect(screen.queryByTestId('attachment-skeleton')).toBeNull();
    expect(img.className).toContain('opacity-100');
  });

  it('renders the reference row with a retry action on load failure, never a stuck skeleton', () => {
    render(<BeeperAttachment attachment={{ ...baseAttachment, width: 800, height: 600 }} />);

    const img = screen.getByRole('img', { name: 'photo.png' });
    fireEvent.error(img);

    expect(screen.queryByTestId('attachment-skeleton')).toBeNull();
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText(/Could not load these bytes from Beeper/i)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Retry/i })).toBeTruthy();
  });
});
