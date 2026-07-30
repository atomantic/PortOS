// Drum-kit playback for the SongBook `drum` format — turns a parsed drum chart
// (see drumNotation.js) into an audible groove you can practice along with at a
// tempo you control. The third consumer of the shared lookahead transport
// (`lookaheadTransport.js`), alongside `createScorePlayer` and `createMidiPlayer`:
// the clock, node lifecycle and teardown semantics are all the shared ones, so
// this module only owns the schedule math and the kit voices.
//
// The kit is SYNTHESIZED — no sampled kit ships with PortOS (repo size + sample
// licensing). The voice recipes live in `drumKits.js` (TR-909 / TR-808 /
// Acoustic, selectable); this module owns the schedule math and the Web Audio
// realization of whichever kit is selected.
//
// `buildDrumSchedule` is PURE (no Web Audio) so the timing math — bpm, time
// signature, subdivision, count-in, loop expansion, per-glyph velocity — is
// unit-testable in a node env, mirroring `buildSchedule` in scorePlayback.js.

import { getAudioContext as ctx, getNoiseBuffer } from './audioContext.js';
import { createLookaheadTransport, SYNTH_TIMING } from './lookaheadTransport.js';
import { makeSafeCall } from './scorePlayback.js';
import { kitPiece, DEFAULT_DRUM_TEMPO } from './drumNotation.js';
import { CLICK_VOICE, kitVoiceLayers, resolveDrumKit } from './drumKits.js';

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

/**
 * A built schedule + a live clock position → where the playhead sits, as a
 * CONTINUOUS grid coordinate (pure; no Web Audio).
 *
 * THIS is the playhead the UI reads. The `onStep` callback reports the last
 * event that SOUNDED, which is enough to light a column but not to place a
 * position: it stalls across rests and never moves at all through a bar with no
 * hits. Anything that has to keep moving with the music — the sheet's line, the
 * transport's pulse — converts the audio clock here instead.
 *
 * Returns `null` when there's nothing to place. Otherwise:
 * - during the count-in (and the negative pre-roll lead) —
 *   `{ countIn: true, beat }`, the 1-based beat WITHIN the count-in bar;
 * - during the music — `{ countIn: false, bar, stepFloat }`, where `bar` is the
 *   chart's own 1-based bar number (so a loop range still points at the right
 *   bar of the full sheet) and `stepFloat` is a fractional grid step into it.
 *
 * @param {object} schedule — `buildDrumSchedule` output.
 * @param {number} posSec — transport position in piece-seconds (may be negative).
 */
export const resolvePlayhead = (schedule, posSec) => {
  const bars = Array.isArray(schedule?.bars) ? schedule.bars : [];
  const { barSec, stepSec, beatSec, countInSec = 0 } = schedule || {};
  if (!bars.length || !(barSec > 0) || !(stepSec > 0)) return null;
  const pos = Number.isFinite(posSec) ? posSec : 0;

  if (pos < countInSec) {
    const beatsPerBar = beatSec > 0 ? Math.max(1, Math.round(barSec / beatSec)) : 1;
    // The lead-in before t=0 is negative — clamp it to the first beat rather
    // than counting backwards past the start of the count-in.
    const elapsedBeats = Math.floor(Math.max(0, pos) / (beatSec || barSec));
    return { countIn: true, beat: (elapsedBeats % beatsPerBar) + 1 };
  }

  const musicSec = bars.length * barSec;
  let elapsed = pos - countInSec;
  // A looping player runs past the end of its schedule forever, replaying the
  // selected range — fold the position back onto one pass.
  if (schedule.loop && musicSec > 0) elapsed = ((elapsed % musicSec) + musicSec) % musicSec;
  elapsed = Math.min(Math.max(0, elapsed), Math.max(0, musicSec - 1e-6));

  const barIdx = Math.min(bars.length - 1, Math.floor(elapsed / barSec));
  return {
    countIn: false,
    bar: bars[barIdx].index,
    stepFloat: (elapsed - barIdx * barSec) / stepSec,
  };
};

