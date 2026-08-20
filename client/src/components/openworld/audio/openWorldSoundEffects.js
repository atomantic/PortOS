// Procedural sound effects using Web Audio API -- each SFX is a pure function
import { getAudioContext, getSfxGain } from './openWorldAudioEngine';

// Helper: create white noise buffer
const createNoiseBuffer = (ctx, duration) => {
  const sampleRate = ctx.sampleRate;
  const length = sampleRate * duration;
  const buffer = ctx.createBuffer(1, length, sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) {
    data[i] = Math.random() * 2 - 1;
  }
  return buffer;
};

// Building hover: soft scan tone (sine sweep 200->800Hz, 100ms)
const playBuildingHover = (ctx, output) => {
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(200, now);
  osc.frequency.exponentialRampToValueAtTime(800, now + 0.1);
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = 500;
  filter.Q.value = 2;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.15, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
  osc.connect(filter);
  filter.connect(gain);
  gain.connect(output);
  osc.start(now);
  osc.stop(now + 0.15);
};

// Building click: percussive ping (noise burst + sine)
const playBuildingClick = (ctx, output) => {
  const now = ctx.currentTime;
  // Noise burst
  const noise = ctx.createBufferSource();
  noise.buffer = createNoiseBuffer(ctx, 0.03);
  const noiseGain = ctx.createGain();
  noiseGain.gain.setValueAtTime(0.2, now);
  noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.03);
  noise.connect(noiseGain);
  noiseGain.connect(output);
  noise.start(now);
  // Sine ping
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.value = 1200;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.15, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
  osc.connect(gain);
  gain.connect(output);
  osc.start(now);
  osc.stop(now + 0.2);
};

// Lightning: thunder crack (noise, high-pass, distortion, decay)
const playLightning = (ctx, output) => {
  const now = ctx.currentTime;
  const noise = ctx.createBufferSource();
  noise.buffer = createNoiseBuffer(ctx, 0.5);
  const filter = ctx.createBiquadFilter();
  filter.type = 'highpass';
  filter.frequency.value = 400;
  const distortion = ctx.createWaveShaper();
  const curve = new Float32Array(256);
  for (let i = 0; i < 256; i++) {
    const x = (i / 128) - 1;
    curve[i] = (Math.PI + 50) * x / (Math.PI + 50 * Math.abs(x));
  }
  distortion.curve = curve;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.3, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
  noise.connect(filter);
  filter.connect(distortion);
  distortion.connect(gain);
  gain.connect(output);
  noise.start(now);
};

// Shooting star: whoosh (high-pass noise sweep 2kHz->200Hz, panned)
const playShootingStar = (ctx, output) => {
  const now = ctx.currentTime;
  const noise = ctx.createBufferSource();
  noise.buffer = createNoiseBuffer(ctx, 0.6);
  const filter = ctx.createBiquadFilter();
  filter.type = 'highpass';
  filter.frequency.setValueAtTime(2000, now);
  filter.frequency.exponentialRampToValueAtTime(200, now + 0.5);
  const panner = ctx.createStereoPanner();
  panner.pan.value = Math.random() * 2 - 1;
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.12, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.55);
  noise.connect(filter);
  filter.connect(panner);
  panner.connect(gain);
  gain.connect(output);
  noise.start(now);
};

// Data pulse: chirp (sine 400->600Hz, 80ms)
const playDataPulse = (ctx, output) => {
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(400, now);
  osc.frequency.exponentialRampToValueAtTime(600, now + 0.08);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.1, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.1);
  osc.connect(gain);
  gain.connect(output);
  osc.start(now);
  osc.stop(now + 0.12);
};

// Task complete: a bright two-note major-third chime (E6 → G#6) with a soft bell decay. Played
// when a CoS task completes (roadmap 3.4) so finishing work has an audible reward in the city.
const playTaskComplete = (ctx, output) => {
  const now = ctx.currentTime;
  const notes = [1318.51, 1661.22]; // E6, G#6 — a rising major third reads as "success"
  notes.forEach((freq, i) => {
    const t = now + i * 0.09; // slight arpeggiation
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.18, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
    osc.connect(gain);
    gain.connect(output);
    osc.start(t);
    osc.stop(t + 0.55);
  });
};

