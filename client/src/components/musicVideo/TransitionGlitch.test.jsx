import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import TransitionGlitch from './TransitionGlitch.jsx';

// The glitch drawing itself is covered with the render's recipes; here it only has to run.
vi.mock('../../lib/musicVideoGlitchCanvas.js', () => ({ createMusicVideoGlitchPainter: () => () => {} }));

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

  // Uniquely catches a glitch over a seeking clip painting the shot's still: a reversed clip seeks on every frame,
  // and its still is the shot's last picture, so a light leak flashed the end of the shot into it.
  it('keeps its last frame while the clip is seeking instead of painting the still', () => {
    const figure = document.createElement('div');
    const still = document.createElement('img');
    still.dataset.shown = 'true';
    Object.defineProperties(still, { complete: { value: true }, naturalWidth: { value: 16 }, naturalHeight: { value: 9 } });
    const clip = document.createElement('video');
    clip.dataset.ready = 'true';
    let seeking = false;
    Object.defineProperties(clip, { seeking: { get: () => seeking }, readyState: { get: () => (seeking ? 1 : 4) }, videoWidth: { value: 16 }, videoHeight: { value: 9 } });
    figure.append(still, clip);
    const drawn = [];
    const ctx = { fillStyle: '', fillRect() {}, drawImage: (el) => drawn.push(el) };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx);
    vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 320, height: 180 });
    const audio = { paused: true, currentTime: 1, addEventListener() {}, removeEventListener() {} };
    const scenes = [{ sceneId: 'a', startSec: 0, endSec: 4, glitches: [{ atSec: 1, style: 'light-leak' }] }];
    const glitchAt = (time) => <TransitionGlitch figureRef={{ current: figure }} audioRef={{ current: audio }} time={time} endSec={4} fps={24} scenes={scenes} />;
    const { rerender } = render(glitchAt(1));
    const canvas = screen.getByTestId('animatic-glitch');
    expect(canvas.style.visibility).toBe('visible');
    expect(drawn).toContain(clip);

    seeking = true;
    drawn.length = 0;
    audio.currentTime = 1 + 1 / 24;
    rerender(glitchAt(audio.currentTime));
    expect(drawn).toEqual([]);
    expect(canvas.style.visibility).toBe('visible');
    vi.restoreAllMocks();
  });
});