// --- Kit voices -------------------------------------------------------------

// The RECIPES live in drumKits.js (three selectable kits); this section is the
// Web Audio realization of them — one node graph per layer, plus the master bus.

const VOICE_PEAK = 0.42; // per-layer gain ceiling before the per-cell velocity scale
// Headroom into the master soft-clipper: a busy bar stacks a kick, a snare, a hat
// and a click at once, so the sum is deliberately kept under unity and the
// clipper only rounds the peaks that still get through.
const MASTER_GAIN = 0.9;

const CURVE_SAMPLES = 1024;
const buildCurve = (shape) => Float32Array.from(
  { length: CURVE_SAMPLES },
  (_, i) => shape((i * 2) / (CURVE_SAMPLES - 1) - 1),
);

// MASTER soft-clipper: plain tanh, so it is unity-gain for quiet material and
// only rounds off the peaks when several loud voices land on the same downbeat.
// Cheaper and steadier than a compressor for a fixed-level drum bus. NOT the
// same curve as a drive of 1 — this one is deliberately un-normalized, and
// normalizing it would push ~2.4 dB of makeup gain into the clipper.
const CLIP_CURVE = buildCurve(Math.tanh);

// Per-LAYER saturation curve, cached per drive amount (a handful of compiled-in
// values). Normalized so the layer keeps its PEAK level and only gains harmonics
// — that harmonic series is what makes a sub-50Hz kick audible on a phone or
// laptop speaker, which has no driver for the fundamental at all (see the
// drumKits.js header).
const driveCurves = new Map();
const driveCurve = (amount) => {
  const cached = driveCurves.get(amount);
  if (cached) return cached;
  const norm = Math.tanh(amount);
  const curve = buildCurve((x) => Math.tanh(amount * x) / norm);
  driveCurves.set(amount, curve);
  return curve;
};

// Flam grace-note lead: the ghost hit lands this far BEFORE the main hit.
const FLAM_LEAD_SEC = 0.032;
// Envelope attack. An instant jump to full scale pops on some speakers, so every
// voice ramps in over this — short enough to stay percussive.
const ATTACK_SEC = 0.0015;
// Pitch-envelope fallback for a recipe that sets `to` without a `pitchDecay`.
// Deliberately NOT the amplitude decay: coupling the two is the weak-kick recipe
// this engine replaced, and a fourth kit must not be able to resurrect it by
// omitting a field.
const PITCH_SNAP_SEC = 0.04;

/**
 * Schedule ONE layer of a voice (see the layer shape in drumKits.js); returns an
 * array of `{ osc, gain }` for the transport's teardown tracking — one per
 * source, so a `metal` cluster's partials are each stoppable (an
 * AudioBufferSourceNode satisfies the same start/stop/onended surface an
 * OscillatorNode does).
 *
 * The pitch envelope runs on `pitchDecay`, NOT on the amplitude `decay` — a
 * drum-machine membrane snaps down to its fundamental in tens of milliseconds
 * and then holds there while the amplitude tail runs on for half a second. The
 * two being the same number is exactly what made the old kick sound weak.
 */
