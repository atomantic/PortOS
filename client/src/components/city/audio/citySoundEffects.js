// Procedural sound effects using Web Audio API -- each SFX is a pure function
import { getAudioContext, getSfxGain } from './cityAudioEngine';

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

const SFX_MAP = {
  buildingHover: playBuildingHover,
  buildingClick: playBuildingClick,
  lightning: playLightning,
  shootingStar: playShootingStar,
  dataPulse: playDataPulse,
};

export const playSfx = (name) => {
  const ctx = getAudioContext();
  const output = getSfxGain();
  if (!ctx || !output || ctx.state === 'closed') return;
  const fn = SFX_MAP[name];
  if (fn) fn(ctx, output);
};
