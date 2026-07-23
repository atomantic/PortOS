import { Loader2 } from 'lucide-react';

// Compact inline "confirm / cancel" button pair for destructive actions that
// live in a dense action area (a card's button row, a list-row's trailing
// controls) — the sibling of <InlineConfirmRow> for when there's no room for a
// full question row. The question, if any, is a short inline word ("Delete?").
//
// Tones pre-compose full Tailwind class names — the JIT scans for complete
// tokens, so `bg-port-${tone}/20` would NOT generate the utility. Spell it out.
// `error` for destructive confirms; `warning` for expensive-but-safe confirms
// (e.g. unlocking a frozen walk set) where the action isn't destructive.
const TONES = {
  error: 'bg-port-error/20 text-port-error hover:bg-port-error/30',
  warning: 'bg-port-warning/20 text-port-warning hover:bg-port-warning/30',
};

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
  className = '',
}) {
  const confirmTone = TONES[tone] || TONES.error;
  // While in-flight, the confirm icon becomes a spinner and both buttons
  // disable; the label additionally swaps to the in-flight word ("Deleting")
  // when a busyText is supplied, otherwise it stays put.
  const confirmLabel = busy && busyText ? busyText : confirmText;

  return (
    <div
      role="group"
      aria-label={ariaLabel}
      className={`flex items-center gap-2 ${className}`.trim()}
    >
      {prompt ? <span className="text-xs text-gray-400">{prompt}</span> : null}
      <button
        type="button"
        onClick={onConfirm}
        disabled={busy}
        className={`inline-flex items-center gap-1 px-2 py-1 text-xs rounded transition-colors disabled:opacity-50 ${confirmTone}`}
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
        className="px-2 py-1 text-xs text-gray-400 hover:text-white transition-colors disabled:opacity-50"
      >
        {cancelText}
      </button>
    </div>
  );
}
