/**
 * CatalogCard — a single Creative Ingredient card.
 *
 * Extracted from Catalog.jsx (#1762) so the flat grid AND the albums grouped
 * view render identical cards. The card is one big <Link> (clicking anywhere
 * opens the editor); the selection checkbox and the armed two-click delete
 * control are absolute-positioned siblings of the Link so their clicks never
 * bubble to the anchor.
 */

import { Link } from 'react-router-dom';
import { Sparkles, Trash2 } from 'lucide-react';
import MediaImage from '../MediaImage';
import { payloadSnippet } from '../../lib/catalogTypes';

function TypeBadge({ type, getType }) {
  const meta = getType(type);
  if (!meta) return null;
  return (
    <span className={`inline-block text-[10px] uppercase tracking-wider px-2 py-0.5 rounded border ${meta.badgeColor}`}>
      {meta.label}
    </span>
  );
}

// Card thumbnail: the ingredient's portrait (or most recent reference image),
// resolved from the media library at /data/images/<key>. With no image we show a
// dimmed Sparkles placeholder; with one we render through <MediaImage>, which
// tolerates a not-yet-arrived peer asset (shows "Syncing" and auto-swaps to the
// live image on the asset-arrived event) instead of permanently breaking on a
// transient 404. Either way the slot keeps a fixed footprint so the grid aligns.
function CardThumb({ mediaKey, alt }) {
  return (
    <div className="w-14 h-14 shrink-0 rounded-md overflow-hidden border border-port-border bg-port-bg flex items-center justify-center">
      {mediaKey ? (
        <MediaImage
          src={`/data/images/${mediaKey}`}
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
  const snippet = payloadSnippet(it.payload, it.type, 120, getType);
  return (
    <li
      className={`relative bg-port-card border rounded-lg transition-colors ${
        selected
          ? 'border-port-accent ring-1 ring-port-accent'
          : 'border-port-border hover:border-port-accent/60'
      }`}
    >
      <span className="absolute top-2 left-2 z-10 flex items-center justify-center rounded bg-port-card/90 border border-port-border">
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggleSelect(it)}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Select ${name}`}
          className="w-4 h-4 m-1 accent-port-accent cursor-pointer"
        />
      </span>
      <Link
        to={`/catalog/${encodeURIComponent(it.type)}/${encodeURIComponent(it.id)}`}
        className={`flex gap-3 p-3 pl-10 min-h-[88px] ${armed ? 'pr-32' : 'pr-10'}`}
      >
        <CardThumb mediaKey={it.thumbnailKey} alt={name} />
        <span className="flex flex-col gap-2 min-w-0 flex-1">
          <span className="block text-white font-medium truncate">{name}</span>
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
      <div className="absolute top-2 right-2">
        {/* The delete control is a sibling of the <Link>, not a descendant, so a
            click on these buttons never traverses the anchor. */}
        {armed ? (
          <span className="inline-flex items-center gap-1 text-xs bg-port-card border border-port-border rounded px-1 py-0.5 shadow-sm">
            <span className="text-gray-400 pl-1">Delete?</span>
            <button
              type="button"
              onClick={() => onConfirmDelete(it)}
              className="px-2 py-0.5 rounded bg-port-error/20 text-port-error hover:bg-port-error/30 font-medium"
            >
              Yes
            </button>
            <button
              type="button"
              onClick={onCancelArm}
              className="px-2 py-0.5 rounded text-gray-400 hover:text-white"
            >
              No
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => onArm(it.id)}
            className="p-1.5 rounded text-gray-500 hover:text-port-error bg-port-card"
            aria-label={`Delete ${name}`}
            title="Delete ingredient"
          >
            <Trash2 size={14} />
          </button>
        )}
      </div>
    </li>
  );
}