const scheduleLayer = (c, layer, startAt, destination, { velocity, open }) => {
  const gain = c.createGain();
  const decay = Math.max(0.005, (open && layer.openDecay) || layer.decay || 0.1);
  const stopAt = startAt + ATTACK_SEC + decay + 0.02;

  // Build the source(s). A `metal` layer is N square oscillators summed into the
  // ONE filter/envelope below — a biquad is linear, so filtering the sum is
  // identical to summing filtered partials, at a third of the nodes per hit.
  const partials = layer.kind === 'metal' ? layer.partials : [null];
  const sources = partials.map((hz) => {
    if (layer.kind === 'noise') {
      const src = c.createBufferSource();
      src.buffer = getNoiseBuffer(c);
      src.loop = true;
      return src;
    }
    const osc = c.createOscillator();
    osc.type = layer.kind === 'metal' ? 'square' : (layer.wave || 'sine');
    osc.frequency.setValueAtTime(hz ?? layer.from, startAt);
    if (layer.kind !== 'metal' && layer.to > 0 && layer.to !== layer.from) {
      osc.frequency.exponentialRampToValueAtTime(
        layer.to,
        startAt + Math.max(0.004, layer.pitchDecay ?? PITCH_SNAP_SEC),
      );
    }
    return osc;
  });

  // source(s) → [drive] → [filter] → gain → bus. The shaper sits BEFORE the gain
  // so the timbre is the same at every velocity (a drive that only bit on accents
  // would make the kit change character as you play softer).
  let head = null;   // the node the sources feed; null until one is created
  let tail = null;   // the last node before the gain
  const append = (node) => {
    if (!head) head = node;
    else tail.connect(node);
    tail = node;
  };
  if (layer.drive > 0) {
    const shaper = c.createWaveShaper();
    shaper.curve = driveCurve(layer.drive);
    shaper.oversample = '2x';
    append(shaper);
  }
  if (layer.filter) {
    const filter = c.createBiquadFilter();
    filter.type = layer.filter.type;
    filter.frequency.setValueAtTime(layer.filter.freq, startAt);
    filter.Q.value = layer.filter.q ?? 1;
    append(filter);
  }
  if (tail) tail.connect(gain);
  for (const src of sources) src.connect(head || gain);
  gain.connect(destination);

  // Percussive envelope: a sub-millisecond attack ramp into an exponential decay
  // to silence. A cluster's `gain` is the level of the WHOLE voice, so it splits
  // across the partials — that keeps a six-oscillator hat comparable to a
  // one-source noise hat instead of six times louder.
  const peak = Math.max(0.0002, (VOICE_PEAK * (layer.gain ?? 1) * velocity) / sources.length);
  gain.gain.setValueAtTime(0.0001, startAt);
  gain.gain.exponentialRampToValueAtTime(peak, startAt + ATTACK_SEC);
  gain.gain.exponentialRampToValueAtTime(0.0001, stopAt - 0.02);

  // One transport entry PER source, all sharing the single gain node: teardown
  // only ever touches `entry.osc`, and a cluster whose partials weren't each
  // tracked would keep ringing after stop() (up to 1.2s for the 808 crash).
  return sources.map((src) => {
    src.start(startAt);
    src.stop(stopAt);
    return { osc: src, gain };
  });
};

// Sound every layer of a voice at one time, scaled by a velocity multiplier.
const soundLayers = (c, layers, at, destination, track, { velocity, open }) => {
  for (const layer of layers) {
    for (const entry of scheduleLayer(c, layer, at, destination, { velocity, open })) track(entry);
  }
};

