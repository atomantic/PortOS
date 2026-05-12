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
 *   closeOnEsc=false        KeyboardHelp / Flux2InstallModal — owners that
 *                           either manage Esc themselves or never wired Esc
 *                           pre-refactor and don't want accidental dismissal.
 *   align='top'             LayoutEditor / KeyboardHelp / Flux2InstallModal.
 *   usePortal               LayoutEditor / KeyboardHelp — escape any
 *                           stacking-context ancestors.
 *
 * Stacking: Modal uses a single module-scope `keydown` listener that fires
 * only the top-most open Modal's `onClose` on Esc. Stacking siblings (e.g.
 * Flux2InstallModal opened on top of LayoutEditor, or PromptRefineModal
 * opened from inside a media flow) never see Esc fire all layers at once.
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

// Module-scope stack of open Modal ids. A single keydown listener on `window`
// dispatches Esc only to the top-most modal — without this, Esc would close
// every modal on the stack at once (e.g. PromptRefineModal inside MediaLightbox,
// or Flux2InstallModal above LayoutEditor).
const modalStack = [];
let globalEscListener = null;

function pushModal(id) {
  modalStack.push(id);
  if (!globalEscListener) {
    globalEscListener = (e) => {
      if (e.key !== 'Escape' || modalStack.length === 0) return;
      const top = modalStack[modalStack.length - 1];
      const onClose = escHandlers.get(top);
      if (onClose) {
        // Block any other Esc listeners (including other Modals' window handlers
        // we may have failed to clean up) from also firing on this keystroke.
        e.stopImmediatePropagation();
        onClose();
      }
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

const escHandlers = new Map();
let modalIdSeq = 0;

export default function Modal({
  open,
  onClose,
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

  // Register this modal on the stack while it is open + opted-in to Esc. The
  // global listener fires only the top-most modal's onClose, preventing the
  // "one Esc closes every layer" bug when modals are stacked.
  useEffect(() => {
    if (!open || !closeOnEsc) return;
    const id = idRef.current;
    escHandlers.set(id, () => onClose?.());
    pushModal(id);
    return () => {
      escHandlers.delete(id);
      popModal(id);
    };
  }, [open, closeOnEsc, onClose]);

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
