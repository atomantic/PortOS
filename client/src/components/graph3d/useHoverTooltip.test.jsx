import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import useHoverTooltip from './useHoverTooltip';

const move = (x, y, pointerType = 'mouse') => ({ clientX: x, clientY: y, pointerType });
const NODE = { id: 'n1', label: 'Alpha' };

describe('useHoverTooltip', () => {
  it('ignores pointer moves while nothing is hovered', () => {
    const { result } = renderHook(() => useHoverTooltip());
    const before = result.current.tooltipPos;

    act(() => result.current.handlePointerMove(move(120, 240)));

    // Same object identity: no setState ran, so no re-render was queued.
    expect(result.current.tooltipPos).toBe(before);
  });

  it('tracks pointer moves once a node is hovered', () => {
    const { result } = renderHook(() => useHoverTooltip());

    act(() => result.current.handleHover(NODE));
    act(() => result.current.handlePointerMove(move(120, 240)));

    expect(result.current.hoveredNode).toBe(NODE);
    expect(result.current.tooltipPos).toEqual({ x: 120, y: 240 });
  });

  it('opens the gate on the SAME event that enters a node, before state flushes', () => {
    // The bug the ref exists for: r3f raycasts on the Canvas' inner div while
    // React delegates the container's onPointerMove at the app root, so both
    // fire for one physical move. A gate reading `hoveredNode` would still see
    // the pre-flush `null` here and strand the tooltip at a stale position.
    const { result } = renderHook(() => useHoverTooltip());

    act(() => {
      result.current.handleHover(NODE, { x: 50, y: 60 });
      result.current.handlePointerMove(move(51, 61));
    });

    expect(result.current.tooltipPos).toEqual({ x: 51, y: 61 });
  });

  it('seeds the position from the enter event so the first frame is placed', () => {
    const { result } = renderHook(() => useHoverTooltip());

    act(() => result.current.handleHover(NODE, { x: 300, y: 400 }));

    expect(result.current.tooltipPos).toEqual({ x: 300, y: 400 });
  });

  it('closes the gate again when the pointer leaves the node', () => {
    const { result } = renderHook(() => useHoverTooltip());

    act(() => result.current.handleHover(NODE, { x: 10, y: 20 }));
    act(() => result.current.handleHover(null));
    const settled = result.current.tooltipPos;
    act(() => result.current.handlePointerMove(move(999, 999)));

    expect(result.current.hoveredNode).toBeNull();
    expect(result.current.tooltipPos).toBe(settled);
  });

  it('ignores touch moves — the tooltip is pointer-coarse:hidden', () => {
    const { result } = renderHook(() => useHoverTooltip());

    act(() => result.current.handleHover(NODE, { x: 10, y: 20 }));
    const seeded = result.current.tooltipPos;
    act(() => result.current.handlePointerMove(move(700, 800, 'touch')));

    expect(result.current.tooltipPos).toBe(seeded);
  });

  it('keeps its handlers identity-stable across renders', () => {
    // BrainGraph passes handleHover into a memo()'d scene; a new identity per
    // render would defeat the memo the whole optimization rests on.
    const { result, rerender } = renderHook(() => useHoverTooltip());
    const first = result.current;

    act(() => result.current.handleHover(NODE, { x: 1, y: 2 }));
    rerender();

    expect(result.current.handleHover).toBe(first.handleHover);
    expect(result.current.handlePointerMove).toBe(first.handlePointerMove);
  });
});
