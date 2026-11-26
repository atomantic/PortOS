/**
 * Shared modal chrome — backdrop + Esc handling + click-outside.
 *
 * The wrapped component owns its own header / footer / form chrome; Modal only
 * owns the outer backdrop and the dialog panel container.
 *
 * Sizing presets: sm max-w-md, md max-w-lg (default), lg max-w-2xl, xl max-w-3xl,
 * '2xl' max-w-4xl, '3xl' max-w-6xl, none (caller owns sizing via panelClassName).
 *
 * Opt-in flags:
 *   closeOnBackdrop=false   long forms where an accidental overlay click would
 *                           lose typed state.
 *   closeOnEsc=false        Modal still registers in the Esc stack as the
 *                           top-most layer so Esc is blocked (no fallthrough to
 *                           underlying modals); it just doesn't dispatch a close.
 *   onEsc                   Esc on the top-most modal invokes `onEsc` instead of
 *                           `onClose` (e.g. cancel an inline mode without
 *                           closing the editor).
 *   align='top'             top-anchored panel.
 *   usePortal               escape stacking-context ancestors.
 *
 * Height: the panel is clamped to the *visible* viewport by Modal itself —
 * `max-h-dvh-cap` (index.css) minus a per-align `--dvh-inset`. Call sites must
 * NOT pass their own `max-h-[NNvh]` in `panelClassName`, nor on a content card
 * wrapping their children (put the card classes on `panelClassName`): the
 * overlay is `fixed inset-0` (the small viewport on iOS Safari) and centres with
 * `items-center`, so a panel taller than the overlay has its overflow split
 * top and bottom, pushing the title AND the Save/Cancel footer off-screen. The
 * clamp lives in the primitive so no call site has to remember it
 * (`client/src/AGENTS.md`); `client/src/test/guards/ui/tailwindClassConventions.test.js` fails the build if the
 * per-caller idiom returns. A caller wanting a *shorter* panel sets the cap, not
 * a raw vh: `panelClassName="… [--dvh-cap:60dvh]"`. Modal also supplies
 * `overflow-auto` unless `panelClassName` already declares an overflow utility;
 * a panel that needs an un-portaled popover to escape its bounds declares
 * `overflow-visible` and keeps the clamp.
 *
 * Stacking: one module-scope bubble-phase `keydown` listener dispatches Esc only
 * to the top-most open layer. Every open Modal registers on the stack (whatever
 * its Esc opt-in), so a closeOnEsc=false top-most layer still blocks the
 * keystroke. Inner widgets that consume Esc themselves (native <select>, custom
 * popovers) call event.preventDefault(); Modal honours `defaultPrevented` and
 * skips the close. The stack is shared with `Drawer` through `useEscLayer`, so
 * layers close innermost-first.
 */

import { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';
import useFocusTrap from '../../hooks/useFocusTrap.js';

const SIZE_CLASSES = {
  sm: 'max-w-md',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-3xl',
  '2xl': 'max-w-4xl',
  '3xl': 'max-w-6xl',
  none: '',
};

// Centre uses `p-4` so the panel doesn't touch the viewport edge on mobile;
// align='none' is for modals that supply their own padding. `backdropClassName`
// is appended last, but Tailwind precedence is CSS source order (see the overlay
// note below).
const ALIGN_CLASSES = {
  center: 'items-center justify-center p-4',
  top: 'items-start justify-center pt-[10dvh] px-4 pb-4',
  // No padding — for callers whose panel supplies its own.
  none: 'items-center justify-center',
};

// Per-align `--dvh-inset` for the panel's `max-h-dvh-cap` clamp: the vertical
// space the overlay's own padding already consumes (center p-4 → 2rem; top
// pt-[10dvh] + pb-4 → 10dvh + 1rem; none → 0). Literal class strings so
// Tailwind's scanner emits the arbitrary-property utilities.
const ALIGN_DVH_INSET = {
  center: '[--dvh-inset:2rem]',
  top: '[--dvh-inset:calc(10dvh_+_1rem)]',
  none: '[--dvh-inset:0px]',
};

// Module-scope stack of open Modal ids. A single bubble-phase keydown listener
// on `window` dispatches Esc only to the top-most modal.
//
// Bubble phase, not capture: an inner widget that wants to own Esc (native
// <select> closing its dropdown, custom popover) gets the event first and calls
// preventDefault(); we skip the close then, so Esc closes the menu, not the modal.
//
// The listener installs at module load so it runs before any window keydown
// handler that mounts later (`stopImmediatePropagation` only blocks listeners
// registered after it on the same target). A handler registered earlier at
// module load is not blocked.
//
// The listener guard AND its dispatch state live in one global record: Vite HMR
// and Vitest isolation can re-evaluate this module while keeping the same DOM
// globals, and a boolean-only guard would leave the old listener pointing at
// its module-local stack while new Modal instances push onto a fresh one,
// orphaning Escape dispatch.
const MODAL_ESC_STATE_KEY = '__portos_modal_esc_state';
const modalEscState = globalThis[MODAL_ESC_STATE_KEY] ?? {
  stack: [],
  handlers: new Map(),
  listener: null,
  windowTarget: null,
  documentTarget: null,
};
globalThis[MODAL_ESC_STATE_KEY] = modalEscState;

const modalStack = modalEscState.stack;
const escHandlers = modalEscState.handlers;

function handleGlobalEsc(e) {
  if (e.key !== 'Escape' || modalStack.length === 0) return;
  // Always swallow the keystroke so it can't reach window-level handlers behind
  // us (MediaLightbox, voice-widget capture). Dispatch the close only when no
  // child widget already consumed Esc via `defaultPrevented`.
  e.stopImmediatePropagation();
  if (e.defaultPrevented) return;
  const top = modalStack[modalStack.length - 1];
  const handler = escHandlers.get(top);
  if (handler) handler();
}

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  // Install on both window AND document: a document-level handler from another
  // component (useKeyboardHelp, AddToCollectionMenu's click-away) fires before a
  // window listener and could dismiss the wrong layer, so we own the keystroke at
  // both phases. Reuse the listener on re-evaluation against the same DOM; if the
  // DOM targets changed (isolated test environments), detach from the old ones
  // and reset their stale stack first.
  const sameTargets = modalEscState.windowTarget === window
    && modalEscState.documentTarget === document;
  if (!sameTargets && modalEscState.listener) {
    modalEscState.windowTarget?.removeEventListener('keydown', modalEscState.listener);
    modalEscState.documentTarget?.removeEventListener('keydown', modalEscState.listener);
    modalStack.length = 0;
    escHandlers.clear();
    modalEscState.listener = null;
  }
  if (!modalEscState.listener) {
    window.addEventListener('keydown', handleGlobalEsc);
    document.addEventListener('keydown', handleGlobalEsc);
    modalEscState.listener = handleGlobalEsc;
    modalEscState.windowTarget = window;
    modalEscState.documentTarget = document;
  }
  // On HMR dispose, tear down both listeners; shared modal state is retained.
  if (import.meta.hot) {
    import.meta.hot.dispose(() => {
      if (modalEscState.listener !== handleGlobalEsc) return;
      modalEscState.windowTarget?.removeEventListener('keydown', handleGlobalEsc);
      modalEscState.documentTarget?.removeEventListener('keydown', handleGlobalEsc);
      modalEscState.listener = null;
      modalEscState.windowTarget = null;
      modalEscState.documentTarget = null;
    });
  }
}

function pushModal(id) {
  modalStack.push(id);
}

function popModal(id) {
  const idx = modalStack.lastIndexOf(id);
  if (idx >= 0) modalStack.splice(idx, 1);
}

/**
 * Register an open overlay on the shared Esc stack so nested layered surfaces
 * (Modal, Drawer) close innermost-first and an inner widget's `preventDefault()`
 * on Esc is honoured uniformly.
 *
 * `onEsc` is read through a ref: handler identity may change every render, but
 * the push/pop must only happen when `open` toggles, or an unrelated render
 * would re-push a layer above one that opened later. Pass a handler that does
 * nothing when the surface opts out of Esc dismissal — the layer still registers
 * and absorbs the keystroke.
 */
