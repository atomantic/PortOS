/**
 * DrumTransportBar — the play-along controls for a SongBook `drum` chart (#3115).
 *
 * Purely presentational over `useDrumPlayer`: play/stop, a practice-tempo number
 * input + slider (clamped by `clampBpm`, 20–320), percent-of-written quick
 * buttons that recompute BPM from the chart's `tempo:` marking, a count-in
 * select, a loop toggle with a from/to bar range, and a metronome-click toggle.
 * All state and audio live in the hook — this file only renders and calls back.
 *
 * Every control pairs `<label htmlFor>` with an `id`, and the buttons keep 44px
 * touch targets; the bar wraps so it stays usable on a phone.
 */

import { Play, Square, Repeat, Timer } from 'lucide-react';
import { METRONOME_BPM_MIN, METRONOME_BPM_MAX } from '../../lib/metronome.js';

// Practice speeds as a percentage of the chart's written tempo.
const PERCENTS = [50, 75, 90, 100, 110];
const COUNT_IN_OPTIONS = [0, 1, 2];

// 44px minimum touch targets, matching the viewer's own controls bar.
const ctrlBtnClass = 'flex items-center justify-center min-w-[44px] min-h-[44px] rounded-lg border border-port-border text-gray-300 hover:text-white hover:bg-port-border/50';
const smallSelectClass = 'bg-port-bg border border-port-border rounded px-2 py-2 min-h-[44px] text-xs text-white focus:border-port-accent focus:outline-none';

export default function DrumTransportBar({
  playing, onToggle, hasMusic = true,
  bpm, onBpmChange, onPercent, writtenTempo,
  countInBars, onCountInChange,
  loopEnabled, onLoopToggle, loopFrom, loopTo, onLoopRangeChange, barCount,
  clickEnabled, onClickToggle,
}) {
  const barOptions = Array.from({ length: Math.max(1, barCount) }, (_, i) => i + 1);
  // Which percent button (if any) the current BPM corresponds to — so the active
  // practice speed is visible rather than inferred.
  const activePercent = PERCENTS.find((p) => Math.round((writtenTempo * p) / 100) === bpm);

  return (
    <div className="shrink-0 border-b border-port-border bg-port-card/60 px-3 py-2 flex flex-wrap items-center gap-x-4 gap-y-2">
      {/* Transport */}
      <div className="flex items-center gap-1" role="group" aria-label="Drum play-along">
        <button
          type="button"
          onClick={onToggle}
          // An all-rest chart parses into bars but has nothing to sound — a Play
          // button that silently does nothing reads as broken.
          disabled={!hasMusic}
          className={`${ctrlBtnClass} disabled:opacity-40 disabled:hover:bg-transparent ${playing ? 'text-port-accent border-port-accent/50' : ''}`}
          aria-label={playing ? 'Stop play-along' : 'Play along'}
          title={hasMusic
            ? (playing ? 'Stop (space)' : 'Play along (space)')
            : 'Nothing to play — this chart has no hits yet'}
        >
          {playing ? <Square size={16} /> : <Play size={18} />}
        </button>
      </div>

      {/* Practice tempo */}
      <div className="flex items-center gap-2">
        <label htmlFor="drum-bpm" className="text-xs text-gray-400">BPM</label>
        <input
          id="drum-bpm"
          type="number"
          min={METRONOME_BPM_MIN}
          max={METRONOME_BPM_MAX}
          value={bpm}
          onChange={(e) => onBpmChange(e.target.value)}
          className="w-16 bg-port-bg border border-port-border rounded px-2 py-2 min-h-[44px] text-sm text-white focus:border-port-accent focus:outline-none"
        />
        <label htmlFor="drum-bpm-slider" className="sr-only">Practice tempo</label>
        <input
          id="drum-bpm-slider"
          type="range"
          min={METRONOME_BPM_MIN}
          max={METRONOME_BPM_MAX}
          value={bpm}
          onChange={(e) => onBpmChange(e.target.value)}
          className="w-24 sm:w-32 accent-port-accent"
          title="Practice tempo (+/-)"
        />
      </div>

      {/* Percent of written tempo */}
      <div className="flex items-center gap-1" role="group" aria-label="Percent of written tempo">
        {PERCENTS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => onPercent(p)}
            aria-pressed={activePercent === p}
            className={`px-2 min-h-[44px] rounded-lg border text-xs ${
              activePercent === p
                ? 'border-port-accent/50 text-port-accent'
                : 'border-port-border text-gray-400 hover:text-white hover:bg-port-border/50'
            }`}
            title={`${p}% of the written ${writtenTempo} BPM`}
          >
            {p}%
          </button>
        ))}
      </div>

      {/* Count-in */}
      <div className="flex items-center gap-2">
        <label htmlFor="drum-countin" className="text-xs text-gray-400">Count-in</label>
        <select
          id="drum-countin"
          value={countInBars}
          onChange={(e) => onCountInChange(e.target.value)}
          className={smallSelectClass}
        >
          {COUNT_IN_OPTIONS.map((n) => (
            <option key={n} value={n}>{n === 0 ? 'none' : `${n} bar${n === 1 ? '' : 's'}`}</option>
          ))}
        </select>
      </div>

      {/* Loop */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onLoopToggle(!loopEnabled)}
          aria-pressed={loopEnabled}
          className={`${ctrlBtnClass} ${loopEnabled ? 'text-port-accent border-port-accent/50' : ''}`}
          aria-label={loopEnabled ? 'Disable loop' : 'Enable loop'}
          title="Loop a bar range ([ and ] set the ends)"
        >
          <Repeat size={16} />
        </button>
        {loopEnabled && (
          <>
            <label htmlFor="drum-loop-from" className="sr-only">Loop from bar</label>
            <select
              id="drum-loop-from"
              value={loopFrom}
              onChange={(e) => onLoopRangeChange(Number(e.target.value), loopTo)}
              className={smallSelectClass}
            >
              {barOptions.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <span className="text-xs text-gray-500">–</span>
            <label htmlFor="drum-loop-to" className="sr-only">Loop to bar</label>
            <select
              id="drum-loop-to"
              value={loopTo}
              onChange={(e) => onLoopRangeChange(loopFrom, Number(e.target.value))}
              className={smallSelectClass}
            >
              {barOptions.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </>
        )}
      </div>

      {/* Metronome click */}
      <button
        type="button"
        onClick={() => onClickToggle(!clickEnabled)}
        aria-pressed={clickEnabled}
        className={`${ctrlBtnClass} ${clickEnabled ? 'text-port-accent border-port-accent/50' : ''}`}
        aria-label={clickEnabled ? 'Turn the click off' : 'Turn the click on'}
        title="Metronome click over the kit"
      >
        <Timer size={16} />
      </button>
    </div>
  );
}
