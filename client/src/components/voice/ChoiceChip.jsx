/** A touch-sized pressed/unpressed pill for picking from a short list on the Voice Call station. */
export default function ChoiceChip({ pressed, onClick, title, children, className = '' }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      title={title}
      className={`inline-flex min-h-11 min-w-0 items-center justify-center gap-1 rounded-lg border px-2.5 font-mono text-[11px] transition-colors sm:min-h-9 pointer-coarse:min-h-11 ${
        pressed
          ? 'border-port-accent bg-port-accent/15 text-port-accent-text'
          : 'border-port-border bg-port-bg text-port-text-muted hover:border-port-accent hover:text-port-text'
      } ${className}`}
    >
      {children}
    </button>
  );
}
