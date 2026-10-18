import { AlertTriangle } from 'lucide-react';

/**
 * Inline "this list failed to load" row with a Retry action, for a picker or
 * a list section where a failed read must not render as "you have none".
 * Pair with `useListResource`: render it on `state === 'error'` and the
 * empty-list copy only on `state === 'ready'`. `LoadFailedState` is the
 * page-sized version of the same contract.
 */
export default function ListLoadError({ what, error = null, onRetry, retrying = false, className = '' }) {
  return (
    <div role="alert" className={`flex flex-wrap items-center gap-2 rounded-lg border border-port-error/30 bg-port-error/5 px-3 py-2 text-xs text-port-error ${className}`}>
      <AlertTriangle size={14} className="shrink-0" aria-hidden="true" />
      <span className="min-w-0">
        Could not load {what}{error?.message ? ` — ${error.message}` : ''}
      </span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          disabled={retrying}
          className="ml-auto min-h-[32px] rounded border border-port-border bg-port-card px-2 text-port-accent hover:text-white disabled:opacity-50"
        >
          {retrying ? 'Retrying…' : 'Retry'}
        </button>
      )}
    </div>
  );
}
