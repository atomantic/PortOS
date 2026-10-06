import { AlertTriangle } from 'lucide-react';

/**
 * A failed read is not an empty list. Render this in place of the
 * "nothing here" sentence when the load rejected, with a retry control.
 */
export default function LoadFailedState({ title, hint, onRetry }) {
  return (
    <div role="alert" className="flex flex-col items-center text-center py-12 px-4 text-gray-400">
      <AlertTriangle size={40} className="mb-3 text-port-error opacity-70" />
      <p className="text-sm font-medium text-port-error">{title}</p>
      {hint && <p className="text-xs mt-1 text-gray-500">{hint}</p>}
      <button
        type="button"
        onClick={onRetry}
        className="mt-3 min-h-[40px] rounded bg-port-card border border-port-border px-3 text-xs text-port-accent hover:text-white"
      >
        Retry
      </button>
    </div>
  );
}
