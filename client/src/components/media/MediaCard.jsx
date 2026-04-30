import { Trash2, Download, Film, Image as ImageIcon, Sparkles, Eye, EyeOff } from 'lucide-react';

// Single card used everywhere a generated image/video appears in a grid:
// the Image Gen page's recent gallery, the Video Gen page's recent renders,
// and the Media History tab. Action visibility is opt-in — pass only the
// callbacks you want rendered. Image-only actions (remix, send-to-video) and
// video-only actions (continue) are auto-hidden when the kind doesn't match.
export default function MediaCard({
  item,
  onPreview,
  onClick, // overrides preview when set (e.g. stitch mode toggling selection)
  onRemix,
  onSendToVideo,
  onContinue,
  onDelete,
  onToggleHidden,
  selectionLabel = null, // e.g. "1", "2" — shown as the stitch order badge
  selected = false,
  disabled = false,
  hideActions = false,
}) {
  const { kind, prompt, modelId, previewUrl, downloadUrl } = item;
  const isVideo = kind === 'video';
  const handleTileClick = onClick || (() => onPreview?.(item));

  return (
    <div className={`bg-port-card border rounded-xl overflow-hidden ${selected ? 'border-port-accent' : 'border-port-border'}`}>
      <button
        type="button"
        onClick={() => handleTileClick(item)}
        disabled={disabled}
        className="block w-full aspect-square bg-port-bg relative disabled:cursor-not-allowed disabled:opacity-40"
      >
        {previewUrl ? (
          <img src={previewUrl} alt={prompt} className="w-full h-full object-cover" loading="lazy" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-600">
            {isVideo ? <Film className="w-10 h-10" /> : <ImageIcon className="w-10 h-10" />}
          </div>
        )}
        <span className="absolute bottom-1 right-1 text-[9px] px-1.5 py-0.5 bg-black/70 text-white rounded uppercase tracking-wide">
          {isVideo ? 'Video' : 'Image'}
        </span>
        {selectionLabel != null && (
          <div className="absolute top-1.5 left-1.5 w-5 h-5 rounded-full bg-port-accent text-white text-[10px] font-bold flex items-center justify-center">
            {selectionLabel}
          </div>
        )}
        {item.stitchedFrom && (
          <span className="absolute top-1.5 right-1.5 text-[9px] px-1 py-0.5 bg-port-success/80 text-white rounded">stitched</span>
        )}
      </button>
      <div className="p-2 space-y-1.5">
        <p className="text-[11px] text-gray-300 line-clamp-2" title={prompt}>{prompt}</p>
        <div className="flex flex-wrap gap-1 text-[9px]">
          {modelId && <span className="px-1.5 py-0.5 bg-port-accent/20 text-port-accent rounded">{modelId}</span>}
          {item.width && <span className="px-1.5 py-0.5 bg-port-border text-gray-400 rounded">{item.width}×{item.height}</span>}
          {item.steps && <span className="px-1.5 py-0.5 bg-port-border text-gray-400 rounded">{item.steps}st</span>}
          {item.numFrames && <span className="px-1.5 py-0.5 bg-port-border text-gray-400 rounded">{item.numFrames}f</span>}
          {item.fps && <span className="px-1.5 py-0.5 bg-port-border text-gray-400 rounded">{item.fps}fps</span>}
          {item.seed != null && <span className="px-1.5 py-0.5 bg-port-border text-gray-400 rounded">seed {item.seed}</span>}
        </div>
        {!hideActions && (
          <div className="flex gap-1">
            {!isVideo && onRemix && (
              <button
                type="button"
                onClick={() => onRemix(item)}
                className="flex-1 px-1.5 py-1 bg-port-accent/20 hover:bg-port-accent/40 text-port-accent text-[10px] rounded flex items-center justify-center gap-1"
                title="Reuse settings"
              >
                <Sparkles className="w-3 h-3" /> Remix
              </button>
            )}
            {!isVideo && onSendToVideo && (
              <button
                type="button"
                onClick={() => onSendToVideo(item)}
                className="flex-1 px-1.5 py-1 bg-port-success/20 hover:bg-port-success/40 text-port-success text-[10px] rounded flex items-center justify-center"
                title="Send to Video"
              >
                <Film className="w-3 h-3" />
              </button>
            )}
            {isVideo && onContinue && (
              <button
                type="button"
                onClick={() => onContinue(item)}
                className="flex-1 px-1.5 py-1 bg-port-accent/20 hover:bg-port-accent/40 text-port-accent text-[10px] rounded flex items-center justify-center gap-1"
                title="Use last frame as Image Gen source"
              >
                <ImageIcon className="w-3 h-3" /> Continue
              </button>
            )}
            <a
              href={downloadUrl}
              download
              className="px-1.5 py-1 bg-port-border hover:bg-port-border/70 text-white text-[10px] rounded flex items-center justify-center"
              title="Download"
            >
              <Download className="w-3 h-3" />
            </a>
            {onToggleHidden && (
              <button
                type="button"
                onClick={() => onToggleHidden(item)}
                className="px-1.5 py-1 bg-port-border hover:bg-port-border/70 text-white text-[10px] rounded flex items-center justify-center"
                title={item.hidden ? 'Unhide (move out of hidden section)' : 'Hide (move to hidden section)'}
              >
                {item.hidden ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
              </button>
            )}
            {onDelete && (
              <button
                type="button"
                onClick={() => onDelete(item)}
                className="px-1.5 py-1 bg-port-error/20 hover:bg-port-error/40 text-port-error text-[10px] rounded flex items-center justify-center"
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
