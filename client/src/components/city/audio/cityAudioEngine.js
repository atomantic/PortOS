// Singleton audio engine -- Web Audio API only, no external dependencies
let audioCtx = null;
let masterGain = null;
let musicGain = null;
let sfxGain = null;
let pendingCleanup = null;

export const getAudioContext = () => audioCtx;
export const getMusicGain = () => musicGain;
export const getSfxGain = () => sfxGain;

export const initAudio = () => {
  // A remount can re-init while a delayed close (scheduleCleanup) is pending;
  // cancel it so the shared context isn't yanked out from under the new mount.
  if (pendingCleanup) {
    clearTimeout(pendingCleanup);
    pendingCleanup = null;
  }
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
  if (pendingCleanup) {
    clearTimeout(pendingCleanup);
    pendingCleanup = null;
  }
  if (audioCtx && audioCtx.state !== 'closed') {
    audioCtx.close();
  }
  audioCtx = null;
  masterGain = null;
  musicGain = null;
  sfxGain = null;
};

// Close after `delayMs` (e.g. once a stop-ramp settles) unless initAudio runs
// again first — an immediate close would cut the ramp short, but an
// uncancelled one would kill a remounted consumer's freshly built graph.
export const scheduleCleanup = (delayMs) => {
  if (pendingCleanup) clearTimeout(pendingCleanup);
  if (!delayMs || delayMs <= 0) {
    pendingCleanup = null;
    cleanup();
    return;
  }
  pendingCleanup = setTimeout(() => {
    pendingCleanup = null;
    cleanup();
  }, delayMs);
};
