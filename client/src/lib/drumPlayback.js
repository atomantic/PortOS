// Drum-kit playback for the SongBook `drum` format — turns a parsed drum chart
// (see drumNotation.js) into an audible groove you can practice along with at a
// tempo you control. The third consumer of the shared lookahead transport
// (`lookaheadTransport.js`), alongside `createScorePlayer` and `createMidiPlayer`:
// the clock, node lifecycle and teardown semantics are all the shared ones, so
// this module only owns the schedule math and the kit voices.
//
// The kit is SYNTHESIZED — noise burst + bandpass for snare/hats/cymbals, a
// pitch-dropping sine for kick/toms. No sampled kit ships with PortOS (repo size
// + sample licensing), and the synth reads well enough as a practice click-with-
// groove, which is what the play-along is for.
//
// `buildDrumSchedule` is PURE (no Web Audio) so the timing math — bpm, time
// signature, subdivision, count-in, loop expansion, per-glyph velocity — is
// unit-testable in a node env, mirroring `buildSchedule` in scorePlayback.js.

import { getAudioContext as ctx } from './audioContext.js';
import { createLookaheadTransport, SYNTH_TIMING } from './lookaheadTransport.js';
import { makeSafeCall } from './scorePlayback.js';
import { kitPiece, DEFAULT_DRUM_TEMPO } from './drumNotation.js';

const { SCHEDULE_AHEAD } = SYNTH_TIMING;
const safeCall = makeSafeCall('drum playback');

// --- Schedule building (pure) ----------------------------------------------

// Clamp a loop range against the chart's real bar count. Returns null when the
// chart is empty or looping is off, so callers can branch on a single value
// instead of juggling three flags. `from`/`to` are 1-based inclusive bar numbers;
// a reversed pair is normalized rather than rejected (the UI's two selects can
// legitimately cross while the user is picking).
export const resolveLoopRange = (barCount, loop) => {
  if (!loop || !barCount) return null;
  const rawFrom = Number.isFinite(loop.from) ? Math.trunc(loop.from) : 1;
  const rawTo = Number.isFinite(loop.to) ? Math.trunc(loop.to) : barCount;
  const from = Math.min(Math.max(1, Math.min(rawFrom, rawTo)), barCount);
  const to = Math.min(Math.max(from, Math.max(rawFrom, rawTo)), barCount);
  return { from, to };
};

/**
 * Flatten a parsed drum chart into absolute-time hit events.
 *
 * Timing mirrors `scorePlayback.buildSchedule`: the tempo counts beats where one
 * beat is the time-signature denominator, so 4/4 reads as quarter=bpm and 6/8 as
 * eighth=bpm. One grid step is one beat / `subdivision`.
 *
 * @param {object} chart — output of `parseDrumChart`.
 * @param {object} [options]
 * @param {number} [options.bpm] — practice tempo (else the chart's `tempo`, else 90).
 * @param {{from:number,to:number}} [options.loop] — 1-based inclusive bar range;
 *   the schedule covers ONLY those bars (the transport loops by replaying it).
 * @param {number} [options.countInBars] — silent-lead bars of click before bar 1.
 * @returns {{ events, bpm, stepSec, barSec, totalSec, countInSec, bars, loop }}
 */
