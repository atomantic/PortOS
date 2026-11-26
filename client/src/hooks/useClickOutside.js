/**
 * Dismiss on a mousedown outside every supplied ref. Use `event: 'click'`
 * when dismissal needs to restore focus after the pointer's default focus change.
 *
 * Use when: Popovers, menus, drawers. Pass `[triggerRef, panelRef]` when the
 * panel is outside the trigger's DOM subtree.
 */

import { useEffect, useRef } from 'react';

export default function useClickOutside(ref, active, onOutside, { event = 'mousedown' } = {}) {
  // Keep the listener subscribed while inline callbacks change on render.
  const onOutsideRef = useRef(onOutside);
  onOutsideRef.current = onOutside;
  // Depend on the array's *contents*, not its identity — an inline
  // `[triggerRef, panelRef]` literal is a new array every render and would
  // otherwise resubscribe the global listener on each one.
  const refs = Array.isArray(ref) ? ref : [ref];
  useEffect(() => {
    if (!active) return undefined;
    const onEvent = (e) => {
      if (refs.some((r) => r.current?.contains(e.target))) return;
      onOutsideRef.current();
    };
    window.addEventListener(event, onEvent);
    return () => window.removeEventListener(event, onEvent);
    // Dependency list is intentionally partial.
  }, [active, event, ...refs]);
}
