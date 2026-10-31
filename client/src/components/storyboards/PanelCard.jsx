import { ImageIcon, Loader2 } from 'lucide-react';
import { SHOT_TYPE_LABELS } from '../../lib/shotGrammar';
import { formatTimecode } from '../../utils/formatters';
import { aspectClass, formatPanelSeconds, selectedTake, takeSrc } from './storyboardArt';

/**
 * One panel thumbnail: its selected art (or its action as text), a mark while it draws, and a footer line.
 * With its place on a song (`span`, lib/storyboardShotSync.js) the footer also shows when it plays and the line sung over it.
 */
export default function PanelCard({ panel, number, aspectRatio, selected = false, sketchNonce, onOpen, caption, span = null }) {
  const take = selectedTake(panel);
  const src = takeSrc(take, sketchNonce?.(take?.sketchKey));
  const seconds = formatPanelSeconds(panel.seconds);
  const framing = panel.framing ? SHOT_TYPE_LABELS[panel.framing] : null;
  const drawing = Object.values(panel.make?.nodes || {}).some((state) => state?.status === 'running' || state?.status === 'queued');

  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Open panel ${number}${panel.action ? `: ${panel.action}` : ''}`}
      aria-current={selected ? 'true' : undefined}
      className={`group block w-full text-left rounded-lg border bg-port-card overflow-hidden transition-colors ${selected ? 'border-port-accent ring-1 ring-port-accent' : 'border-port-border hover:border-port-accent/50'}`}
    >
      <div className={`${aspectClass(aspectRatio)} w-full bg-port-bg flex items-center justify-center overflow-hidden relative`}>
        {src ? (
          <img src={src} alt="" loading="lazy" className="w-full h-full object-cover" />
        ) : panel.action ? (
          <p className="p-2 text-xs text-gray-400 line-clamp-4">{panel.action}</p>
        ) : (
          <ImageIcon className="w-6 h-6 text-gray-600" aria-hidden="true" />
        )}
        {drawing ? (
          <span className="port-media-overlay-strong absolute right-1 bottom-1 inline-flex items-center gap-1 rounded px-1 text-[10px]">
            <Loader2 size={11} className="animate-spin" aria-hidden="true" /> Drawing
          </span>
        ) : null}
        {caption ? (
          <span className="port-media-overlay-strong absolute left-1 top-1 rounded px-1 text-[10px] max-w-[90%] truncate">{caption}</span>
        ) : null}
      </div>
      <div className="flex items-center gap-1.5 px-2 py-1 text-[11px] text-gray-400 min-w-0">
        <span className="font-semibold text-gray-300 tabular-nums">{number}</span>
        {framing ? <span className="truncate">{framing}</span> : null}
        {seconds ? <span className="ml-auto tabular-nums shrink-0">{seconds}</span> : null}
      </div>
      {span ? (
        <div className="px-2 pb-1 -mt-0.5 text-[11px] text-gray-500 min-w-0">
          <span className={`tabular-nums ${span.pastSong ? 'text-port-warning' : ''}`}>
            {span.beforeSong ? 'Before the song' : `${formatTimecode(span.startSec)}–${formatTimecode(span.endSec)}`}
          </span>
          {span.lyricText ? <p className="truncate italic text-gray-400" title={span.lyricText}>{span.lyricText}</p> : null}
        </div>
      ) : null}
    </button>
  );
}