export function useEscLayer(open, onEsc) {
  const layerId = useId();
  const onEscRef = useRef(onEsc);
  onEscRef.current = onEsc;
  useEffect(() => {
    if (!open) return;
    const id = layerId;
    escHandlers.set(id, () => onEscRef.current?.());
    pushModal(id);
    return () => {
      escHandlers.delete(id);
      popModal(id);
    };
  }, [open, layerId]);
}

export default function Modal({
  open,
  onClose,
  onEsc,
  children,
  size = 'md',
  closeOnBackdrop = true,
  closeOnEsc = true,
  align = 'center',
  usePortal = false,
  zIndexClassName = 'z-50',
  backdropClassName = 'bg-black/70',
  panelClassName = '',
  ariaLabelledBy,
  ariaLabel,
  initialFocusRef,
}) {
  const backdropRef = useRef(null);
  const dialogRef = useRef(null);
  // Trap focus inside the dialog while open and restore it to the opener
  // (WCAG 2.4.3 / 2.1.2). Focus otherwise lands on the first focusable
  // descendant — usually a header Close button; pass `initialFocusRef` to aim it.
  useFocusTrap(open, dialogRef, { initialFocusRef });
  // Dispatch onEsc if provided, else onClose when closeOnEsc; otherwise nothing,
  // but Esc is still swallowed so it can't fall through to a modal beneath.
  useEscLayer(open, () => {
    if (onEsc) { onEsc(); return; }
    if (closeOnEsc) onClose?.();
  });

  if (!open) return null;

  // Always stop propagation on a backdrop click (even when `closeOnBackdrop` is
  // false) so it cannot bubble to an ancestor modal/lightbox and dismiss that layer.
  const handleBackdropClick = (e) => {
    if (e.target !== backdropRef.current) return;
    e.stopPropagation();
    if (!closeOnBackdrop) return;
    onClose?.();
  };

  const alignClass = ALIGN_CLASSES[align] || ALIGN_CLASSES.center;
  const sizeClass = SIZE_CLASSES[size] ?? SIZE_CLASSES.md;
  const widthClass = size === 'none' ? '' : `w-full ${sizeClass}`;
  const insetClass = ALIGN_DVH_INSET[align] || ALIGN_DVH_INSET.center;
  // Supply scroll behaviour only when the caller declares no UNPREFIXED overflow
  // of its own: Tailwind precedence follows CSS source order, so emitting
  // `overflow-auto` beside a base `overflow-hidden` would be a coin flip. A
  // variant-prefixed utility (`sm:overflow-hidden`) is deliberately NOT a match;
  // suppressing the default would leave the panel unscrollable below that breakpoint.
  const overflowClass = /(^|\s)!?overflow-/.test(panelClassName) ? '' : 'overflow-auto';
  const heightClass = `max-h-dvh-cap ${insetClass} ${overflowClass}`;

  const overlay = (
    <div
      ref={backdropRef}
      // `backdropClassName` is appended last, but Tailwind precedence is CSS source
      // order, not class order, so two same-property utilities (`p-4` vs `p-0`)
      // resolve by which Tailwind emits later. To reliably beat a default, use an
      // arbitrary value (`p-[0px]`), `!important` (`!p-0`) or a different align.
      className={`fixed inset-0 ${zIndexClassName} flex ${alignClass} ${backdropClassName}`}
      onClick={handleBackdropClick}
      role="presentation"
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={ariaLabelledBy}
        aria-label={!ariaLabelledBy ? ariaLabel : undefined}
        className={`relative ${widthClass} ${heightClass} ${panelClassName}`}
        // Swallow click bubbling at the panel boundary: when this Modal renders
        // inside another modal/portal whose ancestor has a bubble-listening onClick
        // (e.g. MediaLightbox's `onClick={onClose}`), the click would dismiss the parent.
        onClick={(e) => e.stopPropagation()}
        // Same swallow, minus Escape: `handleGlobalEsc` is a native `document`
        // listener owning stack-aware precedence, and stopPropagation here would
        // keep Escape from reaching it.
        onKeyDown={(e) => { if (e.key !== 'Escape') e.stopPropagation(); }}
      >
        {children}
      </div>
    </div>
  );

  if (usePortal && typeof document !== 'undefined') {
    return createPortal(overlay, document.body);
  }
  return overlay;
}
