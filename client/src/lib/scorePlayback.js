// Melody synth playback for the lead-sheet notation — turns a parsed score
// (see scoreNotation.js) into a soft "reference tone" you can hear before you
// sing it. Companion to songPlayback.js: that mixer stacks RECORDED vocal takes,
// this one synthesizes the WRITTEN melody as oscillator tones so a singer can
// preview the intended pitch line.
//
// No third-party audio/MIDI library — Web Audio OscillatorNodes only, mirroring
// the lazy shared-AudioContext + lookahead-scheduler idiom in songPlayback.js.
// The schedule-building math (notes → { freq, startSec, durSec }) is a pure
// function so it can be unit-tested without Web Audio; the player wires that
// schedule onto the audio clock and emits a per-note "now sounding" callback so
// the UI can move a playhead. Pure (no React) — ScoreSheet wraps it in a hook.

import { getAudioContext as ctx } from './audioContext.js';

// --- Pitch → frequency ------------------------------------------------------
// Equal-tempered, A4 = 440 Hz. MIDI 69 == A4, so f = 440 · 2^((midi−69)/12).
const PITCH_CLASS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const ACCIDENTAL_SHIFT = { '': 0, '#': 1, '##': 2, b: -1, bb: -2, n: 0 };

// MIDI note number for a parsed pitch ({ letter, accidental, octave }). C4 = 60,
// A4 = 69. Returns null for anything that isn't a pitch.
export const pitchToMidi = (pitch) => {
  if (!pitch) return null;
  const pc = PITCH_CLASS[String(pitch.letter || '').toUpperCase()];
  const shift = ACCIDENTAL_SHIFT[pitch.accidental || ''];
  if (pc == null || shift == null || !Number.isFinite(pitch.octave)) return null;
  return (pitch.octave + 1) * 12 + pc + shift;
};

// Frequency (Hz) for a MIDI note number. A4 (69) → 440.
export const midiToFreq = (midi) => (Number.isFinite(midi) ? 440 * Math.pow(2, (midi - 69) / 12) : null);

// Frequency (Hz) for a parsed pitch, or null when it isn't a pitch.
export const noteToFrequency = (pitch) => {
  const midi = pitchToMidi(pitch);
  return midi == null ? null : midiToFreq(midi);
};

// --- Schedule building (pure) -----------------------------------------------
// Walk the parsed score in render order (measures → notes) and assign each note
// a global index, an onset, and a duration in seconds. The note index matches
// the order <ScoreSheet> flattens notes, so the player's onNote(index) lines up
// with the rendered notehead for the playhead highlight.
//
// Timing: scoreNotation durations are in QUARTER-NOTE beats. The score's tempo
// counts beats where one beat = the time-signature denominator note, so a
// quarter-note beat lasts (60/bpm)·(beatValue/4) seconds. That makes 4/4 read as
// quarter=bpm and 6/8 read as eighth=bpm (the conventional interpretation),
// using the time signature rather than ignoring it.
export const DEFAULT_BPM = 90;

export const buildSchedule = (score, bpmOverride) => {
  const beatValue = score?.time?.beatValue || 4;
  const bpm = Number.isFinite(bpmOverride) && bpmOverride > 0
    ? bpmOverride
    : (Number.isFinite(score?.tempo) && score.tempo > 0 ? score.tempo : DEFAULT_BPM);
  const secPerQuarter = (60 / bpm) * (beatValue / 4);

  const events = [];
  let beat = 0;
  let index = 0;
  for (const measure of score?.measures || []) {
    for (const note of measure.notes || []) {
      const durBeats = note.duration?.beats || 0;
      events.push({
        index,
        rest: !!note.rest,
        midi: note.rest ? null : pitchToMidi(note.pitch),
        freq: note.rest ? null : noteToFrequency(note.pitch),
        startBeat: beat,
        durBeats,
        startSec: beat * secPerQuarter,
        durSec: durBeats * secPerQuarter,
      });
      beat += durBeats;
      index += 1;
    }
  }
  return { events, bpm, secPerQuarter, totalSec: beat * secPerQuarter };
};

// --- Audio context ----------------------------------------------------------
// The app-wide shared AudioContext (imported at top from audioContext.js).
// Resumed on demand because autoplay policy starts it suspended until a user
// gesture.

// Guard a UI callback that fires from a setInterval tick — an uncaught throw
// there has no request boundary to bubble to and would leave the scheduler
// interval orphaned. (CLAUDE.md: wrap non-request-lifecycle callbacks.)
const safeCall = (cb, ...args) => {
  if (typeof cb !== 'function') return;
  try { cb(...args); }
  catch (err) { console.error(`🎹 score playback callback failed: ${err.message}`); }
};

