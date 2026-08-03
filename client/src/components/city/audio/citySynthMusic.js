// Procedural ambient synthwave using Web Audio oscillators.
//
// Scheduling follows the "two clocks" pattern the sibling synth players use (see
// lib/metronome.js:3-6 and lib/lookaheadTransport.js): a coarse setInterval
// *lookahead* timer wakes every LOOKAHEAD_MS and hands every note event falling
// inside the next SCHEDULE_AHEAD window to the AudioContext clock at an ABSOLUTE
// time. Previously the chord changes (2400ms) and arp plucks (150ms) rode two
// independent setIntervals that read ctx.currentTime at fire time, so both
// drifted under main-thread load and drifted apart from each other.
//
// It does NOT reuse createLookaheadTransport, deliberately: that transport reads
// its clock from the shared lib/audioContext.js singleton with no injection
// point, while cityAudioEngine is a documented holdout that owns its own
// AudioContext (and close()s it on unmount). Driving this graph from the shared
// context's currentTime would mean scheduling against a clock the graph doesn't
// run on. The transport also models a finite piece (total length, pause/seek/
// position, per-note node teardown) — none of which an endless drone built from
// long-lived oscillators has. What IS shared is the timing feel: SYNTH_TIMING.
import { getAudioContext, getMusicGain } from './cityAudioEngine';
import { CHORD_SETS } from '../../../utils/citySoundscape';
import { SYNTH_TIMING } from '../../../lib/lookaheadTransport';

const { LOOKAHEAD_MS, SCHEDULE_AHEAD } = SYNTH_TIMING;

// The note grid: one 16th note every ARP_SEC (150ms at 100BPM), with a chord
// change every CHORD_STEPS sixteenths (2.4s = 4 beats). Deriving both from ONE
// step counter is what keeps the arp phase-locked to the chords — the previous
// pair of independent timers could only stay aligned by luck.
const ARP_SEC = 0.15;
const CHORD_STEPS = 16;

let isPlaying = false;
let oscillators = [];
let nodesCleanup = [];

// Lookahead scheduler state. `gridOrigin` is the ctx time of step 0; every event
// time is gridOrigin + step * ARP_SEC, so the grid can never accumulate drift.
let schedulerTimer = null;
let gridOrigin = 0;
let nextStep = 1;
let currentChordIdx = 0;

// Default chord progression (Am -> Em -> F -> C). The soundscape layer (roadmap 3.4) can swap
// this for the darker `tense` set via setSoundscape(); we keep a mutable pointer so the running
// chord interval reads whatever's current without re-scheduling.
const DEFAULT_CHORDS = CHORD_SETS.bright;
let activeChords = DEFAULT_CHORDS;

// Live references to the modulatable nodes, captured in startMusic(). setSoundscape() ramps
// these in real time so the music's mood/brightness/energy follows system state. Null while
// the music is stopped. `baseArpGain` is the energy-driven target the arp envelope peaks at.
let liveBassFilter = null;
let livePadOscs = [];
let liveArpPeak = 0.06; // peak gain the arp pluck opens to; raised/lowered by energy

// Layer gain nodes, captured in startMusic() so stopMusic() can ramp each audible
// layer to silence before the hard oscillator stop (see stopMusic() below).
let liveBassGain = null;
let livePadGain = null;
let liveArpGain = null;

// Oscillators the scheduler retunes each step. Null while stopped.
let liveBassOsc = null;
let liveArpOsc = null;

// Arp note patterns (scale degrees relative to chord root)
const ARP_PATTERN = [0, 2, 4, 7, 12, 7, 4, 2];

// Apply a soundscape view-model (from computeSoundscape) to the running music graph. Safe to call
// whether or not music is playing — it just updates the targets the next chord/arp tick uses.
export const setSoundscape = (params) => {
  if (!params) return;
  const ctx = getAudioContext();
  activeChords = params.chordSet === 'tense' ? CHORD_SETS.tense : CHORD_SETS.bright;
  liveArpPeak = Math.max(0.01, params.arpGain ?? 0.06);
  if (ctx && liveBassFilter) {
    // Ramp the base cutoff smoothly so mood shifts glide rather than click. The LFO still rides
    // on top of this via its own connection to bassFilter.frequency.
    liveBassFilter.frequency.setTargetAtTime(params.filterBase ?? 200, ctx.currentTime, 0.5);
  }
  if (ctx && livePadOscs.length) {
    livePadOscs.forEach((osc, i) => {
      osc.detune.setTargetAtTime((i - 1) * (params.padDetune ?? 8), ctx.currentTime, 0.5);
    });
  }
};

