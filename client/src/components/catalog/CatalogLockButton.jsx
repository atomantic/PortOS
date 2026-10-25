import { useRef, useState } from 'react';
import { Lock, Unlock, Loader2 } from 'lucide-react';
import useMounted from '../../hooks/useMounted';
import { setCatalogIngredientLock } from '../../services/apiCatalog';

// Every surface changes only the persisted lock, never its surrounding draft.
export default function CatalogLockButton({ record, disabled = false, onChanged, onPendingChange, label = null }) {
  const mounted = useMounted();
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const locked = record.payload?.locked === true;
  const readOnly = record.sharedIdentity?.writable === false;
  const toggle = async () => {
    if (disabled || readOnly || inFlight.current) return;
    inFlight.current = true;
    setPending(true); setError(null); onPendingChange?.(true);
    await setCatalogIngredientLock(record.id, !locked, { silent: true }).then(updated => {
      if (!updated?.payload || updated.payload.locked !== !locked) throw new Error('Lock change was not confirmed. Reload before trying again.');
      if (mounted.current) onChanged?.({ ...record, ...updated, id: record.id, canonicalId: updated.id });
    }).catch(error => {
      if (mounted.current) setError(error.message || 'Could not change the character lock');
    }).finally(() => {
      inFlight.current = false;
      if (mounted.current) { setPending(false); onPendingChange?.(false); }
    });
  };
  return <div className="min-w-0">
    <button type="button" onClick={toggle} disabled={disabled || readOnly || pending} aria-busy={pending} aria-pressed={locked}
      aria-label={label || `${locked ? 'Unlock' : 'Lock'} ${record.name || 'character'}`}
      title={readOnly ? 'This shared identity is read-only here' : locked ? 'Unlock to allow AI rewrites and production generation' : 'Protect from AI rewrites and production generation'}
      className="inline-flex items-center justify-center gap-1.5 rounded border border-port-border px-2 py-2 text-xs text-gray-300 hover:text-port-accent disabled:opacity-40">
      {pending ? <Loader2 size={14} className="animate-spin" aria-hidden="true" /> : locked ? <Lock size={14} aria-hidden="true" /> : <Unlock size={14} aria-hidden="true" />}
      <span>{label || (locked ? 'Unlock' : 'Lock')}</span>
    </button>
    {error && <p role="alert" className="mt-1 text-xs text-port-error break-words">{error}</p>}
  </div>;
}
