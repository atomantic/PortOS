import { useRef, useState } from 'react';
import { Loader2, Unlock } from 'lucide-react';
import useMounted from '../../hooks/useMounted';
import { getCatalogIngredientDetails, updateCatalogIngredient } from '../../services/apiCatalog';
import { getUniverse, setUniverseCanonLock } from '../../services/apiUniverseBuilder';

/** Resolve a render's lock in place without saving the editor's draft or rendering. */
export default function CatalogUnlockNotice({ record, disabled = false, onUnlocked, onPendingChange }) {
  const mounted = useMounted();
  const inFlight = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const [unlocked, setUnlocked] = useState(false);
  const locked = record.payload?.locked === true;

  const unlock = async () => {
    if (inFlight.current || disabled || !locked) return;
    inFlight.current = true;
    setPending(true);
    onPendingChange(true);
    setError(null);
    try {
      const details = await getCatalogIngredientDetails(record.id, { silent: true });
      if (!mounted.current) return;
      const current = details?.ingredient;
      if (!current) throw new Error('This record is no longer available.');
      const field = { character: 'characters', place: 'places', object: 'objects' }[current.type];
      let canonTarget = null;
      for (const ref of details.refs || []) {
        if (!field || ref.refKind !== 'universe') continue;
        const universe = await getUniverse(ref.refId, { silent: true }).catch((err) => {
          if (err?.status === 404 || err?.code === 'NOT_FOUND') return null;
          throw err;
        });
        if (!mounted.current) return;
        const entry = universe?.[field]?.find((item) => item.ingredientId === record.id);
        if (entry) { canonTarget = { universeId: ref.refId, entryId: entry.id }; break; }
      }
      if (canonTarget) {
        await setUniverseCanonLock(canonTarget.universeId, current.type, canonTarget.entryId, false, { silent: true });
      } else if (current.payload?.locked === true) {
        await updateCatalogIngredient(record.id, { payload: { ...current.payload, locked: false } }, { silent: true });
      }
      if (!mounted.current) return;
      // Canon projection can fail independently; only clear the UI lock after readback.
      const confirmed = await getCatalogIngredientDetails(record.id, { silent: true });
      if (!mounted.current) return;
      if (!confirmed?.ingredient || confirmed.ingredient.payload?.locked === true) {
        throw new Error('The record is still locked. Try unlocking again.');
      }
      onUnlocked(confirmed.ingredient);
      setUnlocked(true);
    } catch (err) {
      if (mounted.current) setError(err?.message || 'Could not unlock this record.');
    } finally {
      inFlight.current = false;
      if (mounted.current) { setPending(false); onPendingChange(false); }
    }
  };

  if (!locked && !unlocked) return null;
  return (
    <div className="rounded-lg border border-port-border bg-port-card p-3 space-y-2">
      <p role="status" className="text-sm text-port-warning">
        {locked ? `${record.name} is locked. Unlock it to render a reference sheet or look. Unlocking also allows AI edits to this record.`
          : 'Unlocked. Choose Generate when you are ready; unsaved profile edits still need saving.'}
      </p>
      {locked && <button type="button" onClick={unlock} disabled={disabled || pending} aria-busy={pending}
        className="inline-flex items-center gap-1.5 rounded border border-port-border px-3 py-2 text-sm text-white disabled:opacity-50">
        {pending ? <Loader2 size={14} aria-hidden="true" className="animate-spin" /> : <Unlock size={14} aria-hidden="true" />}
        {pending ? 'Unlocking…' : 'Unlock for rendering'}
      </button>}
      {error && <p role="alert" className="text-sm text-port-error">{error}</p>}
    </div>
  );
}
