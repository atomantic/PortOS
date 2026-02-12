// Singleton audio engine -- Web Audio API only, no external dependencies
let audioCtx = null;
let masterGain = null;
let musicGain = null;
let sfxGain = null;

export const getAudioContext = () => audioCtx;
export const getMusicGain = () => musicGain;
export const getSfxGain = () => sfxGain;

export const initAudio = () => {
  if (audioCtx) return audioCtx;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();

  masterGain = audioCtx.createGain();
  masterGain.gain.value = 1.0;
  masterGain.connect(audioCtx.destination);

  musicGain = audioCtx.createGain();
  musicGain.gain.value = 0.3;
  musicGain.connect(masterGain);

  sfxGain = audioCtx.createGain();
  sfxGain.gain.value = 0.5;
  sfxGain.connect(masterGain);

  return audioCtx;
};

export const setMusicVolume = (v) => {
  if (musicGain) musicGain.gain.value = Math.max(0, Math.min(1, v));
};

export const setSfxVolume = (v) => {
  if (sfxGain) sfxGain.gain.value = Math.max(0, Math.min(1, v));
};

export const cleanup = () => {
  if (audioCtx && audioCtx.state !== 'closed') {
    audioCtx.close();
  }
  audioCtx = null;
  masterGain = null;
  musicGain = null;
  sfxGain = null;
};