// Advance to the next chord and glide the bass + pad onto it AT `when`. Reads
// `activeChords` live so a soundscape mood-swap (bright↔tense) takes effect on
// the next chord; the walk is incremental (not derived from the step index) so
// swapping to a set of a different length can't jump the progression.
const scheduleChordChange = (when) => {
  const chords = activeChords;
  currentChordIdx = (currentChordIdx + 1) % chords.length;
  const chord = chords[currentChordIdx];
  liveBassOsc.frequency.setTargetAtTime(chord[0], when, 0.3);
  livePadOscs.forEach((osc, i) => {
    osc.frequency.setTargetAtTime(chord[i] * 2, when, 0.3);
  });
};

// One arp 16th note AT `when`. The pluck peaks at `liveArpPeak`, which the
// soundscape raises with system energy (more active agents → a louder lead).
const scheduleArpPluck = (step, when) => {
  const chords = activeChords;
  const chord = chords[currentChordIdx % chords.length];
  const rootFreq = chord[0] * 4; // two octaves up
  const semitone = ARP_PATTERN[(step - 1) % ARP_PATTERN.length];
  const freq = rootFreq * Math.pow(2, semitone / 12);

  liveArpOsc.frequency.setTargetAtTime(freq, when, 0.01);
  // Short percussive envelope
  liveArpGain.gain.setTargetAtTime(liveArpPeak, when, 0.005);
  liveArpGain.gain.setTargetAtTime(0.0, when + 0.06, 0.04);
};

// One lookahead tick: schedule every step due inside the next SCHEDULE_AHEAD
// window. Chord-first at a shared step so the pluck landing on the downbeat
// already sounds the new chord.
const scheduleWindow = () => {
  const ctx = getAudioContext();
  if (!isPlaying || !ctx) return;

  // A backgrounded tab throttles this timer to once a second or worse. Without
  // this, catching up would schedule every missed step at a time already in the
  // past — Web Audio clamps those to "now", firing them as one burst. Re-anchor
  // to whole steps instead, which keeps the grid phase (and so the arp/chord
  // lock) while dropping the steps nobody was there to hear.
  const behind = ctx.currentTime - (gridOrigin + nextStep * ARP_SEC);
  if (behind > ARP_SEC) nextStep += Math.floor(behind / ARP_SEC);

  const horizon = ctx.currentTime + SCHEDULE_AHEAD;
  while (gridOrigin + nextStep * ARP_SEC < horizon) {
    const when = gridOrigin + nextStep * ARP_SEC;
    if (nextStep % CHORD_STEPS === 0) scheduleChordChange(when);
    scheduleArpPluck(nextStep, when);
    nextStep += 1;
  }
};

const createReverb = (ctx) => {
  const convolver = ctx.createConvolver();
  const rate = ctx.sampleRate;
  const length = rate * 2.5;
  const impulse = ctx.createBuffer(2, length, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = impulse.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / length, 2.5);
    }
  }
  convolver.buffer = impulse;
  return convolver;
};

