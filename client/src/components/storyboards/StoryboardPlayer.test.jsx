import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import StoryboardPlayer from './StoryboardPlayer';

const panel = (id, action, seconds) => ({ id, action, dialogue: '', seconds, takes: [], selectedTakeId: null });
const board = {
  aspectRatio: '16:9',
  tempTrack: null,
  beats: [
    { id: 'beat-booth', title: 'Booth', beforeSong: true, musicalRole: null, panels: [panel('p1', 'He presses play', 2), panel('p2', 'The reels turn', 1.5)] },
    { id: 'beat-floor', title: 'Floor', musicalRole: 'verse', panels: [panel('p3', 'Skaters circle the rink', 10)] },
  ],
};
const song = { src: '/data/music/example.mp3', name: 'Example Song', lines: [{ id: 'c1', text: 'Here we go', at: 1 }] };

function renderPlayerWithMobileAudio(nextUnlock) {
  let now = 0;
  let frame;
  let paused = true;
  const unlock = Promise.withResolvers();
  const { container } = render(<StoryboardPlayer board={board} song={song} onTempTrack={() => {}} />);
  const audio = container.querySelector('audio');
  Object.defineProperty(audio, 'duration', { configurable: true, value: 30 });
  fireEvent.loadedMetadata(audio);
  vi.spyOn(audio, 'paused', 'get').mockImplementation(() => paused);
  const play = vi.spyOn(audio, 'play').mockImplementation(() => {
    paused = false;
    return Promise.resolve();
  });
  for (const pending of [unlock, nextUnlock].filter(Boolean)) {
    play.mockImplementationOnce(() => {
      paused = false;
      return pending.promise;
    });
  }
  vi.spyOn(audio, 'pause').mockImplementation(() => { paused = true; });
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => { frame = callback; return 1; });
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => { frame = null; });
  const tick = (ms) => act(() => {
    now = ms;
    frame(now);
  });
  const finishUnlock = () => act(async () => { unlock.resolve(); });
  return { audio, play, tick, finishUnlock };
}

describe('StoryboardPlayer', () => {
  afterEach(() => vi.restoreAllMocks());

  // Uniquely catches the song starting under the prelude, or a seek landing on the wrong song time.
  it("plays a music video's own song, starting it after the beats before the song", async () => {
    const play = vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    const { container } = render(<StoryboardPlayer board={board} song={song} onTempTrack={() => {}} />);
    const audio = container.querySelector('audio');
    expect(audio.getAttribute('src')).toBe(song.src);
    expect(screen.getByText('starts at 0:03.50')).toBeTruthy();
    // No temp track controls: the song is the video's.
    expect(screen.queryByText('Add temp track')).toBeNull();
    Object.defineProperty(audio, 'duration', { configurable: true, value: 30 });
    await act(async () => { fireEvent.loadedMetadata(audio); });

    const scrub = screen.getByLabelText('Playhead');
    await act(async () => { fireEvent.change(scrub, { target: { value: '1' } }); });
    expect(screen.getByText('He presses play')).toBeTruthy();
    expect(audio.currentTime).toBe(0);
    expect(screen.queryByText('Here we go')).toBeNull();

    await act(async () => { fireEvent.change(scrub, { target: { value: '5' } }); });
    expect(audio.currentTime).toBeCloseTo(1.5, 5);
    expect(screen.getByText('Here we go')).toBeTruthy();
    // The animatic runs to the song's end, after the prelude.
    expect(screen.getByText('0:05.00 / 0:33.50')).toBeTruthy();
    expect(play).not.toHaveBeenCalled();
  });

  it('advances the prelude on the wall clock while mobile audio silently unlocks', async () => {
    const { audio, play, tick, finishUnlock } = renderPlayerWithMobileAudio();
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    expect(audio.muted).toBe(true);
    expect(audio.paused).toBe(false);

    audio.currentTime = 0.2;
    tick(1000);
    expect(screen.getByLabelText('Playhead').value).toBe('1');
    expect(screen.getByText('He presses play')).toBeTruthy();
    await finishUnlock();
    expect(audio.paused).toBe(true);
    expect(audio.muted).toBe(false);
    expect(audio.currentTime).toBe(0);

    tick(2500);
    expect(screen.getByText('The reels turn')).toBeTruthy();
    tick(3500);
    expect(screen.getByText('Skaters circle the rink')).toBeTruthy();
    expect(play).toHaveBeenCalledTimes(2);
    expect(audio.paused).toBe(false);
    expect(audio.muted).toBe(false);
  });

  it.each([
    ['reaching the song boundary', 0, (tick) => tick(3500)],
    ['scrubbing into the song', 1.5, () => fireEvent.change(screen.getByLabelText('Playhead'), { target: { value: '5' } })],
  ])('hands pending mobile audio to audible playback when %s', async (_action, songTime, enterSong) => {
    const { audio, tick, finishUnlock } = renderPlayerWithMobileAudio();
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    enterSong(tick);
    expect(audio.currentTime).toBe(songTime);
    expect(audio.muted).toBe(false);

    await finishUnlock();
    expect(audio.currentTime).toBe(songTime);
    expect(audio.paused).toBe(false);
    audio.currentTime = songTime + 1;
    tick(4500);
    expect(screen.getByLabelText('Playhead').value).toBe(String(4.5 + songTime));
  });

  it('keeps a stale unlock from interrupting playback after Pause and Play', async () => {
    const nextUnlock = Promise.withResolvers();
    const { audio, finishUnlock } = renderPlayerWithMobileAudio(nextUnlock);
    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(audio.muted).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Play' }));
    await finishUnlock();
    expect(audio.muted).toBe(true);
    expect(audio.paused).toBe(false);
    await act(async () => { nextUnlock.resolve(); });
    expect(audio.paused).toBe(true);
    expect(audio.muted).toBe(false);
  });
});
