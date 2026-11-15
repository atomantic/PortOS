/**
 * Body-scroll lock with ref-count.
 *
 * Use when: Modals, drawers, lightboxes.
 */

import { useEffect } from 'react';

let lockCount = 0;
let savedOverflow = '';

export function useScrollLock(active) {
  useEffect(() => {
    if (!active) return;
    if (lockCount === 0) savedOverflow = document.body.style.overflow;
    lockCount++;
    document.body.style.overflow = 'hidden';
    return () => {
      lockCount--;
      if (lockCount === 0) document.body.style.overflow = savedOverflow;
    };
  }, [active]);
}
