// Shared lookahead-transport for the synth players (#2493). The three players —
// createScorePlayer + createMultiScorePlayer (scorePlayback.js) and
// createMidiPlayer (midiPlayback.js) — all drive a Web Audio OscillatorNode
// graph through the same lookahead-scheduler state machine: a suspended-context
// resume with a teardown-race guard, an interval that hands due tones to the
// audio clock, live-node teardown, and pause/stop/finish/seek sequences that
// only differ in WHAT they schedule and WHAT the UI is told. This module owns
// that transport (the clock + node lifecycle); each player supplies the
// scheduling/notify callbacks below and stays a thin scheduler over it, so a fix
// to the token-guard race or teardown semantics lands in exactly one place.
//
// Pure of any player specifics — no React, no score/MIDI concepts. Imports only
// the shared AudioContext; players import createLookaheadTransport from here.

import { getAudioContext as ctx } from './audioContext.js';

// Shared lookahead-scheduler timing — one definition so every synth player
// can't drift apart on feel. Lives here (not in scorePlayback.js) so the
// transport and its players share it without a circular import.
export const SYNTH_TIMING = {
  LEAD: 0.08,           // seconds of lead-in before beat 0 / t=0 sounds
  LOOKAHEAD_MS: 25,     // how often the scheduler wakes
  SCHEDULE_AHEAD: 0.12, // seconds of audio scheduled past "now"
};
const { LEAD, LOOKAHEAD_MS } = SYNTH_TIMING;

/**
 * Build a lookahead transport that owns the clock and live-node lifecycle for a
 * synth player. The player supplies the pieces that differ between players; the
 * transport owns playing / interval / startTime / offsetSec / nodes / playToken
 * and the play / pause / stop / seek / position transitions.
 *
 * @param {object} hooks
 * @param {() => number} hooks.getTotalSec — current total length in seconds,
 *   re-read every tick and on seek/position (players whose length changes with
 *   tempo return the freshest value).
 * @param {(now:number, startTime:number, track:Function) => void}
 *   hooks.scheduleWindow — one scheduler tick: hand any tones due within
 *   SCHEDULE_AHEAD to the audio clock (via `track(scheduleTone(...))`, `track`
 *   passed in so the player never reaches back into the transport) and fire any
 *   UI/playhead callbacks. Called with the current audio time and startTime.
 * @param {() => boolean} [hooks.prepare] — called in play() AFTER the resume
 *   await + stale-token recheck, BEFORE the transport arms. Rebuild schedules /
 *   create the per-play master bus here. Return false to abort as an empty
 *   schedule (fire onEnded inside); anything else proceeds.
 * @param {(offsetSec:number, soundTails:boolean, startTime:number, track:Function) => void}
 *   [hooks.seekCursors] — position the scheduler/notify cursors at a resume/seek
 *   offset (and, when soundTails, sound notes sustaining across it via `track`).
 *   Called after startTime is set so tails can anchor to the transport clock;
 *   also called with offset 0 by stop/finish to reset the cursors to the top.
 * @param {() => void} [hooks.onStop] — clear-the-playhead notify, fired after the
 *   cursors reset on BOTH stop and natural end (onEnded runs after it on end).
 * @param {() => void} [hooks.onEnded] — natural-end notify, fired once after the
 *   playhead clears when playback reaches the end.
 * @param {() => void} [hooks.onTeardown] — extra teardown after the live nodes
 *   are stopped on pause/stop/finish (e.g. drop the master-bus ref). NOT called
 *   on seek, which reuses the same bus to keep scheduling.
 * @returns {{ play, pause, stop, seek, position, isPlaying, track }}
 */
