/**
 * CatalogCard — a single Creative Ingredient card.
 *
 * Extracted from Catalog.jsx (#1762) so the flat grid AND the albums grouped
 * view render identical cards. The card is one big <Link> (clicking anywhere
 * opens the editor); the selection checkbox and the armed two-click delete
 * control are absolute-positioned siblings of the Link so their clicks never
 * bubble to the anchor.
 */

import { useState } from 'react';
import { Link } from 'react-router';
import { Sparkles, Trash2 } from 'lucide-react';
import MediaImage from '../MediaImage';
import InlineConfirmRow from '../ui/InlineConfirmRow';
import CatalogImageAction from './CatalogImageAction';
import { payloadSnippet } from '../../lib/catalogTypes';
import { ingredientPath, ingredientCoverUrl, usageSummary } from '../../lib/creativeLibraries';

function TypeBadge({ type, getType }) {
  const meta = getType(type);
  if (!meta) return null;
  return (
    <span className={`inline-block text-[10px] uppercase tracking-wider px-2 py-0.5 rounded border ${meta.badgeColor}`}>
      {meta.label}
    </span>
  );
}

// Card thumbnail: the ingredient's portrait (or most recent reference image)
// from the media library, else its universe canon image (ingredientCoverUrl). With no image we show a
// dimmed Sparkles placeholder; with one we render through <MediaImage>, which
// tolerates a not-yet-arrived peer asset (shows "Syncing" and auto-swaps to the
// live image on the asset-arrived event) instead of permanently breaking on a
// transient 404. Either way the slot keeps a fixed footprint so the grid aligns.
function CardThumb({ src, alt }) {
  return (
    <div className="w-14 h-14 shrink-0 rounded-md overflow-hidden border border-port-border bg-port-bg flex items-center justify-center">
      {src ? (
        <MediaImage
          thumbnail
          src={src}
          alt={alt}
          className="w-full h-full object-cover"
          loading="lazy"
        />
      ) : (
        <Sparkles size={18} className="text-gray-600" aria-hidden="true" />
      )}
    </div>
  );
}

export default function CatalogCard({
  ingredient: it,
  getType,
  selected,
  onToggleSelect,
  armed,
  onArm,
  onCancelArm,
  onConfirmDelete,
}) {
  const name = it.name || '(untitled)';
  const [generatedCover, setGeneratedCover] = useState(null);
  const snippet = payloadSnippet(it.payload, it.type, 120, getType);
  return (
    <li
      className={`relative bg-port-card border rounded-lg overflow-hidden transition-colors ${
        selected
          ? 'border-port-accent ring-1 ring-port-accent'
          : 'border-port-border hover:border-port-accent/60'
      }`}
    >
      <label className="absolute top-0 left-0 z-10 flex h-11 w-11 cursor-pointer items-center justify-center rounded bg-port-card/90 border border-port-border" title={`Select ${name}`}>
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggleSelect(it)}
          aria-label={`Select ${name}`}
          className="h-4 w-4 accent-port-accent cursor-pointer"
        />
      </label>
      {/* Armed delete: a full-width band above the card body (the house
          inline-confirm pattern) rather than a corner overlay. A corner overlay
          has to be paid for with reserved padding on the link, and on a
          single-column phone card there isn't enough width to reserve without
          crushing the name — the version that stretched the overlay instead
          covered the name, hiding the very thing being deleted. The band names
          it. `pl-11` clears the absolutely-positioned checkbox. */}
      {armed && (
        <InlineConfirmRow
          variant="separator"
          className="pl-11"
          question={`Delete "${name}"?`}
          confirmText="Yes"
          cancelText="No"
          onConfirm={() => onConfirmDelete(it)}
          onCancel={onCancelArm}
        />
      )}
      <Link
        to={ingredientPath(it)}
        className="flex gap-3 p-3 pl-11 pr-11 min-h-[88px]"
      >
        <CardThumb src={ingredientCoverUrl(it) || generatedCover} alt={name} />
        <span className="flex flex-col gap-2 min-w-0 flex-1">
          <span className="block text-white font-medium truncate">{name}</span>
          <span className="text-xs text-gray-400 break-words">{it.owningUniverse ? `Universe: ${it.owningUniverse.name}` : 'Ownership needs review'}</span>
          {usageSummary(it.usage) && <span className="text-xs text-gray-500">Used in {usageSummary(it.usage)}</span>}
          <span className="flex items-center gap-1.5 flex-wrap">
            <TypeBadge type={it.type} getType={getType} />
            {(it.tags || []).slice(0, 4).map((tag) => (
              <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded bg-port-bg border border-port-border text-gray-400">
                {tag}
              </span>
            ))}
          </span>
          {snippet ? (
            <span className="text-xs text-gray-400 line-clamp-2">{snippet}</span>
          ) : null}
        </span>
      </Link>
      <div className="px-3 pb-3 pl-11">
        <CatalogImageAction ingredient={it} getType={getType} onCover={setGeneratedCover} />
      </div>
      {/* The arm button is a sibling of the <Link>, not a descendant, so its
          click never traverses the anchor. It gives way to the confirm band
          above once armed, so the card never shows two delete affordances. */}
      {!armed && (
        <button
          type="button"
          onClick={() => onArm(it.id)}
          className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 absolute top-2 right-2 p-2 rounded text-gray-500 hover:text-port-error bg-port-card"
          aria-label={`Delete ${name}`}
          title="Delete ingredient"
        >
          <Trash2 size={16} />
        </button>
      )}
    </li>
  );
}
