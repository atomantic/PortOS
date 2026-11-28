import { useLayoutEffect, useRef } from 'react';
import { Loader2 } from 'lucide-react';

// Compact inline "confirm / cancel" button pair for destructive actions that
// live in a dense action area (a card's button row, a list-row's trailing
// controls) — the sibling of <InlineConfirmRow> for when there's no room for a
// full question row. The question, if any, is a short inline word ("Delete?").
// Buttons stay compact for fine pointers and gain 44px targets on coarse
// pointers, even at this text-xs density.
//
// Tones pre-compose full Tailwind class names — the JIT scans for complete
// tokens, so `bg-port-${tone}/20` would NOT generate the utility. Spell it out.
// `error` for destructive confirms; `warning` for expensive-but-safe confirms
// (e.g. unlocking a frozen walk set) where the action isn't destructive;
// `success` for the positive commits that move a workflow forward but are still
// worth confirming (approving a walk candidate, freezing a reference version).
// `stacked` puts the buttons in a full-width column for cells too narrow for a
// row (a grid tile's footer), so nothing overflows or overlaps.
const TONES = {
  error: 'bg-port-error/20 text-port-error hover:bg-port-error/30',
  warning: 'bg-port-warning/20 text-port-warning hover:bg-port-warning/30',
  success: 'bg-port-success/20 text-port-success hover:bg-port-success/30',
};

const CONTROL_SELECTOR = ':is(button, a[href], input:not([type="hidden"]), select, textarea, summary, [tabindex]):not(:disabled):not([tabindex="-1"])';

function focusFirstControl(container) {
  if (!container) return false;
  const controls = container.matches(CONTROL_SELECTOR) ? [container] : container.querySelectorAll(CONTROL_SELECTOR);
  for (const control of controls) {
    control.focus();
    if (container.ownerDocument.activeElement === control) return true;
  }
  return false;
}

export default function ConfirmButtonPair({
  prompt,
  confirmText = 'Delete',
  cancelText = 'Cancel',
  confirmIcon: ConfirmIcon,
  onConfirm,
  onCancel,
  busy = false,
  busyText,
  tone = 'error',
  ariaLabel,
  returnFocusRef,
  confirmAriaLabel,
  cancelAriaLabel,
  className = '',
  largeTouchTargets = false,
  responsiveTouchTargets = false,
  stacked = false,
}) {
  const groupRef = useRef(null);

  useLayoutEffect(() => {
    const group = groupRef.current;
    const doc = group.ownerDocument;
    // A held Enter can activate a newly focused button. Focus the question's group instead.
    if (doc.activeElement === doc.body) group.focus();

    return () => {
      const parent = group.parentElement;
      if (!parent || !group.contains(doc.activeElement)) return;
      const position = Array.from(parent.children).indexOf(group);
      // Wait for the caller to mount the trigger that replaced the pair.
      queueMicrotask(() => {
        if (group.isConnected || !parent.isConnected || doc.activeElement !== doc.body) return;
        returnFocusRef?.current?.focus();
        if (doc.activeElement === doc.body && !focusFirstControl(parent.children[position])) {
          focusFirstControl(parent);
        }
      });
    };
  }, [returnFocusRef]);

  const confirmTone = TONES[tone] || TONES.error;
  const buttonSizeClass = largeTouchTargets
    ? 'min-h-[44px] min-w-[44px] justify-center'
    : responsiveTouchTargets
      ? 'min-h-[44px] min-w-[44px] justify-center pointer-fine:sm:min-h-9 pointer-fine:sm:min-w-0'
    : 'min-h-[36px] pointer-coarse:min-h-11 pointer-coarse:min-w-11 pointer-coarse:justify-center';
  // While in-flight, the confirm icon becomes a spinner and both buttons
  // disable; the label additionally swaps to the in-flight word ("Deleting")
  // when a busyText is supplied, otherwise it stays put.
  const confirmLabel = busy && busyText ? busyText : confirmText;
  const layoutClass = stacked ? 'flex w-full flex-col items-stretch gap-1' : 'flex items-center gap-2';
  const stackedButtonClass = stacked ? 'justify-center' : '';

  return (
    <div
      ref={groupRef}
      role="group"
      tabIndex={-1}
      aria-label={ariaLabel || prompt || `${confirmAriaLabel || confirmText}?`}
      className={`${layoutClass} focus-visible:outline-2 focus-visible:outline-port-accent ${className}`.trim()}
    >
      {prompt ? <span className="text-xs text-gray-400">{prompt}</span> : null}
      <button
        type="button"
        onClick={onConfirm}
        disabled={busy}
        aria-label={confirmAriaLabel}
        className={`inline-flex ${buttonSizeClass} ${stackedButtonClass} items-center gap-1 px-2 py-1 text-xs rounded transition-colors disabled:opacity-50 ${confirmTone}`}
      >
        {busy ? (
          <Loader2 size={12} className="animate-spin" />
        ) : ConfirmIcon ? (
          <ConfirmIcon size={12} />
        ) : null}
        {confirmLabel}
      </button>
      <button
        type="button"
        onClick={onCancel}
        disabled={busy}
        aria-label={cancelAriaLabel}
        className={`${buttonSizeClass} ${stackedButtonClass} px-2 py-1 text-xs text-gray-400 hover:text-white transition-colors disabled:opacity-50`}
      >
        {cancelText}
      </button>
    </div>
  );
}
