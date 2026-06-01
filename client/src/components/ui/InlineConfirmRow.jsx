// Inline "question + confirm + cancel" row for destructive actions — the
// inline-confirmation pattern PortOS prefers over a two-click-arm button or a
// window.confirm() modal. Shaped for confirm/cancel prompts, which is why these
// don't reuse <Banner> (that's "icon + content + actions" alerts).
//
// Tones pre-compose full Tailwind class names — the JIT scans for complete
// tokens, so `bg-port-${tone}/10` would NOT generate the utility. Spell it out.
// Only `error` ships today (every confirm row is destructive); add a map entry
// when a non-destructive tone is actually needed.
const TONES = {
  error: {
    wrapper: 'bg-port-error/10 border-port-error/30',
    confirm: 'bg-port-error text-white hover:bg-port-error/80',
  },
};

export default function InlineConfirmRow({
  question,
  confirmText = 'Delete',
  cancelText = 'Cancel',
  confirmTitle,
  cancelTitle,
  onConfirm,
  onCancel,
  tone = 'error',
  className = '',
  ...rest
}) {
  const t = TONES[tone] || TONES.error;

  return (
    <div className={`flex items-center gap-2 p-2 border rounded ${t.wrapper} ${className}`.trim()} {...rest}>
      <span className="text-xs text-white flex-1">{question}</span>
      <button
        type="button"
        onClick={onConfirm}
        title={confirmTitle}
        className={`px-2 py-1 text-xs rounded transition-colors ${t.confirm}`}
      >
        {confirmText}
      </button>
      <button
        type="button"
        onClick={onCancel}
        title={cancelTitle}
        className="px-2 py-1 text-xs text-gray-400 hover:text-white transition-colors"
      >
        {cancelText}
      </button>
    </div>
  );
}
