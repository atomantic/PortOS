import { Mic, Star, X } from 'lucide-react';
import ConfirmButtonPair from '../ui/ConfirmButtonPair.jsx';
import CatalogImagePreview from './CatalogImagePreview';

// One catalog media attachment tile. Images render via <MediaImage> (which
// shows a "syncing" placeholder when the asset hasn't arrived — the same
// surface the `missing` integrity flag warns about). Audio/video render inline
// players (bytes served from /data/audio and /data/videos); a voice memo's
// transcript rides in `caption`. Other kinds render a labeled chip.
// `onSetPortrait` is optional (sheet tiles omit it); `extraActions` adds
// tab-specific buttons (Plates' mark/unmark) to the hover action row, and
// `label` captions the tile (a sheet's variant); `contain` shows a wide image
// (a sheet) whole instead of a square crop. `badge` overlays the top-left
// corner (a sheet's "Rated bad"), and `pinActions` keeps the action row in view
// without hover.
export default function CatalogMediaTile({
  m, missing, isPortrait = false, onSetPortrait, onDetach, armedDetach, onArmDetach, extraActions = null, label = null, contain = false,
  badge = null, pinActions = false,
}) {
  const isImage = m.kind === 'portrait' || m.kind === 'reference';
  const isAudio = m.kind === 'audio';
  const isVideo = m.kind === 'video';
  const tileKey = `${m.mediaKey}:${m.kind}`;
  return (
    <div className="relative group rounded border border-port-border overflow-hidden bg-port-bg">
      {isImage && (
        <CatalogImagePreview src={`/data/images/${encodeURIComponent(m.mediaKey)}`} fallbackSrc={`/data/image-refs/${encodeURIComponent(m.mediaKey)}`} alt={label || m.caption || m.kind}
          className={contain ? 'w-full object-contain max-h-[420px]' : isPortrait ? 'w-full max-w-[180px] aspect-square object-cover' : 'w-full aspect-square object-cover'} />
      )}
      {isAudio && (
        <div className="p-2 flex flex-col gap-1">
          <div className="text-[10px] uppercase tracking-wider text-gray-400 flex items-center gap-1">
            <Mic size={10} aria-hidden="true" /> {m.role === 'voice-memo' ? 'voice memo' : 'audio'}
          </div>
          <audio controls preload="none" src={`/data/audio/${m.mediaKey}`} className="w-full" />
          {m.caption && <p className="text-[11px] text-gray-300 whitespace-pre-wrap line-clamp-4">{m.caption}</p>}
        </div>
      )}
      {isVideo && (
        <video controls preload="none" src={`/data/videos/${m.mediaKey}`} className="w-full aspect-square object-contain bg-black" />
      )}
      {!isImage && !isAudio && !isVideo && (
        <div className="w-full aspect-square flex items-center justify-center text-[10px] uppercase tracking-wider text-gray-400 px-1 text-center break-all">
          {m.kind}<br />{m.mediaKey}
        </div>
      )}
      {label && (
        <div className="text-[10px] uppercase tracking-wider text-gray-500 px-2 py-1 border-t border-port-border truncate">{label}</div>
      )}
      {badge}
      {missing && (
        <span className="absolute top-1 left-1 text-[9px] px-1 py-0.5 rounded bg-port-warning/20 text-port-warning border border-port-warning/40"
          title="This asset isn't in your media library yet (received from a peer before the file arrived).">
          missing
        </span>
      )}
      {isImage && (isPortrait || (!m.readOnly && onSetPortrait)) && (
        <div className="p-2 border-t border-port-border">
          {isPortrait ? <span className="inline-flex items-center gap-1 text-xs text-port-warning"><Star size={12} aria-hidden="true" /> Canonical image</span>
            : <button type="button" onClick={() => onSetPortrait(m.mediaKey)} className="min-h-11 rounded border border-port-border px-2 py-1 text-xs text-port-accent inline-flex items-center gap-1 hover:bg-port-accent/10">
              <Star size={12} aria-hidden="true" /> Set as canonical image
            </button>}
        </div>
      )}
      {m.readOnly && <p className="text-xs text-gray-500 p-2 break-words">Read-only provenance · {m.ingredientId || 'retained media'}</p>}
      {!m.readOnly && <div className={`port-media-overlay absolute top-1 right-1 flex gap-1 rounded transition-opacity ${pinActions ? 'opacity-100' : 'opacity-100 [@media(hover:hover)]:sm:opacity-0 sm:group-hover:opacity-100 focus-within:opacity-100'}`}>
        {extraActions}
        {onDetach && (armedDetach === tileKey ? (
          <ConfirmButtonPair prompt="Detach?" confirmText="Detach" cancelText="Cancel"
            ariaLabel="Confirm media detach" onConfirm={() => {
              onArmDetach(null);
              onDetach(m.mediaKey, m.kind);
            }} onCancel={() => onArmDetach(null)} largeTouchTargets />
        ) : (
          <button type="button" onClick={() => onArmDetach(tileKey)} title="Detach" aria-label="Detach"
            className="pointer-coarse:min-h-11 pointer-coarse:min-w-11 port-media-overlay-item p-2 sm:p-1 rounded hover:text-port-error">
            <X size={12} aria-hidden="true" />
          </button>
        ))}
      </div>}
    </div>
  );
}
