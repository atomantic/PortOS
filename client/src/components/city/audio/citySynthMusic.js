// Procedural ambient synthwave using Web Audio oscillators
import { getAudioContext, getMusicGain } from './cityAudioEngine';
import { CHORD_SETS } from '../../../utils/citySoundscape';

let isPlaying = false;
let oscillators = [];
let intervals = [];
let nodesCleanup = [];

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

  let currentChordIdx = 0;
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

  let arpStep = 0;
  // Chord change every 2.4s (4 beats at 100BPM). Reads `activeChords` live so a soundscape
  // mood-swap (bright↔tense) takes effect on the next chord without re-scheduling the interval.
  const chordInterval = setInterval(() => {
    if (!isPlaying) return;
    const chords = activeChords;
    currentChordIdx = (currentChordIdx + 1) % chords.length;
    const chord = chords[currentChordIdx];
    const now = ctx.currentTime;
    bassOsc.frequency.setTargetAtTime(chord[0], now, 0.3);
    padOscs.forEach((osc, i) => {
      osc.frequency.setTargetAtTime(chord[i] * 2, now, 0.3);
    });
  }, 2400);
  intervals.push(chordInterval);

  // Arp sixteenth notes at 100BPM = 150ms per step. The pluck peaks at `liveArpPeak`, which the
  // soundscape raises with system energy (more active agents → a louder, livelier lead).
  const arpInterval = setInterval(() => {
    if (!isPlaying) return;
    const chord = activeChords[currentChordIdx % activeChords.length];
    const rootFreq = chord[0] * 4; // two octaves up
    const semitone = ARP_PATTERN[arpStep % ARP_PATTERN.length];
    const freq = rootFreq * Math.pow(2, semitone / 12);
    const now = ctx.currentTime;

    arpOsc.frequency.setTargetAtTime(freq, now, 0.01);
    // Short percussive envelope
    arpGain.gain.setTargetAtTime(liveArpPeak, now, 0.005);
    arpGain.gain.setTargetAtTime(0.0, now + 0.06, 0.04);

    arpStep++;
  }, 150);
  intervals.push(arpInterval);

  // Expose the modulatable nodes so setSoundscape() can ramp them in real time.
  liveBassFilter = bassFilter;
  livePadOscs = padOscs;

  nodesCleanup.push(reverb, reverbGain, delay, delayFeedback, bassFilter, bassGain, padGain, arpFilter, arpGain);
};

export const stopMusic = () => {
  isPlaying = false;
  oscillators.forEach(osc => {
    osc.stop();
    osc.disconnect();
  });
  oscillators = [];
  intervals.forEach(clearInterval);
  intervals = [];
  nodesCleanup.forEach(node => node.disconnect());
  nodesCleanup = [];
  // Drop references to the now-disconnected nodes so a stray setSoundscape() can't ramp a
  // dead graph. The next startMusic() re-captures fresh ones.
  liveBassFilter = null;
  livePadOscs = [];
};
