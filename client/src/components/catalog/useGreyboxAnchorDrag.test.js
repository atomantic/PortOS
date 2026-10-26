import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Ray, Vector3 } from 'three';
import useGreyboxAnchorDrag from './useGreyboxAnchorDrag';

const state = vi.hoisted(() => ({ controls: { enabled: true }, gl: { domElement: null } }));
vi.mock('@react-three/fiber', () => ({ useThree: () => state }));
const anchor = { id: 'performer', position: [1, 0.2, 2] };
const pointer = (x, z) => ({
  button: 0, pointerId: 1, stopPropagation: vi.fn(),
  ray: new Ray(new Vector3(x, 10, z), new Vector3(0, -1, 0)),
  target: { setPointerCapture: vi.fn(), hasPointerCapture: () => true, releasePointerCapture: vi.fn() },
});
beforeEach(() => {
  state.controls.enabled = true;
  state.gl.domElement = document.createElement('canvas');
});

describe('floor anchor dragging', () => {
  it('preserves the grab offset, snaps XZ to 0.1m, retains height, and restores orbit after release', () => {
    const onMove = vi.fn();
    const onSelect = vi.fn();
    const { result } = renderHook(() => useGreyboxAnchorDrag(anchor, onMove, onSelect));
    const down = pointer(1.2, 2.1);
    act(() => result.current.onPointerDown(down));
    expect(onSelect).toHaveBeenCalledWith('anchors:performer');
    expect(down.target.setPointerCapture).toHaveBeenCalledWith(1);
    expect(state.controls.enabled).toBe(false);
    act(() => result.current.onPointerMove(pointer(3.46, -1.18)));
    expect(onMove).toHaveBeenCalledWith('performer', [3.3, 0.2, -1.3]);
    act(() => result.current.onPointerUp(pointer(3.46, -1.18)));
    expect(state.controls.enabled).toBe(true);
    expect(down.target.releasePointerCapture).toHaveBeenCalledWith(1);
  });

  it.each(['pointercancel', 'lostpointercapture', 'blur', 'unmount', 'disabled'])('releases drag ownership on %s without enabling an originally disabled orbit', (end) => {
    state.controls.enabled = false;
    const onMove = vi.fn();
    const { result, unmount, rerender } = renderHook(({ move }) => useGreyboxAnchorDrag(anchor, move), { initialProps: { move: onMove } });
    const down = pointer(1, 2);
    act(() => result.current.onPointerDown(down));
    if (end === 'unmount') unmount();
    else if (end === 'disabled') rerender({ move: undefined });
    else act(() => (end === 'blur' ? window : state.gl.domElement).dispatchEvent(new Event(end)));
    expect(down.target.releasePointerCapture).toHaveBeenCalledWith(1);
    expect(state.controls.enabled).toBe(false);
  });
});