export const buildDrumSchedule = (chart, options = {}) => {
  const beats = chart?.time?.beats || 4;
  const subdivision = chart?.subdivision || 4;
  const bpm = Number.isFinite(options.bpm) && options.bpm > 0
    ? options.bpm
    : (Number.isFinite(chart?.tempo) && chart.tempo > 0 ? chart.tempo : DEFAULT_DRUM_TEMPO);

  // The tempo counts NOTATED beats (the time-signature denominator), so one beat
  // is simply 60/bpm — 4/4 reads as quarter=bpm and 6/8 as eighth=bpm, the
  // conventional interpretation and the same one scorePlayback.buildSchedule
  // arrives at via its quarter-note durations. One grid step is a beat split
  // `subdivision` ways.
  const beatSec = 60 / bpm;
  const stepSec = beatSec / subdivision;
  const barSec = beatSec * beats;

  const allBars = Array.isArray(chart?.bars) ? chart.bars : [];
  const loop = resolveLoopRange(allBars.length, options.loop);
  const bars = loop ? allBars.slice(loop.from - 1, loop.to) : allBars;

  const countInBars = Math.max(0, Math.min(4, Math.trunc(options.countInBars) || 0));
  const countInSec = countInBars * barSec;

  const events = [];
  // Count-in: one click per notated beat, the downbeat accented. Scheduled as
  // real events (not a second clock) so the transport sounds them through the
  // same voice path, and `countIn: true` + a null bar/step lets the UI tell
  // "counting in" from "bar 1".
  for (let bar = 0; bar < countInBars; bar += 1) {
    for (let beat = 0; beat < beats; beat += 1) {
      events.push({
        bar: null,
        step: null,
        beat: beat + 1,
        piece: null,
        sound: 'click',
        velocity: beat === 0 ? 1 : 0.6,
        countIn: true,
        startSec: (bar * beats + beat) * beatSec,
        durSec: Math.min(0.08, stepSec),
      });
    }
  }

  bars.forEach((bar, barIdx) => {
    const barStart = countInSec + barIdx * barSec;
    for (const row of bar.rows || []) {
      const piece = kitPiece(row.piece);
      row.cells.forEach((cell, step) => {
        if (!cell || cell.rest) return;
        events.push({
          // The chart's own bar number (survives a loop-range slice, so the
          // playhead lights the right bar on the full sheet).
          bar: bar.index,
          step,
          piece: row.piece,
          sound: piece?.sound || 'snare',
          velocity: cell.velocity,
          open: !!cell.open,
          accent: !!cell.accent,
          ghost: !!cell.ghost,
          flam: !!cell.flam,
          countIn: false,
          startSec: barStart + step * stepSec,
          durSec: stepSec,
        });
      });
    }
  });

  events.sort((a, b) => a.startSec - b.startSec);
  return {
    events,
    bpm,
    stepSec,
    barSec,
    beatSec,
    countInSec,
    bars,
    loop,
    totalSec: countInSec + bars.length * barSec,
  };
};

// --- Kit voices -------------------------------------------------------------

const VOICE_PEAK = 0.5; // per-hit gain ceiling before the per-cell velocity scale

// Shared white-noise buffer (1s, re-generated only if the sample rate changes) —
// same idiom as chiptunePlayback.js's noise voice.
let noiseBuffer = null;
const getNoiseBuffer = (c) => {
  if (!noiseBuffer || noiseBuffer.sampleRate !== c.sampleRate) {
    noiseBuffer = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
  }
  return noiseBuffer;
};

// One voice recipe per kit sound. `tone` sounds a pitch-dropping sine (membranes);
// `noise` sounds a bandpassed noise burst (metal + snare wires). `decay` is the
// exponential tail in seconds; `open` extends it for an open hi-hat.
const VOICES = {
  kick: { type: 'tone', from: 150, to: 45, decay: 0.22, gain: 1 },
  tom1: { type: 'tone', from: 260, to: 150, decay: 0.24, gain: 0.85 },
  tom2: { type: 'tone', from: 200, to: 115, decay: 0.28, gain: 0.85 },
  floor: { type: 'tone', from: 140, to: 80, decay: 0.34, gain: 0.85 },
  // A snare is a membrane plus wires: a short tone under a wide noise burst.
  snare: { type: 'noise', freq: 1900, q: 0.7, decay: 0.16, gain: 0.9, body: { from: 210, to: 170, decay: 0.09, gain: 0.5 } },
  hihat: { type: 'noise', freq: 8500, q: 1.6, decay: 0.045, openDecay: 0.28, gain: 0.5 },
  hihatFoot: { type: 'noise', freq: 7000, q: 1.4, decay: 0.035, gain: 0.35 },
  ride: { type: 'noise', freq: 6200, q: 0.9, decay: 0.5, gain: 0.4 },
  crash: { type: 'noise', freq: 4200, q: 0.4, decay: 1.1, gain: 0.5 },
  // Metronome click layered over the kit (and the count-in voice) — a short
  // pitched blip, brighter on the accent, so it cuts through the noise voices.
  click: { type: 'tone', from: 1600, to: 1550, decay: 0.05, gain: 0.7 },
};

