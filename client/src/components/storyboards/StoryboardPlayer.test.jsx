import { describe, expect, it, vi } from 'vitest';
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

describe('StoryboardPlayer', () => {
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
    play.mockRestore();
  });
});
