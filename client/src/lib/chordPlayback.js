// Chord-sheet play-along for the SongBook `tab` / `chordpro` formats (#4104) —
// the MIDI/score preview `<TabSheetView>` embeds, and the chord-sheet sibling of
// `drumPlayback.js`. Turns the chord tokens a sheet already carries into a
// strummed, tempo-adjustable backing you can practice against, with the sounding
// chord lit in the sheet.
//
// Like every other synth player in this tree it is a thin scheduler over the
// shared `lookaheadTransport.js` (clock, node lifecycle, teardown) and sounds
// through `scheduleTone` from `scorePlayback.js`, so the preview has the same
// voice as the lead-sheet and MIDI previews rather than a fourth synth.
//
// A CHORD SHEET CARRIES NO RHYTHM. Chords-over-lyrics notation says WHICH chords
// and IN WHAT ORDER, never how long each is held — so the schedule reads one
// chord token as one bar, the convention a player falls back on when reading a
// sheet cold. A dash-joined quick change ("Am-Am7") splits its own bar between
// its segments, which is exactly what that notation means. Tab staffs, lyrics
// and prose contribute nothing.
//
// `buildChordSchedule` is PURE (no Web Audio) so the timing math is unit-testable
// in a node env, mirroring `buildDrumSchedule` / `buildSchedule`.

import { getAudioContext as ctx } from './audioContext.js';
import { createLookaheadTransport, SYNTH_TIMING } from './lookaheadTransport.js';
import { makeSafeCall, midiToFreq, scheduleTone } from './scorePlayback.js';
import { chordTones, splitJoinedChords } from './chordShapes.js';

const { SCHEDULE_AHEAD } = SYNTH_TIMING;
const safeCall = makeSafeCall('chord playback');

// Tempo a sheet with no `tempo:` marking plays at. A chord sheet has no tempo
// field at all, so this is always the reference the percent buttons work off.
export const DEFAULT_CHORD_TEMPO = 90;
// One chord token = one bar of this many beats (see the header note).
export const DEFAULT_CHORD_BEATS_PER_BAR = 4;
export const CHORD_BEATS_MIN = 2;
export const CHORD_BEATS_MAX = 12;
export const CHORD_COUNT_IN_MAX = 4;

// Where the voicing sits. The root lands in the octave starting at MIDI 48 (C3)
// — comfortably under a sung melody — and the bass note an octave and a half
// below that, so the chord reads as a chord rather than a cluster.
const ROOT_BASE_MIDI = 48;
const BASS_BASE_MIDI = 36;

// A strum, not a block chord: each note of the voicing starts this much after
// the one below it. Small enough to still hear as one chord.
const STRUM_SEC = 0.022;
// Per-note gain. Deliberately under `scorePlayback`'s single-voice default —
// four or five tones stack here where the melody synth sounds one.
const CHORD_TONE_PEAK = 0.085;
const BASS_TONE_PEAK = 0.1;
// Count-in / downbeat click: a short high blip, so it cuts through the chords.
const CLICK_FREQ = 1320;
const CLICK_ACCENT_FREQ = 1760;
const CLICK_DUR_SEC = 0.045;
const CLICK_PEAK = 0.14;

