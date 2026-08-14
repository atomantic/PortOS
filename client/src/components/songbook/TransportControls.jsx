/**
 * Shared presentational pieces for the SongBook play-along transports — the
 * drum-kit bar (`DrumTransportBar`) and the chord-sheet bar
 * (`ChordTransportBar`) render the same play button, practice-tempo cluster,
 * percent-of-written buttons, count-in select and beat pulse.
 *
 * Extracted rather than copied so the two bars can't drift on touch-target size,
 * label wording or the ±5 stepper behaviour. Everything here is stateless: the
 * hosting bar owns the values and the callbacks.
 *
 * Every control pairs `<label htmlFor>` with an `id` built off the host's
 * `idPrefix`, so two bars can be mounted on one page without colliding.
 */

import { Play, Square, Minus, Plus } from 'lucide-react';
import { METRONOME_BPM_MIN, METRONOME_BPM_MAX } from '../../lib/metronome.js';
import { ctrlBtnClass, activeCtrlClass, smallSelectClass } from './constants.js';

// The tempo steppers move in fives — a phone user nudging 96→76 shouldn't need
// twenty taps, and the ±1 fine trim is on the keyboard and the number input.
export const BPM_STEP = 5;

// Practice speeds as a percentage of the reference tempo.
export const PERCENTS = [50, 75, 90, 100, 110];

export const COUNT_IN_OPTIONS = [0, 1, 2];

/**
 * Play/stop. `hasMusic` false disables it: a transport that silently does
 * nothing reads as broken, so the reason lives in the title instead.
 */
export const PlayStopButton = ({ playing, onToggle, hasMusic = true, hint, emptyHint }) => (
  <button
    type="button"
    onClick={onToggle}
    disabled={!hasMusic}
    className={`${ctrlBtnClass} disabled:opacity-40 disabled:hover:bg-transparent ${playing ? activeCtrlClass : ''}`}
    aria-label={playing ? 'Stop play-along' : 'Play along'}
    title={hasMusic ? (playing ? `Stop ${hint}` : `Play along ${hint}`) : emptyHint}
  >
    {playing ? <Square size={16} /> : <Play size={18} />}
  </button>
);

/**
 * Practice tempo — steppers everywhere, slider only where there's room. The
 * visible "BPM" carries the unit: an unlabelled number between a minus and a
 * plus, trailed by a slider, reads as a level.
 */
export const TempoControls = ({ idPrefix, bpm, onBpmChange }) => (
  <div className="flex items-center gap-1" role="group" aria-label="Practice tempo">
    <button
      type="button"
      onClick={() => onBpmChange(bpm - BPM_STEP)}
      className={ctrlBtnClass}
      aria-label={`Slower by ${BPM_STEP} BPM`}
      title={`−${BPM_STEP} BPM (− fine-tunes by 1)`}
    >
      <Minus size={16} />
    </button>
    <label htmlFor={`${idPrefix}-bpm`} className="sr-only">Practice tempo (BPM)</label>
    <input
      id={`${idPrefix}-bpm`}
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
    <span aria-hidden="true" className="text-xs text-gray-500 ml-0.5">BPM</span>
    <label htmlFor={`${idPrefix}-bpm-slider`} className="sr-only">Practice tempo slider</label>
    <input
      id={`${idPrefix}-bpm-slider`}
      type="range"
      min={METRONOME_BPM_MIN}
      max={METRONOME_BPM_MAX}
      value={bpm}
      onChange={(e) => onBpmChange(e.target.value)}
      className="hidden md:block w-32 ml-1 accent-port-accent"
      title="Practice tempo (+/-)"
    />
  </div>
);

/**
 * Percent of the reference tempo. The active one is `aria-pressed` so the
 * practice speed is visible rather than inferred.
 */
export const PercentButtons = ({ bpm, writtenTempo, onPercent }) => {
  const active = PERCENTS.find((p) => Math.round((writtenTempo * p) / 100) === bpm);
  return (
    <div className="flex items-center gap-1" role="group" aria-label="Percent of written tempo">
      {PERCENTS.map((p) => (
        <button
          key={p}
          type="button"
          onClick={() => onPercent(p)}
          aria-pressed={active === p}
          className={`px-2 min-h-[44px] rounded-lg border text-xs ${
            active === p
              ? activeCtrlClass
              : 'border-port-border text-gray-400 hover:text-white hover:bg-port-border/50'
          }`}
          title={`${p}% of the written ${writtenTempo} BPM`}
        >
          {p}%
        </button>
      ))}
    </div>
  );
};

export const CountInSelect = ({ idPrefix, countInBars, onCountInChange }) => (
  <div className="flex items-center gap-2">
    <label htmlFor={`${idPrefix}-countin`} className="text-xs text-gray-400">Count-in</label>
    <select
      id={`${idPrefix}-countin`}
      value={countInBars}
      onChange={(e) => onCountInChange(e.target.value)}
      className={smallSelectClass}
    >
      {COUNT_IN_OPTIONS.map((n) => (
        <option key={n} value={n}>{n === 0 ? 'none' : `${n} bar${n === 1 ? '' : 's'}`}</option>
      ))}
    </select>
  </div>
);

/**
 * The pulse row: one dot per beat of the bar, the current one lit. This is the
 * metronome you can SEE — the audible click is easy to lose under a backing,
 * and on a phone the dots double as "yes, it's actually running".
 */
export const BeatDots = ({ beatsPerBar, beat, countingIn }) => (
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
