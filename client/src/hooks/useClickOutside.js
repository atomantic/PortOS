import { useEffect } from 'react';

// Calls onOutside when a mousedown lands outside the ref'd element.
// Listener only attaches while `active` is true so closed menus don't pay
// the per-click cost.
export default function useClickOutside(ref, active, onOutside) {
  useEffect(() => {
    if (!active) return;
    const onDown = (e) => {
      if (!ref.current?.contains(e.target)) onOutside();
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [active, ref, onOutside]);
}
