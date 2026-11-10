import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const getVideoHistoryItem = vi.fn();
vi.mock('../../services/apiImageVideo.js', () => ({ getVideoHistoryItem: (...args) => getVideoHistoryItem(...args) }));
const { default: HandheldCameraControl } = await import('./HandheldCameraControl.jsx');

describe('HandheldCameraControl', () => {
  beforeEach(() => { getVideoHistoryItem.mockReset(); });

  // Uniquely catches the sliders not reaching the request the host sends.
  it('previews the clip and applies the chosen shake and footsteps', async () => {
    getVideoHistoryItem.mockResolvedValue({ id: 'clip-1', filename: 'clip-1.mp4' });
    const onApply = vi.fn(async () => true);
    const { container } = render(<HandheldCameraControl clipId="clip-1" onApply={onApply} />);
    fireEvent.click(screen.getByRole('button', { name: /Handheld camera/ }));
    await waitFor(() => expect(container.querySelector('video')?.getAttribute('src')).toBe('/data/videos/clip-1.mp4'));
    const [shake, steps] = screen.getAllByRole('slider');
    fireEvent.change(shake, { target: { value: '0.8' } });
    fireEvent.change(steps, { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Make handheld take' }));
    await waitFor(() => expect(onApply).toHaveBeenCalledTimes(1));
    expect(onApply.mock.calls[0][0]).toMatchObject({ shake: 0.8, steps: 0 });
    expect(Number.isInteger(onApply.mock.calls[0][0].seed)).toBe(true);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Make handheld take' })).toBeNull());
  });

  // Uniquely catches a handheld take previewing its own shaken file (a doubled shake) or losing its settings.
  it('previews a handheld take on its steady original, starting from its settings', async () => {
    getVideoHistoryItem.mockImplementation(async (id) => (id === 'take-2'
      ? { id: 'take-2', filename: 'take-2.mp4', handheldFrom: 'clip-1', handheld: { shake: 0.3, steps: 0.9, seed: 77 } }
      : { id: 'clip-1', filename: 'clip-1.mp4' }));
    const { container } = render(<HandheldCameraControl clipId="take-2" onApply={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Handheld camera/ }));
    await waitFor(() => expect(container.querySelector('video')?.getAttribute('src')).toBe('/data/videos/clip-1.mp4'));
    expect(screen.getByText('Shake 30%')).toBeInTheDocument();
    expect(screen.getByText('Footsteps 90%')).toBeInTheDocument();
  });

  it('will not make a take that moves nothing', async () => {
    getVideoHistoryItem.mockResolvedValue({ id: 'clip-1', filename: 'clip-1.mp4' });
    const { container } = render(<HandheldCameraControl clipId="clip-1" onApply={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Handheld camera/ }));
    await waitFor(() => expect(container.querySelector('video')).not.toBeNull());
    const [shake, steps] = screen.getAllByRole('slider');
    fireEvent.change(shake, { target: { value: '0' } });
    fireEvent.change(steps, { target: { value: '0' } });
    expect(screen.getByRole('button', { name: 'Make handheld take' })).toBeDisabled();
  });
});

// Uniquely catches a portrait or 4:3 clip previewed in a 16:9 box with the widescreen zoom.
it('frames and zooms the preview to the clip\'s own shape', async () => {
  getVideoHistoryItem.mockResolvedValue({ id: 'clip-1', filename: 'clip-1.mp4' });
  const { container } = render(<HandheldCameraControl clipId="clip-1" onApply={vi.fn()} />);
  fireEvent.click(screen.getByRole('button', { name: /Handheld camera/ }));
  await waitFor(() => expect(container.querySelector('video')).not.toBeNull());
  const video = container.querySelector('video');
  const wide = screen.getByText(/Zooms in \d+%/).textContent;
  Object.defineProperty(video, 'videoWidth', { value: 720 });
  Object.defineProperty(video, 'videoHeight', { value: 1280 });
  fireEvent.loadedMetadata(video);
  await waitFor(() => expect(video.parentElement.style.aspectRatio).toMatch(/^0\.5625/));
  expect(screen.getByText(/Zooms in \d+%/).textContent).not.toBe(wide);
});

// Uniquely catches previewing/re-shooting a shaken file after its original lookup fails.
it('requires the steady original and offers a retry when it cannot be loaded', async () => {
  getVideoHistoryItem.mockImplementation(async (id) => {
    if (id === 'take-2') return { id, filename: 'take-2.mp4', handheldFrom: 'clip-1' };
    throw new Error('offline');
  });
  const onApply = vi.fn();
  const { container } = render(<HandheldCameraControl clipId="take-2" onApply={onApply} />);
  fireEvent.click(screen.getByRole('button', { name: /Handheld camera/ }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the steady original');
  expect(container.querySelector('video')).toBeNull();
  expect(screen.getByRole('button', { name: 'Make handheld take' })).toBeDisabled();
  getVideoHistoryItem.mockImplementation(async (id) => id === 'take-2'
    ? { id, filename: 'take-2.mp4', handheldFrom: 'clip-1' }
    : { id, filename: 'clip-1.mp4' });
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await waitFor(() => expect(container.querySelector('video')?.getAttribute('src')).toBe('/data/videos/clip-1.mp4'));
  expect(screen.getByRole('button', { name: 'Make handheld take' })).not.toBeDisabled();
  expect(onApply).not.toHaveBeenCalled();
});
