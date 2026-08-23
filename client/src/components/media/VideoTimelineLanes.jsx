/**
 * Presentational blocks for the layered video timeline editor.
 *
 * The video lane is dnd-sortable and lays its blocks out sequentially; the
 * overlay and audio lanes are free-floating and position every block by
 * absolute project time. All of them are memoized — the editor's playhead
 * advances once per animation frame during playback, so an unmemoized block
 * would re-render (and, in the video lane, re-run `useSortable`) 60×/s.
 */

import { memo } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { X, Film, Plus, Music } from 'lucide-react';
import { dndTransformToCss } from '../../lib/dndTransform';
import { clickableProps } from '../../lib/a11yKeyboard.js';
import { assetUrl, segmentDuration } from '../../lib/videoTimelineModel';

const segmentLabel = (segment, meta) => {
  if (!segment) return 'clip';
  if (segment.type === 'still') return segment.assetFile || 'still';
  return meta?.prompt?.trim().slice(0, 40) || 'clip';
};

// Black wedge over the head or tail of a block, sized to the fade's share of
// the segment — the cut reads at a glance without opening the inspector.
function FadeRamp({ side, fadeSec, duration }) {
  if (!(fadeSec > 0)) return null;
  return (
    <div
      data-testid={`fade-${side}-ramp`}
      aria-hidden="true"
      style={{ width: `${Math.min(100, (fadeSec / duration) * 100)}%` }}
      className={`absolute inset-y-0 pointer-events-none ${
        side === 'in'
          ? 'left-0 rounded-l-md bg-gradient-to-r from-black/80 to-transparent'
          : 'right-0 rounded-r-md bg-gradient-to-l from-black/80 to-transparent'
      }`}
    />
  );
}

// Draggable+sortable video-lane block. Snaps the segment's project-time length
// to a width derived from `pxPerSec` so longer segments visibly take more
// horizontal space.
export const TimelineBlock = memo(function TimelineBlock({
  clip, clipMeta, isSelected, isMissing, pxPerSec, onSelect, onRemove,
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: clip._key });
  const isStill = clip.type === 'still';
  const dur = Math.max(0.05, segmentDuration(clip));
  const label = segmentLabel(clip, clipMeta);
  const removeLabel = isMissing ? 'missing clip' : label;
  const thumbSrc = isStill
    ? assetUrl(clip.assetKind, clip.assetFile)
    : (clipMeta?.thumbnail ? assetUrl('video-thumbnails', clipMeta.thumbnail) : null);
  const style = {
    transform: dndTransformToCss(transform),
    transition,
    width: `${Math.max(60, dur * pxPerSec)}px`,
    opacity: isDragging ? 0.4 : 1,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={`relative shrink-0 h-20 rounded-md border-2 cursor-pointer transition-colors group ${
        isMissing
          ? 'bg-port-error/20 border-port-error'
          : isSelected
            ? 'border-port-accent bg-port-accent/10'
            : 'bg-port-card border-port-border hover:border-port-accent/50'
      }`}
      onClick={() => onSelect(clip._key)}
      {...attributes}
      {...listeners}
      {...clickableProps(() => onSelect(clip._key))}
    >
      {thumbSrc && (
        <img src={thumbSrc} alt="" draggable={false} className="w-full h-full object-cover rounded-md opacity-80" />
      )}
      <div className="absolute inset-0 rounded-md bg-gradient-to-t from-black/70 via-transparent to-transparent pointer-events-none" />
      <FadeRamp side="in" fadeSec={clip.fadeInSec} duration={dur} />
      <FadeRamp side="out" fadeSec={clip.fadeOutSec} duration={dur} />
      <div className="absolute bottom-1 left-1.5 right-1.5 text-[10px] text-white truncate font-medium">
        {isMissing ? '(missing)' : label}
      </div>
      <div className="absolute top-1 left-1.5 text-[9px] text-white bg-black/60 px-1 rounded">
        {isStill ? `still · ${dur.toFixed(2)}s` : `${dur.toFixed(2)}s`}
      </div>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onRemove(clip._key); }}
        onPointerDown={(e) => e.stopPropagation()}
        className="absolute top-0 right-0 inline-flex min-w-[44px] min-h-[44px] items-start justify-end p-1 rounded opacity-40 lg:opacity-0 lg:group-hover:opacity-100 focus-visible:opacity-100 transition-opacity text-white group/remove"
        title="Remove from timeline"
        aria-label={`Remove ${removeLabel} from timeline`}
      >
        <span className="inline-flex items-center justify-center p-0.5 bg-black/60 group-hover/remove:bg-port-error rounded transition-colors" aria-hidden="true">
          <X className="w-3 h-3" />
        </span>
      </button>
    </div>
  );
});

// A free-floating lane block (overlay or audio bed). Unlike the video lane
// these are positioned by absolute project time, so they carry no sort order —
// the inspector's start field is what moves them.
export const LaneBlock = memo(function LaneBlock({
  entry, label, tone, isSelected, isMissing, pxPerSec, onSelect, onRemove,
}) {
  const dur = Math.max(0.05, entry.durationSec || 0);
  const style = {
    left: `${(entry.startSec || 0) * pxPerSec}px`,
    width: `${Math.max(28, dur * pxPerSec)}px`,
  };
  return (
    <div
      style={style}
      className={`absolute top-1 bottom-1 rounded border cursor-pointer overflow-hidden ${
        isMissing
          ? 'bg-port-error/20 border-port-error'
          : isSelected
            ? 'border-port-accent bg-port-accent/20'
            : `${tone} hover:border-port-accent/50`
      }`}
      onClick={() => onSelect(entry._key)}
      {...clickableProps(() => onSelect(entry._key))}
    >
      <span className="absolute inset-x-1 top-0.5 text-[9px] text-white truncate pointer-events-none">
        {isMissing ? '(missing)' : label}
      </span>
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onRemove(entry._key); }}
        onPointerDown={(e) => e.stopPropagation()}
        className="absolute bottom-0 right-0 p-0.5 text-white/70 hover:text-port-error"
        title="Remove"
        aria-label={`Remove ${label} from timeline`}
      >
        <X className="w-3 h-3" aria-hidden="true" />
      </button>
    </div>
  );
});

