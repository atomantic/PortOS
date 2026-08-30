import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import OpenWorldMobileControls from './OpenWorldMobileControls';

function createInput() {
  return {
    current: {
      moveX: 0,
      moveY: 0,
      lookDeltaX: 0,
      lookDeltaY: 0,
      boost: false,
      jump: false,
    },
  };
}

function renderControls(overrides = {}) {
  const mobileInputRef = createInput();
  const playerActionRef = { current: { interact: vi.fn() } };
  const props = {
    mobileInputRef,
    playerActionRef,
    ...overrides,
  };

  return { ...render(<OpenWorldMobileControls {...props} />), ...props };
}

describe('OpenWorldMobileControls', () => {
  it('exposes a focused touch action set', () => {
    renderControls();

    expect(screen.getByRole('group', { name: 'Movement joystick' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Drag to look around' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'BOOST' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'JUMP' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Interact with nearby building or warp pad' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Switch camera view' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Fly out to orbital view' })).not.toBeInTheDocument();
  });

  it('maps hold actions to the game input refs and clears them on release', () => {
    const { mobileInputRef } = renderControls();
    const boost = screen.getByRole('button', { name: 'BOOST' });
    const jump = screen.getByRole('button', { name: 'JUMP' });

    fireEvent.pointerDown(boost, { pointerId: 1 });
    expect(mobileInputRef.current.boost).toBe(true);
    fireEvent.pointerUp(boost, { pointerId: 1 });
    expect(mobileInputRef.current.boost).toBe(false);

    fireEvent.pointerDown(jump, { pointerId: 2 });
    expect(mobileInputRef.current.jump).toBe(true);
    fireEvent.pointerUp(jump, { pointerId: 2 });
    expect(mobileInputRef.current.jump).toBe(false);
  });

  it('clears a held action if pointer capture is lost', () => {
    const { mobileInputRef } = renderControls();
    const boost = screen.getByRole('button', { name: 'BOOST' });

    fireEvent.pointerDown(boost, { pointerId: 12 });
    expect(mobileInputRef.current.boost).toBe(true);
    fireEvent.lostPointerCapture(boost, { pointerId: 12 });
    expect(mobileInputRef.current.boost).toBe(false);
  });

  it('maps the virtual joystick to normalized drive input', () => {
    const { mobileInputRef } = renderControls();
    const joystick = screen.getByRole('group', { name: 'Movement joystick' });
    vi.spyOn(joystick, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 100,
      height: 100,
      right: 100,
      bottom: 100,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    fireEvent.pointerDown(joystick, { pointerId: 6, clientX: 75, clientY: 25 });
    expect(mobileInputRef.current.moveX).toBeCloseTo(Math.SQRT1_2);
    expect(mobileInputRef.current.moveY).toBeCloseTo(-Math.SQRT1_2);

    fireEvent.pointerUp(joystick, { pointerId: 6 });
    expect(mobileInputRef.current.moveX).toBe(0);
    expect(mobileInputRef.current.moveY).toBe(0);
  });

  it('does not steer from pointer hover without an active drag', () => {
    const { mobileInputRef } = renderControls();
    const joystick = screen.getByRole('group', { name: 'Movement joystick' });
    vi.spyOn(joystick, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 100,
      height: 100,
      right: 100,
      bottom: 100,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    fireEvent.pointerMove(joystick, { pointerId: 9, clientX: 75, clientY: 25 });

    expect(mobileInputRef.current.moveX).toBe(0);
    expect(mobileInputRef.current.moveY).toBe(0);
  });

  it('ignores a second pointer and clears movement if capture is lost', () => {
    const { mobileInputRef } = renderControls();
    const joystick = screen.getByRole('group', { name: 'Movement joystick' });
    vi.spyOn(joystick, 'getBoundingClientRect').mockReturnValue({
      left: 0,
      top: 0,
      width: 100,
      height: 100,
      right: 100,
      bottom: 100,
      x: 0,
      y: 0,
      toJSON: () => {},
    });

    fireEvent.pointerDown(joystick, { pointerId: 10, clientX: 75, clientY: 25 });
    const firstX = mobileInputRef.current.moveX;
    fireEvent.pointerMove(joystick, { pointerId: 11, clientX: 25, clientY: 75 });
    expect(mobileInputRef.current.moveX).toBe(firstX);

    fireEvent.lostPointerCapture(joystick, { pointerId: 10 });
    expect(mobileInputRef.current.moveX).toBe(0);
    expect(mobileInputRef.current.moveY).toBe(0);
  });

  it('accumulates drag-to-look deltas for the player rig', () => {
    const { mobileInputRef } = renderControls();
    const lookZone = screen.getByRole('group', { name: 'Drag to look around' });

    fireEvent.pointerDown(lookZone, { pointerId: 3, clientX: 100, clientY: 120 });
    fireEvent.pointerMove(lookZone, { pointerId: 3, clientX: 128, clientY: 110 });
    fireEvent.pointerMove(lookZone, { pointerId: 3, clientX: 120, clientY: 114 });
    fireEvent.pointerUp(lookZone, { pointerId: 3 });

    expect(mobileInputRef.current.lookDeltaX).toBe(20);
    expect(mobileInputRef.current.lookDeltaY).toBe(-6);
  });

  it('routes the action button to the interaction callback', () => {
    const { playerActionRef } = renderControls();

    fireEvent.click(screen.getByRole('button', { name: 'Interact with nearby building or warp pad' }));

    expect(playerActionRef.current.interact).toHaveBeenCalledTimes(1);
  });

  it('clears active touch state when the controls unmount', () => {
    const { mobileInputRef, unmount } = renderControls();
    fireEvent.pointerDown(screen.getByRole('button', { name: 'BOOST' }), { pointerId: 4 });
    fireEvent.pointerDown(screen.getByRole('button', { name: 'JUMP' }), { pointerId: 5 });
    mobileInputRef.current.moveX = 0.8;
    mobileInputRef.current.lookDeltaX = 12;

    unmount();

    expect(mobileInputRef.current).toEqual({
      moveX: 0,
      moveY: 0,
      lookDeltaX: 0,
      lookDeltaY: 0,
      boost: false,
      jump: false,
    });
  });
});
