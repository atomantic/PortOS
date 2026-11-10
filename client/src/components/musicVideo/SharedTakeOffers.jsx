import { useRef, useState } from 'react';
import { sharedTakeOffers, sharedTakePatches } from '../../../../server/lib/musicVideoSourceTake.js';

const BUTTON = 'flex items-center gap-1 rounded border border-port-border bg-port-bg px-2 py-1.5 text-xs text-port-text hover:bg-port-border/40 min-h-[44px] pointer-fine:sm:min-h-0 disabled:opacity-50';

/**
 * Board suggestions for one shared clip (#15588). Applying is explicit:
 * adjacent shots opt into sequence coverage, and a later return points at
 * the earliest shot. Saves run one after another so two scene writes cannot race.
 */
export default function SharedTakeOffers({ scenes, sceneId = null, onSave }) {
  const applying = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retryOffer, setRetryOffer] = useState(null);
  const offers = sharedTakeOffers(scenes).filter((offer) => {
    if (!sceneId) return true;
    if (offer.kind === 'sequence') return offer.sceneIds.includes(sceneId);
    return offer.sceneId === sceneId;
  });
  if ((!offers.length && !error && !busy) || !onSave) return null;
  const apply = async (offer) => {
    if (applying.current) return;
    applying.current = true;
    setBusy(true);
    setError('');
    setRetryOffer(null);
    let saved = 0;
    try {
      for (const item of sharedTakePatches(scenes, offer)) {
        if (await onSave(item.sceneId, item.patch) === false) throw new Error('A shot could not be saved');
        saved += 1;
      }
    } catch (err) {
      setRetryOffer(offer);
      setError(`${saved ? `${saved} shot${saved === 1 ? '' : 's'} saved before the failure. ` : ''}${err?.message || 'Could not apply the shared take'}. Retry to finish applying the offer.`);
    } finally {
      applying.current = false;
      setBusy(false);
    }
  };
  const labelFor = (offer) => {
    if (offer.kind === 'sequence') return `Render ${offer.sceneIds.length} adjacent shots as one clip`;
    const source = (scenes || []).find((scene) => scene.sceneId === offer.sourceId);
    return `Play ${source?.label || 'the earlier shot'}'s take here from ${Number(offer.offsetSec).toFixed(2)}s`;
  };
  return (
    <div className="space-y-2" data-testid="shared-take-offers">
      {busy && <p role="status" className="text-xs text-port-text-muted">Applying shared take…</p>}
      <div className="flex flex-wrap gap-2">
        {offers.map((offer) => (
          <button
            key={offer.kind === 'sequence' ? `sequence:${offer.sceneIds.join(',')}` : `take:${offer.sceneId}`}
            type="button"
            className={BUTTON}
            disabled={busy}
            onClick={() => apply(offer)}
          >
            {labelFor(offer)}
          </button>
        ))}
      </div>
      {error && <div className="flex flex-wrap items-center gap-2"><p role="alert" className="text-xs text-port-error">{error}</p>{retryOffer && <button type="button" className={BUTTON} disabled={busy} onClick={() => apply(retryOffer)}>Retry shared take</button>}</div>}
    </div>
  );
}
