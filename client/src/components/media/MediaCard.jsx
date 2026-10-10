import { memo, useState } from 'react';
import { Trash2, Download, Film, Image as ImageIcon, Sparkles, Eye, EyeOff, Maximize2, Wand2, Star, MessageSquare, Pencil, Box, Timer } from 'lucide-react';
import MediaImage from '../MediaImage';
import AddToCollectionMenu from './AddToCollectionMenu';
import PinToMoodBoardMenu, { canPinToMoodBoard } from './PinToMoodBoardMenu';
import InlineConfirmRow from '../ui/InlineConfirmRow';
import { loraDisplayName } from './normalize';
import { formatDurationMs } from '../../utils/formatters';
import { assetDownloadUrl } from '../../lib/standaloneDownload.js';

// Equal cells. `flex-1` on Remix used to eat the first row, which pushed
// "Send to 3D" onto the file-action line and left Delete alone under it.
const CREATE_BTN = 'min-h-[44px] min-w-0 w-full px-1.5 rounded-md text-[11px] font-medium flex items-center justify-center gap-1';
const FILE_BTN = 'h-full w-full min-w-0 min-h-[44px] px-0 rounded flex items-center justify-center';

const TONE = {
  accent: 'bg-port-accent/20 hover:bg-port-accent/40 text-port-accent',
  success: 'bg-port-success/20 hover:bg-port-success/40 text-port-success',
  purple: 'bg-purple-600/20 hover:bg-purple-600/40 text-purple-300',
  neutral: 'bg-port-border hover:bg-port-border/70 text-white',
  danger: 'bg-port-error/20 hover:bg-port-error/40 text-port-error',
};

// Five file actions fit one row once the card interior is ~176px (the five-up
// recent-renders column). Narrower — two-up on a phone — keeps three columns
// so a cell stays near 40px instead of shrinking to ~20px. A hard 44px
// min-width cannot fit five controls in that column, which is the wrap the
// card used to show.
function fileActionGridClass(count) {
  if (count <= 1) return 'grid-cols-1';
  if (count === 2) return 'grid-cols-2';
  if (count === 3) return 'grid-cols-3';
  if (count === 4) return 'grid-cols-2 @min-[11rem]:grid-cols-4';
  return 'grid-cols-3 @min-[11rem]:grid-cols-5';
}

