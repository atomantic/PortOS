// Sample-accurate metronome — the shared timing grid for the song system.
//
// Why Web Audio and not setInterval: a beat that rides setInterval drifts by
// tens of ms under load (same reason songPlayback.js stacks takes on one
// AudioContext clock rather than N <audio> elements). So we use the classic
// "two clocks" pattern — a coarse setInterval *lookahead* timer wakes every
// LOOKAHEAD_MS and schedules every click that falls inside the next
// SCHEDULE_AHEAD_S window directly on the AudioContext clock, which is
// sample-accurate. The UI/beat callbacks are fired with setTimeout aligned to
// each click's audio time so a visual pulse lands in sync with the click.
//
// This is the first real consumer of the song `tempo` (BPM) field. It exposes a
// beat-clock callback (`onBeat({ beat, bar, accent, countIn, whenAudioTime })`)
// so color-match (#1025) and sing-to-score (#1026) can later subscribe to the
// same grid. Pure-ish: no React; the <Metronome> component wraps it for UI.

import { parseScore } from './scoreNotation.js';
import { getAudioContext as audioContext } from './audioContext.js';

// BPM band — mirrors the server `tempo` validation (services/rounds.js
// TEMPO_MIN / TEMPO_MAX, also enforced by the Zod schema in routes/rounds.js).
export const METRONOME_BPM_MIN = 20;
export const METRONOME_BPM_MAX = 320;
export const DEFAULT_BPM = 120;

const DEFAULT_BEATS_PER_BAR = 4;
const LOOKAHEAD_MS = 25;        // how often the lookahead timer wakes
const SCHEDULE_AHEAD_S = 0.12;  // how far ahead of `currentTime` we schedule audio
const START_LEAD_S = 0.1;       // small lead before the first beat absorbs jitter

// The app-wide shared AudioContext (imported at top from audioContext.js) —
// reusing one keeps every click on the same clock as the other playback
// features.

// Clamp a BPM into the supported band. Returns null for non-numbers so a caller
// can distinguish "no/invalid value" from a legitimately-clamped number.
export const clampBpm = (bpm) => {
  // Absent (null / undefined / blank) is distinct from a clamped number — don't
  // let Number('') / Number(null) collapse to 0 and silently become the floor.
  if (bpm == null || bpm === '') return null;
  const n = Number(bpm);
  if (!Number.isFinite(n)) return null;
  return Math.max(METRONOME_BPM_MIN, Math.min(METRONOME_BPM_MAX, Math.round(n)));
};

// Seconds between beats at a given BPM (the beat unit is the time-signature
// denominator, i.e. one click per notated beat).
export const secondsPerBeat = (bpm) => 60 / (clampBpm(bpm) ?? DEFAULT_BPM);

// Derive the time signature from a score. Accepts either the raw lead-sheet
// text or an already-parsed `{ beats, beatValue }` object. Defaults to 4/4 when
// absent (parseScore already falls back to 4/4 for a headerless score).
export const timeSignatureFromScore = (score) => {
  if (score && typeof score === 'object' && Number.isFinite(score.beats)) {
    return { beats: score.beats, beatValue: score.beatValue || 4 };
  }
  const parsed = parseScore(typeof score === 'string' ? score : '');
  return {
    beats: parsed.time?.beats || DEFAULT_BEATS_PER_BAR,
    beatValue: parsed.time?.beatValue || 4,
  };
};

// Pure beat-position math: map a global beat index (count-in beats first, then
// music beats) to its descriptor. `accent` marks the accented beat of the bar
// (default beat 1); `countIn` flags the lead-in bars (bar 0). Exported so the UI
// and tests can reason about positions without driving the audio clock.
export const beatDescriptor = (idx, { beatsPerBar = DEFAULT_BEATS_PER_BAR, countInBars = 0, accentBeat = 1 } = {}) => {
  const perBar = Math.max(1, Math.floor(beatsPerBar) || DEFAULT_BEATS_PER_BAR);
  const countInBeats = Math.max(0, Math.floor(countInBars) || 0) * perBar;
  if (idx < countInBeats) {
    const beat = (idx % perBar) + 1;
    return { beat, bar: 0, accent: beat === accentBeat, countIn: true };
  }
  const m = idx - countInBeats;
  const beat = (m % perBar) + 1;
  return { beat, bar: Math.floor(m / perBar) + 1, accent: beat === accentBeat, countIn: false };
};

/**
 * Build a metronome over a tempo + time signature.
 *
 * @param {object} opts
 * @param {number} opts.bpm            — beats per minute (clamped 20–320).
 * @param {number} opts.beatsPerBar    — numerator of the time signature.
 * @param {number} opts.beatValue      — denominator (carried for consumers; click cadence is BPM-based).
 * @param {number} opts.countInBars    — lead-in bars before bar 1 (0 = none).
 * @param {number} opts.accentBeat     — which beat of the bar is accented (default 1).
 * @param {(info) => void} opts.onBeat — fired on every beat with { beat, bar, accent, countIn, whenAudioTime }.
 * @param {(info) => void} opts.onCountInComplete — fired once at the first music downbeat.
 * @returns {{ start, stop, setBpm, isRunning, getBpm, getBeatsPerBar }}
 */
