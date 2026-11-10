import { sharedTakeOffers, sharedTakePatches } from '../../../../server/lib/musicVideoSourceTake.js';

const BUTTON = 'flex items-center gap-1 rounded border border-port-border bg-port-bg px-2 py-1.5 text-xs text-port-text hover:bg-port-border/40 min-h-[44px] pointer-fine:sm:min-h-0';

/**
 * Board suggestions for one shared clip (#15588). Applying is explicit:
 * adjacent shots opt into sequence coverage, and a later return points at
 * the earliest shot. Saves run one after another so two scene writes cannot race.
 */
export default function SharedTakeOffers({ scenes, sceneId = null, onSave }) {
  const offers = sharedTakeOffers(scenes).filter((offer) => {
    if (!sceneId) return true;
    if (offer.kind === 'sequence') return offer.sceneIds.includes(sceneId);
    return offer.sceneId === sceneId;
  });
  if (!offers.length || !onSave) return null;
  const apply = (offer) => sharedTakePatches(scenes, offer)
    .reduce((chain, item) => chain.then(() => onSave(item.sceneId, item.patch)), Promise.resolve());
  const labelFor = (offer) => {
    if (offer.kind === 'sequence') return `Render ${offer.sceneIds.length} adjacent shots as one clip`;
    const source = (scenes || []).find((scene) => scene.sceneId === offer.sourceId);
    return `Play ${source?.label || 'the earlier shot'}'s take here from ${Number(offer.offsetSec).toFixed(2)}s`;
  };
  return (
    <div className="flex flex-wrap gap-2" data-testid="shared-take-offers">
      {offers.map((offer) => (
        <button
          key={offer.kind === 'sequence' ? `sequence:${offer.sceneIds.join(',')}` : `take:${offer.sceneId}`}
          type="button"
          className={BUTTON}
          onClick={() => apply(offer)}
        >
          {labelFor(offer)}
        </button>
      ))}
    </div>
  );
}
