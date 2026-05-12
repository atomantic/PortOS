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
 *   closeOnEsc=false        MediaLightbox / KeyboardHelp — owners that
 *                           already manage Esc themselves (layered cascade,
 *                           or a global hook).
 *   align='top'             LayoutEditor / KeyboardHelp / Flux2InstallModal.
 *   usePortal               LayoutEditor / KeyboardHelp — escape any
 *                           stacking-context ancestors.
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

// Per-align flex + padding combined into one string so a custom padding from
// `backdropClassName` reliably overrides ours (last class in the merged
// attribute wins for same-property utilities).
const ALIGN_CLASSES = {
  center: 'items-center justify-center p-4',
  top: 'items-start justify-center pt-[10vh] px-4 pb-4',
};

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

  useEffect(() => {
    if (!open || !closeOnEsc) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, closeOnEsc, onClose]);

  if (!open) return null;

  // Stop propagation so a Modal rendered as a child of another modal (e.g.
  // PromptRefineModal inside MediaLightbox) doesn't bubble a backdrop click
  // up to the parent's own onClick handler — which would otherwise dismiss
  // both layers at once.
  const handleBackdropClick = (e) => {
    if (!closeOnBackdrop) return;
    if (e.target === backdropRef.current) {
      e.stopPropagation();
      onClose?.();
    }
  };

  const alignClass = ALIGN_CLASSES[align] || ALIGN_CLASSES.center;
  const sizeClass = SIZE_CLASSES[size] ?? SIZE_CLASSES.md;
  const widthClass = size === 'none' ? '' : `w-full ${sizeClass}`;

  const overlay = (
    <div
      ref={backdropRef}
      className={`fixed inset-0 ${zIndexClassName} ${backdropClassName} flex ${alignClass}`}
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
