import { useLayoutEffect, useState } from 'react';
import useChordPlayer from '../../hooks/useChordPlayer.js';
import useWakeLock from '../../hooks/useWakeLock.js';
import ChordTransportBar from './ChordTransportBar.jsx';
import TabSheetView from './TabSheetView.jsx';

/**
 * Audible chord-sheet preview — the transport bar plus the rendered sheet with
 * the sounding chord lit. The chord-sheet counterpart of `<DrumPreview>`, shared
 * by the SongBook editor's live preview and the importer's.
 *
 * Playback uses a snapshot captured when Play is pressed. The live source can
 * therefore keep changing without tearing down the schedule mid-run, and the
 * sheet stays on the sounding snapshot too so the highlight keeps pointing at
 * the chord you're actually hearing.
 */
export default function ChordPreview({
  text,
  songId,
  format = 'tab',
  fontSizeRem,
  instrumentView,
  showChordStrip = false,
  sheetClassName = '',
}) {
  const [snapshot, setSnapshot] = useState(text);
  // `plain` is the sheet's explicit opt-out of ALL notation UI, chord tokens
  // included — so it opts out of the play-along too rather than sounding chords
  // the sheet is deliberately not highlighting.
  const player = useChordPlayer(format === 'plain' ? '' : snapshot, { songId });
  const chartChanged = text !== snapshot;
  useWakeLock(player.playing);

  // Keep the idle player current before the browser can paint another
  // interaction target. Play can then start directly from its trusted click
  // (required by Safari/iOS) while edits made during playback stay frozen.
  useLayoutEffect(() => {
    if (!player.playing && snapshot !== text) setSnapshot(text);
  }, [player.playing, snapshot, text]);

  const displayedText = player.playing ? snapshot : text;

  return (
    <div className="min-w-0">
      {/* No bar at all for a sheet with nothing to play — a lyrics-only draft
          shouldn't grow a dead transport above it. */}
      {player.chordCount > 0 && (
        <ChordTransportBar
          playing={player.playing}
          onToggle={player.toggle}
          hasChords={player.hasChords}
          bpm={player.bpm}
          onBpmChange={player.setBpm}
          onPercent={player.setBpmPercent}
          writtenTempo={player.writtenTempo}
          beatsPerBar={player.beatsPerBar}
          onBeatsPerBarChange={player.setBeatsPerBar}
          countInBars={player.countInBars}
          onCountInChange={player.setCountInBars}
          clickEnabled={player.clickEnabled}
          onClickToggle={player.setClickEnabled}
          chordCount={player.chordCount}
          pulse={player.pulse}
        />
      )}
      {/* Only ever true while playing — the layout effect above resyncs the
          snapshot the moment the player goes idle. */}
      {chartChanged && (
        <p className="px-3 py-1.5 text-xs text-port-warning bg-port-warning/10" role="status">
          Sheet changed — press Play to reload.
        </p>
      )}
      <div className={sheetClassName}>
        <TabSheetView
          text={displayedText}
          format={format}
          fontSizeRem={fontSizeRem}
          instrumentView={instrumentView}
          showChordStrip={showChordStrip}
          soundingChord={player.sounding}
        />
      </div>
    </div>
  );
}
