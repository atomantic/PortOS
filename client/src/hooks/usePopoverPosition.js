import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

// usePopoverPosition — shared fixed-position placement for portal popovers
// anchored to a trigger element.
//
// Both ThemeSwitcher and CollectionPickerShell (and any future surface that
// portals a menu into <body>) compute the same thing: a viewport-clamped
// { left, top, width } for a fixed-position card that sits above-or-below a
// trigger, re-measured on open and re-flowed (rAF-coalesced) on scroll/resize.
// This hook owns that plumbing so callers only wire two refs and render the
// returned style.
//
// Contract:
//   const { triggerRef, popoverRef, style, reposition } = usePopoverPosition({ open, ... });
//   - triggerRef → the anchor element (button) whose rect the popover follows.
//     Attach this to your trigger. If the trigger lives in a parent and you
//     already hold a ref to it, pass it as `anchorRef` and the hook follows
//     that one instead (the returned `triggerRef` then mirrors it).
//   - popoverRef → the fixed-position portal element being placed.
//   - style → { left, top, width } strings while measured, or `null` before the
//     first measurement (render with `visibility: hidden` until non-null so the
//     popover never flashes at the top-left corner pre-measure).
//   - reposition → force a re-measure (e.g. after the popover's content height
//     changes from filtering/search) without waiting for a scroll/resize event.
//
// `contentDeps` is a dependency array of values whose change alters the
// popover's rendered height (search query, filtered list, load state). The
// hook re-measures synchronously (in useLayoutEffect, before paint) whenever
// any of them change, so a content-height change can't paint one frame at the
// stale position before correcting.
//
// Placement: `position: 'above'` prefers opening above the trigger and flips
// below only when there isn't room above; `'below'` does the inverse. Both
// clamp into the viewport with VIEWPORT_PADDING on every edge.
//
// The reflow listener uses capture-phase scroll so scrolling ANY ancestor
// (not just window) keeps the popover attached to its trigger, and coalesces
// bursts through requestAnimationFrame so a fast scrollwheel can't queue dozens
// of layout reads per frame. The setter short-circuits on an unchanged
// { left, top, width } so a capture-phase scroll that doesn't move the trigger
// doesn't re-render every pixel.

const VIEWPORT_PADDING = 8;

export default function usePopoverPosition({
  open,
  width = 288,
  minWidth = 180,
  gap = 8,
  position = 'above',
  anchorRef = null,
  contentDeps = [],
} = {}) {
  const ownTriggerRef = useRef(null);
  // Follow a parent-owned anchor when one is supplied; otherwise place this
  // hook's own ref on the trigger.
  const triggerRef = anchorRef ?? ownTriggerRef;
  const popoverRef = useRef(null);
  const [style, setStyle] = useState(null);

  const reposition = useCallback(() => {
    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (!trigger || !popover) return;

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const w = Math.min(width, Math.max(minWidth, viewportWidth - VIEWPORT_PADDING * 2));

    // Apply width before measuring height — narrow viewports may wrap content
    // and grow the popover's height. Measuring at the wrong width produces a
    // top value that under-clamps and lets the portal overflow.
    popover.style.width = `${w}px`;

    const triggerRect = trigger.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();

    const maxLeft = viewportWidth - w - VIEWPORT_PADDING;
    const left = Math.min(
      Math.max(triggerRect.right - w, VIEWPORT_PADDING),
      Math.max(VIEWPORT_PADDING, maxLeft),
    );

    const aboveTop = triggerRect.top - popoverRect.height - gap;
    const belowTop = triggerRect.bottom + gap;
    const wouldOverflowTop = aboveTop < VIEWPORT_PADDING;
    const wouldOverflowBottom = belowTop + popoverRect.height > viewportHeight - VIEWPORT_PADDING;

    let top = position === 'above'
      ? (wouldOverflowTop ? belowTop : aboveTop)
      : (wouldOverflowBottom ? aboveTop : belowTop);

    const maxTop = Math.max(VIEWPORT_PADDING, viewportHeight - popoverRect.height - VIEWPORT_PADDING);
    top = Math.min(Math.max(top, VIEWPORT_PADDING), maxTop);

    setStyle((prev) => {
      const next = { left: `${left}px`, top: `${top}px`, width: `${w}px` };
      if (prev && prev.left === next.left && prev.top === next.top && prev.width === next.width) {
        return prev;
      }
      return next;
    });
  }, [triggerRef, width, minWidth, gap, position]);

  // Measure synchronously on open (and on any content-height change) so the
  // popover paints in place; clear on close so the next open re-measures (and
  // renders hidden until it does). The content-change re-measure stays in
  // useLayoutEffect — moving it to useEffect would paint one frame at the stale
  // height before correcting when the rendered content grows/shrinks.
  useLayoutEffect(() => {
    if (!open) {
      setStyle(null);
      return;
    }
    reposition();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, reposition, ...contentDeps]);

  useEffect(() => {
    if (!open) return undefined;
    let rafId = null;
    const onReflow = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        reposition();
      });
    };
    window.addEventListener('resize', onReflow);
    window.addEventListener('scroll', onReflow, true);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      window.removeEventListener('resize', onReflow);
      window.removeEventListener('scroll', onReflow, true);
    };
  }, [open, reposition]);

  return { triggerRef, popoverRef, style, reposition };
}

export { VIEWPORT_PADDING };
