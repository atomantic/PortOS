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
 * Stacking: Modal uses a single module-scope `keydown` capture-phase
 * listener that dispatches Esc only to the top-most open Modal — and only
 * the top-most. Every open Modal registers on the stack (regardless of its
 * Esc opt-in), so a closeOnEsc=false top-most layer still blocks the
 * keystroke from reaching the modal beneath it.
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

// Per-align flex + padding. These defaults appear before `backdropClassName`
// in the rendered class string (documenting intent that caller overrides come
// last) but actual Tailwind precedence is decided by CSS source order — see
// the note next to the overlay <div> below for the override mechanics.
const ALIGN_CLASSES = {
  center: 'items-center justify-center p-4',
  top: 'items-start justify-center pt-[10vh] px-4 pb-4',
};

// Module-scope stack of open Modal ids. A single capture-phase keydown
// listener on `window` dispatches Esc only to the top-most modal — every
// other listener (including the layer beneath this one) is blocked via
// stopImmediatePropagation. Modals register here regardless of whether they
// want to close on Esc, so a non-dismissible top-most layer still prevents
// fallthrough to underlying modals.
const modalStack = [];
const escHandlers = new Map();
let globalEscListener = null;
let modalIdSeq = 0;

function pushModal(id) {
  modalStack.push(id);
  if (!globalEscListener) {
    globalEscListener = (e) => {
      if (e.key !== 'Escape' || modalStack.length === 0) return;
      const top = modalStack[modalStack.length - 1];
      const handler = escHandlers.get(top);
      // Always block fallthrough at the top-most modal, even if it didn't
      // register a handler (closeOnEsc=false + no onEsc). Otherwise Esc could
      // reach the layer beneath and dismiss the wrong modal.
      e.stopImmediatePropagation();
      if (handler) handler();
    };
    window.addEventListener('keydown', globalEscListener, true);
  }
}

function popModal(id) {
  const idx = modalStack.lastIndexOf(id);
  if (idx >= 0) modalStack.splice(idx, 1);
  if (modalStack.length === 0 && globalEscListener) {
    window.removeEventListener('keydown', globalEscListener, true);
    globalEscListener = null;
  }
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

  // Every open modal registers on the stack so the top-most always handles
  // (or absorbs) Esc. The handler dispatched is one of:
  //   - onEsc, if provided (caller wants custom Esc semantics — e.g.
  //     LayoutEditor cancels an inline mode instead of closing).
  //   - onClose, if closeOnEsc is true (the common case).
  //   - undefined → no dispatch, but Esc is still swallowed at this layer so
  //     it can't fall through to an underlying modal.
  useEffect(() => {
    if (!open) return;
    const id = idRef.current;
    let handler;
    if (onEsc) handler = () => onEsc();
    else if (closeOnEsc) handler = () => onClose?.();
    if (handler) escHandlers.set(id, handler);
    pushModal(id);
    return () => {
      escHandlers.delete(id);
      popModal(id);
    };
  }, [open, closeOnEsc, onClose, onEsc]);

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
