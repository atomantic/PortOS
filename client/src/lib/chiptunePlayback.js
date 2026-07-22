// Chiptune score preview (#2911) — turns a track's LLM-generated chiptune
// score into a seamlessly LOOPING WebAudio preview. Companion to the offline
// renderer (server/lib/chiptuneRender.js): same score contract, same timing
// semantics (MIRRORS server/lib/chiptuneScore.js buildScoreEvents — keep the
// two in lockstep), synthesized live with OscillatorNodes + a noise buffer
// instead of offline PCM.
//
// No third-party audio library — built on the shared lookahead transport
// (lookaheadTransport.js, #2493) like the other synth players. The schedule
// build is a pure function (unit-tested without Web Audio); the player loops
// by re-basing its cursor each time it exhausts the event list, so the loop
// boundary is sample-scheduler-exact rather than "restart on a timer".

import { getAudioContext as ctx } from './audioContext.js';
import { createLookaheadTransport, SYNTH_TIMING } from './lookaheadTransport.js';
import { midiToFreq, makeSafeCall } from './scorePlayback.js';

const { SCHEDULE_AHEAD } = SYNTH_TIMING;
const safeCall = makeSafeCall('chiptune playback');

// --- Pure schedule build (mirrors server buildScoreEvents) ------------------

const PITCH_CLASS = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const PITCH_RE = /^([A-Ga-g])(#{1,2}|b{1,2})?(-?\d)$/;
export const CHIPTUNE_NOISE_PRESETS = ['kick', 'snare', 'hat', 'open-hat'];

// MIDI number for a scientific-pitch STRING ("C4" = 60), or null. Differs from
// scorePlayback.pitchToMidi, which takes a parsed { letter, accidental, octave }.
export function parseChiptunePitch(pitch) {
  const m = PITCH_RE.exec(String(pitch || '').trim());
  if (!m) return null;
  const shift = m[2] ? (m[2][0] === '#' ? m[2].length : -m[2].length) : 0;
  return (Number(m[3]) + 1) * 12 + PITCH_CLASS[m[1].toUpperCase()] + shift;
}

/**
 * Flatten a chiptune score into absolute-time events + the exact loop length.
 * Same drop/clamp semantics as the server: notes starting past their pattern
 * are dropped, overhang is clamped, unresolvable pitches drop just that note.
 */
export function buildChiptuneSchedule(score) {
  if (
    !score || !Array.isArray(score.channels) || !Array.isArray(score.order)
    || !(score.bpm > 0) || !(score.stepsPerBeat > 0) || !(score.beatsPerBar > 0)
  ) {
    return { events: [], stepSec: 0, totalSec: 0 };
  }
  const stepSec = 60 / (score.bpm * score.stepsPerBeat);
  const channelsById = new Map(score.channels.map((c) => [c.id, c]));
  const events = [];
  let baseStep = 0;
  for (const name of score.order) {
    const pattern = score.patterns?.[name];
    if (!pattern) continue;
    const steps = pattern.bars * score.beatsPerBar * score.stepsPerBeat;
    for (const [channelId, notes] of Object.entries(pattern.notes || {})) {
      const channel = channelsById.get(channelId);
      if (!channel || !Array.isArray(notes)) continue;
      for (const note of notes) {
        if (note.step >= steps) continue;
        const lenSteps = Math.min(note.len, steps - note.step);
        const isNoise = channel.wave === 'noise';
        const noise = isNoise ? (CHIPTUNE_NOISE_PRESETS.includes(note.pitch) ? note.pitch : null) : null;
        const freq = isNoise ? null : midiToFreq(parseChiptunePitch(note.pitch));
        if (isNoise ? !noise : !freq) continue;
        events.push({
          wave: channel.wave,
          duty: channel.duty ?? 0.5,
          gain: channel.gain ?? 0.5,
          freq,
          noise,
          startSec: (baseStep + note.step) * stepSec,
          durSec: lenSteps * stepSec,
          vel: note.vel ?? 0.8,
        });
      }
    }
    baseStep += steps;
  }
  events.sort((a, b) => a.startSec - b.startSec);
  return { events, stepSec, totalSec: baseStep * stepSec };
}

// --- WebAudio voices --------------------------------------------------------

const VOICE_PEAK = 0.22; // per-voice headroom so four channels don't clip

// Band-limited pulse wave for non-50% duty cycles (a 'square' OscillatorNode
// is fixed at 50%). Fourier series of a pulse: a_n ∝ sin(nπ·duty)/n.
const pulseWave = (c, duty) => {
  const N = 32;
  const real = new Float32Array(N);
  const imag = new Float32Array(N);
  for (let n = 1; n < N; n += 1) {
    imag[n] = (2 / (n * Math.PI)) * Math.sin(n * Math.PI * duty);
  }
  return c.createPeriodicWave(real, imag, { disableNormalization: false });
};

// Shared white-noise buffer (1s, reused by every noise voice via offset 0 —
// the LFSR aesthetic matters less in preview than in the deterministic render).
let noiseBuffer = null;
const getNoiseBuffer = (c) => {
  if (!noiseBuffer || noiseBuffer.sampleRate !== c.sampleRate) {
    noiseBuffer = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.random() * 2 - 1;
  }
  return noiseBuffer;
};

const NOISE_VOICES = {
  kick: { decaySec: 0.11 },
  snare: { decaySec: 0.12, rate: 0.45 },
  hat: { decaySec: 0.04, rate: 1 },
  'open-hat': { decaySec: 0.2, rate: 1 },
};

// Schedule one chiptune voice; returns { osc, gain } for transport teardown
// (an AudioBufferSourceNode satisfies the same start/stop/onended surface).
function scheduleChipVoice(c, ev, startAt, destination, waveCache) {
  const gain = c.createGain();
  const peak = Math.max(0.0002, VOICE_PEAK * ev.gain * ev.vel);
  const end = startAt + ev.durSec;
  let osc;

  if (ev.noise) {
    const preset = NOISE_VOICES[ev.noise];
    if (ev.noise === 'kick') {
      // Classic chiptune kick: a fast descending sine sweep, not noise.
      osc = c.createOscillator();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(160, startAt);
      osc.frequency.exponentialRampToValueAtTime(45, startAt + preset.decaySec);
    } else {
      osc = c.createBufferSource();
      osc.buffer = getNoiseBuffer(c);
      osc.loop = true;
      osc.playbackRate.value = preset.rate;
    }
    gain.gain.setValueAtTime(peak, startAt);
    gain.gain.exponentialRampToValueAtTime(0.0001, Math.min(end, startAt + preset.decaySec * 4));
  } else {
    osc = c.createOscillator();
    if (ev.wave === 'triangle') osc.type = 'triangle';
    else if (ev.duty === 0.5) osc.type = 'square';
    else {
      const key = ev.duty.toFixed(3);
      if (!waveCache.has(key)) waveCache.set(key, pulseWave(c, ev.duty));
      osc.setPeriodicWave(waveCache.get(key));
    }
    osc.frequency.setValueAtTime(ev.freq, startAt);
    const attack = Math.min(0.008, ev.durSec * 0.25);
    const release = Math.min(0.05, ev.durSec * 0.3);
    gain.gain.setValueAtTime(0.0001, startAt);
    gain.gain.exponentialRampToValueAtTime(peak, startAt + attack);
    gain.gain.setValueAtTime(peak, Math.max(startAt + attack, end - release));
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
  }

  osc.connect(gain).connect(destination);
  osc.start(startAt);
  osc.stop(end + 0.02);
  return { osc, gain };
}

// --- Player -----------------------------------------------------------------

/**
 * Looping chiptune preview player over the shared lookahead transport.
 * `getScore` is re-read on every play() so the preview always sounds the
 * freshest generation. Loops until stop() — `getTotalSec` is Infinity and the
 * cursor re-bases itself each pass, so the loop boundary is scheduler-exact.
 *
 * @param {() => object|null} getScore — returns the current score (or null)
 * @param {{ onLoop?: (loopCount:number) => void }} [callbacks]
 * @returns {{ play, stop, isPlaying }}
 */
export function createChiptunePlayer(getScore, { onLoop } = {}) {
  let schedule = null;
  let master = null;
  let waveCache = new Map();
  let cursor = { idx: 0, loopStartSec: 0, loops: 0 };

  const transport = createLookaheadTransport({
    getTotalSec: () => Infinity,
    prepare: () => {
      const built = buildChiptuneSchedule(getScore());
      if (!built.events.length || built.totalSec <= 0) return false;
      schedule = built;
      const c = ctx();
      master = c.createGain();
      master.gain.value = 1;
      master.connect(c.destination);
      waveCache = new Map();
      cursor = { idx: 0, loopStartSec: 0, loops: 0 };
      return true;
    },
    scheduleWindow: (now, startTime, track) => {
      if (!schedule || !master) return;
      const horizon = now + SCHEDULE_AHEAD;
      // Hand every event due inside the window to the audio clock; when the
      // list is exhausted, re-base onto the next loop pass and keep going.
      for (;;) {
        if (cursor.idx >= schedule.events.length) {
          cursor.idx = 0;
          cursor.loopStartSec += schedule.totalSec;
          cursor.loops += 1;
          safeCall(onLoop, cursor.loops);
        }
        const ev = schedule.events[cursor.idx];
        const at = startTime + cursor.loopStartSec + ev.startSec;
        if (at >= horizon) break;
        cursor.idx += 1;
        if (at < now - 0.01) continue; // already past (first tick after a stall)
        track(scheduleChipVoice(ctx(), ev, at, master, waveCache));
      }
    },
    seekCursors: () => { cursor = { idx: 0, loopStartSec: 0, loops: 0 }; },
    onTeardown: () => {
      if (master) { try { master.disconnect(); } catch { /* already gone */ } master = null; }
    },
  });

  return { play: transport.play, stop: transport.stop, isPlaying: transport.isPlaying };
}
