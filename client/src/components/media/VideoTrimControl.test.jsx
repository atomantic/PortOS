import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import VideoTrimControl from './VideoTrimControl.jsx';

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

describe('VideoTrimControl', () => {
  // Uniquely catches an off-by-one between the frame shown and the start the
  // server is asked to keep (the server rounds startSec * fps to a frame).
  it('steps frame by frame and trims from the exact start of the frame on screen', async () => {
    const video = fakeVideo({ currentTime: 1.01 });
    const onTrim = vi.fn(async () => {});
    render(<VideoTrimControl videoRef={{ current: video }} fps={24} onTrim={onTrim} />);
    expect(screen.getByText('Frame 24')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Next frame' }));
    fireEvent.click(screen.getByRole('button', { name: 'Next frame' }));
    fireEvent.click(screen.getByRole('button', { name: 'Previous frame' }));
    expect(video.pause).toHaveBeenCalled();
    expect(screen.getByText('Frame 25')).toBeInTheDocument();

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Start clip here/ })); });
    expect(onTrim).toHaveBeenCalledWith({ startSec: 25 / 24 });
  });

  // Uniquely catches an end cut that drops the frame on screen: the end sent is
  // the next frame's start, so the shown frame is the clip's last.
  it('ends the clip after the frame on screen', async () => {
    const onTrim = vi.fn(async () => {});
    render(<VideoTrimControl videoRef={{ current: fakeVideo({ currentTime: 1.01 }) }} fps={24} onTrim={onTrim} />);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /End clip here/ })); });
    expect(onTrim).toHaveBeenCalledWith({ endSec: 25 / 24 });
  });

  it('cannot end at the last frame', () => {
    render(<VideoTrimControl videoRef={{ current: fakeVideo({ currentTime: 3.99, duration: 4 }) }} fps={24} onTrim={vi.fn()} />);
    expect(screen.getByRole('button', { name: /End clip here/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Start clip here/ })).toBeEnabled();
  });

  it('shows a failed trim inline and stays usable', async () => {
    const video = fakeVideo({ currentTime: 0.5 });
    const onTrim = vi.fn(async () => { throw new Error('Pick a frame before the end of the clip'); });
    render(<VideoTrimControl videoRef={{ current: video }} fps={24} onTrim={onTrim} />);
    fireEvent.click(screen.getByRole('button', { name: /Start clip here/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Pick a frame before the end of the clip');
    await waitFor(() => expect(screen.getByRole('button', { name: /Start clip here/ })).not.toBeDisabled());
  });

  it('cannot trim at the first frame', () => {
    render(<VideoTrimControl videoRef={{ current: fakeVideo() }} fps={24} onTrim={vi.fn()} />);
    expect(screen.getByRole('button', { name: /Start clip here/ })).toBeDisabled();
  });
});
