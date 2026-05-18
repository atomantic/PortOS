/**
 * Shared card shell for canon entries (CanonCard) and category variations
 * (VariationCard). Both render through this so the locked-accent border +
 * slot layout stay in sync — visual drift is the bug this guards against.
 *
 * Slot contract:
 * - `title`, `body`, `actions`, `footer` — ReactNode. Consumers own internal
 *   layout (e.g. column vs. row for `actions`) so EntryCard stays unopinionated.
 * - `thumbnail` — descriptor object `{ filename, alt?, onClick?, isPrimary? }`
 *   (NOT a ReactNode). Spread into the internal `EntryCardThumbnail` renderer
 *   so the 12x12 frame, primary-star badge, and zoom-in button styling stay
 *   consistent across consumers. Pass `null`/omit to skip the thumbnail column.
 */

import { Star } from 'lucide-react';

export default function EntryCard({
  locked = false,
  thumbnail = null,
  title = null,
  body = null,
  actions = null,
  footer = null,
}) {
  const borderClass = locked ? 'border-port-accent/40' : 'border-port-border';
  return (
    <li className={`rounded border bg-port-bg/60 p-2 ${borderClass}`}>
      <div className="flex items-start gap-3">
        {thumbnail ? <EntryCardThumbnail {...thumbnail} /> : null}
        <div className="flex-1 min-w-0">
          {title}
          {body}
        </div>
        {actions ? <div className="shrink-0">{actions}</div> : null}
      </div>
      {footer}
    </li>
  );
}

function EntryCardThumbnail({ filename, alt, onClick, isPrimary = false }) {
  const img = (
    <img
      src={`/data/images/${filename}`}
      alt={alt || filename}
      className="w-full h-full object-cover"
      loading="lazy"
    />
  );
  const frame = (
    <div className={`relative w-12 h-12 shrink-0 rounded overflow-hidden border ${
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
      onClick={onClick}
      title={`Preview ${alt || filename}`}
      aria-label={`Preview ${alt || filename}`}
      className="p-0 bg-transparent border-0 cursor-zoom-in"
    >
      {frame}
    </button>
  );
}
