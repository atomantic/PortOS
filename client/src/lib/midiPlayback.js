// Synth preview of a transcribed MIDI file (#2490) — turns the parseMidiFile
// view-model (midiNotes.js) into audible oscillator tones with a live
// `position()` the <MidiPianoRoll> reads for its moving playhead. Companion to
// scorePlayback.js: that synthesizes the WRITTEN lead-sheet melody, this
// synthesizes the TRANSCRIBED .mid; both reuse the same lookahead-scheduler
// idiom, tone envelope (scheduleTone), and the one app-wide AudioContext.
// Pure (no React) — useMidiPlayer wraps it in a hook.

import { getAudioContext as ctx } from './audioContext.js';
import { scheduleTone, midiToFreq, makeSafeCall, SYNTH_TIMING } from './scorePlayback.js';

const safeCall = makeSafeCall('MIDI playback');
const { LEAD, LOOKAHEAD_MS, SCHEDULE_AHEAD } = SYNTH_TIMING;
const MIN_TONE_SEC = 0.05;   // floor so zero/near-zero-length notes still tick
const TONE_PEAK = 0.16;      // per-voice peak at full velocity (polyphonic sum)

// Velocity → per-tone gain peak. A floor keeps ppp notes audible; the master
// bus (scaled to the file's peak polyphony, below) keeps a dense chord from
// clipping the sum.
const peakFor = (velocity) => TONE_PEAK * (0.35 + 0.65 * (Number.isFinite(velocity) ? velocity : 0.8));
const MASTER_CEIL = 0.9;

// Peak simultaneous-note count — the worst-case amplitude sum the master bus
// must keep under clipping. One O(n log n) sweep per player; at a time tie,
// ends sort before starts so back-to-back notes don't double-count.
const peakPolyphony = (list) => {
  const events = [];
  for (const n of list) events.push([n.startSec, 1], [n.startSec + n.durationSec, -1]);
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let live = 0;
  let peak = 0;
  for (const [, delta] of events) { live += delta; if (live > peak) peak = live; }
  return peak;
};

// Master level: at low polyphony the ceiling applies as-is; past ~6 voices it
// backs off so peak-polyphony × full-velocity tone peaks sum below clipping
// (mirrors createMultiScorePlayer's masterGainFor, sized to this TONE_PEAK).
const masterLevelFor = (peak) => Math.min(MASTER_CEIL, MASTER_CEIL / Math.max(1e-6, peak * TONE_PEAK));

/**
 * Build a synth player over a parsed MIDI view-model.
 *
 * @param {object} data — output of `parseMidiFile` ({ notes, durationSec });
 *   notes are sorted by startSec, which the scheduler cursor relies on.
 * @param {object} [options]
 * @param {()=>void} [options.onEnded] — called once when playback reaches the end.
 * @returns {{ play, pause, stop, seek, isPlaying, position }}
 */
export const createMidiPlayer = (data, options = {}) => {
  const { onEnded } = options;
  const notes = (data?.notes || []).filter((n) => Number.isFinite(n?.midi) && Number.isFinite(n?.startSec));
  const totalSec = Math.max(data?.durationSec || 0, 0);
  const masterLevel = masterLevelFor(peakPolyphony(notes));

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
  // and (with soundTails) immediately sound the tails of notes already
  // sustaining across it — seeking into a held chord should be audible, not
  // silent until the next onset. Tails anchor to the transport clock
  // (startTime + offset — callers set startTime first), NOT bare currentTime:
  // the play() path re-anchors with a LEAD of pre-roll, and a tail started at
  // "now" would run LEAD early relative to every newly scheduled onset. Notes
  // are start-sorted, so the tail scan can't early-break; it's a one-time
  // O(n) pass per seek/play, not per tick.
  const seekCursors = (offset, soundTails = false) => {
    let idx = notes.findIndex((n) => n.startSec >= offset - 1e-6);
    if (idx < 0) idx = notes.length;
    nextIdx = idx;
    if (!soundTails) return;
    const at = Math.max(startTime + offset, ctx().currentTime);
    for (let i = 0; i < idx; i += 1) {
      const n = notes[i];
      const remaining = n.startSec + n.durationSec - offset;
      if (remaining > 1e-3) playTone(n.midi, at, remaining, n.velocity);
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
    master.gain.setValueAtTime(masterLevel, c.currentTime);
    master.connect(c.destination);

    playing = true;
    startTime = c.currentTime + LEAD - offsetSec;
    seekCursors(offsetSec, offsetSec > 0);
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
    seekCursors(clamped, true);
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
  };
};
