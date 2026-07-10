import { useEffect, useRef } from 'react';

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
  // Capture the element to return focus to at the RENDER where `active` flips
  // true — before the dialog commits to the DOM and any child `autoFocus`
  // fires. Capturing in the effect below (which runs after commit) would grab
  // the modal's own auto-focused input instead of the control that opened it,
  // breaking restoration for autoFocus modals like ResumeAgentModal.
  const restoreRef = useRef(null);
  const wasActive = useRef(false);
  if (active && !wasActive.current) {
    restoreRef.current = typeof document !== 'undefined' ? document.activeElement : null;
  }
  wasActive.current = active;

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    const previouslyFocused = restoreRef.current;

    const focusInitial = () => {
      if (initialFocusRef?.current) {
        initialFocusRef.current.focus();
        return;
      }
      // Respect focus a child already claimed — React applies a child's
      // `autoFocus` during commit, before this passive effect runs, so if
      // focus is already inside the dialog leave it there rather than yanking
      // it to the first focusable (which would defeat the author's autoFocus).
      if (container.contains(document.activeElement) && document.activeElement !== container) {
        return;
      }
      const target = getFocusable(container)[0];
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
      if (e.key !== 'Tab' || e.defaultPrevented) return;
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
      // Drop the fallback tabindex we may have added so the container doesn't
      // linger as a programmatic focus target after close.
      if (container.getAttribute('tabindex') === '-1') {
        container.removeAttribute('tabindex');
      }
      // Restore focus to the pre-open element so keyboard users return to where
      // they were. Guard: it may have been removed from the DOM while open.
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
        previouslyFocused.focus();
      }
    };
  }, [active, containerRef]);
}
