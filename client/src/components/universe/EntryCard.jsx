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
 * - `selectable` — descriptor `{ selected, onToggle, label? }`. Turns the row
 *   into a checkbox-driven selection card (used by the Importer review for
 *   pre-commit canon picks). Selected accent matches `locked`'s family;
 *   unselected dims with `opacity-60` so picked vs. dropped reads at a glance.
 */
import { Star } from 'lucide-react';

export default function EntryCard({
  locked = false,
  thumbnail = null,
  title = null,
  body = null,
  actions = null,
  footer = null,
  selectable = null,
}) {
  const isSelected = selectable ? selectable.selected : false;
  const borderClass = selectable
    ? (isSelected ? 'border-port-accent bg-port-accent/5' : 'border-port-border opacity-60')
    : (locked ? 'border-port-accent/40' : 'border-port-border');

  const row = (
    <div className="flex items-start gap-3">
      {selectable ? (
        <input
          type="checkbox"
          checked={isSelected}
          onChange={selectable.onToggle}
          aria-label={selectable.label || 'Select entry'}
          className="mt-1 accent-port-accent shrink-0"
        />
      ) : null}
      {thumbnail ? <EntryCardThumbnail {...thumbnail} /> : null}
      <div className="flex-1 min-w-0">
        {title}
        {body}
      </div>
      {actions ? <div className="shrink-0">{actions}</div> : null}
    </div>
  );

  return (
    <li className={`rounded border bg-port-bg/60 p-2 ${borderClass}`}>
      {selectable ? (
        <label className="cursor-pointer block">{row}</label>
      ) : row}
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
