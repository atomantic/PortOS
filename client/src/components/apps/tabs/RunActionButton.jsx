import { Loader2 } from 'lucide-react';

// Keep async action buttons stable while their request is in flight. The
// action label stays in one visual slot; only the icon changes to a spinner.
// Replacing the visible label with a second busy string lets the two text
// layers briefly composite during the theme/button transition on touch
// browsers, which is especially distracting on the compact issue rows.
export default function RunActionButton({
  busy = false,
  busyLabel = 'Queuing…',
  icon: Icon,
  children,
  className = '',
  ...props
}) {
  return (
    <button
      type="button"
      {...props}
      disabled={busy || props.disabled}
      aria-busy={busy}
      aria-label={busy ? busyLabel : props['aria-label']}
      className={`inline-flex min-w-[7.5rem] items-center justify-center gap-1.5 transition-colors disabled:opacity-50 ${className}`}
    >
      <span className="inline-flex w-4 shrink-0 justify-center" aria-hidden="true">
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Icon size={14} />}
      </span>
      <span>{children}</span>
    </button>
  );
}