/**
 * One free-floating lane (overlays or audio), with its own playhead marker.
 * Both lanes are in true project-time coordinates; the video lane is not (it
 * lays blocks out sequentially with a gap and a minimum width), which is why
 * the marker lives here rather than spanning all three.
 */
export const FloatingLane = memo(function FloatingLane({
  title, entries, emptyHint, tone, labelOf, isMissing, selectedKey, pxPerSec, width, playheadSec, onSelect, onRemove,
}) {
  return (
    <>
      <div className="text-[9px] uppercase tracking-wide text-gray-600 px-0.5 pt-1">{title}</div>
      <div className="relative h-8 bg-port-bg/40 rounded" style={{ width: `${width}px` }}>
        {entries.length === 0 && (
          <span className="absolute inset-0 flex items-center pl-2 text-[10px] text-gray-600">{emptyHint}</span>
        )}
        {entries.map((entry) => (
          <LaneBlock
            key={entry._key}
            entry={entry}
            label={labelOf(entry)}
            tone={tone}
            isSelected={entry._key === selectedKey}
            isMissing={isMissing(entry)}
            pxPerSec={pxPerSec}
            onSelect={onSelect}
            onRemove={onRemove}
          />
        ))}
        <div
          data-testid={`${title.toLowerCase()}-playhead`}
          aria-hidden="true"
          style={{ left: `${playheadSec * pxPerSec}px` }}
          className="absolute inset-y-0 w-px bg-port-accent pointer-events-none"
        />
      </div>
    </>
  );
});

// Library tile — renders a clip from history with an "Add to timeline" button.
// Click-to-add-at-end is simpler than DnD here and equally functional;
// reordering on the timeline itself uses sortable.
export const LibraryTile = memo(function LibraryTile({ clip, onAdd }) {
  const dur = clip.numFrames && clip.fps ? clip.numFrames / clip.fps : 0;
  return (
    <div className="bg-port-card border border-port-border rounded-md overflow-hidden hover:border-port-accent/50 transition-colors">
      <div className="aspect-video bg-port-bg relative">
        {clip.thumbnail ? (
          <img src={assetUrl('video-thumbnails', clip.thumbnail)} alt={clip.prompt} className="w-full h-full object-cover" loading="lazy" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-gray-600">
            <Film className="w-6 h-6" />
          </div>
        )}
        <span className="absolute bottom-1 right-1 text-[9px] px-1 py-0.5 bg-black/70 text-white rounded">
          {dur.toFixed(1)}s
        </span>
      </div>
      <div className="p-1.5 space-y-1">
        <p className="text-[10px] text-gray-300 line-clamp-2" title={clip.prompt}>{clip.prompt}</p>
        <button
          type="button"
          onClick={() => onAdd(clip)}
          className="w-full flex items-center justify-center gap-1 px-1.5 py-1 bg-port-accent/20 hover:bg-port-accent/40 text-port-accent text-[10px] rounded"
        >
          <Plus className="w-3 h-3" /> Add to timeline
        </button>
      </div>
    </div>
  );
});

// Gallery tile — one image, two destinations. A still joins the video lane as
// its own held segment; an overlay floats above whatever is playing at the
// current playhead.
export const StillTile = memo(function StillTile({ image, onAddStill, onAddOverlay }) {
  const src = assetUrl('images', image.filename);
  return (
    <div className="bg-port-card border border-port-border rounded-md overflow-hidden hover:border-port-accent/50 transition-colors">
      <div className="aspect-video bg-port-bg">
        {src && <img src={src} alt={image.filename} className="w-full h-full object-cover" loading="lazy" />}
      </div>
      <div className="p-1.5 space-y-1">
        <p className="text-[10px] text-gray-300 truncate" title={image.filename}>{image.filename}</p>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={() => onAddStill(image)}
            className="flex-1 px-1 py-1 bg-port-accent/20 hover:bg-port-accent/40 text-port-accent text-[10px] rounded"
          >
            Still
          </button>
          <button
            type="button"
            onClick={() => onAddOverlay(image)}
            className="flex-1 px-1 py-1 bg-port-card border border-port-border hover:border-port-accent text-gray-300 text-[10px] rounded"
          >
            Overlay
          </button>
        </div>
      </div>
    </div>
  );
});

export const AudioRow = memo(function AudioRow({ track, onAdd }) {
  return (
    <div className="flex items-center gap-2 bg-port-card border border-port-border rounded-md px-2 py-1.5 hover:border-port-accent/50 transition-colors">
      <Music className="w-3 h-3 text-gray-500 shrink-0" aria-hidden="true" />
      <span className="text-[10px] text-gray-300 truncate flex-1" title={track.filename}>{track.label || track.filename}</span>
      <button
        type="button"
        onClick={() => onAdd(track)}
        className="px-1.5 py-1 bg-port-accent/20 hover:bg-port-accent/40 text-port-accent text-[10px] rounded shrink-0"
      >
        Add
      </button>
    </div>
  );
});
