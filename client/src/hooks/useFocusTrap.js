/**
 * `useFocusTrap(active, containerRef, { initialFocusRef })` moves focus into a container on open and
 * traps Tab and Shift+Tab inside it.
 */

import { createContext, useContext, useEffect, useRef } from 'react';
import { pointerFocusSuppressedElement } from '../lib/a11yKeyboard.js';

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
// The document receives Tab even when focus falls to <body>. Only the top
// trap handles it, after nested widgets have a chance to consume the key.
// Share the live stack across module re-evaluation, as with the Escape stack.
const trapsByDocument = (globalThis.__portos_focus_traps ??= new WeakMap());

// React ancestry keeps a nested dialog above its parent when both mount in the
// same commit, including when the child renders in a portal.
export const FocusTrapParent = createContext(null);

function getDocumentTraps(doc) {
  const existing = trapsByDocument.get(doc);
  if (existing) return existing;
  const stack = [];
  const onKeyDown = (event) => {
    if (event.key === 'Tab' && !event.defaultPrevented) stack.at(-1)?.onTab(event);
  };
  const state = { stack, onKeyDown };
  doc.addEventListener('keydown', onKeyDown);
  trapsByDocument.set(doc, state);
  return state;
}

// The selector drops disabled controls, hidden inputs, and tabindex="-1". It
// does NOT filter by layout geometry (offsetWidth/offsetParent) — those are
// always zero under jsdom, which would make the trap untestable — but it MUST
// still exclude CSS-hidden subtrees: a `display:none` panel (e.g. a retained
// but inactive tab panel in a tabbed Drawer) still matches querySelectorAll,
// so without this filter the trap's computed last element diverges from the
// browser's real tab order and Tab fails to wrap, letting focus escape.
const FOCUSABLE_SELECTOR = [
  'a[href]:not([tabindex="-1"])',
  'button:not([disabled]):not([tabindex="-1"])',
  'textarea:not([disabled]):not([tabindex="-1"])',
  'input:not([disabled]):not([type="hidden"]):not([tabindex="-1"])',
  'select:not([disabled]):not([tabindex="-1"])',
  'details > summary:first-of-type:not([tabindex="-1"])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

// Walk from the element up to (but not including) the container, treating it as
// untabbable if it or any ancestor along the way is removed from rendering via
// `display:none`, `visibility:hidden/collapse`, or the `hidden` attribute. Uses
// computed style (reflects inline styles under jsdom and stylesheet rules in the
// browser) rather than offset geometry so it works in both. The container itself
// is the open dialog and assumed visible, so the walk stops there.
function isTabbable(el, container) {
  // Fieldsets disable their form controls without adding a disabled attribute
  // to each descendant. Use native semantics (including the first-legend
  // exception), also covering disabled controls matched by [tabindex].
  if (el.matches(':disabled')) return false;
  for (let node = el; node && node !== container; node = node.parentElement) {
    if (node.nodeType !== 1) return false;
    if (node.hasAttribute('hidden')) return false;
    // Closed disclosures keep their descendants in the DOM and computed
    // styles, but only their summary participates in native keyboard focus.
    if (node.tagName === 'DETAILS' && !node.open) {
      const summary = Array.from(node.children).find(child => child.tagName === 'SUMMARY');
      if (!summary?.contains(el)) return false;
    }
    const style = typeof getComputedStyle === 'function' ? getComputedStyle(node) : null;
    if (style && (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse')) {
      return false;
    }
  }
  return true;
}

function getFocusable(container) {
  if (!container) return [];
  return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter((el) => isTabbable(el, container));
}

export default function useFocusTrap(active, containerRef, { initialFocusRef } = {}) {
  const parentRef = useContext(FocusTrapParent);
  // Capture the element to return focus to at the RENDER where `active` flips
  // true — before the dialog commits to the DOM and any child `autoFocus`
  // fires. Capturing in the effect below (which runs after commit) would grab
  // the modal's own auto-focused input instead of the control that opened it,
  // breaking restoration for autoFocus modals like ResumeAgentModal.
  const restoreRef = useRef(null);
  const wasActive = useRef(false);
  if (active && !wasActive.current) {
    const focused = typeof document !== 'undefined' ? document.activeElement : null;
    // Nothing focused means the opener may have been a control on a surface that
    // refuses pointer focus (`noPointerFocusSurfaceProps` — e.g. an OpenWorld HUD
    // button opening this very drawer). Fall back to it so closing still returns
    // the user to what they clicked instead of stranding focus on <body>.
    restoreRef.current = focused && focused !== document.body
      ? focused
      : (pointerFocusSuppressedElement() || focused);
  }
  wasActive.current = active;

  useEffect(() => {
    if (!active) return;
    const container = containerRef.current;
    if (!container) return;

    const doc = container.ownerDocument;
    const previouslyFocused = restoreRef.current;

    // An empty panel remains focusable if its controls disappear while open.
    const focusContainer = () => {
      container.setAttribute('tabindex', '-1');
      container.focus();
    };

    const focusInitial = () => {
      if (initialFocusRef?.current) {
        initialFocusRef.current.focus();
        return;
      }
      // Respect focus a child already claimed — React applies a child's
      // `autoFocus` during commit, before this passive effect runs, so if
      // focus is already inside the dialog leave it there rather than yanking
      // it to the first focusable (which would defeat the author's autoFocus).
      if (container.contains(doc.activeElement) && doc.activeElement !== container) {
        return;
      }
      const target = getFocusable(container)[0];
      if (target) {
        target.focus();
      } else {
        // Nothing focusable inside — make the container itself the focus target
        // so the reader/keyboard lands in the dialog rather than on the page.
        focusContainer();
      }
    };
    const onTab = (e) => {
      const activeEl = doc.activeElement;
      const outside = !container.contains(activeEl);
      if (outside && activeEl?.closest('[role="menu"], [role="tooltip"]')) return;
      const focusable = getFocusable(container);
      if (focusable.length === 0) {
        e.preventDefault();
        focusContainer();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      // A target we deliberately focused outside the tab order needs steering
      // too: an `initialFocusRef` aimed at a `tabIndex={-1}` element (or the
      // container's own fallback tabindex) sits inside the dialog but outside
      // `focusable`, and without this Shift+Tab from there fell through to the
      // browser and walked straight out of the modal.
      //
      // Only when it is absent from `focusable`: a tabbable initial input must
      // let forward Tab reach its next sibling and wrap only at the boundaries.
      //
      // Scoped to THAT element on purpose. Other unlisted-but-focusable
      // descendants — chiefly `<video controls>`, which the selector doesn't
      // match — must keep falling through, or Tab yanks focus off the video
      // instead of walking into its native controls.
      const steerTarget = initialFocusRef?.current || (container.getAttribute('tabindex') === '-1' ? container : null);
      const adrift = outside || (activeEl === steerTarget && !focusable.includes(steerTarget));
      if (!adrift && activeEl !== (e.shiftKey ? first : last)) return;
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    };

    const { stack, onKeyDown } = getDocumentTraps(doc);
    const trap = { container, parentRef, onTab };
    const childIndex = stack.findIndex(child => child.parentRef === containerRef || container.contains(child.container));
    if (childIndex < 0) {
      stack.push(trap);
      focusInitial();
    } else {
      stack.splice(childIndex, 0, trap);
    }
    return () => {
      stack.splice(stack.indexOf(trap), 1);
      if (stack.length === 0) {
        doc.removeEventListener('keydown', onKeyDown);
        trapsByDocument.delete(doc);
      }
      // Drop the fallback tabindex we may have added so the container doesn't
      // linger as a programmatic focus target after close.
      if (container.getAttribute('tabindex') === '-1') {
        container.removeAttribute('tabindex');
      }
      // Restore focus to the pre-open element so keyboard users return to where
      // they were. Guard: it may have been removed from the DOM while open.
      // <body> is not a real target (nothing was focused at open) — focusing it
      // would blur whatever the caller just moved focus to, e.g. a trigger.
      if (previouslyFocused && previouslyFocused !== doc.body && typeof previouslyFocused.focus === 'function') {
        previouslyFocused.focus();
      }
    };
  }, [active, containerRef, parentRef]);
}
