import { describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import useShotSongSync from './useShotSongSync.js';

function Player({ startSec = 4.5, enabled = true, onTime }) {
  const { videoRef, audioRef } = useShotSongSync({ startSec, enabled, sourceKey: 'shot.mp4', onTime });
  return (
    <>
      <video ref={videoRef} data-testid="video" muted />
      <audio ref={audioRef} data-testid="audio" />
    </>
  );
}

// The suite's setup turns play/pause into no-ops; these elements keep a real paused state and fire the events a browser would.
const playable = (element) => {
  let paused = true;
  Object.defineProperty(element, 'paused', { get: () => paused, configurable: true });
  element.play = () => {
    if (paused) { paused = false; element.dispatchEvent(new Event('play')); }
    return Promise.resolve();
  };
  element.pause = () => {
    if (!paused) { paused = true; element.dispatchEvent(new Event('pause')); }
  };
  return element;
};

const mount = (props) => {
  const view = render(<Player {...props} />);
  const video = playable(view.getByTestId('video'));
  const audio = playable(view.getByTestId('audio'));
  const fire = (type, time) => act(() => {
    if (time !== undefined) video.currentTime = time;
    video.dispatchEvent(new Event(type));
  });
  return { ...view, video, audio, fire };
};

describe('useShotSongSync', () => {
  it('starts the song where the shot sits in it and pauses with the picture', async () => {
    const { video, audio } = mount();
    await act(async () => { await video.play(); });
    expect(audio.paused).toBe(false);
    expect(audio.currentTime).toBeCloseTo(4.5);
    act(() => video.pause());
    expect(audio.paused).toBe(true);
  });

  it('re-seeks the song on a seek, a loop and real drift, and leaves small drift alone', async () => {
    const onTime = vi.fn();
    const { video, audio, fire } = mount({ onTime });
    await act(async () => { await video.play(); });
    fire('seeked', 2);
    expect(audio.currentTime).toBeCloseTo(6.5);
    expect(onTime).toHaveBeenLastCalledWith(6.5);
    // The song running 50 ms off the picture is left to play; a re-seek would click.
    audio.currentTime = 6.55;
    fire('timeupdate', 2);
    expect(audio.currentTime).toBeCloseTo(6.55);
    audio.currentTime = 6.7;
    fire('timeupdate', 2);
    expect(audio.currentTime).toBeCloseTo(6.5);
    // The video looped back to its first frame while the song ran on.
    audio.currentTime = 8.9;
    fire('timeupdate', 0);
    expect(audio.currentTime).toBeCloseTo(4.5);
  });

  it('keeps the song silent while it is switched off, and brings it in when switched on mid-play', async () => {
    const { video, audio, rerender } = mount({ enabled: false });
    await act(async () => { await video.play(); });
    video.currentTime = 1;
    expect(audio.paused).toBe(true);
    rerender(<Player enabled />);
    expect(audio.paused).toBe(false);
    expect(audio.currentTime).toBeCloseTo(5.5);
    rerender(<Player enabled={false} />);
    expect(audio.paused).toBe(true);
  });
});