function CreateAction({ tone, icon: Icon, label, title, ariaLabel, onClick, className = '' }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
      className={`${CREATE_BTN} ${tone} ${className}`}
    >
      <Icon className="w-3.5 h-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">{label}</span>
    </button>
  );
}

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
  const { kind, prompt, modelId, previewUrl, thumbnailUrl, downloadUrl } = item;
  const isVideo = kind === 'video';
  const handleTileClick = onClick || (() => onPreview?.(item));
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  // Send actions come before Draw so the image-gen card (no annotate handler)
  // stays a 2×2: Remix, i2i, Video, 3D. Draw wraps under that set when present.
  const createActions = [
    onRemix && {
      key: 'remix', tone: TONE.accent, icon: Sparkles, label: 'Remix',
      title: 'Reuse prompt and settings', onClick: () => onRemix(item),
    },
    !isVideo && onSendToImage && {
      key: 'i2i', tone: TONE.accent, icon: Wand2, label: 'i2i',
      title: 'Open this image in Image Gen as the image-to-image source',
      ariaLabel: 'Send to image-to-image', onClick: () => onSendToImage(item),
    },
    !isVideo && onSendToVideo && {
      key: 'video', tone: TONE.success, icon: Film, label: 'Video',
      title: 'Send to Video', ariaLabel: 'Send to Video', onClick: () => onSendToVideo(item),
    },
    !isVideo && onSendTo3d && {
      key: '3d', tone: TONE.purple, icon: Box, label: '3D',
      title: 'Send this image to the 3D page to generate a mesh',
      ariaLabel: 'Send to 3D', onClick: () => onSendTo3d(item),
    },
    !isVideo && onAnnotate && {
      key: 'draw', tone: TONE.accent, icon: Pencil, label: 'Draw',
      title: 'Annotate (draw over this image)', ariaLabel: 'Annotate image',
      onClick: () => onAnnotate(item),
    },
    isVideo && onContinue && {
      key: 'continue', tone: TONE.accent, icon: ImageIcon, label: 'Continue',
      title: 'Use last frame as Image Gen source', onClick: () => onContinue(item),
    },
    isVideo && onFinish && {
      key: 'finish', tone: TONE.success, icon: Sparkles, label: 'Finish',
      title: finishTitle, onClick: () => onFinish(item),
    },
    isVideo && onUpscale && !item.upscaledFrom && {
      key: 'upscale', tone: TONE.neutral, icon: Maximize2, label: '2×',
      title: 'Upscale 2×', ariaLabel: 'Upscale 2×', onClick: () => onUpscale(item),
    },
  ].filter(Boolean);
  const fileActionCount = (showCollectionMenu ? 1 : 0)
    + (showMoodBoardMenu && canPinToMoodBoard(item) ? 1 : 0)
    + 1
    + (onToggleHidden ? 1 : 0)
    + (onDelete ? 1 : 0);

  return (
    <div className={`min-w-0 bg-port-card border rounded-xl ${selected ? 'border-port-accent' : 'border-port-border'}`}>
      {/* The tile is a button, so the star toggle cannot live inside it — a
          <button> nested in a <button> is invalid HTML and keeps the inner
          control out of the tab order. Tile and overlays are siblings in this
          positioned wrapper instead, with the overlays click-through so the
          tile stays clickable behind them. */}
      <div className="relative aspect-square rounded-t-xl overflow-hidden bg-port-bg">
        <button
          type="button"
          onClick={() => handleTileClick(item)}
          aria-label={prompt || `Select ${isVideo ? 'video' : 'image'}`}
          disabled={disabled}
          className="block w-full h-full disabled:cursor-not-allowed disabled:opacity-40"
        >
          {previewUrl ? (
            <MediaImage src={thumbnailUrl || previewUrl} fallbackSrc={kind === 'image' ? previewUrl : undefined} assetSrc={previewUrl} alt={prompt} className="w-full h-full object-cover" loading="lazy" />
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
                className="pointer-events-auto min-h-[44px] min-w-[44px] flex items-center justify-center rounded-full"
                title={starred ? 'Unfavorite' : 'Favorite'}
                aria-label={starred ? 'Unfavorite' : 'Favorite'}
                aria-pressed={starred}
              >
                {/* The hit target stays 44px; the disc is smaller so a favorite
                    doesn't cover the render the way a full circle did. */}
                <span className={`w-7 h-7 rounded-full flex items-center justify-center port-media-overlay-item ${starred ? 'bg-port-warning/90 text-black' : 'port-media-overlay-strong text-port-text-muted'}`}>
                  <Star className={`w-3.5 h-3.5 ${starred ? 'fill-current' : ''}`} />
                </span>
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
          <div className="@container space-y-1.5">
            {createActions.length > 0 && (
              <div role="group" aria-label="Create from this render" className="grid grid-cols-2 gap-1">
                {createActions.map(({ key, ...action }) => (
                  <CreateAction
                    key={key}
                    {...action}
                    className={createActions.length === 1 ? 'col-span-2' : ''}
                  />
                ))}
              </div>
            )}
            <div
              role="group"
              aria-label="File actions"
              className={`grid gap-1 border-t border-port-border/70 pt-1.5 ${fileActionGridClass(fileActionCount)}`}
            >
              {showCollectionMenu && <AddToCollectionMenu item={item} size="fill" />}
              {showMoodBoardMenu && <PinToMoodBoardMenu item={item} size="fill" />}
              <a
                href={assetDownloadUrl(downloadUrl)}
                download
                className={`${FILE_BTN} ${TONE.neutral}`}
                title="Download"
                aria-label="Download"
              >
                <Download className="w-3.5 h-3.5" />
              </a>
              {onToggleHidden && (
                <button
                  type="button"
                  onClick={() => onToggleHidden(item)}
                  className={`${FILE_BTN} ${TONE.neutral}`}
                  aria-label={item.hidden ? 'Unhide (move out of hidden section)' : 'Hide (move to hidden section)'}
                  title={item.hidden ? 'Unhide (move out of hidden section)' : 'Hide (move to hidden section)'}
                >
                  {item.hidden ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                </button>
              )}
              {onDelete && (
                <button
                  type="button"
                  onClick={() => setConfirmingDelete(true)}
                  className={`${FILE_BTN} ${TONE.danger}`}
                  aria-label="Delete"
                  title="Delete"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// Gallery parents keep normalized item objects and action callbacks stable, so
// React's shallow prop comparison can skip the expensive thumbnail/layout tree.
export default memo(MediaCard);
