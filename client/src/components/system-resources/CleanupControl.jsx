import { ExternalLink, Trash2 } from 'lucide-react';
import { Link } from 'react-router';
import ConfirmButtonPair from '../ui/ConfirmButtonPair.jsx';

export default function CleanupControl({
  candidate,
  busy,
  disabled = false,
  confirming,
  onRequest,
  onCancel,
  onConfirm,
}) {
  if (confirming) {
    return (
      <ConfirmButtonPair
        prompt="Remove?"
        confirmText="Remove"
        busyText="Removing"
        busy={busy || disabled}
        confirmIcon={Trash2}
        ariaLabel={`Confirm removal of ${candidate.label}`}
        onConfirm={onConfirm}
        onCancel={onCancel}
      />
    );
  }

  if (candidate.action) {
    return (
      <button
        type="button"
        onClick={onRequest}
        disabled={busy || disabled}
        aria-label={`Remove ${candidate.label}`}
        className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-port-error/40 px-2.5 py-1.5 text-xs text-port-error transition-colors hover:bg-port-error/10 disabled:opacity-50"
      >
        <Trash2 size={13} />
        Remove
      </button>
    );
  }

  if (candidate.managePath) {
    return (
      <Link
        to={candidate.managePath}
        aria-label={`Review ${candidate.label}`}
        className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-port-border px-2.5 py-1.5 text-xs text-gray-300 transition-colors hover:bg-port-border/40"
      >
        Review <ExternalLink size={12} />
      </Link>
    );
  }

  return <span className="text-xs text-gray-600">Report only</span>;
}
