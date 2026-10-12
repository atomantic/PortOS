import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import VideoStartTrimControl from './VideoStartTrimControl.jsx';

// A stand-in <video>: happy-dom has no decoder, so currentTime/duration are
// plain fields the test drives.
const fakeVideo = ({ currentTime = 0, duration = 4 } = {}) => {
  const el = document.createElement('video');
  Object.defineProperty(el, 'duration', { value: duration });
  let time = currentTime;
  Object.defineProperty(el, 'currentTime', { get: () => time, set: (t) => { time = t; } });
  el.pause = vi.fn();
  return el;
};

describe('VideoStartTrimControl', () => {
  // Uniquely catches an off-by-one between the frame shown and the start the
  // server is asked to keep (the server rounds startSec * fps to a frame).
  it('steps frame by frame and trims from the exact start of the frame on screen', async () => {
    const video = fakeVideo({ currentTime: 1.01 });
    const onTrim = vi.fn(async () => {});
    render(<VideoStartTrimControl videoRef={{ current: video }} fps={24} onTrim={onTrim} />);
    expect(screen.getByText('Frame 24')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Next frame' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next frame' }));
    fireEvent.click(screen.getByRole('button', { name: 'Previous frame' }));
    expect(video.pause).toHaveBeenCalled();
    expect(screen.getByText('Frame 25')).toBeInTheDocument();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Start clip here/ })); });
    expect(onTrim).toHaveBeenCalledWith(25 / 24);
  });

  it('shows a failed trim inline and stays usable', async () => {
    const video = fakeVideo({ currentTime: 0.5 });
    const onTrim = vi.fn(async () => { throw new Error('Pick a frame before the end of the clip'); });
    render(<VideoStartTrimControl videoRef={{ current: video }} fps={24} onTrim={onTrim} />);
    fireEvent.click(screen.getByRole('button', { name: /Start clip here/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Pick a frame before the end of the clip');
    await waitFor(() => expect(screen.getByRole('button', { name: /Start clip here/ })).not.toBeDisabled());
  });

  it('cannot trim at the first frame', () => {
    render(<VideoStartTrimControl videoRef={{ current: fakeVideo() }} fps={24} onTrim={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Start clip here/ })).toBeDisabled();
  });
});