const clampInt = (value, min, max, fallback) => {
  const n = Math.trunc(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

// --- Schedule building (pure) ----------------------------------------------

/**
 * The ordered chord occurrences a parsed sheet holds — the play-along's source
 * material AND the identity the sheet highlights against.
 *
 * `lineIndex` / `chordIndex` address the token in `parseTabSheet(text).lines`,
 * so a renderer can light the exact token that is sounding without the schedule
 * knowing anything about how the sheet is laid out. A dash-joined token yields
 * one occurrence per segment, all pointing at that same token.
 *
 * @param {Array} lines — `parseTabSheet(text).lines`.
 * @returns {Array<{ lineIndex, chordIndex, segment, segments, name }>}
 */
export const sheetChordOccurrences = (lines) => {
  const out = [];
  (Array.isArray(lines) ? lines : []).forEach((line, lineIndex) => {
    (Array.isArray(line?.chords) ? line.chords : []).forEach((chord, chordIndex) => {
      const parts = splitJoinedChords(chord?.name);
      parts.forEach((name, segment) => {
        out.push({ lineIndex, chordIndex, segment, segments: parts.length, name });
      });
    });
  });
  return out;
};

// A chord name → the MIDI notes that sound it, low to high. `null` (an
// unvoiceable token — "N.C.", an exotic quality) is a REST, not silence-shaped
// noise: the bar still passes, so the sheet keeps its place.
export const chordMidiNotes = (name) => {
  const tones = chordTones(name);
  if (!tones) return null;
  const rootMidi = ROOT_BASE_MIDI + tones.rootPc;
  const bassPc = tones.bassPc ?? tones.rootPc;
  return [BASS_BASE_MIDI + bassPc, ...tones.semitones.map((semis) => rootMidi + semis)];
};

/**
 * Flatten a parsed sheet's chords into absolute-time strum events.
 *
 * @param {Array} lines — `parseTabSheet(text).lines`.
 * @param {object} [options]
 * @param {number} [options.bpm] — practice tempo (default 90).
 * @param {number} [options.beatsPerBar] — beats one chord is held for (default 4).
 * @param {number} [options.countInBars] — click-only lead-in bars (0–4).
 * @returns {{ events, clicks, bpm, beatSec, barSec, beatsPerBar, countInSec, totalSec }}
 */
export const buildChordSchedule = (lines, options = {}) => {
  const bpm = Number.isFinite(options.bpm) && options.bpm > 0 ? options.bpm : DEFAULT_CHORD_TEMPO;
  const beatsPerBar = clampInt(options.beatsPerBar, CHORD_BEATS_MIN, CHORD_BEATS_MAX, DEFAULT_CHORD_BEATS_PER_BAR);
  const countInBars = clampInt(options.countInBars, 0, CHORD_COUNT_IN_MAX, 0);
  const beatSec = 60 / bpm;
  const barSec = beatSec * beatsPerBar;
  const countInSec = countInBars * barSec;

  // The count-in is its own list rather than an entry in `events`: `events` is
  // indexed 1:1 with the sheet's chord tokens (that index IS the highlight), and
  // interleaving clicks would make the index mean two different things.
  const clicks = [];
  for (let bar = 0; bar < countInBars; bar += 1) {
    for (let beat = 0; beat < beatsPerBar; beat += 1) {
      clicks.push({
        beat: beat + 1,
        accent: beat === 0,
        startSec: (bar * beatsPerBar + beat) * beatSec,
      });
    }
  }

  let cursor = countInSec;
  const events = sheetChordOccurrences(lines).map((occurrence, index) => {
    // A dash-joined token's segments share the token's one bar.
    const durSec = barSec / occurrence.segments;
    const startSec = cursor;
    cursor += durSec;
    const midis = chordMidiNotes(occurrence.name);
    return { index, ...occurrence, midis: midis || [], rest: !midis, startSec, durSec };
  });

  return {
    events,
    clicks,
    bpm,
    beatSec,
    barSec,
    beatsPerBar,
    countInSec,
    totalSec: events.length ? cursor : 0,
  };
};

/**
 * A built schedule + a live clock position → what the UI should show (pure).
 *
 * Read off the audio clock rather than the player's `onChord` events, for the
 * same reason `resolvePlayhead` exists on the drum side: an event callback
 * stands still through the count-in and through a stretch with no voiceable
 * chord, so anything that has to keep moving reads the clock instead.
 *
 * Returns `null` when there is nothing to place; otherwise
 * `{ countIn: true, beat }` during the lead-in, else
 * `{ countIn: false, index, beat }` — `index` into `schedule.events`.
 */
export const resolveChordPlayhead = (schedule, posSec) => {
  const events = Array.isArray(schedule?.events) ? schedule.events : [];
  const { beatSec, beatsPerBar, countInSec = 0, totalSec = 0 } = schedule || {};
  if (!events.length || !(beatSec > 0)) return null;
  const pos = Number.isFinite(posSec) ? posSec : 0;

  // `countInSec > 0` is load-bearing, not redundant: the transport's pre-roll
  // lead makes `pos` briefly NEGATIVE, so a bare `pos < countInSec` would report
  // "counting in" for the first ~80ms of a run that has no count-in at all —
  // yellow beat dots and a null highlight before the first chord.
  if (countInSec > 0 && pos < countInSec) {
    // Clamp that negative lead to the first beat rather than counting backwards
    // past the start of the count-in.
    const elapsedBeats = Math.floor(Math.max(0, pos) / beatSec);
    return { countIn: true, beat: (elapsedBeats % Math.max(1, beatsPerBar)) + 1 };
  }

  const elapsed = Math.min(Math.max(0, pos), Math.max(0, totalSec - 1e-6));
  // Events are contiguous and in order, so the last one that has started is the
  // sounding one. A linear scan is fine — a long sheet is a few hundred chords,
  // and this runs once per animation frame.
  let index = 0;
  for (let i = 0; i < events.length; i += 1) {
    if (events[i].startSec > elapsed) break;
    index = i;
  }
  return {
    countIn: false,
    index,
    beat: Math.floor((elapsed - countInSec) / beatSec) % Math.max(1, beatsPerBar) + 1,
  };
};

// --- Player -----------------------------------------------------------------

/**
 * Build a chord-sheet play-along over parsed sheet lines.
 *
 * @param {Array} lines — `parseTabSheet(text).lines`.
 * @param {object} [options]
 * @param {number} [options.bpm] — practice tempo.
 * @param {number} [options.beatsPerBar] — beats per chord.
 * @param {number} [options.countInBars] — click-only lead-in bars.
 * @param {boolean} [options.clickEnabled] — a downbeat click under every chord.
 * @param {(index:number|null)=>void} [options.onChord] — the now-sounding chord
 *   index (null when playback ends/stops), for the sheet highlight.
 * @param {()=>void} [options.onEnded] — fired once when the sheet finishes.
 * @returns {{ play, pause, stop, isPlaying, position, setBpm, setBeatsPerBar,
 *   setCountIn, setClick, schedule }}
 */
export const createChordPlayer = (lines, options = {}) => {
  const { onChord, onEnded } = options;
  let bpm = Number.isFinite(options.bpm) && options.bpm > 0 ? options.bpm : null;
  let beatsPerBar = options.beatsPerBar;
  let countInBars = options.countInBars || 0;
  // Gates FUTURE scheduling only, so — unlike the timing settings — it applies
  // live without a rebuild.
  let clickEnabled = !!options.clickEnabled;

  const build = () => buildChordSchedule(lines, { bpm, beatsPerBar, countInBars });
  let schedule = build();
  let master = null;

  // Separate cursors for the three walks: the tone scheduler and the click
  // scheduler both run AHEAD of the audio clock (a lookahead window), while the
  // highlight trails BEHIND it. One shared cursor would drag the trailing walk
  // forward and light a chord before you hear it.
  let toneIdx = 0;
  let clickIdx = 0;
  let headIdx = 0;
  let lastNotified = -1;
  const resetCursors = () => {
    toneIdx = 0;
    clickIdx = 0;
    headIdx = 0;
    lastNotified = -1;
  };

  // Every click for the current schedule: the count-in's own beats, then a
  // metronome beat through the music. Derived rather than baked into the
  // schedule so toggling the click mid-play needs no rebuild — the toggle gates
  // whether the MUSIC clicks sound, and the count-in's always do.
  const clickTimes = () => {
    const out = schedule.clicks.map((click) => ({ ...click, countIn: true }));
    const musicSec = Math.max(0, schedule.totalSec - schedule.countInSec);
    const beats = Math.round(musicSec / schedule.beatSec);
    for (let beat = 0; beat < beats; beat += 1) {
      out.push({
        beat: (beat % schedule.beatsPerBar) + 1,
        accent: beat % schedule.beatsPerBar === 0,
        countIn: false,
        startSec: schedule.countInSec + beat * schedule.beatSec,
      });
    }
    return out;
  };
  let clicks = clickTimes();

  const soundChord = (c, ev, at, track) => {
    ev.midis.forEach((midi, i) => {
      const freq = midiToFreq(midi);
      if (!freq) return;
      // The bass note (index 0) is not part of the strum sweep and carries a
      // little more level — it is the chord's foundation, not its top voice.
      const offset = i === 0 ? 0 : STRUM_SEC * (i - 1);
      const durSec = Math.max(0.05, ev.durSec - offset);
      track(scheduleTone(c, freq, at + offset, durSec, master, i === 0 ? BASS_TONE_PEAK : CHORD_TONE_PEAK));
    });
  };

  const scheduleWindow = (now, startTime, track) => {
    if (!master) return;
    const c = ctx();
    const horizon = now + SCHEDULE_AHEAD;

    while (toneIdx < schedule.events.length) {
      const ev = schedule.events[toneIdx];
      const at = startTime + ev.startSec;
      if (at >= horizon) break;
      toneIdx += 1;
      if (at < now - 0.05) continue; // already past (first tick after a stall)
      if (!ev.rest) soundChord(c, ev, Math.max(at, now), track);
    }

    while (clickIdx < clicks.length) {
      const click = clicks[clickIdx];
      const at = startTime + click.startSec;
      if (at >= horizon) break;
      // The cursor advances even when the click is muted — skipping the walk
      // wholesale would leave it behind and dump a backlog the moment the
      // toggle came back on.
      clickIdx += 1;
      if (at < now - 0.05) continue;
      // Count-in clicks are NOT gated on `clickEnabled` — "click off, count me
      // in" is the mode that combination means, the same call drumPlayback makes.
      if (!click.countIn && !clickEnabled) continue;
      track(scheduleTone(
        c, click.accent ? CLICK_ACCENT_FREQ : CLICK_FREQ,
        Math.max(at, now), CLICK_DUR_SEC, master, CLICK_PEAK,
      ));
    }

    if (!onChord) return;
    let newest = -1;
    while (headIdx < schedule.events.length
      && startTime + schedule.events[headIdx].startSec <= now) {
      newest = schedule.events[headIdx].index;
      headIdx += 1;
    }
    if (newest >= 0 && newest !== lastNotified) {
      lastNotified = newest;
      safeCall(onChord, newest);
    }
  };

  const transport = createLookaheadTransport({
    // Output-only, so it holds the iOS `playback` session while it sounds —
    // without it the hardware ring/silent switch mutes a pure-synth page.
    audioSession: 'playback',
    getTotalSec: () => schedule.totalSec,
    scheduleWindow,
    prepare: () => {
      schedule = build();
      if (!schedule.events.length || schedule.totalSec <= 0) { safeCall(onEnded); return false; }
      clicks = clickTimes();
      resetCursors();
      const c = ctx();
      master = c.createGain();
      master.gain.value = 1;
      master.connect(c.destination);
      return true;
    },
    seekCursors: (offsetSec) => {
      resetCursors();
      if (offsetSec <= 0) return;
      // Resume (pause → play) positions every cursor past what already sounded.
      // The tone cursor keeps the chord still ringing at the offset so a resume
      // mid-chord re-sounds it rather than dropping into silence.
      while (toneIdx < schedule.events.length
        && schedule.events[toneIdx].startSec + schedule.events[toneIdx].durSec <= offsetSec) toneIdx += 1;
      headIdx = toneIdx;
      while (clickIdx < clicks.length && clicks[clickIdx].startSec < offsetSec) clickIdx += 1;
    },
    onStop: () => { safeCall(onChord, null); },
    onEnded: () => { safeCall(onEnded); },
    onTeardown: () => {
      // Outside the request lifecycle — a disconnect on an already-torn-down
      // node must not throw into the transport's teardown path.
      if (master) {
        try { master.disconnect(); } catch { /* already gone */ }
      }
      master = null;
    },
  });

  // A timing change rebuilds the schedule while idle; while playing the caller
  // restarts, since already-scheduled audio can't be re-timed.
  const rebuildIfIdle = () => {
    if (transport.isPlaying()) return;
    schedule = build();
    clicks = clickTimes();
    resetCursors();
  };

  return {
    play: transport.play,
    pause: transport.pause,
    stop: transport.stop,
    isPlaying: transport.isPlaying,
    position: transport.position,
    setBpm: (next) => {
      bpm = Number.isFinite(next) && next > 0 ? next : null;
      rebuildIfIdle();
    },
    setBeatsPerBar: (next) => { beatsPerBar = next; rebuildIfIdle(); },
    setCountIn: (bars) => { countInBars = clampInt(bars, 0, CHORD_COUNT_IN_MAX, 0); rebuildIfIdle(); },
    setClick: (enabled) => { clickEnabled = !!enabled; },
    schedule: () => schedule,
  };
};
