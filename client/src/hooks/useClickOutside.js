/**
 * Fire `onOutside` on mousedown outside a ref — or outside *every* ref in an array.
 *
 * Use when: Popovers, menus, drawers. Pass `[triggerRef, panelRef]` for a portaled panel, which is
 * outside the trigger's subtree.
 */

import { useEffect, useRef } from 'react';

// Calls onOutside when a mousedown lands outside the ref'd element(s); the listener attaches only while `active` so closed menus don't pay the per-click cost.
// `ref` is a single ref OR an array, firing only when the click missed every one: a portaled popover's panel renders into <body>, outside the trigger's DOM subtree, so a single-ref check would close it on a click on the panel itself (pass [triggerRef, panelRef]).
// `onOutside` is read through a ref, so an inline arrow recreated every parent render doesn't re-add the global mousedown listener; only `active`/`ref` flip the subscription.
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
