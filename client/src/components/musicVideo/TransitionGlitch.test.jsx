import { createRef } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import TransitionGlitch from './TransitionGlitch.jsx';

// Uniquely catches the animatic mounting a glitch layer over a storyboard with no
// transitions, or failing to mount one when a shot sets one.
describe('TransitionGlitch', () => {
  const props = { figureRef: createRef(), audioRef: createRef(), time: 0, endSec: 8, fps: 24 };
  it('mounts its canvas only when a shot sets a transition, hidden off the glitched frames', () => {
    const { rerender } = render(<TransitionGlitch {...props} scenes={[{ sceneId: 'a', startSec: 0 }, { sceneId: 'b', startSec: 4 }]} />);
    expect(screen.queryByTestId('animatic-glitch')).toBeNull();
    rerender(<TransitionGlitch {...props} scenes={[{ sceneId: 'a', startSec: 0, transitionOut: 'channel-change' }, { sceneId: 'b', startSec: 4 }]} />);
    expect(screen.getByTestId('animatic-glitch').style.visibility).toBe('hidden');
  });
});
