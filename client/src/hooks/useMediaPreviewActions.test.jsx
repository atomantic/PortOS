import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import useMediaPreviewActions from './useMediaPreviewActions';

const navigate = vi.fn();
vi.mock('react-router-dom', () => ({ useNavigate: () => navigate }));
vi.mock('../components/ui/Toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));
vi.mock('../services/apiImageVideo', () => ({
  regenerateGalleryImage: vi.fn(),
  extractLastFrame: vi.fn(),
  removeImageWatermark: vi.fn(),
}));

import { removeImageWatermark, regenerateGalleryImage } from '../services/apiImageVideo';

const parseNav = () => {
  const url = navigate.mock.calls.at(-1)?.[0] || '';
  const [path, qs] = url.split('?');
  return { path, params: new URLSearchParams(qs) };
};

describe('useMediaPreviewActions.handleSendToImage', () => {
  beforeEach(() => navigate.mockReset());

  it('navigates to /media/image with the image queued as init + settings carried', () => {
    const { result } = renderHook(() => useMediaPreviewActions());
    result.current.handleSendToImage({
      kind: 'image', filename: 'cat.png', prompt: 'a cat', negativePrompt: 'blurry',
      modelId: 'flux2', width: 1024, height: 768, seed: 7, steps: 8, guidance: 3.5, quantize: '8',
    });
    const { path, params } = parseNav();
    expect(path).toBe('/media/image');
    expect(params.get('initImageFile')).toBe('cat.png');
    expect(params.get('prompt')).toBe('a cat');
    expect(params.get('negativePrompt')).toBe('blurry');
    expect(params.get('width')).toBe('1024');
    expect(params.get('seed')).toBe('7');
    // modelId is intentionally dropped — i2i may auto-switch backends, so the
    // source's model (possibly provider-specific) must not poison the target form.
    expect(params.get('modelId')).toBeNull();
    // Distinct from Remix — no `remix` param.
    expect(params.get('remix')).toBeNull();
  });

  it('skips the (no prompt) placeholder so it does not seed the next render', () => {
    const { result } = renderHook(() => useMediaPreviewActions());
    result.current.handleSendToImage({ kind: 'image', filename: 'x.png', prompt: '(no prompt)' });
    const { params } = parseNav();
    expect(params.get('initImageFile')).toBe('x.png');
    expect(params.get('prompt')).toBeNull();
  });

  it('is a no-op for videos and for items without a filename', () => {
    const { result } = renderHook(() => useMediaPreviewActions());
    result.current.handleSendToImage({ kind: 'video', filename: 'clip.mp4' });
    result.current.handleSendToImage({ kind: 'image' });
    expect(navigate).not.toHaveBeenCalled();
  });
});

describe('useMediaPreviewActions.handleRemoveWatermark', () => {
  beforeEach(() => removeImageWatermark.mockReset());

  it('calls the API and fires onCleanComplete with the returned variant', async () => {
    const variant = { filename: 'cat_nowatermark.png', watermarkRemoved: true };
    removeImageWatermark.mockResolvedValue(variant);
    const onCleanComplete = vi.fn();
    const { result } = renderHook(() => useMediaPreviewActions({ onCleanComplete }));
    const returned = await result.current.handleRemoveWatermark({ filename: 'cat.png' });
    expect(removeImageWatermark).toHaveBeenCalledWith('cat.png');
    expect(onCleanComplete).toHaveBeenCalledWith(variant);
    expect(returned).toBe(variant);
  });

  it('throws when the image has no filename', async () => {
    const { result } = renderHook(() => useMediaPreviewActions());
    await expect(result.current.handleRemoveWatermark({})).rejects.toThrow('Missing filename');
    expect(removeImageWatermark).not.toHaveBeenCalled();
  });
});

describe('useMediaPreviewActions.handleClean', () => {
  beforeEach(() => regenerateGalleryImage.mockReset());

  it('runs the CPU resize-squeeze (light regen), not the aggressive denoise clean', async () => {
    const variant = { filename: 'cat_regen-light.png', regenMethod: 'light-spatial' };
    regenerateGalleryImage.mockResolvedValue(variant);
    const onCleanComplete = vi.fn();
    const { result } = renderHook(() => useMediaPreviewActions({ onCleanComplete }));
    const returned = await result.current.handleClean({ filename: 'cat.png' });
    expect(regenerateGalleryImage).toHaveBeenCalledWith('cat.png', { method: 'light' });
    expect(onCleanComplete).toHaveBeenCalledWith(variant);
    expect(returned).toBe(variant);
  });

  it('throws when the image has no filename', async () => {
    const { result } = renderHook(() => useMediaPreviewActions());
    await expect(result.current.handleClean({})).rejects.toThrow('Missing filename');
    expect(regenerateGalleryImage).not.toHaveBeenCalled();
  });
});
