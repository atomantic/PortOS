import { useCallback, useLayoutEffect, useMemo, useState } from 'react';
import useDrumPlayer from '../../hooks/useDrumPlayer.js';
import useWakeLock from '../../hooks/useWakeLock.js';
import { chartHasMusic, parseDrumChart } from '../../lib/drumNotation.js';
import DrumSheetView from './DrumSheetView.jsx';
import DrumTransportBar from './DrumTransportBar.jsx';

/**
 * Audible drum-chart preview shared by the SongBook editor and importer.
 *
 * Playback uses a snapshot captured when Play is pressed. The live source can
 * therefore keep changing without rebuilding the Web Audio schedule mid-run.
 * While that happens the sheet stays on the sounding snapshot too, keeping its
 * playhead aligned with what the user hears.
 */
export default function DrumPreview({
  text,
  songId,
  fontSizeRem,
  sheetClassName = '',
  settingsMirror,
}) {
  const [snapshot, setSnapshot] = useState(text);
  const player = useDrumPlayer(snapshot, { songId, initialSettings: settingsMirror });
  const chartChanged = text !== snapshot;
  const liveHasMusic = useMemo(() => chartHasMusic(parseDrumChart(text)), [text]);
  useWakeLock(player.playing);

  // Keep the idle player current before the browser can paint another
  // interaction target. Play can then start directly from its trusted click
  // (required by Safari/iOS) while edits made during playback stay frozen.
  useLayoutEffect(() => {
    if (!player.playing && snapshot !== text) setSnapshot(text);
  }, [player.playing, snapshot, text]);

  const setBpm = useCallback((next) => {
    player.setBpm(next);
    settingsMirror?.setBpm(next);
  }, [player.setBpm, settingsMirror]);
  const setBpmPercent = useCallback((percent) => {
    player.setBpmPercent(percent);
    settingsMirror?.setBpm(Math.round((player.writtenTempo * percent) / 100));
  }, [player.setBpmPercent, player.writtenTempo, settingsMirror]);
  const setCountInBars = useCallback((next) => {
    player.setCountInBars(next);
    settingsMirror?.setCountInBars(next);
  }, [player.setCountInBars, settingsMirror]);
  const setLoopEnabled = useCallback((enabled) => {
    player.setLoopEnabled(enabled);
    settingsMirror?.setLoopEnabled(enabled);
  }, [player.setLoopEnabled, settingsMirror]);
  const setLoopRange = useCallback((from, to) => {
    player.setLoopRange(from, to);
    settingsMirror?.setLoopRange(from, to);
  }, [player.setLoopRange, settingsMirror]);
  const setClickEnabled = useCallback((enabled) => {
    player.setClickEnabled(enabled);
    settingsMirror?.setClickEnabled(enabled);
  }, [player.setClickEnabled, settingsMirror]);
  // The kit persists globally, but the viewer's transport already read it at
  // mount — mirror the change so the two don't disagree until a reload.
  const setKitId = useCallback((next) => {
    player.setKitId(next);
    settingsMirror?.setKitId(next);
  }, [player.setKitId, settingsMirror]);

  const toggle = useCallback(() => {
    player.toggle();
  }, [player.toggle]);

  const displayedText = player.playing ? snapshot : text;

  return (
    <div className="min-w-0">
      {/* A sounding snapshot must keep Stop enabled even if the live draft is silent. */}
      <DrumTransportBar
        playing={player.playing}
        onToggle={toggle}
        hasMusic={player.playing || (chartChanged ? liveHasMusic : player.hasMusic)}
        bpm={player.bpm}
        onBpmChange={setBpm}
        onPercent={setBpmPercent}
        writtenTempo={player.writtenTempo}
        countInBars={player.countInBars}
        onCountInChange={setCountInBars}
        loopEnabled={player.loopEnabled}
        onLoopToggle={setLoopEnabled}
        loopFrom={player.loopFrom}
        loopTo={player.loopTo}
        onLoopRangeChange={setLoopRange}
        barCount={player.barCount}
        clickEnabled={player.clickEnabled}
        onClickToggle={setClickEnabled}
        kitId={player.kitId}
        onKitChange={setKitId}
        beatsPerBar={player.beatsPerBar}
        pulse={player.pulse}
        currentBar={player.currentBar}
      />
      {chartChanged && (
        <p className="px-3 py-1.5 text-xs text-port-warning bg-port-warning/10" role="status">
          Chart changed — press Play to reload.
        </p>
      )}
      <div className={sheetClassName}>
        <DrumSheetView
          text={displayedText}
          fontSizeRem={fontSizeRem}
          getPlayhead={player.getPlayhead}
          playing={player.playing}
        />
      </div>
    </div>
  );
}
