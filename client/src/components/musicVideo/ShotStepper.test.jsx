import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import ShotStepper, { shotNumbers, shotSteps } from './ShotStepper.jsx';

const scenes = [{ startSec: 4 }, { startSec: 0 }, { startSec: 8.5 }, { startSec: null }];

describe('shotSteps', () => {
  it('backs up to the shot start, or the shot before when at its start, and steps forward', () => {
    expect(shotSteps(scenes, 6)).toEqual({ back: 4, next: 8.5, index: 2, count: 3 });
    expect(shotSteps(scenes, 4.5)).toMatchObject({ back: 0, next: 8.5 });
    expect(shotSteps(scenes, 3.98)).toMatchObject({ back: 0, next: 8.5, index: 2 });
    expect(shotSteps(scenes, 0.2)).toMatchObject({ back: 0, next: 4, index: 1 });
    expect(shotSteps(scenes, 9)).toMatchObject({ back: 4, next: null, index: 3 });
  });

  it('keeps a rendered excerpt to the shots inside it', () => {
    expect(shotSteps(scenes, 5, { startSec: 4, endSec: 8 })).toEqual({ back: 4, next: null, index: 1, count: 1 });
  });

  it('leaves a shot moved before the song off the song clock, even with its old start time', () => {
    const board = [{ sceneId: 'a', startSec: 0, preMusic: { durationSec: 3 } }, { sceneId: 'b', startSec: 0 }, { sceneId: 'c', startSec: 4 }];
    expect(shotSteps(board, 1)).toEqual({ back: 0, next: 4, index: 1, count: 2 });
    expect([...shotNumbers(board)]).toEqual([['b', 1], ['c', 2]]);
  });
});

describe('ShotStepper', () => {
  it('jumps with the buttons and the arrow keys, leaving a focused slider its own arrows', () => {
    const onSeek = vi.fn();
    render(<><ShotStepper scenes={scenes} time={6} onSeek={onSeek} keys /><input type="range" aria-label="Scrub" /></>);
    expect(screen.getByText('Shot 2 / 3')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Next shot' }));
    expect(onSeek).toHaveBeenLastCalledWith(8.5);
    fireEvent.keyDown(window, { key: 'ArrowLeft' });
    expect(onSeek).toHaveBeenLastCalledWith(4);
    onSeek.mockClear();
    fireEvent.keyDown(screen.getByLabelText('Scrub'), { key: 'ArrowRight' });
    expect(onSeek).not.toHaveBeenCalled();
  });
});