export const startMusic = () => {
  const ctx = getAudioContext();
  const output = getMusicGain();
  if (!ctx || !output || isPlaying) return;
  isPlaying = true;

  const reverb = createReverb(ctx);
  const reverbGain = ctx.createGain();
  reverbGain.gain.value = 0.3;
  reverb.connect(reverbGain);
  reverbGain.connect(output);

  const delay = ctx.createDelay(1.0);
  delay.delayTime.value = 0.375; // dotted eighth at ~100BPM
  const delayFeedback = ctx.createGain();
  delayFeedback.gain.value = 0.35;
  delay.connect(delayFeedback);
  delayFeedback.connect(delay);
  delayFeedback.connect(output);

  // --- Bass drone layer ---
  const bassFilter = ctx.createBiquadFilter();
  bassFilter.type = 'lowpass';
  bassFilter.frequency.value = 200;
  bassFilter.Q.value = 2;
  bassFilter.connect(output);
  bassFilter.connect(reverb);

  const bassOsc = ctx.createOscillator();
  bassOsc.type = 'sawtooth';
  bassOsc.frequency.value = activeChords[0][0];
  const bassGain = ctx.createGain();
  bassGain.gain.value = 0.12;
  bassOsc.connect(bassGain);
  bassGain.connect(bassFilter);
  bassOsc.start();
  oscillators.push(bassOsc);

  // LFO for filter sweep
  const lfo = ctx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = 0.08;
  const lfoGain = ctx.createGain();
  lfoGain.gain.value = 120;
  lfo.connect(lfoGain);
  lfoGain.connect(bassFilter.frequency);
  lfo.start();
  oscillators.push(lfo);

  // --- Pad layer (wide stereo detuned sines) ---
  const padGain = ctx.createGain();
  padGain.gain.value = 0.04;
  padGain.connect(output);
  padGain.connect(reverb);

  const padOscs = [];
  for (let i = 0; i < 3; i++) {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = activeChords[0][i];
    osc.detune.value = (i - 1) * 8; // slight spread
    osc.connect(padGain);
    osc.start();
    padOscs.push(osc);
    oscillators.push(osc);
  }

  // --- Arp lead layer ---
  const arpFilter = ctx.createBiquadFilter();
  arpFilter.type = 'bandpass';
  arpFilter.frequency.value = 1200;
  arpFilter.Q.value = 1.5;
  const arpGain = ctx.createGain();
  arpGain.gain.value = 0;
  arpFilter.connect(arpGain);
  arpGain.connect(output);
  arpGain.connect(delay);
  arpGain.connect(reverb);

  const arpOsc = ctx.createOscillator();
  arpOsc.type = 'triangle';
  arpOsc.frequency.value = 440;
  arpOsc.detune.value = 5;
  arpOsc.connect(arpFilter);
  arpOsc.start();
  oscillators.push(arpOsc);

  // Expose the modulatable nodes so setSoundscape() and the scheduler can reach them.
  liveBassFilter = bassFilter;
  livePadOscs = padOscs;
  liveBassGain = bassGain;
  livePadGain = padGain;
  liveArpGain = arpGain;
  liveBassOsc = bassOsc;
  liveArpOsc = arpOsc;

  nodesCleanup.push(reverb, reverbGain, delay, delayFeedback, bassFilter, bassGain, padGain, arpFilter, arpGain);

  // Anchor the note grid to the audio clock and start the lookahead timer. Chord
  // index 0 is already sounding from the oscillator frequencies above, so the
  // grid starts at step 1 — the first chord CHANGE lands on step CHORD_STEPS.
  gridOrigin = ctx.currentTime;
  nextStep = 1;
  currentChordIdx = 0;
  scheduleWindow();
  schedulerTimer = setInterval(scheduleWindow, LOOKAHEAD_MS);
};

// Fade time constant for the pre-stop ramp (setTargetAtTime never truly reaches
// zero, so REST settles ~3 time-constants in — audibly silent well under 100ms).
const STOP_RAMP_TC = 0.02;
// Oscillators are hard-stopped this long after the ramp starts, once the layers
// have settled toward silence, instead of mid-waveform (the audible pop this fixes).
const STOP_SETTLE = 0.08;

// Stops the running music graph. Ramps each audible layer to silence first — an
// abrupt osc.stop() while a waveform is mid-cycle truncates it at a non-zero
// sample, which reads as an audible click/pop on mute toggle or CyberCity unmount.
// Mirrors citySoundEffects.js's envelope-before-stop pattern (setTargetAtTime /
// exponentialRampToValueAtTime before every osc.stop() there).
//
// Returns the settle time in milliseconds so a caller that needs to tear down the
// AudioContext right after (useCityAudio's unmount cleanup) can delay the close
// until the ramp has actually finished, instead of cutting it off immediately.
export const stopMusic = () => {
  if (!isPlaying) return 0;
  isPlaying = false;
  // Stop the lookahead timer before the ramps below, so no further note events
  // get scheduled onto a graph that is already fading out.
  if (schedulerTimer != null) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
  const ctx = getAudioContext();
  const now = ctx ? ctx.currentTime : 0;

  if (ctx) {
    [liveBassGain, livePadGain, liveArpGain].forEach(gainNode => {
      if (gainNode) gainNode.gain.setTargetAtTime(0, now, STOP_RAMP_TC);
    });
  }

  const stopAt = ctx ? now + STOP_SETTLE : 0;
  const pendingOscillators = oscillators;
  const pendingNodes = nodesCleanup;
  pendingOscillators.forEach(osc => {
    if (ctx) osc.stop(stopAt);
    else osc.stop();
  });

  oscillators = [];
  nodesCleanup = [];
  // Drop references to the now-stopping nodes so a stray setSoundscape() can't ramp a
  // dead graph. The next startMusic() re-captures fresh ones.
  liveBassFilter = null;
  livePadOscs = [];
  liveBassGain = null;
  livePadGain = null;
  liveArpGain = null;
  liveBassOsc = null;
  liveArpOsc = null;

  // Disconnect after the ramp/stop settles instead of instantly — an immediate
  // disconnect() would cut the fade above short, defeating the point of it.
  const settleMs = ctx ? (STOP_SETTLE + STOP_RAMP_TC) * 1000 : 0;
  setTimeout(() => {
    pendingOscillators.forEach(osc => osc.disconnect());
    pendingNodes.forEach(node => node.disconnect());
  }, settleMs);

  return settleMs;
};
