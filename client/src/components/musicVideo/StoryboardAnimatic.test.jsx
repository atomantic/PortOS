import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
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
