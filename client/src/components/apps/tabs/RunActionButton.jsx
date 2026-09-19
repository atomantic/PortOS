import { Loader2 } from 'lucide-react';

// Keep async action buttons stable while their label changes. A fixed content
// slot prevents the spinner and the old label from visually crossing during a
// theme transition, and keeps every run action's pending state consistent.
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
      className={`inline-flex min-w-[7.5rem] items-center justify-center gap-1.5 transition-colors disabled:opacity-50 ${className}`}
    >
      <span className="inline-flex w-4 shrink-0 justify-center" aria-hidden="true">
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Icon size={14} />}
      </span>
      <span>{busy ? busyLabel : children}</span>
    </button>
  );
}
