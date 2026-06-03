import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import usePopoverPosition from './usePopoverPosition.js';

// jsdom returns all-zero rects by default; stub measurements so the placement
// math has something to clamp/flip against. We model a viewport of 1000x800.
function stubViewport({ width = 1000, height = 800 } = {}) {
  vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(width);
  vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(height);
}

// Build a fake element with a fixed rect and a no-op style object so the hook's
// `el.style.width = …` write doesn't throw.
function fakeEl(rect) {
  return {
    style: {},
    getBoundingClientRect: () => rect,
    contains: () => false,
  };
}

describe('usePopoverPosition', () => {
  beforeEach(() => {
    stubViewport();
    // Run rAF callbacks synchronously so reflow assertions don't need timers.
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      cb();
      return 1;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null style while closed and never measures', () => {
    const { result } = renderHook(() => usePopoverPosition({ open: false }));
    expect(result.current.style).toBeNull();
  });

  it('measures on open and returns viewport-clamped { left, top, width }', () => {
    const { result } = renderHook(() => usePopoverPosition({ open: true, width: 288, gap: 8 }));
    // Wire trigger + popover refs to measurable fakes, then re-measure.
    act(() => {
      // Trigger sits mid-viewport; popover is 288x200.
      result.current.triggerRef.current = fakeEl({ top: 400, bottom: 430, left: 500, right: 600, height: 30 });
      result.current.popoverRef.current = fakeEl({ height: 200, width: 288 });
      result.current.reposition();
    });
    const { left, top, width } = result.current.style;
    expect(width).toBe('288px');
    // right-align to trigger.right (600) minus width (288) = 312.
    expect(left).toBe('312px');
    // position 'above' (default): trigger.top(400) - height(200) - gap(8) = 192.
    expect(top).toBe('192px');
  });

  it("flips below the trigger when 'above' would overflow the top edge", () => {
    const { result } = renderHook(() => usePopoverPosition({ open: true, width: 288, gap: 8, position: 'above' }));
    act(() => {
      // Trigger pinned near the top; a 200px popover above would overflow.
      result.current.triggerRef.current = fakeEl({ top: 20, bottom: 50, left: 500, right: 600, height: 30 });
      result.current.popoverRef.current = fakeEl({ height: 200, width: 288 });
      result.current.reposition();
    });
    // Flipped below: trigger.bottom(50) + gap(8) = 58.
    expect(result.current.style.top).toBe('58px');
  });

  it('clamps left to the viewport padding instead of going off-screen', () => {
    const { result } = renderHook(() => usePopoverPosition({ open: true, width: 288, gap: 8 }));
    act(() => {
      // Trigger near the left edge; right-align would push left negative.
      result.current.triggerRef.current = fakeEl({ top: 400, bottom: 430, left: 10, right: 60, height: 30 });
      result.current.popoverRef.current = fakeEl({ height: 200, width: 288 });
      result.current.reposition();
    });
    // left = max(60 - 288, 8) = 8 (VIEWPORT_PADDING).
    expect(result.current.style.left).toBe('8px');
  });

  it('shrinks width to fit a narrow viewport down to minWidth bound', () => {
    stubViewport({ width: 300, height: 800 });
    const { result } = renderHook(() => usePopoverPosition({ open: true, width: 288, minWidth: 180 }));
    act(() => {
      result.current.triggerRef.current = fakeEl({ top: 400, bottom: 430, left: 100, right: 200, height: 30 });
      result.current.popoverRef.current = fakeEl({ height: 200, width: 288 });
      result.current.reposition();
    });
    // min(288, max(180, 300 - 16)) = min(288, 284) = 284.
    expect(result.current.style.width).toBe('284px');
  });

  it('clears the style back to null when it closes', () => {
    const { result, rerender } = renderHook(
      ({ open }) => usePopoverPosition({ open, width: 288 }),
      { initialProps: { open: true } },
    );
    act(() => {
      result.current.triggerRef.current = fakeEl({ top: 400, bottom: 430, left: 500, right: 600, height: 30 });
      result.current.popoverRef.current = fakeEl({ height: 200, width: 288 });
      result.current.reposition();
    });
    expect(result.current.style).not.toBeNull();
    act(() => rerender({ open: false }));
    expect(result.current.style).toBeNull();
  });

  it('follows a parent-supplied anchorRef instead of its own trigger ref', () => {
    const anchorRef = { current: fakeEl({ top: 300, bottom: 330, left: 400, right: 500, height: 30 }) };
    const { result } = renderHook(() => usePopoverPosition({ open: true, width: 200, gap: 6, anchorRef }));
    act(() => {
      result.current.popoverRef.current = fakeEl({ height: 100, width: 200 });
      result.current.reposition();
    });
    // The hook surfaces the supplied anchor as triggerRef and places off it:
    expect(result.current.triggerRef).toBe(anchorRef);
    // left = max(500 - 200, 8) = 300; top (above) = 300 - 100 - 6 = 194.
    expect(result.current.style.left).toBe('300px');
    expect(result.current.style.top).toBe('194px');
  });

  it('re-measures synchronously when a contentDep changes', () => {
    const popover = fakeEl({ height: 200, width: 288 });
    const { result, rerender } = renderHook(
      ({ dep }) => usePopoverPosition({ open: true, width: 288, gap: 8, contentDeps: [dep] }),
      { initialProps: { dep: 'a' } },
    );
    act(() => {
      result.current.triggerRef.current = fakeEl({ top: 400, bottom: 430, left: 500, right: 600, height: 30 });
      result.current.popoverRef.current = popover;
      result.current.reposition();
    });
    // top = 400 - 200 - 8 = 192.
    expect(result.current.style.top).toBe('192px');
    // The rendered content grew taller; change the dep and let the hook's
    // layout effect re-measure off the new popover height (300).
    act(() => {
      popover.getBoundingClientRect = () => ({ height: 300, width: 288 });
      rerender({ dep: 'b' });
    });
    // top = 400 - 300 - 8 = 92.
    expect(result.current.style.top).toBe('92px');
  });

  it('re-measures on window resize while open', () => {
    const { result } = renderHook(() => usePopoverPosition({ open: true, width: 288, gap: 8 }));
    act(() => {
      result.current.triggerRef.current = fakeEl({ top: 400, bottom: 430, left: 500, right: 600, height: 30 });
      result.current.popoverRef.current = fakeEl({ height: 200, width: 288 });
    });
    // Move the trigger near the top, then fire resize — the listener re-reads
    // the rect, sees 'above' would overflow (100 - 200 - 8 = -108), and flips
    // below: trigger.bottom(130) + gap(8) = 138.
    act(() => {
      result.current.triggerRef.current = fakeEl({ top: 100, bottom: 130, left: 500, right: 600, height: 30 });
      window.dispatchEvent(new Event('resize'));
    });
    expect(result.current.style.top).toBe('138px');
  });
});
