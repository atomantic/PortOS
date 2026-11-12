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
vi.mock('../../services/apiMusicVideo.js', async original => ({
  ...await original(),
  getMusicVideoLyricOverlayPreview: vi.fn(async () => ({ html: '<!doctype html><p>words</p>', assets: [], width: 1920, height: 1080, fps: 24, durationSec: 8 })),
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

// Uniquely catches a saved frame that loses a steady title card (its layer sits outside the tree the
// capture freezes), or bakes it under the film look with the words instead of over the finished picture.
it('saves the words through the film look and a steady title card over it', async () => {
  capturePreviewFrame.mockClear();
  uploadGalleryImage.mockClear();
  const frames = new Map();
  let nextFrame = 0;
  vi.stubGlobal('requestAnimationFrame', tick => { frames.set(++nextFrame, tick); return nextFrame; });
  vi.stubGlobal('cancelAnimationFrame', id => frames.delete(id));
  const paint = async () => {
    await act(async () => {
      const pending = [...frames.values()];
      frames.clear();
      for (const tick of pending) tick(performance.now());
    });
  };
  try {
    render(<StoryboardAnimatic project={{
      id: 'capture', audioAnalysis: { durationSec: 8 }, scenes: [{ sceneId: 'selected', startSec: 0, endSec: 8, label: 'Shot 1' }],
      lyricCues: [{ id: 'line', text: 'example words', startSec: 0, endSec: 4 }],
      titleCard: { enabled: true, title: 'Example Song', style: 'mtv', startSec: 0, endSec: 5 },
    }} audioUrl="/song.wav" />);
    const words = await screen.findByTestId('animatic-lyrics');
    const card = await screen.findByTestId('animatic-title-card');
    await act(async () => {});
    const posted = new Map([[words, vi.spyOn(words.contentWindow, 'postMessage')], [card, vi.spyOn(card.contentWindow, 'postMessage')]]);
    const reply = (frame, data) => act(async () => { window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, data })); });
    for (const frame of [words, card]) {
      await reply(frame, { type: 'portos-mv:loaded' });
      await reply(frame, { type: 'portos-mv:seeked', t: 0 });
    }
    // Each layer is asked for its frame at the song's place, one after the other, and answers with its own picture.
    const answer = async (frame, png) => {
      const asked = () => posted.get(frame).mock.calls.map(([message]) => message).find((message) => message.type === 'portos-mv:capture-lyrics');
      await waitFor(async () => { await reply(frame, { type: 'portos-mv:seeked', t: 0 }); expect(asked()).toBeTruthy(); });
      await reply(frame, { type: 'portos-mv:captured-lyrics', id: asked().id, t: 0, png });
    };
    fireEvent.click(screen.getByRole('button', { name: 'Save frame', exact: true }));
    await paint(); await paint(); await paint();
    await answer(words, 'data:image/png;base64,AAAA');
    await answer(card, 'data:image/png;base64,BBBB');
    await waitFor(() => expect(capturePreviewFrame).toHaveBeenCalledTimes(1));
    const [root, layers] = capturePreviewFrame.mock.calls[0];
    expect(root.contains(words)).toBe(true);
    expect(root.contains(card)).toBe(false);
    expect([...layers.iframeImages]).toEqual([[words, 'data:image/png;base64,AAAA']]);
    expect(layers.over).toEqual(['data:image/png;base64,BBBB']);
    await waitFor(() => expect(uploadGalleryImage).toHaveBeenCalled());
  } finally {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});
