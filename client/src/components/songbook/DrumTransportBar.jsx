/**
 * DrumTransportBar — the play-along controls for a SongBook `drum` chart (#3115).
 *
 * Purely presentational over `useDrumPlayer`: play/stop, a practice-tempo
 * stepper + number input (slider on wider screens, clamped by `clampBpm`,
 * 20–320), percent-of-written quick buttons that recompute BPM from the chart's
 * `tempo:` marking, a kit picker (TR-909 / TR-808 / Acoustic), a count-in select,
 * a loop toggle with a from/to bar range, a metronome-click toggle, and a live
 * beat/bar readout. All state and audio live in the hook — this file only
 * renders and calls back.
 *
 * PHONE-FIRST LAYOUT. A phone is the primary SongBook surface, and the previous
 * one-flat-wrapping-row bar cost three stacked rows (~330px) before the sheet
 * even started. So the controls split in two:
 * - a PRIMARY row that is always visible — the ones you touch mid-practice
 *   (play, tempo, click) plus the beat readout; and
 * - a SECONDARY row of setup controls (practice percent, count-in, loop range)
 *   that collapses behind a "More" disclosure under `sm` and sits inline above
 *   it from `sm` up, where there's room.
 *
 * Every control pairs `<label htmlFor>` with an `id`, and the buttons keep 44px
 * touch targets.
 */

import { useMemo, useState } from 'react';
import { Play, Square, Repeat, Timer, Minus, Plus, SlidersHorizontal } from 'lucide-react';
import { METRONOME_BPM_MIN, METRONOME_BPM_MAX } from '../../lib/metronome.js';
import { DRUM_KIT_LIST, resolveDrumKit } from '../../lib/drumKits.js';
import { ctrlBtnClass, activeCtrlClass } from './constants.js';

// Practice speeds as a percentage of the chart's written tempo.
const PERCENTS = [50, 75, 90, 100, 110];
const COUNT_IN_OPTIONS = [0, 1, 2];
// The tempo steppers move in fives — a phone user nudging 96→76 shouldn't need
// twenty taps, and the ±1 fine trim is on the keyboard (+/-) and the input.
const BPM_STEP = 5;

const smallSelectClass = 'bg-port-bg border border-port-border rounded px-2 py-2 min-h-[44px] text-xs text-white focus:border-port-accent focus:outline-none';

// The pulse row: one dot per notated beat of the bar, the current one lit. This
// is the metronome you can SEE — the audible click is easy to lose under a kit,
// and on a phone the dots double as "yes, it's actually running".
const BeatDots = ({ beatsPerBar, beat, countingIn }) => (
  <div
    className="flex items-center gap-1"
    role="status"
    aria-live="off"
    aria-label={countingIn ? `Counting in, beat ${beat || 1}` : (beat ? `Beat ${beat}` : 'Stopped')}
  >
    {Array.from({ length: beatsPerBar }, (_, i) => {
      const lit = beat === i + 1;
      return (
        <span
          key={i}
          aria-hidden="true"
          className={`rounded-full ${lit ? 'w-2.5 h-2.5' : 'w-1.5 h-1.5'} ${
            !lit ? 'bg-port-border' : (countingIn ? 'bg-port-warning' : 'bg-port-accent')
          }`}
        />
      );
    })}
  </div>
);

