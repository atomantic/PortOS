import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import ShotStepper, { shotNumbers, shotStartFrameSec, shotSteps } from './ShotStepper.jsx';

const scenes = [{ startSec: 4 }, { startSec: 0 }, { startSec: 8.5 }, { startSec: null }];

describe('shotSteps', () => {
  it('backs up to the shot start, or the shot before when at its start, and steps forward', () => {
    expect(shotSteps(scenes, 6)).toMatchObject({ back: 4, next: 8.5, index: 2, count: 3, scene: scenes[0] });
    expect(shotSteps(scenes, 4.5)).toMatchObject({ back: 0, next: 8.5 });
    expect(shotSteps(scenes, 3.98)).toMatchObject({ back: 0, next: 8.5, index: 2 });
    expect(shotSteps(scenes, 0.2)).toMatchObject({ back: 0, next: 4, index: 1 });
    expect(shotSteps(scenes, 9)).toMatchObject({ back: 4, next: null, index: 3 });
  });

  it('lands on a between-frames start\'s first whole frame, so the jump shows that shot', () => {
    // 5.37 s falls inside 24 fps frame 128 (5.333 s), which still belongs to the shot before.
    const between = [{ startSec: 0 }, { startSec: 5.37 }, { startSec: 9.45 }];
    const next = shotSteps(between, 0.5).next;
    expect(next).toBe(129 / 24);
    expect(Math.floor(next * 24 + 1e-9)).toBe(129);
    expect(shotSteps(between, next)).toMatchObject({ index: 2, back: 0, next: shotStartFrameSec(9.45) });
    expect(shotStartFrameSec(4)).toBe(4);
  });

  it('still shows the shot it jumped to after the media clock truncates to microseconds', () => {
    for (let frame = 1; frame <= 24 * 240; frame += 1) {
      const held = Math.floor(shotStartFrameSec(frame / 24) * 1e6) / 1e6;
      // The frame the composition draws for a song time (documentTemplateDrawing.js, the layered engine).
      expect(Math.floor(held * 24 + 1e-6)).toBe(frame);
    }
  });

  it('keeps a rendered excerpt to the shots inside it', () => {
    const excerpt = shotSteps([{ sceneId: 'earlier', startSec: 0 }, { sceneId: 'remaining', startSec: 4, label: 'Shot 3' }, { sceneId: 'later', startSec: 8.5 }], 5, { startSec: 4, endSec: 8 });
    expect(excerpt).toMatchObject({ back: 4, next: null, index: 1, count: 1, scene: { sceneId: 'remaining', label: 'Shot 3' } });
  });

  it('leaves a shot moved before the song off the song clock, even with its old start time', () => {
    const board = [{ sceneId: 'a', startSec: 0, preMusic: { durationSec: 3 } }, { sceneId: 'b', startSec: 0 }, { sceneId: 'c', startSec: 4 }];
    expect(shotSteps(board, 1)).toMatchObject({ back: 0, next: 4, index: 1, count: 2, scene: board[1] });
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

  it('jumps to the start of the song, or of a rendered excerpt, and rests there', () => {
    const onSeek = vi.fn();
    const { rerender } = render(<ShotStepper scenes={scenes} time={6} onSeek={onSeek} />);
    fireEvent.click(screen.getByRole('button', { name: 'Jump to start' }));
    expect(onSeek).toHaveBeenLastCalledWith(0);
    rerender(<ShotStepper scenes={scenes} time={6} onSeek={onSeek} range={{ startSec: 4, endSec: 8 }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Jump to start' }));
    expect(onSeek).toHaveBeenLastCalledWith(4);
    rerender(<ShotStepper scenes={scenes} time={4} onSeek={onSeek} range={{ startSec: 4, endSec: 8 }} />);
    expect(screen.getByRole('button', { name: 'Jump to start' }).disabled).toBe(true);
  });
});