// Flam grace-note lead: the ghost hit lands this far BEFORE the main hit.
const FLAM_LEAD_SEC = 0.032;

// Schedule one voice node pair; returns { osc, gain } for the transport's
// teardown tracking (an AudioBufferSourceNode satisfies the same
// start/stop/onended surface an OscillatorNode does).
const scheduleVoice = (c, voice, startAt, destination, { velocity, open }) => {
  const gain = c.createGain();
  const peak = Math.max(0.0002, VOICE_PEAK * (voice.gain ?? 1) * velocity);
  const decay = open && voice.openDecay ? voice.openDecay : voice.decay;
  let osc;

  if (voice.type === 'noise') {
    osc = c.createBufferSource();
    osc.buffer = getNoiseBuffer(c);
    osc.loop = true;
    const filter = c.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(voice.freq, startAt);
    filter.Q.value = voice.q;
    osc.connect(filter).connect(gain);
  } else {
    osc = c.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(voice.from, startAt);
    osc.frequency.exponentialRampToValueAtTime(voice.to, startAt + decay);
    osc.connect(gain);
  }

  // Percussive envelope: instant attack, exponential decay to silence.
  gain.gain.setValueAtTime(peak, startAt);
  gain.gain.exponentialRampToValueAtTime(0.0001, startAt + decay);
  gain.connect(destination);
  osc.start(startAt);
  osc.stop(startAt + decay + 0.02);
  return { osc, gain };
};

// Sound one chart event — the main hit, plus a snare-body tone and/or a flam
// grace note when the voice/glyph calls for them. Every created node pair goes
// through `track` so the transport tears all of them down on stop.
const soundEvent = (c, ev, at, destination, track) => {
  const voice = VOICES[ev.sound] || VOICES.snare;
  if (ev.flam) {
    track(scheduleVoice(c, voice, Math.max(at - FLAM_LEAD_SEC, 0), destination, {
      velocity: ev.velocity * 0.45, open: ev.open,
    }));
  }
  track(scheduleVoice(c, voice, at, destination, { velocity: ev.velocity, open: ev.open }));
  if (voice.body) {
    track(scheduleVoice(c, voice.body, at, destination, { velocity: ev.velocity, open: false }));
  }
};

// --- Player -----------------------------------------------------------------

/**
 * Build a drum-kit player over a parsed chart.
 *
 * @param {object} chart — output of `parseDrumChart`.
 * @param {object} [options]
 * @param {number} [options.bpm] — practice tempo (else the chart's `tempo:`).
 * @param {number} [options.countInBars] — click-only lead-in bars.
 * @param {{from:number,to:number}|null} [options.loopBars] — 1-based inclusive
 *   bar range; when set, playback repeats that range until stopped.
 * @param {boolean} [options.clickEnabled] — layer a metronome click on every
 *   notated beat, on the same clock as the kit.
 * @param {({bar:number|null, step:number|null, countIn:boolean})=>void} [options.onStep]
 *   — the now-sounding grid position (null when playback ends/stops), for the
 *   sheet playhead.
 * @param {()=>void} [options.onEnded] — fired once when a non-looping chart ends.
 * @returns {{ play, pause, stop, isPlaying, setBpm, setLoop, setClick, schedule }}
 */
