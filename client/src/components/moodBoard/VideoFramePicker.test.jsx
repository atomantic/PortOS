import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import VideoFramePicker from './VideoFramePicker';

function openWithDuration(onAdd) {
  render(<VideoFramePicker src="/data/videos/clip.mp4" onAdd={onAdd} onClose={() => {}} />);
  const video = screen.getByTestId('frame-picker-video');
  Object.defineProperty(video, 'duration', { configurable: true, value: 10 });
  fireEvent.loadedMetadata(video);
}

describe('VideoFramePicker', () => {
  it('picks frames by stepping and keyboard scrubbing, then adds them in timeline order', () => {
    const onAdd = vi.fn();
    openWithDuration(onAdd);
    const add = screen.getByRole('button', { name: 'Add frames to board' });
    expect(add).toBeDisabled();

    fireEvent.keyDown(screen.getByRole('slider', { name: 'Filmstrip' }), { key: 'ArrowRight' });
    fireEvent.click(screen.getByRole('button', { name: 'Pick this frame' }));
    // The same frame can't be picked twice.
    expect(screen.getByRole('button', { name: 'Pick this frame' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Back one frame' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pick this frame' }));

    expect(screen.getByRole('button', { name: 'Go to 0:00.03' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add 2 frames to board' }));
    expect(onAdd).toHaveBeenCalledWith([0, 0.033]);
  });

  it('removes a picked frame', () => {
    openWithDuration(vi.fn());
    fireEvent.click(screen.getByRole('button', { name: 'Pick this frame' }));
    fireEvent.click(screen.getByRole('button', { name: 'Remove 0:00.00' }));
    expect(screen.getByRole('button', { name: 'Add frames to board' })).toBeDisabled();
  });
});
