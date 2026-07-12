// Synth preview of a transcribed MIDI file (#2490) — turns the parseMidiFile
// view-model (midiNotes.js) into audible oscillator tones with a live
// `position()` the <MidiPianoRoll> reads for its moving playhead. Companion to
// scorePlayback.js: that synthesizes the WRITTEN lead-sheet melody, this
// synthesizes the TRANSCRIBED .mid; both reuse the same lookahead-scheduler
// idiom, tone envelope (scheduleTone), and the one app-wide AudioContext.
// Pure (no React) — useMidiPlayer wraps it in a hook.

import { getAudioContext as ctx } from './audioContext.js';
import { scheduleTone, midiToFreq } from './scorePlayback.js';

// Guard a UI callback that fires from a setInterval tick — an uncaught throw
// there has no request boundary to bubble to and would leave the scheduler
// interval orphaned. (CLAUDE.md: wrap non-request-lifecycle callbacks.)
const safeCall = (cb, ...args) => {
  if (typeof cb !== 'function') return;
  try { cb(...args); }
  catch (err) { console.error(`🎹 MIDI playback callback failed: ${err.message}`); }
};

const LEAD = 0.08;           // seconds of lead-in before t=0 sounds
const LOOKAHEAD_MS = 25;     // how often the scheduler wakes
const SCHEDULE_AHEAD = 0.12; // seconds of audio scheduled past "now"
const MIN_TONE_SEC = 0.05;   // floor so zero/near-zero-length notes still tick
const TONE_PEAK = 0.16;      // per-voice peak at full velocity (polyphonic sum)

// Velocity → per-tone gain peak. A floor keeps ppp notes audible; the master
// bus (fixed, below) keeps a dense chord from clipping the sum.
const peakFor = (velocity) => TONE_PEAK * (0.35 + 0.65 * (Number.isFinite(velocity) ? velocity : 0.8));
const MASTER_GAIN = 0.9;

/**
 * Build a synth player over a parsed MIDI view-model.
 *
 * @param {object} data — output of `parseMidiFile` ({ notes, durationSec });
 *   notes are sorted by startSec, which the scheduler cursor relies on.
 * @param {object} [options]
 * @param {()=>void} [options.onEnded] — called once when playback reaches the end.
 * @returns {{ play, pause, stop, seek, isPlaying, position, duration }}
 */
export const createMidiPlayer = (data, options = {}) => {
  const { onEnded } = options;
  const notes = (data?.notes || []).filter((n) => Number.isFinite(n?.midi) && Number.isFinite(n?.startSec));
  const totalSec = Math.max(data?.durationSec || 0, 0);

  let playing = false;
  let interval = null;
  let startTime = 0;  // ctx time at which t=0 plays
  let offsetSec = 0;  // resume position (seconds into the file)
  let nextIdx = 0;    // next note to hand to the oscillator scheduler
  let master = null;  // per-play master bus GainNode
  let nodes = [];     // live { osc, gain } for teardown
  // Bumped on every stop/pause; play() captures it before its `await ctx.resume()`
  // and bails if a teardown landed during that await (same guard as scorePlayback).
  let playToken = 0;

  const stopNodes = () => {
    for (const n of nodes) {
      n.osc.onended = null;
      try { n.osc.stop(); } catch { /* already stopped */ }
    }
    nodes = [];
  };

  const clearTick = () => {
    if (interval != null) { clearInterval(interval); interval = null; }
  };

  const playTone = (midi, startAt, durSec, velocity) => {
    const freq = midiToFreq(midi);
    if (!freq) return;
    const entry = scheduleTone(ctx(), freq, startAt, Math.max(durSec, MIN_TONE_SEC), master, peakFor(velocity));
    entry.osc.onended = () => { nodes = nodes.filter((n) => n !== entry); };
    nodes.push(entry);
  };

  // Position the scheduler cursor at the first note starting at/after `offset`,
  // and immediately sound the tails of notes already sustaining across it —
  // seeking into a held chord should be audible, not silent until the next
  // onset. Notes are start-sorted, so the tail scan can't early-break; it's a
  // one-time O(n) pass per seek/play, not per tick.
  const seekCursors = (offset, { soundTails } = {}) => {
    let idx = notes.findIndex((n) => n.startSec >= offset - 1e-6);
    if (idx < 0) idx = notes.length;
    nextIdx = idx;
    if (!soundTails) return;
    const now = ctx().currentTime;
    for (let i = 0; i < idx; i += 1) {
      const n = notes[i];
      const remaining = n.startSec + n.durationSec - offset;
      if (remaining > 1e-3) playTone(n.midi, now, remaining, n.velocity);
    }
  };

  // One scheduler tick: hand any due tones to the audio clock, finish at the end.
  const tick = () => {
    const now = ctx().currentTime;
    while (nextIdx < notes.length) {
      const n = notes[nextIdx];
      const at = startTime + n.startSec;
      if (at > now + SCHEDULE_AHEAD) break;
      playTone(n.midi, Math.max(at, now), n.durationSec, n.velocity);
      nextIdx += 1;
    }
    if (now - startTime >= totalSec) finish();
  };

  // Natural end — reset to the top and notify.
  function finish() {
    clearTick();
    stopNodes();
    master = null;
    playing = false;
    offsetSec = 0;
    nextIdx = 0;
    safeCall(onEnded);
  }

  const play = async () => {
    if (playing) return;
    const c = ctx();
    const token = ++playToken;
    if (c.state === 'suspended' && c.resume) await c.resume();
    if (token !== playToken) return; // a stop/pause landed during the resume await
    if (!notes.length || totalSec <= 0) { safeCall(onEnded); return; }

    master = c.createGain();
    master.gain.setValueAtTime(MASTER_GAIN, c.currentTime);
    master.connect(c.destination);

    playing = true;
    startTime = c.currentTime + LEAD - offsetSec;
    seekCursors(offsetSec, { soundTails: offsetSec > 0 });
    tick(); // schedule the immediate window now so playback starts promptly
    interval = setInterval(tick, LOOKAHEAD_MS);
  };

  // Pause — stop sounding, remember position for resume.
  const pause = () => {
    playToken++; // abort an in-flight play() still awaiting ctx.resume()
    if (!playing) return;
    offsetSec = Math.min(Math.max(0, ctx().currentTime - startTime), totalSec);
    clearTick();
    stopNodes();
    master = null;
    playing = false;
  };

  // Stop — full teardown back to the top.
  const stop = () => {
    playToken++; // abort an in-flight play() still awaiting ctx.resume()
    clearTick();
    stopNodes();
    master = null;
    playing = false;
    offsetSec = 0;
    nextIdx = 0;
  };

  // Jump to a position. While playing this re-anchors the running transport
  // (silences what's sounding, re-schedules from the new point); while idle it
  // just moves the resume offset so the next play() starts there.
  const seek = (sec) => {
    const clamped = Math.min(Math.max(0, Number.isFinite(sec) ? sec : 0), totalSec);
    if (!playing) { offsetSec = clamped; return; }
    stopNodes();
    startTime = ctx().currentTime - clamped;
    seekCursors(clamped, { soundTails: true });
    tick();
  };

  // Current playback head in file-seconds, for the moving playhead. During the
  // LEAD-in before t=0 sounds this is negative (down to −LEAD) — intentionally
  // not clamped, so the playhead doesn't jump ahead of the first audible note.
  const position = () => (playing
    ? Math.min(ctx().currentTime - startTime, totalSec)
    : offsetSec);

  return {
    play,
    pause,
    stop,
    seek,
    isPlaying: () => playing,
    position,
    duration: () => totalSec,
  };
};