const LEAD = 0.08;          // seconds of lead-in before beat 0 sounds
const LOOKAHEAD_MS = 25;    // how often the scheduler wakes
const SCHEDULE_AHEAD = 0.12; // seconds of audio scheduled past "now"
const TONE_PEAK = 0.18;     // per-voice gain peak for a single sounding tone

// Schedule one tone with a short attack/release gain envelope so it doesn't
// click. Triangle wave reads as a soft reference tone. Routed into `destination`
// (the context output for the solo player; a per-part gain → master bus for the
// multi-part player). Returns the live { osc, gain } so the caller can track it
// for teardown. Pure of any module state — both players here share it, and
// midiPlayback.js imports it so the MIDI preview sounds like the score synth.
export const scheduleTone = (c, freq, startAt, durSec, destination, peak = TONE_PEAK) => {
  const osc = c.createOscillator();
  const gain = c.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(freq, startAt);

  const attack = Math.min(0.012, durSec * 0.25);
  const release = Math.min(0.07, durSec * 0.4);
  const end = startAt + durSec;
  const sustainEnd = Math.max(startAt + attack, end - release);
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(peak, startAt + attack);
  gain.gain.setValueAtTime(peak, sustainEnd);
  gain.gain.exponentialRampToValueAtTime(0.0001, end);

  osc.connect(gain).connect(destination);
  osc.start(startAt);
  osc.stop(end + 0.03);
  return { osc, gain };
};

/**
 * Build a melody player over a parsed score.
 *
 * @param {object} score — output of `parseScore`.
 * @param {object} [options]
 * @param {number} [options.bpm] — tempo override (else score.tempo, else 90).
 * @param {(index:number|null)=>void} [options.onNote] — called with the index of
 *   the now-sounding note (null when playback ends / stops) so the UI can move a
 *   playhead.
 * @param {()=>void} [options.onEnded] — called once when the melody finishes.
 * @returns {{ play, pause, stop, isPlaying, setTempo, schedule }}
 */
export const createScorePlayer = (score, options = {}) => {
  const { onNote, onEnded } = options;
  let bpm = Number.isFinite(options.bpm) && options.bpm > 0 ? options.bpm : null;
  let schedule = buildSchedule(score, bpm);

  let playing = false;
  let interval = null;
  let startTime = 0;       // ctx time at which beat 0 plays
  let offsetSec = 0;       // resume position (seconds into the score)
  let nextScheduleIdx = 0; // next event to hand to the oscillator scheduler
  let nextNotifyIdx = 0;   // next event to fire onNote for
  let lastNotified = -1;
  let nodes = [];          // live { osc, gain } for teardown
  // Bumped on every stop/pause; play() captures it before its `await ctx.resume()`
  // and bails if a teardown landed during that await, so a stop/score-change/unmount
  // mid–first-play can't re-arm an orphaned interval after the await resolves.
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

  // Hand one due tone to the audio clock and track it for teardown.
  const playTone = (freq, startAt, durSec) => {
    const entry = scheduleTone(ctx(), freq, startAt, durSec, ctx().destination);
    entry.osc.onended = () => { nodes = nodes.filter((n) => n !== entry); };
    nodes.push(entry);
  };

  // One scheduler tick: hand any due tones to the audio clock, fire the playhead
  // callback for the latest note that has started, and finish at the end.
  const tick = () => {
    const now = ctx().currentTime;
    const events = schedule.events;

    while (nextScheduleIdx < events.length) {
      const ev = events[nextScheduleIdx];
      const at = startTime + ev.startSec;
      if (at > now + SCHEDULE_AHEAD) break;
      if (!ev.rest && ev.freq) playTone(ev.freq, Math.max(at, now), ev.durSec);
      nextScheduleIdx += 1;
    }

    let newest = -1;
    while (nextNotifyIdx < events.length && startTime + events[nextNotifyIdx].startSec <= now) {
      newest = events[nextNotifyIdx].index;
      nextNotifyIdx += 1;
    }
    if (newest >= 0 && newest !== lastNotified) {
      lastNotified = newest;
      safeCall(onNote, newest);
    }

    if (now - startTime >= schedule.totalSec) finish();
  };

  // Natural end — reset to the top and notify.
  function finish() {
    clearTick();
    stopNodes();
    playing = false;
    offsetSec = 0;
    nextScheduleIdx = 0;
    nextNotifyIdx = 0;
    lastNotified = -1;
    safeCall(onNote, null);
    safeCall(onEnded);
  }

  // Position the schedule/notify cursors at a resume offset — the first event
  // still sounding at (or starting after) `offset`. Both cursors share this
  // point so the note under the playhead at resume is (re)scheduled AND
  // (re)notified, and a fresh play from 0 still notifies note 0.
  const seekCursors = (offset) => {
    const events = schedule.events;
    let idx = events.findIndex((e) => e.startSec + e.durSec > offset + 1e-6);
    if (idx < 0) idx = events.length;
    nextScheduleIdx = idx;
    nextNotifyIdx = idx;
  };

  const play = async () => {
    if (playing) return;
    const c = ctx();
    const token = ++playToken;
    if (c.state === 'suspended' && c.resume) await c.resume();
    if (token !== playToken) return; // a stop/pause landed during the resume await
    if (!schedule.events.length || schedule.totalSec <= 0) { safeCall(onEnded); return; }

    schedule = buildSchedule(score, bpm); // pick up a tempo change made while idle
    playing = true;
    lastNotified = -1;
    startTime = c.currentTime + LEAD - offsetSec;
    seekCursors(offsetSec);
    tick(); // schedule the immediate window now so playback starts promptly
    interval = setInterval(tick, LOOKAHEAD_MS);
  };

  // Pause — stop sounding, remember position, keep the cursor for resume.
  const pause = () => {
    playToken++; // abort an in-flight play() still awaiting ctx.resume()
    if (!playing) return;
    offsetSec = Math.min(Math.max(0, ctx().currentTime - startTime), schedule.totalSec);
    clearTick();
    stopNodes();
    playing = false;
  };

  // Stop — full teardown back to the top, clears the playhead.
  const stop = () => {
    playToken++; // abort an in-flight play() still awaiting ctx.resume()
    clearTick();
    stopNodes();
    playing = false;
    offsetSec = 0;
    nextScheduleIdx = 0;
    nextNotifyIdx = 0;
    lastNotified = -1;
    safeCall(onNote, null);
  };

  const setTempo = (nextBpm) => {
    bpm = Number.isFinite(nextBpm) && nextBpm > 0 ? nextBpm : null;
    if (!playing) schedule = buildSchedule(score, bpm);
  };

  return {
    play,
    pause,
    stop,
    isPlaying: () => playing,
    setTempo,
    schedule: () => schedule,
  };
};