export function createMetronome({
  bpm = DEFAULT_BPM,
  beatsPerBar = DEFAULT_BEATS_PER_BAR,
  beatValue: _beatValue = 4,
  countInBars = 0,
  accentBeat = 1,
  onBeat = null,
  onCountInComplete = null,
} = {}) {
  let currentBpm = clampBpm(bpm) ?? DEFAULT_BPM;
  const perBar = Math.max(1, Math.floor(beatsPerBar) || DEFAULT_BEATS_PER_BAR);
  const countIn = Math.max(0, Math.floor(countInBars) || 0);
  const descriptorOpts = { beatsPerBar: perBar, countInBars: countIn, accentBeat };

  let running = false;
  let tickIndex = 0;       // global beats scheduled so far (count-in + music)
  let nextNoteTime = 0;    // audio time of the next beat to schedule
  let lookahead = null;    // setInterval id for the lookahead scheduler
  const pendingTimeouts = new Set(); // beat-callback timers, cleared on stop()

  // Schedule one short click tone at audio time `when`. The accented beat is a
  // brighter, louder blip so beat 1 is audible without watching the screen.
  const scheduleClick = (when, accent) => {
    const c = audioContext();
    const osc = c.createOscillator();
    const gain = c.createGain();
    osc.frequency.value = accent ? 1500 : 1000;
    const peak = accent ? 0.5 : 0.3;
    // Fast attack, short exponential decay — a click, not a tone.
    gain.gain.setValueAtTime(0.0001, when);
    gain.gain.exponentialRampToValueAtTime(peak, when + 0.001);
    gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
    osc.connect(gain).connect(c.destination);
    osc.start(when);
    osc.stop(when + 0.06);
    osc.onended = () => {
      // Outside the request lifecycle — never let a disconnect throw escape.
      try { osc.disconnect(); gain.disconnect(); } catch { /* already torn down */ }
    };
  };

  // Fire the beat/count-in callbacks aligned to the click's audio time.
  const dispatchBeat = (idx, when) => {
    const info = { ...beatDescriptor(idx, descriptorOpts), whenAudioTime: when };
    const firstMusicBeat = !info.countIn && idx === countIn * perBar;
    const delayMs = Math.max(0, (when - audioContext().currentTime) * 1000);
    const id = setTimeout(() => {
      pendingTimeouts.delete(id);
      // setTimeout runs outside the request lifecycle — a throwing consumer
      // callback must not crash the process (CLAUDE.md deferred-work boundary).
      try {
        if (firstMusicBeat && onCountInComplete) onCountInComplete(info);
        if (onBeat) onBeat(info);
      } catch (err) {
        console.error(`❌ Metronome beat callback failed: ${err.message}`);
      }
    }, delayMs);
    pendingTimeouts.add(id);
  };

  // Lookahead scheduler — schedule every beat inside the next window.
  const scheduler = () => {
    const c = audioContext();
    while (nextNoteTime < c.currentTime + SCHEDULE_AHEAD_S) {
      const accent = beatDescriptor(tickIndex, descriptorOpts).accent;
      scheduleClick(nextNoteTime, accent);
      dispatchBeat(tickIndex, nextNoteTime);
      nextNoteTime += secondsPerBeat(currentBpm);
      tickIndex += 1;
    }
  };

  const start = async () => {
    if (running) return;
    const c = audioContext();
    // Autoplay policy starts the context suspended until a user gesture.
    if (c.state === 'suspended') await c.resume();
    running = true;
    tickIndex = 0;
    nextNoteTime = c.currentTime + START_LEAD_S;
    scheduler(); // schedule the first window synchronously
    lookahead = setInterval(() => {
      // Interval callback is outside the request lifecycle — guard it.
      try {
        scheduler();
      } catch (err) {
        console.error(`❌ Metronome scheduler failed: ${err.message}`);
      }
    }, LOOKAHEAD_MS);
  };

  // Cancel all scheduled work: the lookahead interval and every pending beat
  // callback. Already-scheduled audio nodes stop on their own `osc.stop(when)`.
  const stop = () => {
    running = false;
    if (lookahead != null) {
      clearInterval(lookahead);
      lookahead = null;
    }
    for (const id of pendingTimeouts) clearTimeout(id);
    pendingTimeouts.clear();
    tickIndex = 0;
  };

  // Change tempo live — takes effect on the next scheduled beat.
  const setBpm = (next) => {
    const clamped = clampBpm(next);
    if (clamped != null) currentBpm = clamped;
  };

  return {
    start,
    stop,
    setBpm,
    isRunning: () => running,
    getBpm: () => currentBpm,
    getBeatsPerBar: () => perBar,
  };
}