// Sound one chart event — the hit, plus a flam grace note when the glyph calls
// for one. Every created node pair goes through `track` so the transport tears
// all of them down on stop.
const soundEvent = (c, kit, ev, at, destination, track) => {
  const layers = kitVoiceLayers(kit, ev.sound);
  if (ev.flam) {
    soundLayers(c, layers, Math.max(at - FLAM_LEAD_SEC, 0), destination, track, {
      velocity: ev.velocity * 0.45, open: ev.open,
    });
  }
  soundLayers(c, layers, at, destination, track, { velocity: ev.velocity, open: ev.open });
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
 * @param {string} [options.kit] — kit id from `drumKits.js` (`909` / `808` /
 *   `acoustic`); an unknown id falls back to the default rather than to silence.
 * @param {({bar:number|null, step:number|null, countIn:boolean})=>void} [options.onStep]
 *   — the now-sounding grid position (null when playback ends/stops), for the
 *   sheet playhead.
 * @param {()=>void} [options.onEnded] — fired once when a non-looping chart ends.
 * @returns {{ play, pause, stop, isPlaying, setBpm, setLoop, setClick, setKit, schedule }}
 */
export const createDrumPlayer = (chart, options = {}) => {
  const { onStep, onEnded } = options;
  let bpm = Number.isFinite(options.bpm) && options.bpm > 0 ? options.bpm : null;
  let loopBars = options.loopBars || null;
  let clickEnabled = !!options.clickEnabled;
  let countInBars = options.countInBars || 0;
  // The kit only affects which voices SOUND, never the schedule — so unlike the
  // timing settings it can change mid-play (the next scheduled hit picks it up).
  let kit = resolveDrumKit(options.kit);

  const build = () => buildDrumSchedule(chart, { bpm, loop: loopBars, countInBars });
  let schedule = build();
  let master = null;
  let masterOut = null;

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
  // A loop pass must have BOTH real duration AND at least one music event to
  // advance past. A rest-only selected bar has duration but no events, so
  // `firstMusicIdx()` would return the exhausted end index and the rebase branch
  // would spin forever (a wedged tab, not just silence) — that's the case this
  // event check exists for, distinct from the duration check.
  const canLoop = () => !!schedule.loop
    && musicSec() > 0
    && schedule.events.some((ev) => !ev.countIn);

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
      soundEvent(c, kit, ev, Math.max(at, now), master, track);
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
        soundLayers(c, CLICK_VOICE, Math.max(at, now), master, track, {
          velocity: click.accent ? 1 : 0.55, open: false,
        });
      }
    }

    // Playhead: report the LATEST position whose onset has already passed. Keyed
    // by bar+step so a bar's simultaneous hits fire one callback, not one per
    // piece — and the key includes the pass, so a looped single bar re-lights.
    //
    // Event-driven, so it stands still through a rest — a caller that needs a
    // position rather than "the last thing that sounded" reads the clock via
    // `position()` + `resolvePlayhead` and passes no `onStep` at all, which
    // skips this walk entirely.
    if (!onStep) return;
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
    // A LOOPING player never "ends" on its own, so the transport's end check must
    // not finish it — unbounded until stop(). But `canLoop()` is the same gate the
    // scheduler uses: when a selected range holds no music (a rest-only bar) there
    // is nothing to repeat, so the run must be allowed to finish at its natural
    // length instead of sitting "playing" forever after the count-in.
    getTotalSec: () => (canLoop() ? Infinity : schedule.totalSec),
    scheduleWindow,
    prepare: () => {
      schedule = build();
      if (!schedule.events.length || schedule.totalSec <= 0) { safeCall(onEnded); return false; }
      clicks = clickTimes();
      resetCursor();
      const c = ctx();
      // Drum bus: every voice sums here, then through a soft-clipper so a
      // downbeat stacking kick + crash + click rounds off instead of clipping.
      master = c.createGain();
      master.gain.value = MASTER_GAIN;
      masterOut = c.createWaveShaper();
      masterOut.curve = CLIP_CURVE;
      masterOut.oversample = '2x';
      master.connect(masterOut);
      masterOut.connect(c.destination);
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
      // Outside the request lifecycle — a disconnect on an already-torn-down
      // node must not throw into the transport's teardown path.
      for (const node of [master, masterOut]) {
        if (!node) continue;
        try { node.disconnect(); } catch { /* already gone */ }
      }
      master = null;
      masterOut = null;
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
    // Live audio-clock position in piece-seconds. The `onStep` callback only
    // fires on EVENTS (so it stalls across a rest and skips a silent bar
    // entirely) — a continuously-scrolling sheet needs the clock itself, read
    // per animation frame rather than pushed through React state.
    position: transport.position,
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
    // Kit changes touch no timing, so — like the click toggle — they apply live:
    // whatever is already in the lookahead window finishes on the old kit and
    // everything scheduled after this lands on the new one.
    setKit: (id) => { kit = resolveDrumKit(id); },
    schedule: () => schedule,
  };
};
