import { useEffect, useRef } from 'react';

// Calls onOutside when a mousedown lands outside the ref'd element(s).
// Listener only attaches while `active` is true so closed menus don't pay
// the per-click cost.
//
// `ref` accepts a single ref OR an array of refs, and fires only when the click
// missed every one of them. The array form is what a portaled popover needs: its
// panel renders into <body>, so it is NOT inside the trigger's DOM subtree and a
// single-ref containment check would treat every click on the panel itself as an
// outside click and close it. Pass [triggerRef, panelRef] instead of hand-rolling
// the two-ref effect.
//
// `onOutside` is read through a ref, so an inline arrow recreated every parent
// render (the common call-site shape) doesn't tear down + re-add the global
// mousedown listener on each render — only `active`/`ref` flip the subscription.
export default function useClickOutside(ref, active, onOutside) {
  const onOutsideRef = useRef(onOutside);
  onOutsideRef.current = onOutside;
  // Depend on the array's *contents*, not its identity — an inline
  // `[triggerRef, panelRef]` literal is a new array every render and would
  // otherwise resubscribe the global listener on each one.
  const refs = Array.isArray(ref) ? ref : [ref];
  const refsKey = refs;
  useEffect(() => {
    if (!active) return undefined;
    const onDown = (e) => {
      if (refsKey.some((r) => r.current?.contains(e.target))) return;
      onOutsideRef.current();
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
    // Dependency list is intentionally partial.
  }, [active, ...refsKey]);
}
