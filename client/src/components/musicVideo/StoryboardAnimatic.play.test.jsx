import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import StoryboardAnimatic from './StoryboardAnimatic.jsx';

describe('StoryboardAnimatic seek requests', () => {
  it('plays from a shot when the request asks to play, and only cues it otherwise', () => {
    const play = vi.spyOn(window.HTMLMediaElement.prototype, 'play').mockImplementation(() => Promise.resolve());
    const project = { id: 'p', scenes: [{ sceneId: 'a', label: 'Opening', startSec: 0 }, { sceneId: 'b', label: 'Chorus', startSec: 10 }] };
    const { rerender } = render(<StoryboardAnimatic project={project} audioUrl="/song.mp3" seekRequest={{ t: 10, n: 1 }} />);
    expect(play).not.toHaveBeenCalled();
    rerender(<StoryboardAnimatic project={project} audioUrl="/song.mp3" seekRequest={{ t: 10, n: 2, play: true }} />);
    expect(play).toHaveBeenCalledTimes(1);
    play.mockRestore();
  });
});
