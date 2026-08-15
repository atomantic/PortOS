/**
 * DrumTransportBar — the play-along controls for a SongBook `drum` chart (#3115).
 *
 * Purely presentational over `useDrumPlayer`: play/stop, a practice-tempo
 * stepper + number input (slider on wider screens, clamped by `clampBpm`,
 * 20–320), percent-of-written quick buttons that recompute BPM from the chart's
 * `tempo:` marking, a kit picker (TR-909 / TR-808 / Acoustic), a count-in select,
 * a loop toggle with a from/to bar range, a metronome mute + volume pair, and a
 * live beat/bar readout. All state and audio live in the hook — this file only
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
import { Repeat, SlidersHorizontal, Volume2, VolumeX } from 'lucide-react';
import { DRUM_KIT_LIST, resolveDrumKit } from '../../lib/drumKits.js';
import { clampClickVolume, DEFAULT_CLICK_VOLUME } from '../../lib/drumPlayback.js';
import { ctrlBtnClass, activeCtrlClass, smallSelectClass } from './constants.js';
import BeatPulse from '../ui/BeatPulse.jsx';
import {
  CountInSelect, PercentButtons, PlayStopButton, TempoControls,
} from './TransportControls.jsx';

export default function DrumTransportBar({
  playing, onToggle, hasMusic = true,
  bpm, onBpmChange, onPercent, writtenTempo,
  countInBars, onCountInChange,
  loopEnabled, onLoopToggle, loopFrom, loopTo, onLoopRangeChange, barCount,
  clickEnabled, onClickToggle,
  clickVolume = DEFAULT_CLICK_VOLUME, onClickVolumeChange,
  kitId, onKitChange,
  beatsPerBar = 4, pulse = null, currentBar = null,
}) {
  // Setup controls: collapsed by default on a phone, always shown from `sm` up.
  const [showSetup, setShowSetup] = useState(false);

  // The click level rides a 0–100 slider but is stored 0–1, so the two ends
  // convert here rather than leaking percent into the player.
  const clickPercent = Math.round((clampClickVolume(clickVolume) ?? DEFAULT_CLICK_VOLUME) * 100);

  // `pulse` turns over on every beat, so the bar-range options must not be
  // rebuilt with it — a 32-bar song is 64 <option>s per beat otherwise.
  const barOptions = useMemo(
    () => Array.from({ length: Math.max(1, barCount) }, (_, i) => i + 1),
    [barCount],
  );
  return (
    <div className="shrink-0 border-b border-port-border bg-port-card/60 px-3 py-2 space-y-2">
      {/* --- Primary: the controls you touch while playing -------------------- */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {/* An all-rest chart parses into bars but has nothing to sound. */}
        <PlayStopButton
          playing={playing}
          onToggle={onToggle}
          hasMusic={hasMusic}
          hint="(space)"
          emptyHint="Nothing to play — this chart has no hits yet"
        />

        {/* Metronome — a primary control: it's the thing you toggle between
            "play me the groove" and "just count me in", and the level you
            balance against your own playing.

            It reads as a VOLUME (speaker icon + its own short slider) so the
            tempo control beside it can't be mistaken for one — with the BPM
            slider as the bar's only slider, that was exactly the confusion. */}
        <div className="flex items-center gap-1" role="group" aria-label="Metronome">
          <button
            type="button"
            onClick={() => onClickToggle(!clickEnabled)}
            aria-pressed={clickEnabled}
            className={`${ctrlBtnClass} ${clickEnabled ? activeCtrlClass : ''}`}
            aria-label={clickEnabled ? 'Turn the metronome off' : 'Turn the metronome on'}
            title={clickEnabled
              ? 'Mute the metronome click (m) — the count-in still sounds'
              : 'Unmute the metronome click (m)'}
          >
            {clickEnabled ? <Volume2 size={16} /> : <VolumeX size={16} />}
          </button>
          <label htmlFor="drum-click-volume" className="sr-only">Metronome volume</label>
          <input
            id="drum-click-volume"
            type="range"
            min={0}
            max={100}
            step={5}
            value={clickPercent}
            onChange={(e) => onClickVolumeChange(Number(e.target.value) / 100)}
            aria-valuetext={`${clickPercent}%`}
            // Tall box, thin native track: the thumb centers in it, so a phone
            // gets a 44px drag target without the slider looking chunky.
            className="w-14 sm:w-20 min-h-[44px] accent-port-accent"
            title={`Metronome volume (${clickPercent}%)`}
          />
        </div>

        <TempoControls idPrefix="drum" bpm={bpm} onBpmChange={onBpmChange} />

        {/* Where you are: the visual pulse plus the bar counter */}
        <div className="flex items-center gap-2">
          <BeatPulse beatsPerBar={beatsPerBar} beat={pulse?.beat} countingIn={pulse?.countingIn} />
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
        <PercentButtons bpm={bpm} writtenTempo={writtenTempo} onPercent={onPercent} />

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

        <CountInSelect idPrefix="drum" countInBars={countInBars} onCountInChange={onCountInChange} />

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
