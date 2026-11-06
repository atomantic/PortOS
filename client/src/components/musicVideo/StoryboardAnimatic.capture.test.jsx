import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import StoryboardAnimatic from './StoryboardAnimatic.jsx';
import { capturePreviewFrame } from '../../lib/musicVideoFrameCapture.js';
import { uploadGalleryImage } from '../../services/apiSystem.js';
import toast from '../ui/Toast.jsx';

vi.mock('../../services/apiImageVideo.js', () => ({
  getVideoHistoryItem: vi.fn(async () => ({ id: 'clip', filename: 'clip.webm' })),
}));
vi.mock('../../services/apiSystem.js', () => ({
  uploadGalleryImage: vi.fn(async () => ({ filename: 'captured.png' })),
}));
vi.mock('../../lib/musicVideoFrameCapture.js', async original => ({
  ...await original(), capturePreviewFrame: vi.fn(async () => new Blob(['synthetic'], { type: 'image/png' })),
}));

// A decoder can be ready before loadeddata reveals the selected clip. Capture
// must wait for that clip's paused surface rather than freeze its transient still.
it('waits for a decoded selected clip while its wrapper is still transparent', async () => {
  const success = vi.spyOn(toast, 'success');
  const frames = new Map();
  let nextFrame = 0;
  vi.stubGlobal('requestAnimationFrame', tick => { frames.set(++nextFrame, tick); return nextFrame; });
  vi.stubGlobal('cancelAnimationFrame', id => frames.delete(id));
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() });
  const paint = async () => {
    await act(async () => {
      const pending = [...frames.values()];
      frames.clear();
      for (const tick of pending) tick(performance.now());
    });
  };
  try {
    render(<StoryboardAnimatic project={{ id: 'capture', scenes: [{
      sceneId: 'selected', startSec: 0, endSec: 4, label: 'Shot 3',
      referenceImageId: 'still.png', videoHistoryId: 'clip',
    }] }} audioUrl="/song.wav" />);
    const video = await screen.findByLabelText('Clip for Shot 3');
    await waitFor(() => expect(video.getAttribute('src')).toBe('/data/videos/clip.webm'));
    await paint(); await paint();
    Object.defineProperties(video, {
      readyState: { configurable: true, value: 4 },
      videoWidth: { configurable: true, value: 480 },
      videoHeight: { configurable: true, value: 240 },
    });
    const still = screen.getByLabelText('Storyboard animatic').querySelector('img');
    Object.defineProperties(still, {
      complete: { configurable: true, value: true },
      naturalWidth: { configurable: true, value: 480 },
    });
    expect(video.parentElement.className).toContain('opacity-0');
    fireEvent.click(screen.getByRole('button', { name: 'Save frame', exact: true }));
    await paint(); await paint();
    expect(capturePreviewFrame).not.toHaveBeenCalled();
    fireEvent.loadedData(video);
    await paint(); await paint(); await paint();
    await waitFor(() => expect(uploadGalleryImage).toHaveBeenCalledWith(
      expect.any(Blob), { silent: true },
    ));
    expect(success).toHaveBeenCalledWith('Saved Shot 3 · frame 0 to the image gallery');
    expect(video.dataset.pausedFrame).toBe(String(video.currentTime));
    expect(video.parentElement.className).toContain('opacity-100');
  } finally {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    success.mockRestore();
  }
});
