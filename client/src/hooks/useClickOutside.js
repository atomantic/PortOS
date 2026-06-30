import { useEffect, useRef } from 'react';

// Calls onOutside when a mousedown lands outside the ref'd element.
// Listener only attaches while `active` is true so closed menus don't pay
// the per-click cost.
//
// `onOutside` is read through a ref, so an inline arrow recreated every parent
// render (the common call-site shape) doesn't tear down + re-add the global
// mousedown listener on each render — only `active`/`ref` flip the subscription.
export default function useClickOutside(ref, active, onOutside) {
  const onOutsideRef = useRef(onOutside);
  onOutsideRef.current = onOutside;
  useEffect(() => {
    if (!active) return undefined;
    const onDown = (e) => {
      if (!ref.current?.contains(e.target)) onOutsideRef.current();
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [active, ref]);
}
