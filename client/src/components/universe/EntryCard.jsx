/**
 * Shared card shell for canon entries (CanonCard) and category variations
 * (VariationCard). Both render through this so the locked-accent border +
 * slot layout stay in sync — visual drift is the bug this guards against.
 *
 * Slot contract:
 * - `title`, `body`, `actions`, `footer` — ReactNode. Consumers own internal
 *   layout (e.g. column vs. row for `actions`) so EntryCard stays unopinionated.
 * - `thumbnail` — descriptor object `{ filename, alt?, onClick?, isPrimary?,
 *   fallbackRefs? }` (NOT a ReactNode). Spread into the internal
 *   `EntryCardThumbnail` renderer so the 12x12 frame, primary-star badge, and
 *   zoom-in button styling stay consistent across consumers. Pass `null`/omit
 *   to skip the thumbnail column. `fallbackRefs` is an optional chronological
 *   list of older filenames — when the primary one fails to load (file
 *   deleted), the thumbnail walks back through this list to the next existing
 *   render rather than producing a broken image; if none load, the column
 *   collapses to nothing.
 * - `selectable` — descriptor `{ selected, onToggle, label? }`. Turns the row
 *   into a checkbox-driven selection card (used by the Importer review for
 *   pre-commit canon picks). Selected accent matches `locked`'s family;
 *   unselected dims with `opacity-60` so picked vs. dropped reads at a glance.
 *   Implementation: an overlay `<label htmlFor>` sits above the padded card
 *   surface so the entire bordered area toggles the checkbox; `actions` and
 *   clickable (`onClick`) thumbnails sit on a `relative z-10` layer above the
 *   overlay so they remain independently clickable without nesting interactive
 *   controls inside a `<label>` (invalid HTML).
 */
import { useId, useState, useEffect } from 'react';
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
  const reactId = useId();
  const checkboxId = selectable ? `entry-card-cb-${reactId}` : undefined;
  const isSelected = selectable ? selectable.selected : false;
  const borderClass = selectable
    ? (isSelected ? 'border-port-accent bg-port-accent/5' : 'border-port-border opacity-60')
    : (locked ? 'border-port-accent/40' : 'border-port-border');
  // Match the pre-extract Importer card spacing (p-3) in selectable mode so
  // the visual diff vs. the inline card it replaces is genuinely zero.
  const paddingClass = selectable ? 'p-3' : 'p-2';

  return (
    <li className={`relative rounded border bg-port-bg/60 ${paddingClass} ${borderClass}`}>
      {selectable ? (
        <label
          htmlFor={checkboxId}
          aria-label={selectable.label || 'Select entry'}
          className="absolute inset-0 cursor-pointer"
        />
      ) : null}
      <div className="flex items-start gap-3">
        {selectable ? (
          <input
            id={checkboxId}
            type="checkbox"
            checked={isSelected}
            onChange={selectable.onToggle}
            aria-label={selectable.label || 'Select entry'}
            className="relative z-10 mt-1 accent-port-accent shrink-0"
          />
        ) : null}
        {thumbnail ? (
          <EntryCardThumbnail {...thumbnail} />
        ) : null}
        <div className="flex-1 min-w-0">
          {title}
          {body}
        </div>
        {actions ? <div className="relative z-10 shrink-0">{actions}</div> : null}
      </div>
      {footer ? <div className="relative z-10">{footer}</div> : null}
    </li>
  );
}

function EntryCardThumbnail({ filename, alt, onClick, isPrimary = false, fallbackRefs = null }) {
  // Build a walk-back list: primary first, then any older filenames (most
  // recent of the fallbacks first since the consumer passes chronological,
  // newest last — reverse so we step back through history). `filename` is
  // de-duplicated from `fallbackRefs` so it isn't tried twice.
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
  // Reset the walk-back when the candidates list changes (new render landed,
  // entry swapped, etc.). Keyed on the joined list so React rebuilds local
  // state when the input genuinely changes vs. a parent re-render.
  const candidateKey = candidates.join('|');
  const [idx, setIdx] = useState(0);
  useEffect(() => { setIdx(0); }, [candidateKey]);
  // Walked past the end → all files are missing on disk. Collapse rather than
  // render a broken `<img>`; matches the contract that no avatar shows when
  // there are no resolvable renders.
  if (!candidates.length || idx >= candidates.length) return null;
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
      onClick={() => onClick(currentFilename)}
      title={`Preview ${alt || currentFilename}`}
      aria-label={`Preview ${alt || currentFilename}`}
      className="p-0 bg-transparent border-0 cursor-zoom-in relative z-10"
    >
      {frame}
    </button>
  );
}
