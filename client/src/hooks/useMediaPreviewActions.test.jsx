import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import useMediaPreviewActions from './useMediaPreviewActions';

const navigate = vi.fn();
vi.mock('react-router', () => ({ useNavigate: () => navigate }));
vi.mock('../components/ui/Toast', () => ({ default: { error: vi.fn(), success: vi.fn() } }));
vi.mock('../services/apiImageVideo', () => ({
  cleanGalleryImage: vi.fn(),
  extractLastFrame: vi.fn(),
  removeImageWatermark: vi.fn(),
}));

import { removeImageWatermark, cleanGalleryImage, extractLastFrame } from '../services/apiImageVideo';

const parseNav = () => {
  const url = navigate.mock.calls.at(-1)?.[0] || '';
  const [path, qs] = url.split('?');
  return { path, params: new URLSearchParams(qs) };
};

describe('useMediaPreviewActions.handleRemix', () => {
  beforeEach(() => navigate.mockReset());

  // #6290: a saved video hands over its RECORD ID, not a render-settings
  // bundle. The bundle was a second restore implementation that had to be
  // extended for every new render field and wasn't — it silently dropped the
  // conditioner, speed profile, draft decode and LoRAs — so the same clip came
  // back with different settings from History than from the Video Gen gallery.
  // Enumerating fields here again would re-open exactly that drift.
  it('sends a saved video back to /media/video by record id, with no settings bundle', () => {
    const { result } = renderHook(() => useMediaPreviewActions());
    result.current.handleRemix({
      kind: 'video',
      id: 'vid-1',
      prompt: 'a fox in rain',
      negativePrompt: 'blurry',
      modelId: 'ltx2-dev',
      width: 768,
      height: 512,
      numFrames: 121,
      fps: 24,
      raw: { seed: 42, steps: 8, guidanceScale: 3, tiling: 'none', disableAudio: true },
    });
    const { path, params } = parseNav();
    expect(path).toBe('/media/video');
    expect(params.get('remix')).toBe('vid-1');
    expect([...params.keys()]).toEqual(['remix']);
  });

  // Records that never got an id (and links already out in the wild) keep the
  // legacy field bundle. It is deliberately not extended with new fields.
  it('falls back to the legacy field bundle for a video with no record id', () => {
    const { result } = renderHook(() => useMediaPreviewActions());
    result.current.handleRemix({
      kind: 'video',
      prompt: 'a fox in rain',
      negativePrompt: 'blurry',
      modelId: 'ltx2-dev',
      width: 768,
      height: 512,
      numFrames: 121,
      fps: 24,
      raw: { seed: 42, steps: 8, guidanceScale: 3, tiling: 'none', disableAudio: true },
    });
    const { path, params } = parseNav();
    expect(path).toBe('/media/video');
    expect(params.get('remix')).toBeNull();
    expect(params.get('prompt')).toBe('a fox in rain');
    expect(params.get('negativePrompt')).toBe('blurry');
    expect(params.get('modelId')).toBe('ltx2-dev');
    expect(params.get('w')).toBe('768');
    expect(params.get('h')).toBe('512');
    expect(params.get('numFrames')).toBe('121');
    expect(params.get('fps')).toBe('24');
    expect(params.get('seed')).toBe('42');
    expect(params.get('steps')).toBe('8');
    expect(params.get('guidanceScale')).toBe('3');
    expect(params.get('tiling')).toBe('none');
    expect(params.get('disableAudio')).toBe('1');
  });

  it('skips the (no prompt) placeholder so an id-less remixed clip does not seed that literal', () => {
    const { result } = renderHook(() => useMediaPreviewActions());
    result.current.handleRemix({ kind: 'video', prompt: '(no prompt)', width: 512, height: 512 });
    const { params } = parseNav();
    expect(params.get('prompt')).toBeNull();
  });
});

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

describe('useMediaPreviewActions.handleContinue', () => {
  beforeEach(() => { navigate.mockReset(); extractLastFrame.mockReset(); });

  it('carries the source clip prompt into the continuation form', async () => {
    extractLastFrame.mockResolvedValue({ filename: 'last.png' });
    const { result } = renderHook(() => useMediaPreviewActions());
    await result.current.handleContinue({
      kind: 'video', id: 'vid-1', prompt: 'a neon alley, rain', width: 768, height: 512,
      raw: { negative_prompt: 'blurry' },
    });
    const { path, params } = parseNav();
    expect(path).toBe('/media/video');
    expect(params.get('sourceImageFile')).toBe('last.png');
    expect(params.get('prompt')).toBe('a neon alley, rain');
    expect(params.get('negativePrompt')).toBe('blurry');
    expect(params.get('w')).toBe('768');
  });

  it('leaves the prompt out for a clip we did not generate', async () => {
    extractLastFrame.mockResolvedValue({ filename: 'last.png' });
    const { result } = renderHook(() => useMediaPreviewActions());
    await result.current.handleContinue({ kind: 'video', id: 'vid-2', prompt: '(no prompt)' });
    const { params } = parseNav();
    expect(params.get('sourceImageFile')).toBe('last.png');
    expect(params.get('prompt')).toBeNull();
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
  beforeEach(() => cleanGalleryImage.mockReset());

  it('runs the gallery clean endpoint (resize-squeeze) and returns the cleaned variant', async () => {
    const variant = { filename: 'cat_clean-resize-squeeze.png', cleanLevel: 'resize-squeeze' };
    cleanGalleryImage.mockResolvedValue(variant);
    const onCleanComplete = vi.fn();
    const { result } = renderHook(() => useMediaPreviewActions({ onCleanComplete }));
    const returned = await result.current.handleClean({ filename: 'cat.png' });
    expect(cleanGalleryImage).toHaveBeenCalledWith('cat.png', { silent: true });
    expect(onCleanComplete).toHaveBeenCalledWith(variant);
    expect(returned).toBe(variant);
  });

  it('throws when the image has no filename', async () => {
    const { result } = renderHook(() => useMediaPreviewActions());
    await expect(result.current.handleClean({})).rejects.toThrow('Missing filename');
    expect(cleanGalleryImage).not.toHaveBeenCalled();
  });
});