// Master gain for the multi-part bus: back the level off as more voices stack so
// the summed triangle waves don't clip, while a lone voice still plays at the
// same level as the solo player (1.0 for n=1, ~0.35 for a 4-part stack).
const masterGainFor = (count) => Math.min(1, 1.4 / Math.max(1, count));

/**
 * Build a player that synthesizes MULTIPLE parts at once — the melody plus any
 * checked harmony parts — so any combination of lead-sheet voices sounds
 * together, sample-aligned on the one shared AudioContext. Each part is scheduled
 * through its own gain into a shared master bus whose level backs off as more
 * voices stack so the sum doesn't clip. The transport mirrors `createScorePlayer`
 * (play / pause / stop / setTempo) but iterates every part each tick, and the
 * playhead callback is per-part so a viewer can highlight the staff it's showing.
 *
 * @param {Array<{id:string, score:object}>} parts — parsed scores to play together.
 * @param {object} [options]
 * @param {number} [options.bpm] — tempo override applied to every part.
 * @param {(partId:string, index:number|null)=>void} [options.onNote] — the
 *   now-sounding note index for a part (null for every part when playback ends).
 * @param {()=>void} [options.onEnded] — called once when the longest part finishes.
 * @returns {{ play, pause, stop, isPlaying, setTempo }}
 */
