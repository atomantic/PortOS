/**
 * Shared modal chrome — backdrop + Esc handling + click-outside.
 *
 * Replaces ~10 hand-rolled variants of `fixed inset-0 z-50 bg-black/70 flex
 * items-center justify-center p-4` scattered across the app. The wrapped
 * component owns its own header / footer / form chrome; Modal only owns the
 * outer backdrop and the dialog panel container — so each conversion is 1:1
 * with the existing markup (no visual regressions, no header reshuffling).
 *
 * Sizing presets mirror the panels before extraction:
 *   sm     max-w-md
 *   md     max-w-lg   (default)
 *   lg     max-w-2xl
 *   xl     max-w-3xl
 *   '2xl'  max-w-4xl
 *   '3xl'  max-w-6xl
 *   none   no width clamp (caller owns sizing via panelClassName)
 *
 * Divergent call-site behavior is opt-in via flags:
 *   closeOnBackdrop=false   EditAppModal / MemoryEditModal / ResumeAgentModal
 *                           — long forms where an accidental click on the
 *                           overlay would lose typed state.
 *   closeOnEsc=false        Flux2InstallModal — never wired Esc pre-refactor.
 *                           Modal still registers in the Esc stack as the
 *                           top-most layer so Esc is blocked (no fallthrough
 *                           to underlying modals); it just doesn't dispatch
 *                           a close.
 *   onEsc                   Caller-supplied Esc handler. When provided, Esc
 *                           on the top-most modal invokes `onEsc` instead of
 *                           `onClose`. Used by LayoutEditor (Esc cancels an
 *                           inline rename/delete mode without closing the
 *                           editor) and KeyboardHelp (defers to its own
 *                           toggle hook).
 *   align='top'             LayoutEditor / KeyboardHelp / Flux2InstallModal.
 *   usePortal               LayoutEditor / KeyboardHelp — escape any
 *                           stacking-context ancestors.
 *
 * Stacking: Modal uses a single module-scope bubble-phase `keydown`
 * listener that dispatches Esc only to the top-most open Modal — and only
 * the top-most. Every open Modal registers on the stack (regardless of its
 * Esc opt-in), so a closeOnEsc=false top-most layer still blocks the
 * keystroke from reaching the modal beneath it. Inner widgets that consume
 * Esc themselves (native <select> closing a dropdown, custom popovers) can
 * call event.preventDefault() — Modal honours `defaultPrevented` and skips
 * the close in that case.
 */

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

const SIZE_CLASSES = {
  sm: 'max-w-md',
  md: 'max-w-lg',
  lg: 'max-w-2xl',
  xl: 'max-w-3xl',
  '2xl': 'max-w-4xl',
  '3xl': 'max-w-6xl',
  none: '',
};

// Per-align flex + padding. Centre uses `p-4` so the panel doesn't touch the
// viewport edge on mobile; callers that need an edge-to-edge layout (e.g. a
// modal that supplies its own padding internally) should pass align='none'.
// `backdropClassName` is appended last in the class string; actual Tailwind
// utility precedence is decided by CSS source order, not class-attribute
// order — see the note next to the overlay <div> below.
const ALIGN_CLASSES = {
  center: 'items-center justify-center p-4',
  top: 'items-start justify-center pt-[10vh] px-4 pb-4',
  // No padding — for callers that historically had a bare overlay (no `p-*`)
  // and provide their own panel-internal padding instead. Used by
  // ResumeAgentModal where the pre-refactor overlay was
  // `fixed inset-0 ... flex items-center justify-center` with no padding.
  none: 'items-center justify-center',
};

// Module-scope stack of open Modal ids. A single bubble-phase keydown
// listener on `window` dispatches Esc only to the top-most modal — every
// other Modal listener (including the layer beneath this one) is blocked via
// stopImmediatePropagation after dispatch.
//
// Bubble phase, not capture: an inner widget that wants to own Esc (native
// <select> closing its dropdown, custom popover dismissing itself) gets the
// event first and can call event.preventDefault(). We honour
// `event.defaultPrevented` and skip the close in that case, so opening a
// <select> inside a modal and pressing Esc closes the menu instead of the
// whole modal.
//
// Modals register on the stack regardless of whether they opt in to Esc, so
// a non-dismissible top-most layer still absorbs the keystroke and prevents
// fallthrough to the modal beneath it.
//
// IMPORTANT: the listener is registered at module load (not lazily on first
// modal open) so it runs before any window keydown handler that mounts after
// this module is imported (MediaLightbox, VoiceWidget, CityFilterBar, etc.).
// `stopImmediatePropagation` only blocks listeners registered after this
// one on the same target, so install-order matters. Modal is imported very
// early by App.jsx via the layout shell, which gives us reliable precedence
// over component-level listeners that mount only when their pages open.
const modalStack = [];
const escHandlers = new Map();
let modalIdSeq = 0;

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || modalStack.length === 0) return;
    // Always swallow the keystroke at this layer so it can't reach window-
    // level handlers behind us (MediaLightbox, voice-widget capture, etc.).
    // Whether we also dispatch the close handler depends on
    // `defaultPrevented`: if a child widget already consumed Esc (focused
    // <select> closing its dropdown, custom menu calling preventDefault()),
    // skip the close — but the keystroke is still ours to absorb.
    e.stopImmediatePropagation();
    if (e.defaultPrevented) return;
    const top = modalStack[modalStack.length - 1];
    const handler = escHandlers.get(top);
    if (handler) handler();
  });
}

