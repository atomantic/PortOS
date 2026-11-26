import { RotateCw } from 'lucide-react';

export default function RetryFormActions({ onCancel, retrying, submitDisabled, submitTitle }) {
  return (
    <div className="flex flex-wrap items-center justify-end gap-2 pt-1">
      <button
        type="button"
        disabled={retrying}
        onClick={onCancel}
        className="pointer-coarse:min-h-11 rounded-lg border border-port-border px-3 py-2 text-xs text-port-text-muted hover:bg-port-border/50 hover:text-white focus-visible:outline focus-visible:outline-port-accent disabled:opacity-50"
      >
        Cancel
      </button>
      <button
        type="submit"
        disabled={retrying || submitDisabled}
        title={submitTitle}
        className="pointer-coarse:min-h-11 inline-flex items-center gap-1 rounded-lg border border-port-accent bg-port-accent px-3 py-2 text-xs text-white hover:bg-port-accent/90 focus-visible:outline focus-visible:outline-offset-2 focus-visible:outline-port-accent disabled:opacity-50"
      >
        <RotateCw className="size-3" aria-hidden="true" />
        Retry with changes
      </button>
    </div>
  );
}