export const createDrumPlayer = (chart, options = {}) => {
  const { onStep, onEnded } = options;
  let bpm = Number.isFinite(options.bpm) && options.bpm > 0 ? options.bpm : null;
  let loopBars = options.loopBars || null;
  let clickEnabled = !!options.clickEnabled;
  let countInBars = options.countInBars || 0;

  const build = () => buildDrumSchedule(chart, { bpm, loop: loopBars, countInBars });
  let schedule = build();
  let master = null;

  // Click track for the CURRENT schedule: one marker per notated beat of the
  // music (the count-in carries its own clicks as real events). Derived rather
  // than baked into the schedule, so toggling the click mid-play needs no rebuild.
  const clickTimes = () => {
    const out = [];
    const beats = chart?.time?.beats || 4;
    for (let bar = 0; bar < schedule.bars.length; bar += 1) {
      for (let beat = 0; beat < beats; beat += 1) {
        out.push({
          startSec: schedule.countInSec + bar * schedule.barSec + beat * schedule.beatSec,
          accent: beat === 0,
        });
      }
    }
    return out;
  };
  let clicks = clickTimes();

  // Index of the first music (non-count-in) event. Events are sorted by onset and
  // every count-in event precedes the music, so this is where loop pass 2+ starts
  // — a looped range must not re-count-you-in every time around.
  const firstMusicIdx = () => {
    const i = schedule.events.findIndex((ev) => !ev.countIn);
    return i < 0 ? schedule.events.length : i;
  };
  // Length of one LOOP pass: the music only, since the count-in belongs to pass 0.
  const musicSec = () => schedule.totalSec - schedule.countInSec;
  // A pass with no music has nothing to advance past — a looping player must not
  // spin its rebase branch forever on one.
  const canLoop = () => !!schedule.loop && musicSec() > 0;

  // A cursor walks one list (events or clicks) forward through loop passes. Each
  // walker keeps its OWN `pass` because they advance at different rates: the
  // scheduler runs a lookahead window AHEAD of the audio clock while the playhead
  // trails BEHIND it, so a shared pass counter would drag the trailing walker
  // across a loop boundary early and collapse the loop to one pass.
  //
  // A pass-N onset sits at `pass * musicSec + ev.startSec` — pass 0 covers the
  // count-in plus the music, and pass ≥ 1 starts at `firstMusicIdx`, so the first
  // music event of pass 1 lands exactly at the end of pass 0.
  const makeCursor = () => ({ idx: 0, pass: 0 });
  const cursorTime = (cursor, startSec) => startSec + cursor.pass * musicSec();
  // Advance a cursor onto the next pass, or return false when it must stop.
  const advancePass = (cursor, from) => {
    if (!canLoop()) return false;
    cursor.pass += 1;
    cursor.idx = from;
    return true;
  };

  let hitCursor = makeCursor();     // schedules audio (runs ahead)
  let clickCursor = makeCursor();   // schedules the click layer (runs ahead)
  let headCursor = makeCursor();    // drives the playhead (trails)
  let lastHeadKey = null;
  const resetCursor = () => {
    hitCursor = makeCursor();
    clickCursor = makeCursor();
    headCursor = makeCursor();
    lastHeadKey = null;
  };

  const notify = (info) => safeCall(onStep, info);

  const scheduleWindow = (now, startTime, track) => {
    if (!master) return;
    const c = ctx();
    const horizon = now + SCHEDULE_AHEAD;

    // Hand every due hit to the audio clock; on exhausting the list a looping
    // player rebases onto the next pass and keeps going, while a one-shot player
    // stops scheduling and lets the transport's own end check finish it.
    for (;;) {
      if (hitCursor.idx >= schedule.events.length) {
        if (!advancePass(hitCursor, firstMusicIdx())) break;
        continue;
      }
      const ev = schedule.events[hitCursor.idx];
      const at = startTime + cursorTime(hitCursor, ev.startSec);
      if (at >= horizon) break;
      hitCursor.idx += 1;
      if (at < now - 0.05) continue; // already past (first tick after a stall)
      soundEvent(c, ev, Math.max(at, now), master, track);
    }

    // The click layer walks its own list on the same pass geometry. Its pass ≥ 1
    // restart index is 0: every click belongs to the music (the count-in's clicks
    // are real events on the hit list), so a loop pass replays all of them.
    if (clickEnabled) {
      for (;;) {
        if (clickCursor.idx >= clicks.length) {
          if (!advancePass(clickCursor, 0)) break;
          continue;
        }
        const click = clicks[clickCursor.idx];
        const at = startTime + cursorTime(clickCursor, click.startSec);
        if (at >= horizon) break;
        clickCursor.idx += 1;
        if (at < now - 0.05) continue;
        track(scheduleVoice(c, VOICES.click, Math.max(at, now), master, {
          velocity: click.accent ? 1 : 0.55, open: false,
        }));
      }
    }

    // Playhead: report the LATEST position whose onset has already passed. Keyed
    // by bar+step so a bar's simultaneous hits fire one callback, not one per
    // piece — and the key includes the pass, so a looped single bar re-lights.
    let latest = null;
    for (;;) {
      if (headCursor.idx >= schedule.events.length) {
        if (!advancePass(headCursor, firstMusicIdx())) break;
        continue;
      }
      const ev = schedule.events[headCursor.idx];
      if (startTime + cursorTime(headCursor, ev.startSec) > now) break;
      latest = ev;
      headCursor.idx += 1;
    }
    if (latest) {
      const key = `${headCursor.pass}:${latest.countIn ? 'c' : 'm'}:${latest.bar}:${latest.step}`;
      if (key !== lastHeadKey) {
        lastHeadKey = key;
        notify({ bar: latest.bar, step: latest.step, countIn: latest.countIn });
      }
    }
  };

  const transport = createLookaheadTransport({
    // A looping player never "ends" on its own — the transport's end check must
    // not finish it, so its length is unbounded until stop().
    getTotalSec: () => (schedule.loop ? Infinity : schedule.totalSec),
    scheduleWindow,
    prepare: () => {
      schedule = build();
      if (!schedule.events.length || schedule.totalSec <= 0) { safeCall(onEnded); return false; }
      clicks = clickTimes();
      resetCursor();
      const c = ctx();
      master = c.createGain();
      master.gain.value = 1;
      master.connect(c.destination);
      return true;
    },
    seekCursors: (offsetSec) => {
      // The sheet has no scrub UI, so in practice this only ever runs with 0
      // (fresh play, and stop/finish resetting to the top). A resume offset
      // (transport.pause → play) positions every cursor past what already sounded.
      resetCursor();
      if (offsetSec <= 0) return;
      const skip = (cursor, list, key) => {
        while (cursor.idx < list.length && list[cursor.idx][key] < offsetSec) cursor.idx += 1;
      };
      skip(hitCursor, schedule.events, 'startSec');
      skip(headCursor, schedule.events, 'startSec');
      skip(clickCursor, clicks, 'startSec');
    },
    onStop: () => { notify(null); },
    onEnded: () => { safeCall(onEnded); },
    onTeardown: () => {
      if (master) {
        // Outside the request lifecycle — a disconnect on an already-torn-down
        // node must not throw into the transport's teardown path.
        try { master.disconnect(); } catch { /* already gone */ }
        master = null;
      }
    },
  });

  // A live setting change rebuilds the schedule while idle; while playing, the
  // caller restarts (a mid-groove tempo jump would desync the playhead against
  // already-scheduled audio).
  const rebuildIfIdle = () => {
    if (transport.isPlaying()) return;
    schedule = build();
    clicks = clickTimes();
    resetCursor();
  };

  return {
    play: transport.play,
    pause: transport.pause,
    stop: transport.stop,
    isPlaying: transport.isPlaying,
    setBpm: (next) => {
      bpm = Number.isFinite(next) && next > 0 ? next : null;
      rebuildIfIdle();
    },
    setLoop: (next) => { loopBars = next || null; rebuildIfIdle(); },
    setCountIn: (bars) => {
      countInBars = Math.max(0, Math.trunc(Number(bars)) || 0);
      rebuildIfIdle();
    },
    setClick: (enabled) => { clickEnabled = !!enabled; },
    schedule: () => schedule,
  };
};
