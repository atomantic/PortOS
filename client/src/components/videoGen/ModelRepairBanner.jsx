import { AlertTriangle, RefreshCw } from 'lucide-react';

// Weight-integrity repair banner (issue #1324), shared by the video-model and
// text-encoder cases in VideoGen.jsx (#2834). A corrupt/truncated model decodes
// to garbled "mosaic" video that a clean re-download fixes — this surfaces the
// Repair affordance keyed on the cheap structural check the status poll already
// ran. `message` is the case-specific copy; `onRepair`/`onDismiss` and the
// button label/disabled/spinner state come from the caller.
export default function ModelRepairBanner({ message, repairLabel, onRepair, onDismiss, disabled, repairing }) {
  return (
    <div className="rounded-lg border border-port-error/40 bg-port-error/10 px-3 py-3 text-xs text-port-error flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
      <div className="flex items-start gap-2">
        <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
        <div>{message}</div>
      </div>
      <div className="flex items-center gap-2 self-start sm:self-auto">
        <button
          type="button"
          onClick={onRepair}
          disabled={disabled}
          className="whitespace-nowrap inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-port-error text-white text-xs font-medium hover:bg-port-error/80 disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${repairing ? 'animate-spin' : ''}`} />
          {repairLabel}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          className="text-gray-400 hover:text-gray-200 text-xs"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
