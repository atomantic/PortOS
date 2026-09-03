import { memo, useState } from 'react';
import { Trash2, Download, Film, Image as ImageIcon, Sparkles, Eye, EyeOff, Maximize2, Wand2, Star, MessageSquare, Pencil, Box, Timer } from 'lucide-react';
import MediaImage from '../MediaImage';
import AddToCollectionMenu from './AddToCollectionMenu';
import PinToMoodBoardMenu from './PinToMoodBoardMenu';
import InlineConfirmRow from '../ui/InlineConfirmRow';
import { loraDisplayName } from './normalize';
import { formatDurationMs } from '../../utils/formatters';

// Single card used everywhere a generated image/video appears in a grid:
// the Image Gen page's recent gallery, the Video Gen page's recent renders,
// and the Media History tab. Action visibility is opt-in — pass only the
// callbacks you want rendered. Remix is offered for both kinds (callers
// dispatch by `item.kind`). Image-only actions (send-to-video, i2i, 3d) and
// video-only actions (continue, finish) are auto-hidden when the kind doesn't
// match. `onFinish` is passed only for a draft the caller already resolved a
// delivery model for (see client/src/lib/videoFinish.js) — an image-conditioned
// or legacy record gets no Finish button rather than a disabled one.
function MediaCard({
  item,
  onPreview,
  onClick, // overrides preview when set (e.g. stitch mode toggling selection)
  onRemix,
  onSendToImage,
  onSendToVideo,
  onSendTo3d,
  onContinue,
  onFinish,
  finishTitle = 'Re-render this draft on its delivery model',
  onUpscale,
  onDelete,
  onToggleHidden,
  selectionLabel = null, // e.g. "1", "2" — shown as the stitch order badge
  selected = false,
  disabled = false,
  hideActions = false,
  showCollectionMenu = true,
  showMoodBoardMenu = true,
  starred = false,
  hasNote = false,
  onToggleStar,
  onAnnotate,
}) {
  const { kind, prompt, modelId, previewUrl, downloadUrl } = item;
  const isVideo = kind === 'video';
  const handleTileClick = onClick || (() => onPreview?.(item));
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  return (
    <div className={`bg-port-card border rounded-xl ${selected ? 'border-port-accent' : 'border-port-border'}`}>
      {/* The tile is a button, so the star toggle cannot live inside it — a
          <button> nested in a <button> is invalid HTML and keeps the inner
          control out of the tab order. Tile and overlays are siblings in this
          positioned wrapper instead, with the overlays click-through so the
          tile stays clickable behind them. */}
      <div className="relative aspect-square rounded-t-xl overflow-hidden bg-port-bg">
        <button
          type="button"
          onClick={() => handleTileClick(item)}
          disabled={disabled}
          className="block w-full h-full disabled:cursor-not-allowed disabled:opacity-40"
        >
          {previewUrl ? (
            <MediaImage src={previewUrl} alt={prompt} className="w-full h-full object-cover" loading="lazy" />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-gray-600">
              {isVideo ? <Film className="w-10 h-10" /> : <ImageIcon className="w-10 h-10" />}
            </div>
          )}
        </button>
        {selectionLabel != null && (
          <div className="absolute top-1.5 left-1.5 w-5 h-5 rounded-full bg-port-accent text-white text-[10px] font-bold flex items-center justify-center pointer-events-none">
            {selectionLabel}
          </div>
        )}
        {(onToggleStar || starred || hasNote) && (
          <div className="absolute bottom-1.5 left-1.5 flex items-center gap-1 pointer-events-none">
            {onToggleStar && (
              <button
                type="button"
                onClick={() => onToggleStar(item)}
                className={`pointer-events-auto p-1 rounded-full ${starred ? 'bg-port-warning/90 text-black' : 'bg-black/50 text-white/70 hover:text-white'}`}
                title={starred ? 'Unfavorite' : 'Favorite'}
                aria-label={starred ? 'Unfavorite' : 'Favorite'}
              >
                <Star className={`w-3.5 h-3.5 ${starred ? 'fill-current' : ''}`} />
              </button>
            )}
            {hasNote && (
              <span
                className="pointer-events-auto p-1 rounded-full bg-port-accent/80 text-white"
                title="Has note"
                aria-label="Has note"
              >
                <MessageSquare className="w-3 h-3" />
              </span>
            )}
          </div>
        )}
        {/* The container is click-through so the tile stays clickable behind it,
            but each badge takes pointer events back — a `title` tooltip needs
            them, and these badges are the only thing explaining "frame". */}
        <div className="absolute top-1.5 right-1.5 flex flex-col items-end gap-0.5 pointer-events-none">
          {[
            item.stitchedFrom && { label: 'stitched', cls: 'bg-port-success/80 text-white' },
            item.upscaledFrom && { label: '2×', cls: 'bg-port-accent/80 text-white' },
            item.extractedFromVideoId && { label: 'frame', cls: 'bg-port-warning/80 text-black', title: 'Extracted from video' },
          ].filter(Boolean).map((b) => (
            <span key={b.label} title={b.title} className={`pointer-events-auto text-[9px] px-1 py-0.5 rounded ${b.cls}`}>{b.label}</span>
          ))}
        </div>
      </div>
      <div className="p-2 space-y-1.5">
        <p className="text-[11px] text-gray-300 line-clamp-2" title={prompt}>{prompt}</p>
        <div className="flex flex-wrap gap-1 text-[9px]">
          {modelId && <span className="px-1.5 py-0.5 bg-port-accent/20 text-port-accent rounded">{modelId}</span>}
          {item.width && <span className="px-1.5 py-0.5 bg-port-border text-gray-400 rounded">{item.width}×{item.height}</span>}
          {item.steps && <span className="px-1.5 py-0.5 bg-port-border text-gray-400 rounded">{item.steps}st</span>}
          {item.numFrames && <span className="px-1.5 py-0.5 bg-port-border text-gray-400 rounded">{item.numFrames}f</span>}
          {item.fps && <span className="px-1.5 py-0.5 bg-port-border text-gray-400 rounded">{item.fps}fps</span>}
          {item.seed != null && <span className="px-1.5 py-0.5 bg-port-border text-gray-400 rounded">seed {item.seed}</span>}
          {/* How long this render took, once the queue picked it up (see the
              renderMs contract in normalize.js). Absent renders no chip at all,
              rather than a placeholder, so the row stays scannable. */}
          {item.renderMs != null && (
            <span
              title="Render time — measured from when the queue started this job, so it excludes queue wait"
              className="px-1.5 py-0.5 bg-port-border text-gray-400 rounded inline-flex items-center gap-0.5"
            >
              <Timer className="w-2.5 h-2.5" aria-hidden="true" />{formatDurationMs(item.renderMs)}
            </span>
          )}
        </div>
        {Array.isArray(item.loraNames) && item.loraNames.length > 0 && (
          <div className="flex flex-wrap items-center gap-1 text-[9px]" title={item.loraNames.map(loraDisplayName).join(', ')}>
            <Wand2 className="w-2.5 h-2.5 text-purple-300 shrink-0" />
            {item.loraNames.slice(0, 2).map((fn) => (
              <span key={fn} className="px-1.5 py-0.5 bg-purple-600/20 text-purple-300 rounded truncate max-w-[120px]">
                {loraDisplayName(fn)}
              </span>
            ))}
            {item.loraNames.length > 2 && (
              <span className="px-1.5 py-0.5 bg-purple-600/20 text-purple-300 rounded">+{item.loraNames.length - 2}</span>
            )}
          </div>
        )}
        {!hideActions && confirmingDelete && onDelete && (
          <InlineConfirmRow
            question={`Delete this ${isVideo ? 'video' : 'image'}?`}
            confirmText="Delete"
            confirmTitle="Permanently delete"
            onConfirm={() => { setConfirmingDelete(false); onDelete(item); }}
            onCancel={() => setConfirmingDelete(false)}
          />
        )}
        {!hideActions && !confirmingDelete && (
          <div className="flex flex-wrap gap-1">
            {onRemix && (
              <button
                type="button"
                onClick={() => onRemix(item)}
                className="flex-1 min-w-0 px-1.5 py-1 bg-port-accent/20 hover:bg-port-accent/40 text-port-accent text-[10px] rounded flex items-center justify-center gap-1"
                title="Reuse prompt and settings"
              >
                <Sparkles className="w-3 h-3 shrink-0" /> <span className="truncate">Remix</span>
              </button>
            )}
            {!isVideo && onSendToImage && (
              <button
                type="button"
                onClick={() => onSendToImage(item)}
                className="shrink-0 px-1.5 py-1 bg-port-accent/20 hover:bg-port-accent/40 text-port-accent text-[10px] rounded flex items-center justify-center"
                title="Send to image-to-image"
                aria-label="Send to image-to-image"
              >
                <Wand2 className="w-3 h-3" />
              </button>
            )}
            {!isVideo && onAnnotate && (
              <button
                type="button"
                onClick={() => onAnnotate(item)}
                className="shrink-0 px-1.5 py-1 bg-port-accent/20 hover:bg-port-accent/40 text-port-accent text-[10px] rounded flex items-center justify-center"
                title="Annotate (draw over this image)"
                aria-label="Annotate image"
              >
                <Pencil className="w-3 h-3" />
              </button>
            )}
            {!isVideo && onSendToVideo && (
              <button
                type="button"
                onClick={() => onSendToVideo(item)}
                className="shrink-0 px-1.5 py-1 bg-port-success/20 hover:bg-port-success/40 text-port-success text-[10px] rounded flex items-center justify-center"
                title="Send to Video" aria-label="Send to Video"
              >
                <Film className="w-3 h-3" />
              </button>
            )}
            {!isVideo && onSendTo3d && (
              <button
                type="button"
                onClick={() => onSendTo3d(item)}
                className="shrink-0 px-1.5 py-1 bg-purple-600/20 hover:bg-purple-600/40 text-purple-300 text-[10px] rounded flex items-center justify-center"
                title="Send this image to the 3D page to generate a mesh"
                aria-label="Send to 3D"
              >
                <Box className="w-3 h-3" />
              </button>
            )}
            {isVideo && onContinue && (
              <button
                type="button"
                onClick={() => onContinue(item)}
                className="flex-1 min-w-0 px-1.5 py-1 bg-port-accent/20 hover:bg-port-accent/40 text-port-accent text-[10px] rounded flex items-center justify-center gap-1"
                title="Use last frame as Image Gen source"
              >
                <ImageIcon className="w-3 h-3 shrink-0" /> <span className="truncate">Continue</span>
              </button>
            )}
            {isVideo && onFinish && (
              <button
                type="button"
                onClick={() => onFinish(item)}
                className="shrink-0 px-1.5 py-1 bg-port-success/20 hover:bg-port-success/40 text-port-success text-[10px] rounded flex items-center justify-center gap-1"
                title={finishTitle}
              >
                <Sparkles className="w-3 h-3 shrink-0" /> <span className="truncate">Finish</span>
              </button>
            )}
            {isVideo && onUpscale && !item.upscaledFrom && (
              <button
                type="button"
                onClick={() => onUpscale(item)}
                className="shrink-0 px-1.5 py-1 bg-port-border hover:bg-port-border/70 text-white text-[10px] rounded flex items-center justify-center"
                title="Upscale 2× (Lanczos, ~10s)" aria-label="Upscale 2× (Lanczos, ~10s)"
              >
                <Maximize2 className="w-3 h-3" />
              </button>
            )}
            {showCollectionMenu && <AddToCollectionMenu item={item} />}
            {showMoodBoardMenu && <PinToMoodBoardMenu item={item} />}
            <a
              href={downloadUrl}
              download
              className="shrink-0 px-1.5 py-1 bg-port-border hover:bg-port-border/70 text-white text-[10px] rounded flex items-center justify-center"
              title="Download"
              aria-label="Download"
            >
              <Download className="w-3 h-3" />
            </a>
            {onToggleHidden && (
              <button
                type="button"
                onClick={() => onToggleHidden(item)}
                className="shrink-0 px-1.5 py-1 bg-port-border hover:bg-port-border/70 text-white text-[10px] rounded flex items-center justify-center"
                aria-label={item.hidden ? 'Unhide (move out of hidden section)' : 'Hide (move to hidden section)'}
                title={item.hidden ? 'Unhide (move out of hidden section)' : 'Hide (move to hidden section)'}
              >
                {item.hidden ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
              </button>
            )}
            {onDelete && (
              <button
                type="button"
                onClick={() => setConfirmingDelete(true)}
                className="shrink-0 px-1.5 py-1 bg-port-error/20 hover:bg-port-error/40 text-port-error text-[10px] rounded flex items-center justify-center"
                aria-label="Delete"
                title="Delete"
              >
                <Trash2 className="w-3 h-3" />
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// Gallery parents keep normalized item objects and action callbacks stable, so
// React's shallow prop comparison can skip the expensive thumbnail/layout tree.
export default memo(MediaCard);