function pushModal(id) {
  modalStack.push(id);
}

function popModal(id) {
  const idx = modalStack.lastIndexOf(id);
  if (idx >= 0) modalStack.splice(idx, 1);
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
}) {
  const backdropRef = useRef(null);
  const idRef = useRef(null);
  if (idRef.current === null) idRef.current = ++modalIdSeq;
  // Latest handler refs — kept fresh on every render without re-running the
  // stack-registration effect. This decouples handler identity (which
  // changes every render when callers use inline arrow functions, e.g.
  // DeployPanel during streaming output) from stack push/pop, which must
  // only happen when `open` toggles. Otherwise an unrelated render of one
  // modal would pop+re-push it and accidentally move it above another
  // modal that opened later.
  const onCloseRef = useRef(onClose);
  const onEscRef = useRef(onEsc);
  const closeOnEscRef = useRef(closeOnEsc);
  onCloseRef.current = onClose;
  onEscRef.current = onEsc;
  closeOnEscRef.current = closeOnEsc;

  // Push/pop only on open toggle + unmount. Handler indirection through
  // refs lets us absorb prop changes (new onClose / onEsc / closeOnEsc)
  // without touching the stack. The dispatched handler is one of:
  //   - onEsc, if provided (caller wants custom Esc semantics — e.g.
  //     LayoutEditor cancels an inline mode instead of closing).
  //   - onClose, if closeOnEsc is true (the common case).
  //   - undefined → no dispatch, but Esc is still swallowed at this layer
  //     so it can't fall through to an underlying modal.
  useEffect(() => {
    if (!open) return;
    const id = idRef.current;
    escHandlers.set(id, () => {
      if (onEscRef.current) { onEscRef.current(); return; }
      if (closeOnEscRef.current) onCloseRef.current?.();
    });
    pushModal(id);
    return () => {
      escHandlers.delete(id);
      popModal(id);
    };
  }, [open]);

  if (!open) return null;

  // Always stop propagation when the click lands on the backdrop element so a
  // backdrop click on this modal cannot bubble up to an ancestor modal /
  // lightbox / overlay handler and accidentally dismiss *that* layer. We do
  // this even when `closeOnBackdrop` is false — non-dismissible modals must
  // still swallow their own backdrop clicks.
  const handleBackdropClick = (e) => {
    if (e.target !== backdropRef.current) return;
    e.stopPropagation();
    if (!closeOnBackdrop) return;
    onClose?.();
  };

  const alignClass = ALIGN_CLASSES[align] || ALIGN_CLASSES.center;
  const sizeClass = SIZE_CLASSES[size] ?? SIZE_CLASSES.md;
  const widthClass = size === 'none' ? '' : `w-full ${sizeClass}`;

  const overlay = (
    <div
      ref={backdropRef}
      // `backdropClassName` (caller override) is appended last so callers can
      // visually see their override at the end of the class string. NOTE:
      // Tailwind utility precedence is decided by CSS source order in the
      // generated stylesheet, NOT class-attribute order, so two same-property
      // utilities like `p-4` and `p-0` resolve by which one Tailwind emits
      // later — typically the higher-numbered preset. To reliably beat a
      // default like `p-4`, callers should use a more specific override:
      // arbitrary values (`p-[0px]`), `!important` (`!p-0`), or a different
      // align variant. The string-order convention here is documentation of
      // intent, not an enforcement mechanism.
      className={`fixed inset-0 ${zIndexClassName} flex ${alignClass} ${backdropClassName}`}
      onClick={handleBackdropClick}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={ariaLabelledBy}
        aria-label={!ariaLabelledBy ? ariaLabel : undefined}
        className={`relative ${widthClass} ${panelClassName}`}
        // Swallow click bubbling at the panel boundary. Two reasons: (1)
        // target-check on the backdrop already prevents panel clicks from
        // firing our own backdrop dismiss, but if this Modal is rendered as
        // a child of another modal/portal whose ancestor div has a bubble-
        // listening onClick (e.g. MediaLightbox's `onClick={onClose}`), the
        // child click would still propagate and dismiss the parent. (2) it
        // matches the original hand-rolled modals' behavior so the refactor
        // stays 1:1.
        onClick={(e) => e.stopPropagation()}
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
