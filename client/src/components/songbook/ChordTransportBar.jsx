/**
 * ChordTransportBar — the play-along controls for a SongBook chord/tab sheet
 * (#4104), and the chord-sheet sibling of `DrumTransportBar`.
 *
 * Purely presentational over `useChordPlayer`: play/stop, a metronome toggle, a
 * practice-tempo cluster, percent-of-reference quick buttons, a beats-per-chord
 * select, a count-in select, and a live beat/chord readout. All state and audio
 * live in the hook — this file only renders and calls back. The controls
 * themselves come from `TransportControls.jsx`, shared with the drum bar.
 *
 * PHONE-FIRST LAYOUT, same split as the drum bar: a PRIMARY row that is always
 * visible (the ones you touch mid-practice) and a SECONDARY row of setup
 * controls that collapses behind a "More" disclosure under `sm`.
 *
 * BEATS PER CHORD is the control the drum bar has no equivalent of. A chord
 * sheet carries no rhythm — the schedule reads one chord token as one bar — so
 * this is where you tell it how long that bar is. It is a timing setting, so it
 * sits with setup rather than beside Play.
 */

import { useState } from 'react';
import { SlidersHorizontal, Volume2, VolumeX } from 'lucide-react';
import { CHORD_BEATS_MIN, CHORD_BEATS_MAX } from '../../lib/chordPlayback.js';
import { ctrlBtnClass, activeCtrlClass, smallSelectClass } from './constants.js';
import {
  BeatDots, CountInSelect, PercentButtons, PlayStopButton, TempoControls,
} from './TransportControls.jsx';

const BEATS_OPTIONS = Array.from(
  { length: CHORD_BEATS_MAX - CHORD_BEATS_MIN + 1 },
  (_, i) => CHORD_BEATS_MIN + i,
);

export default function ChordTransportBar({
  playing, onToggle, hasChords = true,
  bpm, onBpmChange, onPercent, writtenTempo,
  beatsPerBar, onBeatsPerBarChange,
  countInBars, onCountInChange,
  clickEnabled, onClickToggle,
  chordCount = 0, pulse = null,
  // The host's keyboard shortcut for Play, if it binds one. Only the viewer's
  // play mode does (`p`), so the editor and importer previews must NOT advertise
  // a key that does nothing there — hence a prop rather than a baked-in hint.
  keyHint = '',
}) {
  // Setup controls: collapsed by default on a phone, always shown from `sm` up.
  const [showSetup, setShowSetup] = useState(false);

  return (
    <div className="shrink-0 border-b border-port-border bg-port-card/60 px-3 py-2 space-y-2">
      {/* --- Primary: the controls you touch while playing -------------------- */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {/* A sheet can hold chord-shaped tokens that none of them voice ("N.C."
            alone), so the gate is "something will sound", not "there are
            tokens". */}
        <PlayStopButton
          playing={playing}
          onToggle={onToggle}
          hasMusic={hasChords}
          hint={keyHint}
          emptyHint="Nothing to play — this sheet has no playable chords"
        />

        <button
          type="button"
          onClick={() => onClickToggle(!clickEnabled)}
          aria-pressed={clickEnabled}
          className={`${ctrlBtnClass} ${clickEnabled ? activeCtrlClass : ''}`}
          aria-label={clickEnabled ? 'Turn the metronome off' : 'Turn the metronome on'}
          title={clickEnabled
            ? 'Mute the metronome click — the count-in still sounds'
            : 'Unmute the metronome click'}
        >
          {clickEnabled ? <Volume2 size={16} /> : <VolumeX size={16} />}
        </button>

        <TempoControls idPrefix="chord" bpm={bpm} onBpmChange={onBpmChange} />

        {/* Where you are: the visual pulse plus the chord counter */}
        <div className="flex items-center gap-2">
          <BeatDots beatsPerBar={beatsPerBar} beat={pulse?.beat ?? null} countingIn={!!pulse?.countingIn} />
          <span className="text-xs text-gray-400 tabular-nums whitespace-nowrap">
            {pulse?.countingIn
              ? 'count-in'
              : `${(pulse?.index ?? 0) + 1}/${Math.max(1, chordCount)}`}
          </span>
        </div>

        <button
          type="button"
          onClick={() => setShowSetup((v) => !v)}
          aria-expanded={showSetup}
          aria-controls="chord-setup-controls"
          className={`${ctrlBtnClass} sm:hidden ml-auto ${showSetup ? activeCtrlClass : ''}`}
          aria-label={showSetup ? 'Hide practice settings' : 'Show practice settings'}
          title="Practice speed, beats per chord, count-in"
        >
          <SlidersHorizontal size={16} />
        </button>
      </div>

      {/* --- Secondary: setup you touch between run-throughs ------------------ */}
      <div
        id="chord-setup-controls"
        className={`${showSetup ? 'flex' : 'hidden'} sm:flex flex-wrap items-center gap-x-4 gap-y-2`}
      >
        <PercentButtons bpm={bpm} writtenTempo={writtenTempo} onPercent={onPercent} />

        <div className="flex items-center gap-2">
          <label htmlFor="chord-beats" className="text-xs text-gray-400">Beats per chord</label>
          <select
            id="chord-beats"
            value={beatsPerBar}
            onChange={(e) => onBeatsPerBarChange(e.target.value)}
            className={smallSelectClass}
            title="How long each chord is held — a chord sheet doesn't write it down"
          >
            {BEATS_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
          </select>
        </div>

        <CountInSelect idPrefix="chord" countInBars={countInBars} onCountInChange={onCountInChange} />
      </div>
    </div>
  );
}
