import { useRef, useState } from 'react';
import ConfirmButtonPair from '../ui/ConfirmButtonPair';
import { removeUniverseCanonImageRef } from '../../services/apiUniverseBuilder';
import { getCanonCatalogContext } from '../../services/canonCatalogContext';
import useMounted from '../../hooks/useMounted';

// Use the existing explicit reference removal path. It preserves concurrent
// appends, invalidates identity-pack assets and reflects linked catalog canon.
export default function CanonReferenceRemoval({ recordId, universeId, kind, filename, disabled, onRemoved }) {
  const mounted = useMounted();
  const flight = useRef(false);
  const [armed, setArmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const remove = async () => {
    if (disabled || flight.current) return;
    flight.current = true; setPending(true); setError(null);
    await getCanonCatalogContext(universeId, recordId, kind, { silent: true }).then(async ({ entry }) => {
      if (!mounted.current) return;
      if (!entry) throw new Error('The owning universe no longer has this canon entry. Refresh before removing the reference.');
      await removeUniverseCanonImageRef(universeId, kind, entry.id, filename, { silent: true });
      if (mounted.current) { setArmed(false); onRemoved(); }
    }).catch(error => { if (mounted.current) setError(error.message); }).finally(() => {
      flight.current = false;
      if (mounted.current) setPending(false);
    });
  };
  return <div className="space-y-1">
    {armed && !disabled ? <ConfirmButtonPair confirmText="Remove reference" ariaLabel={`Remove canon reference ${filename}`} busy={pending}
      onConfirm={remove} onCancel={() => setArmed(false)} prompt="Remove reference; the image asset is kept." />
      : <button type="button" aria-label={`Remove reference ${filename}`} disabled={disabled} onClick={() => setArmed(true)} className="min-h-11 text-xs text-port-error disabled:opacity-40">Remove reference</button>}
    {error && <p role="alert" className="text-xs text-port-error">{error}</p>}
  </div>;
}
