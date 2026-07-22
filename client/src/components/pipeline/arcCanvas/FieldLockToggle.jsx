import { Loader2, Lock, Unlock } from 'lucide-react';
import { useLockToggle } from '../../../hooks/useLockToggle';
import { setPipelineArcFieldLock } from '../../../services/api';

// Per-field arc lock toggle. Click flips `series.locked.arcFields[field]`; the
// server-side `commitSeasonsWithRemap` honors the map so auto-resolve /
// regenerate rewrite unlocked fields while preserving locked ones verbatim.
// Subtle inline icon — not a full button — to stay out of the read flow.
export default function FieldLockToggle({ series, field, label, onSeriesUpdate }) {
  const lockedFields = series.locked?.arcFields || {};
  const locked = lockedFields[field] === true;
  const { busy: saving, toggle } = useLockToggle({
    patchFn: (next) => setPipelineArcFieldLock(series.id, field, next, { silent: true }),
    onSuccess: (updated) => onSeriesUpdate(updated),
    lockedMessage: `${label} locked — preserved on regenerate / auto-resolve`,
    unlockedMessage: `${label} unlocked`,
    errorMessage: `${label} lock update failed`,
  });
  return (
    <button
      type="button"
      onClick={(e) => {
        // Several callers render this button inside a <details><summary>...
        // tree (Summary, Protagonist arc). A click on the lock would otherwise
        // bubble to the summary and toggle the disclosure. Stop here so the
        // user only flips the lock.
        e.stopPropagation();
        e.preventDefault();
        toggle(locked);
      }}
      disabled={saving}
      aria-pressed={locked}
      title={locked
        ? `${label} is locked — click to unlock`
        : `Lock ${label} to preserve it through regenerate / auto-resolve`}
      aria-label={locked ? `Unlock ${label}` : `Lock ${label}`}
      className={`inline-flex items-center justify-center w-4 h-4 rounded transition-colors disabled:opacity-40 ${
        locked ? 'text-port-warning hover:text-port-warning/80' : 'text-gray-600 hover:text-gray-300'
      }`}
    >
      {saving
        ? <Loader2 size={10} className="animate-spin" />
        : (locked ? <Lock size={10} /> : <Unlock size={10} />)}
    </button>
  );
}
