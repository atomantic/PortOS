import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import StoryboardAnimatic, { shotAt } from './StoryboardAnimatic.jsx';

const scenes = [
  { sceneId: 'b', label: 'Chorus', startSec: 10, endSec: 20, referenceImageId: 'frame-b.png' },
  { sceneId: 'a', label: 'Opening', startSec: 0, endSec: 10, visualIntent: 'Lights come up' },
];

describe('StoryboardAnimatic', () => {
  it('picks the last shot that has started at a song time', () => {
    expect(shotAt(scenes, 0).sceneId).toBe('a');
    expect(shotAt(scenes, 9.9).sceneId).toBe('a');
    expect(shotAt(scenes, 10).sceneId).toBe('b');
    expect(shotAt(scenes, 300).sceneId).toBe('b');
    expect(shotAt([], 3)).toBeNull();
  });

  it('shows the shot card, then its frame, as the song plays', () => {
    const { container } = render(<StoryboardAnimatic project={{ id: 'p', scenes }} audioUrl="/song.mp3" />);
    expect(screen.getByText('Opening')).toBeTruthy();
    expect(screen.getByText('Lights come up')).toBeTruthy();
    expect(screen.getByText('Shot 1 of 2 · 0:00')).toBeTruthy();
    const audio = screen.getByLabelText('Song for the storyboard animatic');
    Object.defineProperty(audio, 'currentTime', { value: 12, configurable: true });
    fireEvent.timeUpdate(audio);
    expect(container.querySelector('img').getAttribute('src')).toBe('/data/images/frame-b.png');
    expect(screen.getByText('Shot 2 of 2 · 0:10')).toBeTruthy();
  });
});

vi.mock('../../services/apiMusicVideo.js', () => ({
  getMusicVideoLyricOverlayPreview: vi.fn(async () => ({ html: '<!doctype html><p>words</p>', assets: [], width: 1920, height: 1080, fps: 24, durationSec: 20 })),
}));

describe('StoryboardAnimatic lyrics', () => {
  const lyricProject = {
    id: 'p', scenes, audioAnalysis: { durationSec: 20 },
    lyricCues: [{ id: 'c1', text: 'hello there', startSec: 1, endSec: 3 }],
  };

  it('lays the lyrics over the picture by default and hides them on the toggle', async () => {
    render(<StoryboardAnimatic project={lyricProject} audioUrl="/song.mp3" />);
    const overlay = await screen.findByTestId('animatic-lyrics');
    expect(overlay.getAttribute('sandbox')).toBe('allow-scripts');
    // The frameless shot's stand-in text moves out from under the words.
    expect(screen.getByText('Opening').closest('figure')).toBeNull();
    const toggle = screen.getByRole('button', { name: 'Lyrics' });
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(toggle);
    await waitFor(() => expect(screen.queryByTestId('animatic-lyrics')).toBeNull());
    expect(screen.getByText('Opening').closest('figure')).toBeTruthy();
  });

  it('offers no lyrics until the words are timed', () => {
    render(<StoryboardAnimatic project={{ ...lyricProject, lyricCues: [{ id: 'c1', text: 'hello', startSec: null }] }} audioUrl="/song.mp3" />);
    expect(screen.queryByRole('button', { name: 'Lyrics' })).toBeNull();
  });
});
