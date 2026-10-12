import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import ShotStepper, { shotSteps } from './ShotStepper.jsx';
import { ShotLockContext } from './ShotLock.jsx';

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

describe('ShotStepper shot lock', () => {
  const shots = [{ sceneId: 'a', startSec: 0 }, { sceneId: 'b', startSec: 4 }];
  const renderWith = (locks, time) => {
    const toggle = vi.fn();
    render(<ShotLockContext.Provider value={{ locks, toggle, busy: false }}><ShotStepper scenes={shots} time={time} onSeek={vi.fn()} /></ShotLockContext.Provider>);
    return toggle;
  };

  it('locks the shot on screen in one tap, and unlocks a locked one', () => {
    const toggle = renderWith({ a: 'locked', b: 'changed' }, 5);
    fireEvent.click(screen.getByRole('button', { name: 'Lock again' }));
    expect(toggle).toHaveBeenLastCalledWith('b', true);
  });

  it('offers Unlock on a locked shot, and no lock button without lockable shots', () => {
    const toggle = renderWith({ a: 'locked', b: 'open' }, 1);
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(toggle).toHaveBeenLastCalledWith('a', false);
    document.body.innerHTML = '';
    render(<ShotStepper scenes={shots} time={1} onSeek={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /lock/i })).toBeNull();
  });
});
