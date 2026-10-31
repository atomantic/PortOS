import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import ShotStepper, { shotNumbers, shotSteps } from './ShotStepper.jsx';
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

describe('ShotStepper shot lock', () => {
  const shots = [{ sceneId: 'a', startSec: 0 }, { sceneId: 'b', startSec: 4 }];
  const renderWith = (locks, time) => {
    const toggle = vi.fn();
    render(<ShotLockContext.Provider value={{ locks, toggle, busy: false }}><ShotStepper scenes={shots} time={time} onSeek={vi.fn()} /></ShotLockContext.Provider>);
    return toggle;
  };

  it('locks the shot on screen in one tap, and unlocks a locked one', () => {
    const toggle = renderWith({ a: 'locked', b: 'changed' }, 5);
    const lock = screen.getByRole('button', { name: 'Lock' });
    expect(lock.title).toMatch(/^Changed since locked/);
    fireEvent.click(lock);
    expect(toggle).toHaveBeenLastCalledWith('b', true, 'still');
  });

  it('offers Unlock on a locked shot, and no lock button without lockable shots', () => {
    const toggle = renderWith({ a: 'locked', b: 'open' }, 1);
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    expect(toggle).toHaveBeenLastCalledWith('a', false, 'still');
    document.body.innerHTML = '';
    render(<ShotStepper scenes={shots} time={1} onSeek={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /lock/i })).toBeNull();
  });

  // Uniquely catches a video shot skipping its clip lock, or a still lock with no way back.
  it('walks a video shot from Lock still to Lock video to Unlock video', () => {
    const scenes = [{ sceneId: 'a', startSec: 0 }, { sceneId: 'b', startSec: 4, videoHistoryId: 'clip-1' }];
    const view = (locks, clips, time) => {
      const toggle = vi.fn();
      document.body.innerHTML = '';
      render(<ShotLockContext.Provider value={{ locks, clips, toggle, busy: false }}><ShotStepper scenes={scenes} time={time} onSeek={vi.fn()} /></ShotLockContext.Provider>);
      return toggle;
    };
    let toggle = view({ a: 'open', b: 'open' }, { a: 'open', b: 'open' }, 1);
    fireEvent.click(screen.getByRole('button', { name: 'Lock still' }));
    expect(toggle).toHaveBeenLastCalledWith('a', true, 'still');
    // No clip yet: the still stays locked until its clip is made.
    toggle = view({ a: 'locked', b: 'open' }, { a: 'open', b: 'open' }, 1);
    expect(screen.queryByRole('button', { name: 'Lock video' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Unlock still' }));
    expect(toggle).toHaveBeenLastCalledWith('a', false, 'still');
    toggle = view({ a: 'open', b: 'locked' }, { a: 'open', b: 'open' }, 5);
    fireEvent.click(screen.getByRole('button', { name: 'Lock video' }));
    expect(toggle).toHaveBeenLastCalledWith('b', true, 'video');
    fireEvent.click(screen.getByRole('button', { name: 'Unlock still' }));
    expect(toggle).toHaveBeenLastCalledWith('b', false, 'still');
    toggle = view({ a: 'open', b: 'locked' }, { a: 'open', b: 'locked' }, 5);
    fireEvent.click(screen.getByRole('button', { name: 'Unlock video' }));
    expect(toggle).toHaveBeenLastCalledWith('b', false, 'video');
  });
});
