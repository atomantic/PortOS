/**
 * Three-state thumbnail slot for universe canon entries and category variations.
 *
 * Mirrors the comic-page render thumb pattern from
 * `client/src/components/pipeline/MediaJobThumb.jsx`:
 *
 *   1. Pending — `inFlightJobId` set → render `MediaJobThumb` so the user
 *      sees the diffusion spinner / step counter / preview latent.
 *   2. Completed — `imageRefs[]` non-empty → walk-back thumbnail (the existing
 *      `EntryCardThumbnail` behavior, extracted here to keep both paths in
 *      lock-step).
 *   3. Empty — no jobId, no images → 48x48 placeholder box with a centered
 *      Sparkles button that fires `onRender()`. Keeps row heights consistent
 *      across freshly-extracted entries (no images yet) and rendered ones,
 *      and surfaces a one-click render affordance without scrolling to the
 *      row's action column.
 *
 * The fixed footprint avoids row-height jitter between empty / pending /
 * rendered states. Disabled when `canRender` is false (no backend selected,
 * save pending, etc.) so the button shape is still visible but inert.
 */
import { useState, useEffect } from 'react';
import { Sparkles, Loader2, Star } from 'lucide-react';
import MediaJobThumb from '../pipeline/MediaJobThumb';

export default function EntryThumbSlot({
  inFlightJobId = null,
  imageRefs = null,
  primaryImageRef = null,
  onRender = null,
  onPreview = null,
  canRender = true,
  alt = 'Render',
  // `'lg'` renders the empty-state box at 64x96 with a bigger Sparkles
  // affordance (reserved for slots that ride a wider card). Defaults to the
  // compact 48x80 (w-12 h-20) portrait footprint shared with variation +
  // canon avatar rows — matched to the 2:3 aspect of typical 1024x1536
  // universe renders so the slot doesn't crop the subject.
  size = 'sm',
}) {
  if (inFlightJobId) {
    // `xs` (48x80) matches the empty + completed states below so all three
    // states share a footprint and the row doesn't jump mid-render. `'lg'`
    // upgrades the pending box to `sm` (64x64) when the slot is configured
    // for the larger size — note `MediaJobThumb` doesn't have a portrait
    // 64x96 variant, so the larger slot's pending state is square.
    return (
      <MediaJobThumb
        jobId={inFlightJobId}
        label={alt}
        size={size === 'lg' ? 'sm' : 'xs'}
        onPreview={onPreview}
      />
    );
  }
  const refs = Array.isArray(imageRefs) ? imageRefs : [];
  const hasImage = refs.length > 0 || !!primaryImageRef;
  if (hasImage) {
    const chosen = (primaryImageRef && refs.includes(primaryImageRef))
      ? primaryImageRef
      : refs[refs.length - 1];
    return (
      <WalkBackThumb
        filename={chosen}
        alt={alt}
        fallbackRefs={refs}
        isPrimary={!!primaryImageRef && primaryImageRef === chosen}
        onClick={onPreview}
      />
    );
  }
  // Empty state — placeholder box with render button. Portrait footprint
  // (48x80 / 64x96) matches the 2:3 aspect of typical universe renders so
  // the row reserves the same vertical space as WalkBackThumb's completed
  // image, and the pending MediaJobThumb (xs / sm), eliminating row jitter
  // across the three states.
  const dim = size === 'lg' ? 'w-16 h-24' : 'w-12 h-20';
  return (
    <button
      type="button"
      onClick={() => onRender?.()}
      disabled={!onRender || !canRender}
      title={canRender ? 'Render image for this item' : 'Save the universe first to enable render'}
      className={`${dim} shrink-0 flex items-center justify-center rounded border border-dashed border-port-border bg-port-bg/40 text-gray-500 hover:border-port-accent/50 hover:text-port-accent hover:bg-port-accent/5 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:border-port-border disabled:hover:text-gray-500 disabled:hover:bg-port-bg/40 transition-colors`}
    >
      <Sparkles size={size === 'lg' ? 18 : 14} />
    </button>
  );
}

// Walk-back thumbnail extracted from EntryCard's internal renderer so the
// has-image branch of EntryThumbSlot reuses the same on-error fallback chain
// (stale gallery file → walk back through prior renders → collapse). Mirrors
// `EntryCardThumbnail` in `EntryCard.jsx`; intentionally kept in sync — visual
// drift would defeat the point of a shared slot.
function WalkBackThumb({ filename, alt, onClick, isPrimary = false, fallbackRefs = null }) {
  const candidates = [];
  if (filename) candidates.push(filename);
  if (Array.isArray(fallbackRefs)) {
    for (let i = fallbackRefs.length - 1; i >= 0; i -= 1) {
      const f = fallbackRefs[i];
      if (typeof f === 'string' && f && f !== filename && !candidates.includes(f)) {
        candidates.push(f);
      }
    }
  }
  const candidateKey = candidates.join('|');
  const [idx, setIdx] = useState(0);
  useEffect(() => { setIdx(0); }, [candidateKey]);
  if (!candidates.length || idx >= candidates.length) {
    // All candidates failed to load — collapse to empty (no render button
    // here; the user can re-render from the action column).
    return <div className="w-12 h-20 shrink-0 rounded border border-port-border bg-port-bg/40" />;
  }
  const currentFilename = candidates[idx];
  const img = (
    <img
      src={`/data/images/${currentFilename}`}
      alt={alt || currentFilename}
      className="w-full h-full object-cover"
      loading="lazy"
      onError={() => setIdx((n) => n + 1)}
    />
  );
  const frame = (
    <div className={`relative w-12 h-20 shrink-0 rounded overflow-hidden border ${
      isPrimary ? 'border-port-accent' : 'border-port-border'
    }`}>
      {img}
      {isPrimary ? (
        <span
          title="Primary reference image"
          className="absolute top-0.5 right-0.5 p-0.5 rounded bg-port-accent text-white"
        >
          <Star size={8} fill="currentColor" />
        </span>
      ) : null}
    </div>
  );
  if (!onClick) return frame;
  return (
    <button
      type="button"
      onClick={() => onClick(currentFilename)}
      title={`Preview ${alt || currentFilename}`}
      aria-label={`Preview ${alt || currentFilename}`}
      className="p-0 bg-transparent border-0 cursor-zoom-in"
    >
      {frame}
    </button>
  );
}