export const createLookaheadTransport = ({
  getTotalSec,
  scheduleWindow,
  prepare,
  seekCursors,
  onStop,
  onEnded,
  onTeardown,
}) => {
  const noop = () => {};
  const doPrepare = prepare || (() => true);
  const doSeekCursors = seekCursors || noop;
  const doStop = onStop || noop;
  const doEnded = onEnded || noop;
  const doTeardown = onTeardown || noop;

  let playing = false;
  let interval = null;
  let startTime = 0;   // ctx time at which the schedule origin (beat 0 / t=0) plays
  let offsetSec = 0;   // resume position (seconds into the piece)
  let nodes = [];      // live { osc, gain } for teardown
  // Bumped on every stop/pause; play() captures it before its `await ctx.resume()`
  // and bails if a teardown landed during that await, so a stop/change/unmount
  // mid–first-play can't re-arm an orphaned interval after the await resolves.
  let playToken = 0;

  // Track a scheduled { osc, gain } for teardown, pruning it from the live set
  // when its oscillator ends. Players call this from scheduleWindow/seekCursors
  // instead of hand-rolling the onended prune.
  const track = (entry) => {
    entry.osc.onended = () => { nodes = nodes.filter((n) => n !== entry); };
    nodes.push(entry);
    return entry;
  };

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

  // One scheduler tick: let the player schedule its due window, then finish at
  // the end. Kept minimal — everything player-specific lives in scheduleWindow.
  const tick = () => {
    const now = ctx().currentTime;
    scheduleWindow(now, startTime, track);
    if (now - startTime >= getTotalSec()) finish();
  };

  // Natural end — full teardown back to the top, clear the playhead, notify. The
  // cursor reset is just a seek to the top (offset 0), shared with stop().
  function finish() {
    clearTick();
    stopNodes();
    doTeardown();
    playing = false;
    offsetSec = 0;
    doSeekCursors(0, false, startTime, track);
    doStop();
    doEnded();
  }

  const play = async () => {
    if (playing) return;
    const c = ctx();
    const token = ++playToken;
    if (c.state === 'suspended' && c.resume) await c.resume();
    if (token !== playToken) return;     // a stop/pause landed during the resume await
    if (doPrepare() === false) return;   // empty schedule — prepare fired onEnded
    playing = true;
    startTime = c.currentTime + LEAD - offsetSec;
    doSeekCursors(offsetSec, offsetSec > 0, startTime, track);
    tick();                              // schedule the immediate window so playback starts promptly
    interval = setInterval(tick, LOOKAHEAD_MS);
  };

  // Pause — stop sounding, remember position, keep the cursor for resume.
  const pause = () => {
    playToken++; // abort an in-flight play() still awaiting ctx.resume()
    if (!playing) return;
    offsetSec = Math.min(Math.max(0, ctx().currentTime - startTime), getTotalSec());
    clearTick();
    stopNodes();
    doTeardown();
    playing = false;
  };

  // Stop — full teardown back to the top, clears the playhead.
  const stop = () => {
    playToken++; // abort an in-flight play() still awaiting ctx.resume()
    clearTick();
    stopNodes();
    doTeardown();
    playing = false;
    offsetSec = 0;
    doSeekCursors(0, false, startTime, track);
    doStop();
  };

  // Jump to a position. While playing this re-anchors the running transport
  // (silences what's sounding, re-schedules from the new point, keeping the same
  // master bus — hence no onTeardown); while idle it just moves the resume
  // offset so the next play() starts there.
  const seek = (sec) => {
    const clamped = Math.min(Math.max(0, Number.isFinite(sec) ? sec : 0), getTotalSec());
    if (!playing) { offsetSec = clamped; return; }
    stopNodes();
    startTime = ctx().currentTime - clamped;
    doSeekCursors(clamped, true, startTime, track);
    tick();
  };

  // Current playback head in piece-seconds. While playing it's the live audio
  // clock (capped at the length); paused/stopped it's the remembered offset.
  // During the LEAD-in before the origin sounds this is NEGATIVE (down to −LEAD)
  // — intentionally NOT clamped to 0, so a visualizer keeps the first note above
  // the hit line until its oscillator actually starts rather than lighting early.
  const position = () => (playing
    ? Math.min(ctx().currentTime - startTime, getTotalSec())
    : offsetSec);

  return { play, pause, stop, seek, position, isPlaying: () => playing, track };
};