export const createMultiScorePlayer = (parts, options = {}) => {
  const { onNote, onEnded } = options;
  let bpm = Number.isFinite(options.bpm) && options.bpm > 0 ? options.bpm : null;

  // A voice carries its part id, its schedule, and per-voice scheduler cursors.
  // `endNotified` tracks whether this voice's playhead has been cleared at its
  // own end — voices have different lengths, so a short part must clear when IT
  // finishes, not when the longest part does (else its last note stays lit).
  const buildVoices = () => (parts || []).map((p) => ({
    id: p.id,
    schedule: buildSchedule(p.score, bpm),
    nextScheduleIdx: 0,
    nextNotifyIdx: 0,
    lastNotified: -1,
    endNotified: false,
  }));

  let voices = [];
  let totalSec = 0;        // longest voice (seconds) — cached, refreshed on rebuild
  // Rebuild the voice schedules (and cache totalSec) — on init, on play, and on a
  // tempo change while idle. Cheaper than reducing over voices every 25ms tick.
  const rebuild = () => {
    voices = buildVoices();
    totalSec = voices.reduce((m, v) => Math.max(m, v.schedule.totalSec), 0);
  };
  rebuild();

  let playing = false;
  let interval = null;
  let startTime = 0;       // ctx time at which beat 0 plays
  let offsetSec = 0;       // resume position (seconds into the score)
  let master = null;       // shared bus GainNode (created per play)
  let nodes = [];          // live { osc, gain } across all voices, for teardown
  // Bumped on every stop/pause; play() captures it before its `await ctx.resume()`
  // and bails if a teardown landed during that await — otherwise a checkbox toggle
  // (which tears the player down) mid–first-play re-arms an orphaned, un-stoppable
  // interval after the await resolves.
  let playToken = 0;

  const stopNodes = () => {
    for (const n of nodes) {
      n.osc.onended = null;
      try { n.osc.stop(); } catch { /* already stopped */ }
    }
    nodes = [];
    master = null;
  };

  const clearTick = () => {
    if (interval != null) { clearInterval(interval); interval = null; }
  };

  const resetCursors = (offset = 0) => {
    for (const v of voices) {
      const events = v.schedule.events;
      let idx = events.findIndex((e) => e.startSec + e.durSec > offset + 1e-6);
      if (idx < 0) idx = events.length;
      v.nextScheduleIdx = idx;
      v.nextNotifyIdx = idx;
      v.lastNotified = -1;
      v.endNotified = false;
    }
  };

  const playTone = (freq, startAt, durSec) => {
    const entry = scheduleTone(ctx(), freq, startAt, durSec, master);
    entry.osc.onended = () => { nodes = nodes.filter((n) => n !== entry); };
    nodes.push(entry);
  };

  const tick = () => {
    const now = ctx().currentTime;
    for (const v of voices) {
      const events = v.schedule.events;
      while (v.nextScheduleIdx < events.length) {
        const ev = events[v.nextScheduleIdx];
        const at = startTime + ev.startSec;
        if (at > now + SCHEDULE_AHEAD) break;
        if (!ev.rest && ev.freq) playTone(ev.freq, Math.max(at, now), ev.durSec);
        v.nextScheduleIdx += 1;
      }

      let newest = -1;
      while (v.nextNotifyIdx < events.length && startTime + events[v.nextNotifyIdx].startSec <= now) {
        newest = events[v.nextNotifyIdx].index;
        v.nextNotifyIdx += 1;
      }
      if (newest >= 0 && newest !== v.lastNotified) {
        v.lastNotified = newest;
        safeCall(onNote, v.id, newest);
      }

      // Clear this voice's playhead the moment IT finishes (its last note's
      // duration has elapsed), independent of longer voices still sounding.
      if (!v.endNotified && now - startTime >= v.schedule.totalSec) {
        v.endNotified = true;
        safeCall(onNote, v.id, null);
      }
    }

    if (now - startTime >= totalSec) finish();
  };

  function finish() {
    clearTick();
    stopNodes();
    playing = false;
    offsetSec = 0;
    resetCursors(0);
    for (const v of voices) safeCall(onNote, v.id, null);
    safeCall(onEnded);
  }

  const play = async () => {
    if (playing) return;
    const c = ctx();
    const token = ++playToken;
    if (c.state === 'suspended' && c.resume) await c.resume();
    if (token !== playToken) return; // a stop/pause landed during the resume await
    rebuild(); // pick up a tempo change made while idle
    if (!totalSec) { safeCall(onEnded); return; }

    master = c.createGain();
    master.gain.setValueAtTime(masterGainFor(voices.length), c.currentTime);
    master.connect(c.destination);

    playing = true;
    startTime = c.currentTime + LEAD - offsetSec;
    resetCursors(offsetSec);
    tick(); // schedule the immediate window now so playback starts promptly
    interval = setInterval(tick, LOOKAHEAD_MS);
  };

  const pause = () => {
    playToken++; // abort an in-flight play() still awaiting ctx.resume()
    if (!playing) return;
    offsetSec = Math.min(Math.max(0, ctx().currentTime - startTime), totalSec);
    clearTick();
    stopNodes();
    playing = false;
  };

  const stop = () => {
    playToken++; // abort an in-flight play() still awaiting ctx.resume()
    clearTick();
    stopNodes();
    playing = false;
    offsetSec = 0;
    resetCursors(0);
    for (const v of voices) safeCall(onNote, v.id, null);
  };

  const setTempo = (nextBpm) => {
    bpm = Number.isFinite(nextBpm) && nextBpm > 0 ? nextBpm : null;
    if (!playing) rebuild();
  };

  // Current playback head in score-seconds, for a continuous visualizer (the
  // piano-roll). While playing it's the live audio clock (capped at the score
  // length); paused/stopped it's the remembered resume offset. During the LEAD-in
  // before beat 0 sounds this is NEGATIVE (down to −LEAD) — intentionally NOT
  // clamped to 0, so the visualizer keeps the first note above the hit line until
  // its oscillator actually starts rather than lighting the key early.
  const position = () => (playing
    ? Math.min(ctx().currentTime - startTime, totalSec)
    : offsetSec);

  return {
    play,
    pause,
    stop,
    isPlaying: () => playing,
    setTempo,
    position,
    duration: () => totalSec,
  };
};
