import { useEffect } from 'react';

// Keyboard focus management for modal surfaces (dialogs, drawers, lightboxes).
// When `active` flips true it:
//   1. remembers the element that had focus (to restore on close),
//   2. moves focus into the container — an explicit `initialFocusRef` if given,
//      else the first focusable descendant, else the container itself,
//   3. traps Tab / Shift+Tab so focus wraps at the edges and can't escape to
//      the page behind the modal (WCAG 2.4.3 / 2.1.2), and
//   4. on deactivate/unmount, returns focus to where it was before the modal
//      opened.
//
// The Tab listener is bound to the container (not `document`) so nested/stacked
// modals don't fight: an inner dialog's Tab bubbles to its own container first,
// and the outer container's handler is a no-op while focus sits inside the
// inner one. Modal owns the Esc stack separately (see ui/Modal.jsx); this hook
// only concerns focus.

// Visibility is intentionally NOT filtered by layout geometry
// (offsetWidth/offsetParent) — those are always zero under jsdom, which would
// make the trap untestable. The selector already drops disabled controls,
// hidden inputs, and tabindex="-1"; that is sufficient for the modal surfaces
// this hook guards.
const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

function getFocusable(container) {
  if (!container) return [];
  return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR));
}

export default function useFocusTrap(active, containerRef, { initialFocusRef } = {}) {
  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    const previouslyFocused = document.activeElement;

    const focusInitial = () => {
      const target = initialFocusRef?.current || getFocusable(container)[0];
      if (target) {
        target.focus();
      } else {
        // Nothing focusable inside — make the container itself the focus target
        // so the reader/keyboard lands in the dialog rather than on the page.
        container.setAttribute('tabindex', '-1');
        container.focus();
      }
    };
    focusInitial();

    const onKeyDown = (e) => {
      if (e.key !== 'Tab') return;
      const focusable = getFocusable(container);
      if (focusable.length === 0) {
        e.preventDefault();
        container.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeEl = document.activeElement;
      if (e.shiftKey) {
        if (activeEl === first || !container.contains(activeEl)) {
          e.preventDefault();
          last.focus();
        }
      } else if (activeEl === last || !container.contains(activeEl)) {
        e.preventDefault();
        first.focus();
      }
    };

    container.addEventListener('keydown', onKeyDown);
    return () => {
      container.removeEventListener('keydown', onKeyDown);
      // Restore focus to the pre-open element so keyboard users return to where
      // they were. Guard: it may have been removed from the DOM while open.
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
        previouslyFocused.focus();
      }
    };
  }, [active, containerRef]);
}