export default function DrumTransportBar({
  playing, onToggle, hasMusic = true,
  bpm, onBpmChange, onPercent, writtenTempo,
  countInBars, onCountInChange,
  loopEnabled, onLoopToggle, loopFrom, loopTo, onLoopRangeChange, barCount,
  clickEnabled, onClickToggle,
  kitId, onKitChange,
  beatsPerBar = 4, pulse = null, currentBar = null,
}) {
  // Setup controls: collapsed by default on a phone, always shown from `sm` up.
  const [showSetup, setShowSetup] = useState(false);

  // `pulse` turns over on every beat, so the bar-range options must not be
  // rebuilt with it — a 32-bar song is 64 <option>s per beat otherwise.
  const barOptions = useMemo(
    () => Array.from({ length: Math.max(1, barCount) }, (_, i) => i + 1),
    [barCount],
  );
  // Which percent button (if any) the current BPM corresponds to — so the active
  // practice speed is visible rather than inferred.
  const activePercent = PERCENTS.find((p) => Math.round((writtenTempo * p) / 100) === bpm);

  return (
    <div className="shrink-0 border-b border-port-border bg-port-card/60 px-3 py-2 space-y-2">
      {/* --- Primary: the controls you touch while playing -------------------- */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="flex items-center gap-1.5" role="group" aria-label="Drum play-along">
          <button
            type="button"
            onClick={onToggle}
            // An all-rest chart parses into bars but has nothing to sound — a Play
            // button that silently does nothing reads as broken.
            disabled={!hasMusic}
            className={`${ctrlBtnClass} disabled:opacity-40 disabled:hover:bg-transparent ${playing ? activeCtrlClass : ''}`}
            aria-label={playing ? 'Stop play-along' : 'Play along'}
            title={hasMusic
              ? (playing ? 'Stop (space)' : 'Play along (space)')
              : 'Nothing to play — this chart has no hits yet'}
          >
            {playing ? <Square size={16} /> : <Play size={18} />}
          </button>

          {/* Metronome click — a primary control: it's the thing you toggle
              between "play me the groove" and "just count me in". */}
          <button
            type="button"
            onClick={() => onClickToggle(!clickEnabled)}
            aria-pressed={clickEnabled}
            className={`${ctrlBtnClass} ${clickEnabled ? activeCtrlClass : ''}`}
            aria-label={clickEnabled ? 'Turn the metronome off' : 'Turn the metronome on'}
            title="Metronome click over the kit"
          >
            <Timer size={16} />
          </button>
        </div>

        {/* Practice tempo — steppers everywhere, slider only where there's room */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onBpmChange(bpm - BPM_STEP)}
            className={ctrlBtnClass}
            aria-label={`Slower by ${BPM_STEP} BPM`}
            title={`−${BPM_STEP} BPM (− fine-tunes by 1)`}
          >
            <Minus size={16} />
          </button>
          <label htmlFor="drum-bpm" className="sr-only">Practice tempo (BPM)</label>
          <input
            id="drum-bpm"
            type="number"
            inputMode="numeric"
            min={METRONOME_BPM_MIN}
            max={METRONOME_BPM_MAX}
            value={bpm}
            onChange={(e) => onBpmChange(e.target.value)}
            className="w-14 bg-port-bg border border-port-border rounded px-1 py-2 min-h-[44px] text-sm text-center text-white focus:border-port-accent focus:outline-none"
            title="Practice tempo (BPM)"
          />
          <button
            type="button"
            onClick={() => onBpmChange(bpm + BPM_STEP)}
            className={ctrlBtnClass}
            aria-label={`Faster by ${BPM_STEP} BPM`}
            title={`+${BPM_STEP} BPM (+ fine-tunes by 1)`}
          >
            <Plus size={16} />
          </button>
          <label htmlFor="drum-bpm-slider" className="sr-only">Practice tempo slider</label>
          <input
            id="drum-bpm-slider"
            type="range"
            min={METRONOME_BPM_MIN}
            max={METRONOME_BPM_MAX}
            value={bpm}
            onChange={(e) => onBpmChange(e.target.value)}
            className="hidden md:block w-32 ml-1 accent-port-accent"
            title="Practice tempo (+/-)"
          />
        </div>

        {/* Where you are: the visual pulse plus the bar counter */}
        <div className="flex items-center gap-2">
          <BeatDots beatsPerBar={beatsPerBar} beat={pulse?.beat ?? null} countingIn={!!pulse?.countingIn} />
          <span className="text-xs text-gray-400 tabular-nums whitespace-nowrap">
            {pulse?.countingIn ? 'count-in' : `${currentBar || 1}/${Math.max(1, barCount)}`}
          </span>
        </div>

        {/* Disclosure for the setup controls — phone only; from `sm` up they're
            always rendered below. */}
        <button
          type="button"
          onClick={() => setShowSetup((v) => !v)}
          aria-expanded={showSetup}
          aria-controls="drum-setup-controls"
          className={`${ctrlBtnClass} sm:hidden ml-auto ${showSetup ? activeCtrlClass : ''}`}
          aria-label={showSetup ? 'Hide practice settings' : 'Show practice settings'}
          title="Practice speed, count-in, loop"
        >
          <SlidersHorizontal size={16} />
        </button>
      </div>

      {/* --- Secondary: setup you touch between run-throughs ------------------ */}
      <div
        id="drum-setup-controls"
        className={`${showSetup ? 'flex' : 'hidden'} sm:flex flex-wrap items-center gap-x-4 gap-y-2`}
      >
        <div className="flex items-center gap-1" role="group" aria-label="Percent of written tempo">
          {PERCENTS.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => onPercent(p)}
              aria-pressed={activePercent === p}
              className={`px-2 min-h-[44px] rounded-lg border text-xs ${
                activePercent === p
                  ? activeCtrlClass
                  : 'border-port-border text-gray-400 hover:text-white hover:bg-port-border/50'
              }`}
              title={`${p}% of the written ${writtenTempo} BPM`}
            >
              {p}%
            </button>
          ))}
        </div>

        {/* Which synthesized kit sounds the chart. A taste setting rather than a
            practice one, so it sits with the setup controls — but it applies
            live, without stopping playback. */}
        <div className="flex items-center gap-2">
          <label htmlFor="drum-kit" className="text-xs text-gray-400">Kit</label>
          <select
            id="drum-kit"
            value={kitId}
            onChange={(e) => onKitChange(e.target.value)}
            className={smallSelectClass}
            title={resolveDrumKit(kitId).description}
          >
            {DRUM_KIT_LIST.map((kit) => (
              <option key={kit.id} value={kit.id}>{kit.label}</option>
            ))}
          </select>
        </div>

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

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onLoopToggle(!loopEnabled)}
            aria-pressed={loopEnabled}
            className={`${ctrlBtnClass} ${loopEnabled ? activeCtrlClass : ''}`}
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
      </div>
    </div>
  );
}
