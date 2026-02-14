// Procedural ambient synthwave using Web Audio oscillators
import { getAudioContext, getMusicGain } from './cityAudioEngine';

let isPlaying = false;
let oscillators = [];
let intervals = [];
let nodesCleanup = [];

// Chord progressions (Am -> Em -> F -> C) as frequency arrays
const CHORDS = [
  [110, 130.81, 164.81],   // Am (A2, C3, E3)
  [82.41, 123.47, 164.81], // Em (E2, B2, E3)
  [87.31, 110, 130.81],    // F  (F2, A2, C3)
  [65.41, 98.0, 130.81],   // C  (C2, G2, C3)
];

// Arp note patterns (scale degrees relative to chord root)
const ARP_PATTERN = [0, 2, 4, 7, 12, 7, 4, 2];

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
  bassOsc.frequency.value = CHORDS[0][0];
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
    osc.frequency.value = CHORDS[0][i];
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
  // Chord change every 2.4s (4 beats at 100BPM)
  const chordInterval = setInterval(() => {
    if (!isPlaying) return;
    currentChordIdx = (currentChordIdx + 1) % CHORDS.length;
    const chord = CHORDS[currentChordIdx];
    const now = ctx.currentTime;
    bassOsc.frequency.setTargetAtTime(chord[0], now, 0.3);
    padOscs.forEach((osc, i) => {
      osc.frequency.setTargetAtTime(chord[i] * 2, now, 0.3);
    });
  }, 2400);
  intervals.push(chordInterval);

  // Arp sixteenth notes at 100BPM = 150ms per step
  const arpInterval = setInterval(() => {
    if (!isPlaying) return;
    const chord = CHORDS[currentChordIdx];
    const rootFreq = chord[0] * 4; // two octaves up
    const semitone = ARP_PATTERN[arpStep % ARP_PATTERN.length];
    const freq = rootFreq * Math.pow(2, semitone / 12);
    const now = ctx.currentTime;

    arpOsc.frequency.setTargetAtTime(freq, now, 0.01);
    // Short percussive envelope
    arpGain.gain.setTargetAtTime(0.06, now, 0.005);
    arpGain.gain.setTargetAtTime(0.0, now + 0.06, 0.04);

    arpStep++;
  }, 150);
  intervals.push(arpInterval);

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
};
