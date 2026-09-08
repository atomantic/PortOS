import { ChevronDown, ChevronRight } from 'lucide-react';

/**
 * A collapsible header band for the SongBook viewer's play mode — the shared
 * chrome behind the Audio, Play along, and Chords used cards that sit ABOVE the
 * sheet scroller (`shrink-0`, so they persist while the sheet scrolls under
 * them).
 *
 * The header row is deliberately terse (one line, `text-xs`): three stacked
 * cards must cost almost nothing when collapsed, which is the whole point of
 * moving them out of the scroller. `summary` renders beside the label only
 * while collapsed, truncated to one line, so a closed card still says what it
 * holds.
 *
 * The body stays MOUNTED and is hidden with the `hidden` attribute rather than
 * unmounted: the cards wrap live transports whose inner setup disclosure
 * (`ChordTransportBar`'s "More") is local state, and collapsing the card while
 * a play-along runs must not throw that away.
 */
export default function CollapsibleBar({
  id,
  label,
  summary = '',
  open,
  onToggle,
  bodyClassName = '',
  children,
}) {
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className="shrink-0">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={id}
        className="w-full flex items-center gap-1.5 border-b border-port-border bg-port-card/60 px-3 py-2 text-xs text-gray-400 hover:text-white"
      >
        <Chevron size={13} className="shrink-0" />
        <span className="font-semibold shrink-0">{label}</span>
        {summary && !open
          ? <span className="min-w-0 truncate text-gray-500">{summary}</span>
          : null}
      </button>
      <div id={id} hidden={!open} className={bodyClassName}>{children}</div>
    </div>
  );
}
