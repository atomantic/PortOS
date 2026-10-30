import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';

vi.mock('../../services/apiMusicVideo.js', async (importOriginal) => ({
  ...await importOriginal(),
  mixMusicVideoColdOpenAudio: vi.fn(async () => ({ name: 'cold-open-example.wav' })),
}));

const { default: StoryboardAnimatic } = await import('./StoryboardAnimatic.jsx');
const { mixMusicVideoColdOpenAudio } = await import('../../services/apiMusicVideo.js');

const project = { id: 'p', scenes: [
  { sceneId: 'song', order: 1, label: 'Rink', startSec: 0, endSec: 10, visualIntent: 'Skaters under the lights' },
  { sceneId: 'booth', order: 0, label: 'Booth', startSec: 30, endSec: 33, visualIntent: 'He presses play', preMusic: { durationSec: 2 } },
] };

describe('StoryboardAnimatic cold open', () => {
  // Uniquely catches the song starting before the cold open, or the cold open's shots landing on song time.
  it('plays the shots before the song with their own sound, then the song from its first note', async () => {
    const play = vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    render(<StoryboardAnimatic project={project} audioUrl="/song.mp3" />);
    await waitFor(() => expect(mixMusicVideoColdOpenAudio).toHaveBeenCalledWith('p', { silent: true }));
    const song = screen.getByLabelText('Song for the storyboard animatic');
    // On the song's clock the booth shot is not a song shot.
    expect(screen.getByText('Skaters under the lights')).toBeTruthy();
    // Playing the song from its start runs the cold open first.
    await act(async () => { fireEvent.play(song); });
    const cold = screen.getByLabelText('Sound before the song');
    await waitFor(() => expect(cold.getAttribute('src')).toBe('/api/music-video/p/cold-open/cold-open-example.wav'));
    expect(screen.getByText('He presses play')).toBeTruthy();
    expect(screen.getByText(/Before the song · shot 1 of 1/)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Cold open/ }).getAttribute('aria-pressed')).toBe('true');
    play.mockClear();
    // When it ends the song plays from 0, and that play is the song's own.
    await act(async () => { fireEvent.ended(cold); });
    expect(play).toHaveBeenCalledTimes(1);
    expect(song.currentTime).toBe(0);
    await act(async () => { fireEvent.play(song); });
    expect(screen.getByText('Skaters under the lights')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Cold open/ }).getAttribute('aria-pressed')).toBe('false');
    play.mockRestore();
  });
});
