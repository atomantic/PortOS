import { memo, useMemo } from 'react';
import ChordDiagram from './ChordDiagram.jsx';
import CollapsibleSection from '../ui/CollapsibleSection.jsx';
import { sheetUsedChords } from '../../lib/chordShapes.js';

/**
 * "Chords used" — every chord the sheet names, in order of first appearance,
 * each with a mini diagram for the active instrument view.
 *
 * It lived inside `<TabSheetView>` (a strip above the sheet) until it moved out
 * here so the viewer can pin it in the header band ABOVE the scroller: the
 * shapes you are reaching for are the thing you want on screen at bar 60, not
 * only at bar 1. The host owns (and persists) the open flag.
 */
function ChordsUsedCard({ text, instrument, open, onToggle }) {
  const chords = useMemo(() => sheetUsedChords(text), [text]);
  if (chords.length === 0) return null;
  return (
    <CollapsibleSection
      id="song-chords-used"
      size="bar"
      label={`Chords used (${chords.length})`}
      summary={chords.join(' · ')}
      open={open}
      onOpenChange={onToggle}
      className="shrink-0"
      buttonClassName="border-b border-port-border bg-port-card/60 px-3"
      // A 12-chord song must not push the sheet itself off a phone screen.
      bodyClassName="border-b border-port-border bg-port-card/40 px-3 py-2 max-h-[30vh] overflow-y-auto"
    >
      <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
        {chords.map((name) => (
          <div key={name} className="flex flex-col items-center gap-0.5">
            <span className="text-[11px] font-mono font-semibold text-port-accent">{name}</span>
            <ChordDiagram name={name} instrument={instrument} size="sm" />
          </div>
        ))}
      </div>
    </CollapsibleSection>
  );
}

// Every prop is a primitive or the host's stable toggle, so memo keeps the
// diagrams out of the viewer's per-beat re-render.
export default memo(ChordsUsedCard);