// Horn: dual-tone retro-futuristic synth horn
const playHorn = (ctx, output) => {
  const now = ctx.currentTime;
  const freqs = [440, 554.37]; // A4 + C#5 major third interval
  freqs.forEach((freq) => {
    const osc = ctx.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.setValueAtTime(freq, now);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(1400, now);
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.001, now);
    gain.gain.exponentialRampToValueAtTime(0.14, now + 0.02);
    gain.gain.setValueAtTime(0.12, now + 0.22);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(output);
    osc.start(now);
    osc.stop(now + 0.38);
  });
};

// Boost: high-energy rising whoosh + resonance sweep
const playBoost = (ctx, output) => {
  const now = ctx.currentTime;
  const noise = ctx.createBufferSource();
  noise.buffer = createNoiseBuffer(ctx, 0.45);
  const filter = ctx.createBiquadFilter();
  filter.type = 'bandpass';
  filter.Q.value = 3;
  filter.frequency.setValueAtTime(300, now);
  filter.frequency.exponentialRampToValueAtTime(1800, now + 0.4);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.001, now);
  gain.gain.exponentialRampToValueAtTime(0.15, now + 0.04);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.45);
  noise.connect(filter);
  filter.connect(gain);
  gain.connect(output);
  noise.start(now);
};

// Boost pad: turbo charged surge
const playBoostPad = (ctx, output) => {
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = 'sawtooth';
  osc.frequency.setValueAtTime(220, now);
  osc.frequency.exponentialRampToValueAtTime(880, now + 0.25);
  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(600, now);
  filter.frequency.exponentialRampToValueAtTime(3200, now + 0.25);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.001, now);
  gain.gain.exponentialRampToValueAtTime(0.2, now + 0.03);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
  osc.connect(filter);
  filter.connect(gain);
  gain.connect(output);
  osc.start(now);
  osc.stop(now + 0.32);
};

// Jump: springy upward chirp
const playJump = (ctx, output) => {
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(260, now);
  osc.frequency.exponentialRampToValueAtTime(620, now + 0.12);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.15, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
  osc.connect(gain);
  gain.connect(output);
  osc.start(now);
  osc.stop(now + 0.18);
};

// Land: solid low-end damping thud
const playLand = (ctx, output) => {
  const now = ctx.currentTime;
  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(110, now);
  osc.frequency.exponentialRampToValueAtTime(40, now + 0.14);
  const gain = ctx.createGain();
  gain.gain.setValueAtTime(0.22, now);
  gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
  osc.connect(gain);
  gain.connect(output);
  osc.start(now);
  osc.stop(now + 0.18);
};

// Collectible shard: sparkling 4-note ascending crystalline arpeggio
const playCollect = (ctx, output) => {
  const now = ctx.currentTime;
  const notes = [1046.5, 1318.51, 1567.98, 2093.0]; // C6, E6, G6, C7
  notes.forEach((freq, i) => {
    const t = now + i * 0.055;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.001, t);
    gain.gain.exponentialRampToValueAtTime(0.16, t + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.38);
    osc.connect(gain);
    gain.connect(output);
    osc.start(t);
    osc.stop(t + 0.4);
  });
};

// Easter egg discovery: shimmering mystical chord
const playEggDiscover = (ctx, output) => {
  const now = ctx.currentTime;
  const freqs = [739.99, 932.33, 1108.73, 1396.91]; // F#5, A#5, C#6, F6 (Major 7th sparkle)
  freqs.forEach((freq, i) => {
    const t = now + i * 0.04;
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = freq;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.001, t);
    gain.gain.exponentialRampToValueAtTime(0.12, t + 0.08);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
    osc.connect(gain);
    gain.connect(output);
    osc.start(t);
    osc.stop(t + 0.75);
  });
};

const SFX_MAP = {
  buildingHover: playBuildingHover,
  buildingClick: playBuildingClick,
  lightning: playLightning,
  shootingStar: playShootingStar,
  dataPulse: playDataPulse,
  taskComplete: playTaskComplete,
  horn: playHorn,
  boost: playBoost,
  boostPad: playBoostPad,
  jump: playJump,
  land: playLand,
  collect: playCollect,
  eggDiscover: playEggDiscover,
};

export const playSfx = (name) => {
  const ctx = getAudioContext();
  const output = getSfxGain();
  if (!ctx || !output || ctx.state === 'closed') return;
  const fn = SFX_MAP[name];
  if (fn) fn(ctx, output);
};
